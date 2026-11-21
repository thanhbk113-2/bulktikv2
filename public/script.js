const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let results = [];

// ================= CHUYỂN TAB =================
function switchTab(tab) {
  const isTikTok = tab === "tiktok";
  $("tabBtnTikTok").classList.toggle("active", isTikTok);
  $("tabBtnTikTok").setAttribute("aria-selected", String(isTikTok));
  $("tabBtnGif").classList.toggle("active", !isTikTok);
  $("tabBtnGif").setAttribute("aria-selected", String(!isTikTok));
  $("tabTikTok").hidden = !isTikTok;
  $("tabGif").hidden = isTikTok;
}
$("tabBtnTikTok").onclick = () => switchTab("tiktok");
$("tabBtnGif").onclick = () => switchTab("gif");

// ================= TAB 1: TIKTOK DOWNLOADER =================
// Tách link kể cả khi bị dính liền nhau (dừng trước chữ "http" kế tiếp)
function parseLinks() {
  const found =
    $("links").value.match(/https?:\/\/.+?(?=https?:\/\/|\s|$)/g) || [];
  return [...new Set(found.map((s) => s.trim()))];
}
// Tự xuống dòng khi có link dính nhau
function autoBreak() {
  const ta = $("links");
  const fixed = ta.value.replace(/(\S)(?=https?:\/\/)/g, "$1\n");
  if (fixed !== ta.value) {
    ta.value = fixed;
    ta.selectionStart = ta.selectionEnd = fixed.length;
  }
}
function updateCounter() {
  $("counter").textContent = `Entered ${parseLinks().length} links`;
}
$("links").addEventListener("input", () => {
  autoBreak();
  updateCounter();
});
$("links").addEventListener("paste", () =>
  setTimeout(() => {
    autoBreak();
    updateCounter();
  }, 0),
);
$("clear").onclick = () => {
  $("links").value = "";
  $("grid").innerHTML = "";
  $("progress").textContent = "";
  results = [];
  updateCounter();
};

// Hiện thông báo ngắn trên chính nút, rồi trả lại chữ cũ
function flashLabel(el, text, ms = 1500) {
  if (!el._label) el._label = el.textContent;
  el.textContent = text;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.textContent = el._label), ms);
}

// Dán đoạn văn bản vừa copy vào ô link
$("pasteClip").onclick = async () => {
  const btn = $("pasteClip");
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) return flashLabel(btn, "⚠ Clipboard trống");
    const ta = $("links");
    ta.value = ta.value.trim() ? ta.value.trimEnd() + "\n" + text : text;
    autoBreak();
    updateCounter();
    flashLabel(btn, "✅ Đã dán");
  } catch (e) {
    flashLabel(btn, "❌ Bị chặn, hãy dán thủ công", 2500);
    $("links").focus();
  }
};

// Copy tất cả link đang có trong ô
$("copyLinks").onclick = async () => {
  const btn = $("copyLinks");
  const links = parseLinks();
  if (!links.length) return flashLabel(btn, "⚠ Chưa có link");
  const ok = await copyText(links.join("\n"));
  flashLabel(
    btn,
    ok ? `✅ Đã copy ${links.length} link` : "❌ Không copy được",
  );
};

