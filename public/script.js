const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let results = [];

// Tách link kể cả khi bị dính liền nhau (dừng trước chữ "http" kế tiếp)
function parseLinks() {
  const found =
    $('links').value.match(/https?:\/\/.+?(?=https?:\/\/|\s|$)/g) || [];
  return [...new Set(found.map((s) => s.trim()))];
}
// Tự xuống dòng khi có link dính nhau
function autoBreak() {
  const ta = $('links');
  const fixed = ta.value.replace(/(\S)(?=https?:\/\/)/g, '$1\n');
  if (fixed !== ta.value) {
    ta.value = fixed;
    ta.selectionStart = ta.selectionEnd = fixed.length;
  }
}
function updateCounter() {
  $('counter').textContent = `Entered ${parseLinks().length} links`;
}
$('links').addEventListener('input', () => {
  autoBreak();
  updateCounter();
});
$('links').addEventListener('paste', () =>
  setTimeout(() => {
    autoBreak();
    updateCounter();
  }, 0)
);
$('clear').onclick = () => {
  $('links').value = '';
  $('grid').innerHTML = '';
  $('progress').textContent = '';
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
$('pasteClip').onclick = async () => {
  const btn = $('pasteClip');
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) return flashLabel(btn, '⚠ Clipboard trống');
    const ta = $('links');
    ta.value = ta.value.trim() ? ta.value.trimEnd() + '\n' + text : text;
    autoBreak();
    updateCounter();
    flashLabel(btn, '✅ Đã dán');
  } catch (e) {
    // Trình duyệt chặn quyền đọc clipboard (hoặc trang không chạy qua https)
    flashLabel(btn, '❌ Bị chặn, hãy dán thủ công', 2500);
    $('links').focus();
  }
};

// Copy tất cả link đang có trong ô
$('copyLinks').onclick = async () => {
  const btn = $('copyLinks');
  const links = parseLinks();
  if (!links.length) return flashLabel(btn, '⚠ Chưa có link');
  const ok = await copyText(links.join('\n'));
  flashLabel(
    btn,
    ok ? `✅ Đã copy ${links.length} link` : '❌ Không copy được'
  );
};

// ===== Gọi backend (yt-dlp trên Vercel) =====
async function fetchInfo(url) {
  let r, j;
  try {
    r = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls: [url] }),
    });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    throw new Error('Không kết nối được máy chủ: ' + e.message);
  }
  if (!r.ok) throw new Error(j.detail || `Máy chủ trả lỗi HTTP ${r.status}`);
  const it = j.items && j.items[0];
  if (!it || !it.ok) throw new Error((it && it.error) || 'Không lấy được video');
  return {
    id: it.id,
    url,
    title: it.title || 'TikTok video',
    cover: it.thumbnail || '',
  };
}

const dlUrl = (info, kind, inline) =>
  `/api/download?url=${encodeURIComponent(info.url)}&kind=${kind}` +
  (inline ? '&inline=1' : '');

// Tải file qua backend: hiện spinner + tiến độ trên nút, báo kết quả ngay trên nút
async function saveFile(url, name, btn) {
  if (btn.classList.contains('loading')) return; // đang tải thì bỏ qua lần bấm thêm
  const ic = btn.querySelector('.ic');
  const lb = btn.querySelector('.lb');
  if (!btn.dataset.ic) {
    btn.dataset.ic = ic.textContent;
    btn.dataset.lb = lb.textContent;
  }
  clearTimeout(btn._t);
  btn.classList.remove('bad');
  btn.classList.add('loading');
  ic.textContent = ''; // vòng xoay được vẽ bằng CSS
  lb.textContent = 'Đang tải…';
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.detail || 'HTTP ' + res.status);
    }
    const total = +res.headers.get('content-length') || 0;
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
    if (!got) throw new Error('File rỗng');
    const blob = new Blob(chunks, {
      type: res.headers.get('content-type') || '',
    });
    // Lấy tên file từ server (đuôi có thể là m4a thay vì mp3)
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename="?([^";]+)"?/.exec(cd);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    btn.classList.remove('loading');
    ic.textContent = '✅';
    lb.textContent = 'Đã tải xong';
  } catch (e) {
    btn.classList.remove('loading');
    btn.classList.add('bad');
    ic.textContent = '❌';
    lb.textContent = String(e.message).slice(0, 80);
  }
  btn._t = setTimeout(() => {
    btn.classList.remove('bad');
    ic.textContent = btn.dataset.ic;
    lb.textContent = btn.dataset.lb;
  }, 2500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // Fallback cho trình duyệt cũ / không hỗ trợ Clipboard API
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {}
    ta.remove();
    return ok;
  }
}

