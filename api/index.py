"""TikTok bulk downloader - bản chạy trên Vercel (một FastAPI app, stream trực tiếp).

Không ghi file ra đĩa: video được stream từ CDN của TikTok qua function.
MP3: nếu TikTok có luồng audio riêng thì stream thẳng, nếu không thì dùng
ffmpeg (gói imageio-ffmpeg) để tách và mã hóa MP3 ngay khi stream.
"""
import os
import re
import subprocess
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlparse

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

MAX_LINKS = 5
CHUNK = 64 * 1024
PROXY = os.environ.get("YDL_PROXY")  # tuỳ chọn: http://user:pass@host:port

app = FastAPI(title="TikTok bulk downloader")

TIKTOK_HOST = re.compile(r"^(www\.|m\.|vm\.|vt\.)?tiktok\.com$")
THUMB_HOST_SUFFIXES = (
    "tiktokcdn.com",
    "tiktokcdn-us.com",
    "tiktokcdn-eu.com",
    "tiktokv.com",
    "tiktokv.us",
    "byteimg.com",
    "ibyteimg.com",
    "muscdn.com",
)
# Bỏ format "download" (bản có watermark), ưu tiên h264 để phát được mọi nơi
VIDEO_FORMAT = "b[vcodec^=h264][format_id!=download]/b[format_id!=download]/b"


def is_tiktok_url(url: str) -> bool:
    p = urlparse(url.strip())
    return p.scheme in ("http", "https") and bool(TIKTOK_HOST.match(p.hostname or ""))


def is_allowed_thumb(url: str) -> bool:
    p = urlparse(url)
    host = p.hostname or ""
    return p.scheme == "https" and any(
        host == s or host.endswith("." + s) for s in THUMB_HOST_SUFFIXES
    )