// ===== Gọi backend (yt-dlp trên Vercel) =====
async function resolveBatch(urls) {
  let r, j;
  try {
    r = await fetch("/api/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    throw new Error("Không kết nối được máy chủ: " + e.message);
  }
  if (!r.ok) throw new Error(j.detail || `Máy chủ trả lỗi HTTP ${r.status}`);
  return j.items || [];
}

async function fetchInfo(url) {
  const items = await resolveBatch([url]);
  const it = items[0];
  if (!it || !it.ok)
    throw new Error((it && it.error) || "Không lấy được video");
  return {
    id: it.id,
    url: it.url || url,
    title: it.title || "TikTok video",
    cover: it.thumbnail || "",
  };
}

const dlUrl = (info, kind, inline) =>
  `/api/download?url=${encodeURIComponent(info.url)}&kind=${kind}` +
  (inline ? "&inline=1" : "");

// Tải file qua backend: hiện spinner + tiến độ trên nút, báo kết quả ngay trên nút
async function saveFile(url, name, btn) {
  if (btn.classList.contains("loading")) return;
  const ic = btn.querySelector(".ic");
  const lb = btn.querySelector(".lb");
  if (!btn.dataset.ic) {
    btn.dataset.ic = ic.textContent;
    btn.dataset.lb = lb.textContent;
  }
  clearTimeout(btn._t);
  btn.classList.remove("bad");
  btn.classList.add("loading");
  ic.textContent = "";
  lb.textContent = "Đang tải…";
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.detail || "HTTP " + res.status);
    }
    const total = +res.headers.get("content-length") || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      lb.textContent = total
        ? `Đang tải… ${Math.min(99, Math.floor((got * 100) / total))}%`
        : `Đang tải… ${(got / 1048576).toFixed(1)} MB`;
    }
    if (!got) throw new Error("File rỗng");
    const blob = new Blob(chunks, {
      type: res.headers.get("content-type") || "",
    });
    const cd = res.headers.get("content-disposition") || "";
    const m = /filename="?([^";]+)"?/.exec(cd);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    btn.classList.remove("loading");
    ic.textContent = "✅";
    lb.textContent = "Đã tải xong";
  } catch (e) {
    btn.classList.remove("loading");
    btn.classList.add("bad");
    ic.textContent = "❌";
    lb.textContent = String(e.message).slice(0, 80);
  }
  btn._t = setTimeout(() => {
    btn.classList.remove("bad");
    ic.textContent = btn.dataset.ic;
    lb.textContent = btn.dataset.lb;
  }, 2500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_) {}
    ta.remove();
    return ok;
  }
}

// Nối thêm nội dung (hashtag...) vào tiêu đề gốc
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
const composeCap = (title) => {
  const x = $("capSuffix").value.trim();
  if (!x) return title;
  let base = title.trim();
  if ($("capModeReplace").checked && /#[\p{L}\p{N}_]+/u.test(x)) {
    base = base.replace(HASHTAG_RE, " ").replace(/\s+/g, " ").trim();
  }
  return base ? `${base} ${x}` : x;
};
$("capSuffix").value = localStorage.getItem("capSuffix") || "";
if (localStorage.getItem("capMode") === "replace")
  $("capModeReplace").checked = true;
document.querySelectorAll('input[name="capMode"]').forEach((el) =>
  el.addEventListener("change", () => {
    localStorage.setItem(
      "capMode",
      $("capModeReplace").checked ? "replace" : "append",
    );
    refreshCaps();
  }),
);
$("capSuffix").oninput = () => {
  localStorage.setItem("capSuffix", $("capSuffix").value);
  refreshCaps();
};
function refreshCaps() {
  results.forEach((r) => {
    if (!r.capEl || r.capEl.value !== r.autoCap) return;
    r.capEl.value = r.autoCap = composeCap(r.title);
  });
}

