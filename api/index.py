"""TikTok bulk downloader & GIF to MP4 converter - bản chạy trên Vercel."""
import io
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlparse

import httpx
import yt_dlp
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from PIL import Image, ImageSequence
from pydantic import BaseModel
from starlette.background import BackgroundTask

MAX_LINKS = 5
MAX_GIF_BYTES = 20 * 1024 * 1024  # 20MB
MAX_LOOPS = 60
CHUNK = 64 * 1024
PROXY = os.environ.get("YDL_PROXY")  # tuỳ chọn: http://user:pass@host:port

app = FastAPI(title="TikTok bulk downloader & GIF to MP4")

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
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
# Bỏ format "download" (bản có watermark), ưu tiên h264 để phát được mọi nơi
VIDEO_FORMAT = "b[vcodec^=h264][format_id!=download]/b[format_id!=download]/b"


def is_tiktok_url(url: str) -> bool:
    p = urlparse(url.strip())
    return p.scheme in ("http", "https") and bool(TIKTOK_HOST.match(p.hostname or ""))


def is_http_url(url: str) -> bool:
    p = urlparse(url.strip())
    return p.scheme in ("http", "https") and bool(p.hostname)


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


# ===== GIF TO MP4 =====

def fetch_gif_bytes(url: str) -> bytes:
    if not is_http_url(url):
        raise HTTPException(400, "Link GIF không hợp lệ.")
    parsed = urlparse(url)
    referer = f"{parsed.scheme}://{parsed.hostname}/"
    try:
        with httpx.Client(timeout=20.0, follow_redirects=True) as client:
            r = client.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Referer": referer,
                },
            )
            r.raise_for_status()
            data = r.content
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Không tải được GIF từ link: {str(e)[:120]}")

    if len(data) > MAX_GIF_BYTES:
        raise HTTPException(400, "File GIF vượt quá giới hạn 20MB.")
    if not (data[:6] in (b"GIF87a", b"GIF89a")):
        raise HTTPException(400, "Nội dung từ link không phải định dạng GIF hợp lệ.")
    return data


def inspect_gif(data: bytes) -> dict:
    """Đo kích thước, số frame và tổng thời lượng 1 vòng lặp của GIF."""
    try:
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
            frames = 0
            total_ms = 0
            for frame in ImageSequence.Iterator(im):
                frames += 1
                delay = int(frame.info.get("duration", 100) or 100)
                if delay < 10:
                    delay = 100
                total_ms += delay
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Không đọc được cấu trúc file GIF: {str(e)[:120]}")

    if frames == 0:
        raise HTTPException(400, "GIF không có khung hình nào.")
    loop_sec = max(0.1, round(total_ms / 1000.0, 3))
    return {"width": w, "height": h, "frames": frames, "loop_duration": loop_sec}


@app.get("/api/gif-proxy")
def gif_proxy(url: str):
    """Tải hộ GIF từ URL ngoài để frontend vượt CORS, phân tích màu & đo thời lượng."""
    data = fetch_gif_bytes(url.strip())
    meta = inspect_gif(data)
    return Response(
        data,
        media_type="image/gif",
        headers={
            "Cache-Control": "public, max-age=1800",
            "X-Gif-Duration": str(meta["loop_duration"]),
            "X-Gif-Frames": str(meta["frames"]),
            "X-Gif-Size": f"{meta['width']}x{meta['height']}",
        },
    )