def extract(url: str, fmt: str | None = None):
    """Trả về (info, cookie_header). Nếu có fmt thì info đã chứa format được chọn."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "cache_dir": False,  # filesystem của Vercel là read-only
        "socket_timeout": 15,
    }
    if fmt:
        opts["format"] = fmt
    if PROXY:
        opts["proxy"] = PROXY
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        cookie = ""
        if fmt and info.get("url"):
            try:
                cookie = ydl.cookiejar.get_cookie_header(info["url"]) or ""
            except Exception:  # noqa: BLE001
                cookie = ""
    return info, cookie


class ResolveBody(BaseModel):
    urls: list[str]


def resolve_one(url: str) -> dict:
    try:
        info, _ = extract(url)
        thumb = info.get("thumbnail")
        return {
            "ok": True,
            "url": url,
            "id": info.get("id"),
            "title": info.get("title") or info.get("description") or "TikTok video",
            "uploader": info.get("uploader"),
            "duration": info.get("duration"),
            "thumbnail": f"/api/thumb?u={quote(thumb, safe='')}" if thumb else None,
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "url": url, "error": str(e).replace("ERROR: ", "")[:200]}


@app.post("/api/resolve")
def resolve(body: ResolveBody):
    urls = []
    for u in body.urls:
        u = u.strip()
        if u and u not in urls:
            urls.append(u)
    if not urls:
        raise HTTPException(400, "Chưa có link nào.")
    if len(urls) > MAX_LINKS:
        raise HTTPException(400, f"Tối đa {MAX_LINKS} link mỗi lần.")

    items = [None] * len(urls)
    todo = []
    for i, u in enumerate(urls):
        if is_tiktok_url(u):
            todo.append((i, u))
        else:
            items[i] = {"ok": False, "url": u, "error": "Không phải link TikTok hợp lệ."}

    with ThreadPoolExecutor(max_workers=MAX_LINKS) as pool:
        for (i, _), result in zip(todo, pool.map(lambda t: resolve_one(t[1]), todo)):
            items[i] = result
    return {"items": items}


@app.get("/api/thumb")
def thumb(u: str):
    if not is_allowed_thumb(u):
        raise HTTPException(400, "Nguồn ảnh không được phép.")
    try:
        r = httpx.get(u, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
    except httpx.HTTPError:
        raise HTTPException(502, "Không tải được ảnh.")
    return Response(
        r.content,
        media_type=r.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "public, max-age=3600"},
    )


def build_headers(info: dict, cookie: str) -> dict:
    headers = dict(info.get("http_headers") or {})
    headers.setdefault("User-Agent", "Mozilla/5.0")
    if cookie:
        headers["Cookie"] = cookie
    return headers


def stream_remote(url: str, headers: dict, media_type: str, filename: str, inline: bool = False):
    if urlparse(url).scheme != "https":
        raise HTTPException(502, "Nguồn video không hợp lệ.")
    client = httpx.Client(timeout=httpx.Timeout(15.0, read=60.0), follow_redirects=True)
    try:
        r = client.send(client.build_request("GET", url, headers=headers), stream=True)
    except httpx.HTTPError as e:
        client.close()
        raise HTTPException(502, f"Không kết nối được nguồn video: {str(e)[:100]}")
    if r.status_code >= 400:
        code = r.status_code
        r.close()
        client.close()
        raise HTTPException(502, f"TikTok từ chối yêu cầu (HTTP {code}).")

    def gen():
        try:
            for chunk in r.iter_raw(CHUNK):
                yield chunk
        finally:
            r.close()
            client.close()

    disp = "inline" if inline else "attachment"
    out = {"Content-Disposition": f'{disp}; filename="{filename}"'}
    if r.headers.get("content-length") and not r.headers.get("content-encoding"):
        out["Content-Length"] = r.headers["content-length"]
    return StreamingResponse(gen(), media_type=media_type, headers=out)


def stream_mp3(url: str, headers: dict, filename: str):
    """Tách audio từ video bằng ffmpeg và stream ra MP3."""
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        raise HTTPException(501, "Server chưa có ffmpeg nên không xuất được MP3.")

    headers = dict(headers)
    ua = headers.pop("User-Agent", "Mozilla/5.0")
    hdr = "".join(f"{k}: {v}\r\n" for k, v in headers.items())
    cmd = [
        exe, "-hide_banner", "-loglevel", "error",
        "-user_agent", ua, "-headers", hdr,
        "-i", url, "-vn", "-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3", "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    first = proc.stdout.read(CHUNK)
    if not first:
        proc.kill()
        proc.wait()
        raise HTTPException(502, "Không tách được audio từ video này.")

    def gen():
        try:
            yield first
            while True:
                chunk = proc.stdout.read(CHUNK)
                if not chunk:
                    break
                yield chunk
        finally:
            proc.kill()
            proc.wait()

    return StreamingResponse(
        gen(),
        media_type="audio/mpeg",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/download")
def download(url: str, kind: str = Query("video", pattern="^(video|audio)$"), inline: int = 0):
    if not is_tiktok_url(url):
        raise HTTPException(400, "Không phải link TikTok hợp lệ.")

    try:
        if kind == "video":
            info, cookie = extract(url, VIDEO_FORMAT)
            ext = info.get("ext") or "mp4"
            return stream_remote(
                info["url"], build_headers(info, cookie),
                "video/mp4" if ext == "mp4" else f"video/{ext}",
                f"tiktok_{info.get('id', 'video')}.{ext}",
                inline=bool(inline),
            )

        # kind == "audio": thử luồng audio riêng trước
        try:
            info, cookie = extract(url, "ba")
            ext = info.get("ext") or "m4a"
            return stream_remote(
                info["url"], build_headers(info, cookie),
                "audio/mpeg" if ext == "mp3" else f"audio/{ext}",
                f"tiktok_{info.get('id', 'audio')}.{ext}",
            )
        except yt_dlp.utils.DownloadError:
            # không có audio-only -> tách từ video bằng ffmpeg
            info, cookie = extract(url, VIDEO_FORMAT)
            return stream_mp3(
                info["url"], build_headers(info, cookie),
                f"tiktok_{info.get('id', 'audio')}.mp3",
            )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Tải thất bại: {str(e).replace('ERROR: ', '')[:150]}")


@app.get("/")
def index():
    # Thường CDN đã phục vụ public/index.html; route này chỉ là dự phòng
    page = Path(__file__).resolve().parent.parent / "public" / "index.html"
    if not page.exists():
        raise HTTPException(404, "Không tìm thấy giao diện.")
    return FileResponse(page)


@app.get("/{name}")
def static_file(name: str):
    # Dự phòng: phục vụ style.css, script.js... trong public/ nếu CDN không tự phục vụ
    public = (Path(__file__).resolve().parent.parent / "public").resolve()
    f = (public / name).resolve()
    if f.parent != public or not f.is_file():
        raise HTTPException(404, "Not Found")
    return FileResponse(f)