function addCard(info) {
  const div = document.createElement("div");
  div.className = "card";
  div.innerHTML = `
    <div class="thumb"><video controls preload="none" playsinline></video></div>
    <div class="info">
      <div class="title"></div>
      <button class="copy" type="button">📋 Copy tiêu đề</button>
      <button class="dl" data-t="video"><span class="ic">🎬</span><span class="lb">MP4 (no watermark)</span></button>
      <button class="dl" data-t="audio"><span class="ic">🎵</span><span class="lb">Download MP3 audio</span></button>
      <textarea class="cap" placeholder="Nhập phụ đề / nội dung bài đăng..."></textarea>
      <button class="copy copy-new" type="button">📋 Copy tiêu đề đã thay thế</button>
    </div>`;
  div.querySelector(".title").textContent = info.title;
  const video = div.querySelector("video");
  if (info.cover) video.poster = info.cover;
  video.src = dlUrl(info, "video", true);

  const cap = div.querySelector(".cap");
  info.capEl = cap;
  cap.value = info.autoCap = composeCap(info.title);

  const bindCopy = (btn, label, getText) => {
    btn.onclick = async () => {
      const ok = await copyText(getText());
      btn.textContent = ok ? "✅ Đã copy" : "❌ Không copy được";
      btn.classList.toggle("ok", ok);
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("ok");
      }, 1500);
    };
  };
  bindCopy(
    div.querySelector(".copy:not(.copy-new)"),
    "📋 Copy tiêu đề",
    () => info.title,
  );
  bindCopy(
    div.querySelector(".copy-new"),
    "📋 Copy tiêu đề đã thay thế",
    () => cap.value.trim() || composeCap(info.title),
  );

  const base = "tiktok_" + (info.id || Date.now());
  const vBtn = div.querySelector('[data-t="video"]');
  const aBtn = div.querySelector('[data-t="audio"]');
  vBtn.onclick = () => saveFile(dlUrl(info, "video"), base + ".mp4", vBtn);
  aBtn.onclick = () => saveFile(dlUrl(info, "audio"), base + ".mp3", aBtn);
  $("grid").appendChild(div);
}

function addError(url, msg) {
  const div = document.createElement("div");
  div.className = "card err";
  div.innerHTML = `<div class="msg"></div>`;
  div.querySelector(".msg").textContent = `Lỗi: ${msg}\n${url}`;
  $("grid").appendChild(div);
}

$("go").onclick = async () => {
  autoBreak();
  updateCounter();
  const links = parseLinks();
  if (!links.length) {
    $("progress").textContent = "Hãy dán ít nhất 1 link TikTok.";
    return;
  }
  $("go").disabled = true;
  $("grid").innerHTML = "";
  results = [];

  const BATCH_SIZE = 5;
  const chunks = [];
  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    chunks.push(links.slice(i, i + BATCH_SIZE));
  }

  let processedCount = 0;
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    $("progress").textContent = `Đang xử lý ${processedCount + 1}–${Math.min(processedCount + chunk.length, links.length)}/${links.length}...`;
    try {
      const items = await resolveBatch(chunk);
      for (const it of items) {
        if (it && it.ok) {
          const info = {
            id: it.id,
            url: it.url,
            title: it.title || "TikTok video",
            cover: it.thumbnail || "",
          };
          results.push(info);
          addCard(info);
        } else {
          addError(it ? it.url : "", (it && it.error) || "Không lấy được video");
        }
      }
    } catch (e) {
      for (const u of chunk) {
        addError(u, e.message);
      }
    }
    processedCount += chunk.length;
    if (c < chunks.length - 1) {
      await sleep(300);
    }
  }

  $("progress").textContent = `Xong: ${results.length}/${links.length} video.`;
  $("go").disabled = false;
};

// ================= TAB 2: GIF TO MP4 =================
const gifState = {
  file: null, // File object nếu upload từ máy
  url: "", // URL nếu tải qua link
  blobUrl: "",
  loopDuration: 1.0, // Thời lượng 1 vòng lặp (giây)
  detectedColors: [], // Danh sách màu {r, g, b, hex, count} có trong GIF
  cornerColor: "#FFFFFF",
  hasTransparency: false,
  resultBlobUrl: "",
};

const rgbToHex = (r, g, b) =>
  "#" +
  [r, g, b]
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s, v };
}

function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