// Nối thêm nội dung (hashtag...) vào tiêu đề gốc
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
const composeCap = (title) => {
  const x = $('capSuffix').value.trim();
  if (!x) return title;
  let base = title.trim();
  if ($('capModeReplace').checked && /#[\p{L}\p{N}_]+/u.test(x)) {
    base = base.replace(HASHTAG_RE, ' ').replace(/\s+/g, ' ').trim(); // bỏ hashtag cũ
  }
  return base ? `${base} ${x}` : x;
};
$('capSuffix').value = localStorage.getItem('capSuffix') || '';
if (localStorage.getItem('capMode') === 'replace')
  $('capModeReplace').checked = true;
document.querySelectorAll('input[name="capMode"]').forEach((el) =>
  el.addEventListener('change', () => {
    localStorage.setItem(
      'capMode',
      $('capModeReplace').checked ? 'replace' : 'append'
    );
    refreshCaps();
  })
);
$('capSuffix').oninput = () => {
  localStorage.setItem('capSuffix', $('capSuffix').value);
  refreshCaps();
};
function refreshCaps() {
  results.forEach((r) => {
    if (!r.capEl || r.capEl.value !== r.autoCap) return; // không ghi đè nội dung đã sửa tay
    r.capEl.value = r.autoCap = composeCap(r.title);
  });
}

function addCard(info) {
  const div = document.createElement('div');
  div.className = 'card';
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
  div.querySelector('.title').textContent = info.title;
  const video = div.querySelector('video');
  if (info.cover) video.poster = info.cover;
  video.src = dlUrl(info, 'video', true); // preload=none: chỉ tải khi bấm phát

  const cap = div.querySelector('.cap');
  info.capEl = cap;
  cap.value = info.autoCap = composeCap(info.title);

  // Gắn nút copy: getText() trả về nội dung cần copy tại thời điểm bấm
  const bindCopy = (btn, label, getText) => {
    btn.onclick = async () => {
      const ok = await copyText(getText());
      btn.textContent = ok ? '✅ Đã copy' : '❌ Không copy được';
      btn.classList.toggle('ok', ok);
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove('ok');
      }, 1500);
    };
  };
  bindCopy(
    div.querySelector('.copy:not(.copy-new)'),
    '📋 Copy tiêu đề',
    () => info.title
  );
  bindCopy(
    div.querySelector('.copy-new'),
    '📋 Copy tiêu đề đã thay thế',
    () => cap.value.trim() || composeCap(info.title)
  );

  const base = 'tiktok_' + (info.id || Date.now());
  const vBtn = div.querySelector('[data-t="video"]');
  const aBtn = div.querySelector('[data-t="audio"]');
  vBtn.onclick = () => saveFile(dlUrl(info, 'video'), base + '.mp4', vBtn);
  aBtn.onclick = () => saveFile(dlUrl(info, 'audio'), base + '.mp3', aBtn);
  $('grid').appendChild(div);
}

function addError(url, msg) {
  const div = document.createElement('div');
  div.className = 'card err';
  div.innerHTML = `<div class="msg"></div>`;
  div.querySelector('.msg').textContent = `Lỗi: ${msg}\n${url}`;
  $('grid').appendChild(div);
}