@app.post("/api/gif-to-mp4")
async def gif_to_mp4(
    file: UploadFile | None = File(None),
    url: str = Form(""),
    bg_color: str = Form("#00FF00"),
    bg_mode: str = Form("transparent_only"),  # transparent_only | force_chroma
    key_source_color: str = Form("#FFFFFF"),
    key_similarity: float = Form(0.12),
    loops: int = Form(1),
    target_seconds: float | None = Form(None),
):
    """Chuyển GIF sang MP4 H.264 với màu nền Chroma Key và số vòng lặp/giây tuỳ chỉnh."""
    if file is not None and file.filename:
        raw = await file.read()
        if len(raw) > MAX_GIF_BYTES:
            raise HTTPException(400, "File GIF vượt quá giới hạn 20MB.")
        if raw[:6] not in (b"GIF87a", b"GIF89a"):
            raise HTTPException(400, "File tải lên không phải định dạng GIF hợp lệ.")
        stem = Path(file.filename).stem or "converted"
    elif url.strip():
        raw = fetch_gif_bytes(url.strip())
        stem = Path(urlparse(url.strip()).path).stem or "converted"
    else:
        raise HTTPException(400, "Hãy chọn file GIF hoặc nhập link GIF.")

    if not HEX_COLOR_RE.match(bg_color.strip()):
        raise HTTPException(400, "Mã màu nền không hợp lệ (định dạng #RRGGBB).")
    bg_hex = bg_color.strip().lstrip("#")

    if not HEX_COLOR_RE.match(key_source_color.strip()):
        key_source_color = "#FFFFFF"
    src_hex = key_source_color.strip().lstrip("#")

    if bg_mode not in ("transparent_only", "force_chroma"):
        bg_mode = "transparent_only"

    similarity = max(0.01, min(0.45, float(key_similarity)))
    loops = max(1, min(MAX_LOOPS, int(loops)))

    meta = inspect_gif(raw)
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        raise HTTPException(501, "Server chưa có ffmpeg nên không thể xuất MP4.")

    # Kích thước chẵn để yuv420p / H.264 không lỗi
    out_w = meta["width"] + (meta["width"] % 2)
    out_h = meta["height"] + (meta["height"] % 2)

    if bg_mode == "force_chroma":
        # Tách cả vùng trong suốt lẫn màu nền gốc (ví dụ nền trắng) và thay bằng bg_color
        fg_chain = (
            f"[0:v]format=rgba,"
            f"colorkey=0x{src_hex}:{similarity:.2f}:0.05,"
            f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000[fg];"
        )
    else:
        # Chỉ fill màu chroma key vào vùng trong suốt của GIF
        fg_chain = (
            f"[0:v]format=rgba,"
            f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000[fg];"
        )

    filter_complex = (
        f"color=c=0x{bg_hex}:s={out_w}x{out_h}:r=30[bg];"
        f"{fg_chain}"
        f"[bg][fg]overlay=shortest=1:format=auto,format=yuv420p[out]"
    )

    tmpdir = tempfile.mkdtemp()
    try:
        in_path = os.path.join(tmpdir, "input.gif")
        out_path = os.path.join(tmpdir, "output.mp4")
        with open(in_path, "wb") as f:
            f.write(raw)

        # -stream_loop N: lặp thêm N lần => tổng số vòng = loops => stream_loop = loops - 1
        cmd = [
            exe,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-stream_loop",
            str(loops - 1),
            "-i",
            in_path,
            "-filter_complex",
            filter_complex,
            "-map",
            "[out]",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "20",
            "-movflags",
            "+faststart",
        ]
        # Nếu người dùng nhập số giây chính xác, cắt/giữ đúng thời lượng đó
        if target_seconds is not None and target_seconds > 0:
            clamped_sec = min(180.0, max(0.2, float(target_seconds)))
            cmd.extend(["-t", f"{clamped_sec:.3f}"])

        cmd.append(out_path)

        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not os.path.exists(out_path):
            err_msg = (proc.stderr or "Lỗi ffmpeg không xác định").strip()[:200]
            raise HTTPException(502, f"Chuyển đổi MP4 thất bại: {err_msg}")

        safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "_", stem).strip("_") or "gif_chroma"
        return FileResponse(
            out_path,
            media_type="video/mp4",
            filename=f"{safe_stem}_{bg_hex}.mp4",
            background=BackgroundTask(shutil.rmtree, tmpdir, ignore_errors=True),
        )
    except Exception:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise


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