// Đọc tổng thời lượng 1 vòng lặp trực tiếp từ byte nhị phân file GIF
function parseGifDurationFromBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 13) return 1.0;
  let pos = 6; // bỏ qua header GIF87a / GIF89a
  const packed = bytes[pos + 4];
  pos += 7; // Logical Screen Descriptor
  if (packed & 0x80) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    pos += gctSize;
  }

  let totalCentiseconds = 0;
  let frameCount = 0;
  let lastDelay = 10;

  while (pos < bytes.length) {
    const blockType = bytes[pos++];
    if (blockType === 0x3b) break; // Trailer
    if (blockType === 0x21) {
      // Extension Introducer
      const label = bytes[pos++];
      if (label === 0xf9 && pos + 5 < bytes.length) {
        // Graphic Control Extension
        const blockSize = bytes[pos];
        if (blockSize === 4) {
          const delay = bytes[pos + 2] | (bytes[pos + 3] << 8);
          lastDelay = delay < 2 ? 10 : delay;
        }
      }
      // Bỏ qua sub-blocks
      while (pos < bytes.length) {
        const subLen = bytes[pos++];
        if (!subLen) break;
        pos += subLen;
      }
    } else if (blockType === 0x2c) {
      // Image Descriptor
      frameCount++;
      totalCentiseconds += lastDelay;
      lastDelay = 10;
      if (pos + 9 > bytes.length) break;
      const lPacked = bytes[pos + 8];
      pos += 9;
      if (lPacked & 0x80) {
        const lctSize = 3 * (1 << ((lPacked & 0x07) + 1));
        pos += lctSize;
      }
      pos++; // LZW minimum code size
      while (pos < bytes.length) {
        const subLen = bytes[pos++];
        if (!subLen) break;
        pos += subLen;
      }
    } else {
      break;
    }
  }
  if (!frameCount) return 1.0;
  return Math.max(0.1, Number((totalCentiseconds / 100).toFixed(2)));
}

// Quét bảng màu thực tế của GIF qua Canvas
function analyzeGifPixels(imgEl) {
  const canvas = document.createElement("canvas");
  const maxDim = 180;
  const scale = Math.min(
    1,
    maxDim / Math.max(imgEl.naturalWidth || 1, imgEl.naturalHeight || 1),
  );
  const w = Math.max(1, Math.round((imgEl.naturalWidth || 100) * scale));
  const h = Math.max(1, Math.round((imgEl.naturalHeight || 100) * scale));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(imgEl, 0, 0, w, h);

  const data = ctx.getImageData(0, 0, w, h).data;
  const buckets = new Map();
  let transparentPixels = 0;

  // Lấy màu 4 góc để biết màu nền nếu GIF không trong suốt
  const corners = [
    0,
    (w - 1) * 4,
    (h - 1) * w * 4,
    ((h - 1) * w + (w - 1)) * 4,
  ];
  let cR = 0,
    cG = 0,
    cB = 0,
    cValid = 0;
  corners.forEach((idx) => {
    if (data[idx + 3] > 200) {
      cR += data[idx];
      cG += data[idx + 1];
      cB += data[idx + 2];
      cValid++;
    }
  });
  const cornerColor = cValid
    ? rgbToHex(cR / cValid, cG / cValid, cB / cValid)
    : "#FFFFFF";

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) {
      transparentPixels++;
      continue;
    }
    // Gom nhóm màu theo bước 16 để đại diện chính xác bảng màu trong ảnh
    const r = Math.min(255, Math.round(data[i] / 16) * 16);
    const g = Math.min(255, Math.round(data[i + 1] / 16) * 16);
    const b = Math.min(255, Math.round(data[i + 2] / 16) * 16);
    const key = `${r},${g},${b}`;
    const entry = buckets.get(key);
    if (entry) entry.count++;
    else buckets.set(key, { r, g, b, hex: rgbToHex(r, g, b), count: 1 });
  }

  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  return {
    colors: sorted.slice(0, 24),
    hasTransparency: transparentPixels > w * h * 0.03,
    cornerColor,
  };
}