$('go').onclick = async () => {
  autoBreak();
  updateCounter();
  const links = parseLinks();
  if (!links.length) {
    $('progress').textContent = 'Hãy dán ít nhất 1 link TikTok.';
    return;
  }
  $('go').disabled = true;
  $('grid').innerHTML = '';
  results = [];

  for (let i = 0; i < links.length; i++) {
    $('progress').textContent = `Đang xử lý ${i + 1}/${links.length}...`;
    try {
      const info = await fetchInfo(links[i]);
      results.push(info);
      addCard(info);
    } catch (e) {
      addError(links[i], e.message);
    }
    await sleep(300);
  }

  $('progress').textContent = `Xong: ${results.length}/${links.length} video.`;
  $('go').disabled = false;
};

// ===== Văn bản / link lưu sẵn =====
const NOTES_KEY = 'savedNotes';
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
  const list = $('noteList');
  list.innerHTML = '';
  loadNotes().forEach((text, i) => {
    const item = document.createElement('div');
    item.className = 'note-item';

    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.textContent = text;

    const acts = document.createElement('div');
    acts.className = 'acts';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy';
    copyBtn.textContent = '📋 Copy';
    copyBtn.onclick = async () => {
      const ok = await copyText(text);
      copyBtn.textContent = ok ? '✅ Đã copy' : '❌ Không copy được';
      copyBtn.classList.toggle('ok', ok);
      clearTimeout(copyBtn._t);
      copyBtn._t = setTimeout(() => {
        copyBtn.textContent = '📋 Copy';
        copyBtn.classList.remove('ok');
      }, 1500);
    };

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'note-del';
    delBtn.textContent = '🗑 Xoá';
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

$('noteSave').onclick = () => {
  const v = $('noteInput').value.trim();
  if (!v) return;
  const arr = loadNotes();
  arr.push(v);
  storeNotes(arr);
  $('noteInput').value = '';
  renderNotes();
};

renderNotes();
// Bật/tắt bảng nổi
const togglePanel = (force) => {
  const p = $('notePanel');
  const open =
    typeof force === 'boolean' ? force : !p.classList.contains('open');
  p.classList.toggle('open', open);
  $('noteFab').textContent = open ? '✕' : '📌';
};
$('noteFab').onclick = () => togglePanel();
$('noteClose').onclick = () => togglePanel(false);

// ===== Sao lưu / khôi phục =====
const BACKUP_KEYS = ['savedNotes', 'capSuffix', 'capMode'];
const bkSay = (t, ok = true) => {
  $('bkMsg').textContent = t;
  $('bkMsg').style.color = ok ? '#188038' : '#d93025';
};

$('bkExport').onclick = () => {
  const data = {};
  BACKUP_KEYS.forEach((k) => {
    const v = localStorage.getItem(k);
    if (v !== null) data[k] = v;
  });
  const payload = {
    app: 'tiktok-bulk',
    version: 1,
    exportedAt: new Date().toISOString(),
    data,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tiktok-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  bkSay('✅ Đã xuất file. Hãy cất file ở nơi an toàn.');
};

$('bkImport').onclick = () => $('bkFile').click();

$('bkFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!j || typeof j.data !== 'object' || !j.data) throw new Error();
    if (j.data.savedNotes) {
      const n = JSON.parse(j.data.savedNotes);
      if (!Array.isArray(n)) throw new Error();
    }
    if (!confirm('Nhập file sẽ ghi đè ghi chú và cài đặt hiện tại. Tiếp tục?'))
      return;

    BACKUP_KEYS.forEach((k) => {
      if (typeof j.data[k] === 'string') localStorage.setItem(k, j.data[k]);
    });
    // Cập nhật lại giao diện
    renderNotes();
    $('capSuffix').value = localStorage.getItem('capSuffix') || '';
    $('capModeReplace').checked = localStorage.getItem('capMode') === 'replace';
    $('capModeAppend').checked = !$('capModeReplace').checked;
    refreshCaps();
    bkSay('✅ Đã nhập xong.');
  } catch (err) {
    bkSay('❌ File không hợp lệ.', false);
  } finally {
    e.target.value = ''; // cho phép chọn lại cùng một file
  }
};