// Tính khoảng cách nhận thức màu giữa ứng viên Chroma Key và màu trong GIF
function colorDistanceScore(cand, existingColors) {
  if (!existingColors.length) return 999;
  const cHsv = rgbToHsv(cand.r, cand.g, cand.b);
  let minScore = Infinity;

  for (const col of existingColors) {
    // Khoảng cách Euclidean có trọng số mắt người
    const dr = cand.r - col.r;
    const dg = cand.g - col.g;
    const db = cand.b - col.b;
    const rgbDist = Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db);

    // Phạt thêm nếu màu trong GIF có độ bão hòa (không phải trắng/đen/xám) và trùng góc Hue
    const eHsv = rgbToHsv(col.r, col.g, col.b);
    let huePenalty = 0;
    if (eHsv.s > 0.25 && eHsv.v > 0.2) {
      const dh = Math.min(
        Math.abs(cHsv.h - eHsv.h),
        360 - Math.abs(cHsv.h - eHsv.h),
      );
      if (dh < 45) huePenalty = (45 - dh) * 4;
    }

    const score = rgbDist - huePenalty;
    if (score < minScore) minScore = score;
  }
  return minScore;
}

// Tự động chọn màu Chroma Key không trùng với các màu trong GIF
function pickDistinctChromaColor() {
  // Danh sách các màu nền Chroma Key chuẩn & rực rỡ (dễ tách key nhất)
  const presets = [
    { hex: "#00FF00", name: "Xanh lá Chroma chuẩn" },
    { hex: "#FF00FF", name: "Hồng Magenta Chroma" },
    { hex: "#00E5FF", name: "Xanh Cyan sáng" },
    { hex: "#FFFF00", name: "Vàng chanh tươi" },
    { hex: "#FF5500", name: "Cam Neon" },
    { hex: "#7B00FF", name: "Tím điện" },
    { hex: "#0055FF", name: "Xanh dương Chroma" },
    { hex: "#FF0066", name: "Hồng cánh sen đậm" },
  ];

  const candidates = presets.map((p) => ({
    ...p,
    ...hexToRgb(p.hex),
  }));

  // Bổ sung thêm 36 màu bão hòa cao trải đều vòng tròn 360 độ
  for (let h = 0; h < 360; h += 10) {
    const rgb = hsvToRgb(h, 0.95, 1.0);
    candidates.push({
      ...rgb,
      hex: rgbToHex(rgb.r, rgb.g, rgb.b),
      name: `Màu tự động (Hue ${h}°)`,
    });
  }

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const cand of candidates) {
    const score = colorDistanceScore(cand, gifState.detectedColors);
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }

  setChromaColor(best.hex);
  const topExisting = gifState.detectedColors
    .slice(0, 4)
    .map((c) => c.hex)
    .join(", ");
  $("gifColorReason").textContent = topExisting
    ? `Đã tránh các màu trong GIF (${topExisting}…) → Đề xuất: ${best.name} (${best.hex})`
    : `Đề xuất mặc định: ${best.name} (${best.hex})`;
}

function setChromaColor(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const upper = hex.toUpperCase();
  $("gifBgColor").value = upper;
  $("gifBgHex").value = upper;
  $("gifStage").style.backgroundColor = upper;
}

$("gifBgColor").oninput = (e) => setChromaColor(e.target.value);
$("gifBgHex").oninput = (e) => {
  let v = e.target.value.trim();
  if (!v.startsWith("#")) v = "#" + v;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) setChromaColor(v);
};
$("gifAutoColor").onclick = () => pickDistinctChromaColor();

// Chế độ fill nền Chroma Key
document.querySelectorAll('input[name="gifBgMode"]').forEach((el) => {
  el.onchange = () => {
    const isForce =
      document.querySelector('input[name="gifBgMode"]:checked').value ===
      "force_chroma";
    $("forceChromaOpts").hidden = !isForce;
  };
});
$("gifPickCornerColor").onclick = () => {
  $("gifKeySrcColor").value = gifState.cornerColor;
};
$("gifKeySim").oninput = (e) => {
  $("gifKeySimVal").textContent = Number(e.target.value).toFixed(2);
};

// Đồng bộ 2 chiều Number of loop <-> Giây
function syncFromLoops() {
  const loops = Math.max(
    1,
    Math.min(60, Math.round(Number($("gifLoops").value) || 1)),
  );
  $("gifLoops").value = loops;
  const totalSec = Number((loops * gifState.loopDuration).toFixed(2));
  $("gifSeconds").value = totalSec;
  $("gifSyncHint").textContent =
    `${loops} vòng × ${gifState.loopDuration}s/vòng = ${totalSec} giây.`;
}

function syncFromSeconds() {
  const sec = Math.max(
    0.2,
    Math.min(180, Number($("gifSeconds").value) || gifState.loopDuration),
  );
  const loops = Math.max(
    1,
    Math.min(60, Math.round(sec / gifState.loopDuration)),
  );
  $("gifLoops").value = loops;
  const actualLoopSec = Number((loops * gifState.loopDuration).toFixed(2));
  $("gifSyncHint").textContent =
    `Cần ${sec}s → tự chọn ${loops} vòng lặp (tổng ~${actualLoopSec}s).`;
}

$("gifLoops").oninput = syncFromLoops;
$("gifSeconds").oninput = syncFromSeconds;

document.querySelectorAll(".chip-btn").forEach((btn) => {
  btn.onclick = () => {
    $("gifSeconds").value = btn.dataset.sec;
    syncFromSeconds();
  };
});

// Nạp & phân tích GIF (từ File hoặc ArrayBuffer)
function loadGifBuffer(arrayBuffer, displayName, metaFromHeader = null) {
  if (gifState.blobUrl) URL.revokeObjectURL(gifState.blobUrl);
  const blob = new Blob([arrayBuffer], { type: "image/gif" });
  const blobUrl = URL.createObjectURL(blob);
  gifState.blobUrl = blobUrl;

  const duration =
    metaFromHeader && metaFromHeader.duration > 0
      ? metaFromHeader.duration
      : parseGifDurationFromBytes(arrayBuffer);
  gifState.loopDuration = duration;

  const img = $("gifPreviewImg");
  img.onload = () => {
    $("gifPlaceholder").hidden = true;
    img.hidden = false;

    const analysis = analyzeGifPixels(img);
    gifState.detectedColors = analysis.colors;
    gifState.hasTransparency = analysis.hasTransparency;
    gifState.cornerColor = analysis.cornerColor;
    $("gifKeySrcColor").value = analysis.cornerColor;

    // Hiển thị các chấm màu tìm thấy trong GIF
    const dots = $("gifPaletteDots");
    dots.innerHTML = "";
    analysis.colors.slice(0, 12).forEach((c) => {
      const dot = document.createElement("span");
      dot.className = "color-dot";
      dot.style.backgroundColor = c.hex;
      dot.title = c.hex;
      dots.appendChild(dot);
    });
    $("gifPaletteWrap").hidden = analysis.colors.length === 0;

    // Tự động chọn chế độ nền phù hợp (nếu GIF có nền đặc thì gợi ý force_chroma)
    const modeRadio = document.querySelector(
      `input[name="gifBgMode"][value="${
        analysis.hasTransparency ? "transparent_only" : "force_chroma"
      }"]`,
    );
    if (modeRadio) {
      modeRadio.checked = true;
      $("forceChromaOpts").hidden = analysis.hasTransparency;
    }

    // Tự chọn màu nền không trùng
    pickDistinctChromaColor();

    // Cập nhật thông tin & đồng bộ loop/giây
    $("gifMetaInfo").textContent =
      `Kích thước: ${img.naturalWidth}×${img.naturalHeight}px | 1 vòng: ${duration}s | ${
        analysis.hasTransparency
          ? "Có nền trong suốt"
          : "Nền đặc (" + analysis.cornerColor + ")"
      }`;
    syncFromLoops();
    $("gifStatus").textContent = `✅ Đã sẵn sàng: ${displayName}`;
  };
  img.src = blobUrl;
}

// Xử lý chọn file GIF từ máy
async function handleGifFileSelect(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".gif") && file.type !== "image/gif") {
    $("gifStatus").textContent = "❌ Vui lòng chọn đúng định dạng file .GIF";
    return;
  }
  gifState.file = file;
  gifState.url = "";
  $("gifFileName").textContent = file.name;
  $("gifStatus").textContent = "⏳ Đang phân tích màu và thời lượng GIF...";
  const buf = await file.arrayBuffer();
  loadGifBuffer(buf, file.name);
}

$("gifFile").onchange = (e) => handleGifFileSelect(e.target.files[0]);

// Kéo thả file vào dropzone
const dz = $("gifDropzone");
["dragenter", "dragover"].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.add("dragover");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
  }),
);
dz.addEventListener("drop", (e) => {
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) handleGifFileSelect(f);
});

// Tải GIF từ URL
$("gifLoadUrl").onclick = async () => {
  const url = $("gifUrl").value.trim();
  if (!url) {
    $("gifStatus").textContent = "⚠ Hãy dán link ảnh GIF trước.";
    return;
  }
  $("gifLoadUrl").disabled = true;
  $("gifStatus").textContent = "⏳ Đang tải GIF từ link và quét màu...";
  try {
    const res = await fetch(`/api/gif-proxy?url=${encodeURIComponent(url)}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.detail || `HTTP ${res.status}`);
    }
    const durHeader = parseFloat(res.headers.get("X-Gif-Duration") || "0");
    const buf = await res.arrayBuffer();
    gifState.file = null;
    gifState.url = url;
    $("gifFileName").textContent = "Bấm chọn file .GIF hoặc kéo thả vào đây";
    loadGifBuffer(buf, url.split("/").pop().split("?")[0] || "remote.gif", {
      duration: durHeader,
    });
  } catch (e) {
    $("gifStatus").textContent = `❌ ${e.message}`;
  } finally {
    $("gifLoadUrl").disabled = false;
  }
};

// Gửi sang server để xuất MP4
$("gifConvertBtn").onclick = async () => {
  if (!gifState.file && !gifState.url) {
    $("gifConvertStatus").textContent =
      "⚠ Hãy chọn file GIF hoặc tải GIF từ link trước.";
    return;
  }
  const btn = $("gifConvertBtn");
  btn.disabled = true;
  $("gifConvertStatus").textContent =
    "⏳ Đang render MP4 với nền Chroma Key...";
  $("gifResultBox").hidden = true;

  try {
    const fd = new FormData();
    if (gifState.file) fd.append("file", gifState.file);
    else fd.append("url", gifState.url);

    const bgColor = $("gifBgHex").value.trim();
    const bgMode = document.querySelector(
      'input[name="gifBgMode"]:checked',
    ).value;
    const loops = Math.max(
      1,
      Math.min(60, Math.round(Number($("gifLoops").value) || 1)),
    );
    const targetSec = Number($("gifSeconds").value) || "";

    fd.append("bg_color", bgColor);
    fd.append("bg_mode", bgMode);
    fd.append("key_source_color", $("gifKeySrcColor").value);
    fd.append("key_similarity", $("gifKeySim").value);
    fd.append("loops", String(loops));
    if (targetSec) fd.append("target_seconds", String(targetSec));

    const res = await fetch("/api/gif-to-mp4", { method: "POST", body: fd });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.detail || `HTTP ${res.status}`);
    }

    const blob = await res.blob();
    if (gifState.resultBlobUrl) URL.revokeObjectURL(gifState.resultBlobUrl);
    const outUrl = URL.createObjectURL(blob);
    gifState.resultBlobUrl = outUrl;

    const cd = res.headers.get("content-disposition") || "";
    const m = /filename="?([^";]+)"?/.exec(cd);
    const fileName = m ? m[1] : `chroma_${bgColor.replace("#", "")}.mp4`;

    // Tự động tải xuống trình duyệt + hiện preview MP4 bên dưới
    const a = document.createElement("a");
    a.href = outUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();

    $("gifResultVideo").src = outUrl;
    $("gifDownloadLink").href = outUrl;
    $("gifDownloadLink").download = fileName;
    $("gifResultBox").hidden = false;
    $("gifConvertStatus").textContent =
      `✅ Đã chuyển đổi & tải về: ${fileName}`;
  } catch (e) {
    $("gifConvertStatus").textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
};

// ================= Văn bản / link lưu sẵn =================
const NOTES_KEY = "savedNotes";
const loadNotes = () => {
  try {
    return JSON.parse(localStorage.getItem(NOTES_KEY)) || [];
  } catch (e) {
    return [];
  }
};
const storeNotes = (arr) =>
  localStorage.setItem(NOTES_KEY, JSON.stringify(arr));

function renderNotes() {
  const list = $("noteList");
  list.innerHTML = "";
  loadNotes().forEach((text, i) => {
    const item = document.createElement("div");
    item.className = "note-item";

    const txt = document.createElement("div");
    txt.className = "txt";
    txt.textContent = text;

    const acts = document.createElement("div");
    acts.className = "acts";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy";
    copyBtn.textContent = "📋 Copy";
    copyBtn.onclick = async () => {
      const ok = await copyText(text);
      copyBtn.textContent = ok ? "✅ Đã copy" : "❌ Không copy được";
      copyBtn.classList.toggle("ok", ok);
      clearTimeout(copyBtn._t);
      copyBtn._t = setTimeout(() => {
        copyBtn.textContent = "📋 Copy";
        copyBtn.classList.remove("ok");
      }, 1500);
    };

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "note-del";
    delBtn.textContent = "🗑 Xoá";
    delBtn.onclick = () => {
      const arr = loadNotes();
      arr.splice(i, 1);
      storeNotes(arr);
      renderNotes();
    };

    acts.append(copyBtn, delBtn);
    item.append(txt, acts);
    list.appendChild(item);
  });
}

$("noteSave").onclick = () => {
  const v = $("noteInput").value.trim();
  if (!v) return;
  const arr = loadNotes();
  arr.push(v);
  storeNotes(arr);
  $("noteInput").value = "";
  renderNotes();
};

renderNotes();
const togglePanel = (force) => {
  const p = $("notePanel");
  const open =
    typeof force === "boolean" ? force : !p.classList.contains("open");
  p.classList.toggle("open", open);
  $("noteFab").textContent = open ? "✕" : "📌";
};
$("noteFab").onclick = () => togglePanel();
$("noteClose").onclick = () => togglePanel(false);

// ===== Sao lưu / khôi phục =====
const BACKUP_KEYS = ["savedNotes", "capSuffix", "capMode"];
const bkSay = (t, ok = true) => {
  $("bkMsg").textContent = t;
  $("bkMsg").style.color = ok ? "#188038" : "#d93025";
};

$("bkExport").onclick = () => {
  const data = {};
  BACKUP_KEYS.forEach((k) => {
    const v = localStorage.getItem(k);
    if (v !== null) data[k] = v;
  });
  const payload = {
    app: "tiktok-bulk",
    version: 1,
    exportedAt: new Date().toISOString(),
    data,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tiktok-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  bkSay("✅ Đã xuất file. Hãy cất file ở nơi an toàn.");
};

$("bkImport").onclick = () => $("bkFile").click();

$("bkFile").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!j || typeof j.data !== "object" || !j.data) throw new Error();
    if (j.data.savedNotes) {
      const n = JSON.parse(j.data.savedNotes);
      if (!Array.isArray(n)) throw new Error();
    }
    if (!confirm("Nhập file sẽ ghi đè ghi chú và cài đặt hiện tại. Tiếp tục?"))
      return;

    BACKUP_KEYS.forEach((k) => {
      if (typeof j.data[k] === "string") localStorage.setItem(k, j.data[k]);
    });
    renderNotes();
    $("capSuffix").value = localStorage.getItem("capSuffix") || "";
    $("capModeReplace").checked = localStorage.getItem("capMode") === "replace";
    $("capModeAppend").checked = !$("capModeReplace").checked;
    refreshCaps();
    bkSay("✅ Đã nhập xong.");
  } catch (err) {
    bkSay("❌ File không hợp lệ.", false);
  } finally {
    e.target.value = "";
  }
};
