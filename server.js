const express = require('express');
const { exec, spawn } = require('child_process');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Helper ────────────────────────────────────────────────────────
function ytdlp(args) {
  return new Promise((resolve, reject) => {
    exec(`yt-dlp ${args}`, { timeout: 45000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ── /info — single tweet ──────────────────────────────────────────
app.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url || !/x\.com|twitter\.com/i.test(url))
    return res.status(400).json({ error: 'Ungültige URL' });

  try {
    const raw = await ytdlp(`--dump-json --no-playlist "${url}"`);
    const info = JSON.parse(raw.split('\n')[0]);

    const allFormats = (info.formats || []);

    // Video formats — combined streams (no ffmpeg needed)
    const videoFormats = allFormats
      .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.url)
      .map(f => ({ quality: f.height ? f.height + 'p' : 'SD', height: f.height || 0, directUrl: f.url, filesize: f.filesize }))
      .sort((a, b) => b.height - a.height);

    // Deduplicate
    const seen = new Set();
    const unique = videoFormats.filter(f => { if (seen.has(f.quality)) return false; seen.add(f.quality); return true; });

    // Photos
    const photos = (info.thumbnails || [])
      .filter(t => t.url && (t.url.includes('pbs.twimg.com/media') || t.url.includes('twimg.com/media')))
      .map(t => ({ url: t.url.replace(/\?.*$/, '') + '?name=orig', thumb: t.url }));

    res.json({
      type: unique.length > 0 ? 'video' : (photos.length > 0 ? 'photo' : 'unknown'),
      uploader: info.uploader || info.uploader_id || '',
      title: info.title || '',
      thumbnail: info.thumbnail || null,
      formats: unique.length ? unique : [],
      photos: photos,
      duration: info.duration || null,
    });
  } catch (e) {
    res.status(500).json({ error: 'Kein Video/Foto gefunden oder privater Tweet.' });
  }
});

// ── /profile — all media from a profile ──────────────────────────
app.post('/profile', async (req, res) => {
  const { url } = req.body;
  if (!url || !/x\.com|twitter\.com/i.test(url))
    return res.status(400).json({ error: 'Ungültige URL' });

  try {
    // Get up to 50 entries from profile
    const raw = await ytdlp(`--dump-json --no-playlist --playlist-end 30 "${url}"`);
    const lines = raw.split('\n').filter(l => l.startsWith('{'));
    const items = lines.map(l => {
      try {
        const info = JSON.parse(l);
        const hasVideo = (info.formats || []).some(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none');
        return {
          id: info.id,
          url: info.webpage_url || info.original_url,
          thumbnail: info.thumbnail,
          title: info.title || '',
          type: hasVideo ? 'video' : 'photo',
          duration: info.duration,
        };
      } catch { return null; }
    }).filter(Boolean);

    res.json({ items, uploader: lines.length ? JSON.parse(lines[0]).uploader : '' });
  } catch (e) {
    res.status(500).json({ error: 'Profil nicht gefunden oder privat.' });
  }
});

// ── /download — stream video directly ────────────────────────────
app.get('/download', (req, res) => {
  const { url, direct } = req.query;
  if (!url) return res.status(400).send('Keine URL');

  res.setHeader('Content-Disposition', 'attachment; filename="xsave.mp4"');
  res.setHeader('Content-Type', 'video/mp4');

  let cmd, args;
  if (direct === '1') {
    // Direct video URL — just pipe it
    cmd = 'yt-dlp';
    args = ['-f', 'best[ext=mp4]/best', '--no-playlist', '-o', '-', url];
  } else {
    cmd = 'yt-dlp';
    args = ['-f', 'best[ext=mp4]/best[vcodec!=none][acodec!=none]/best', '--no-playlist', '-o', '-', url];
  }

  const proc = spawn(cmd, args);
  proc.stdout.pipe(res);
  proc.stderr.on('data', d => console.error('yt-dlp:', d.toString()));
  proc.on('error', () => { if (!res.headersSent) res.status(500).send('Fehler'); });
  req.on('close', () => proc.kill());
});

app.get('/health', (_, res) => res.json({ ok: true, ytdlp: true }));

// ── Serve PWA ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

app.listen(PORT, () => console.log('XSave running on port ' + PORT));

// ── HTML ──────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="XLoad">
<meta name="theme-color" content="#000">
<title>XLoad</title>
<link rel="apple-touch-icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%23000'/><path d='M57 46L71 27H66L55 43 45 27H30L45 51 30 73H35L47 56 58 73H73Z' fill='white'/></svg>">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#000;--card:#111;--card2:#1a1a1a;--border:#1e1e1e;
  --text:#fff;--sub:#555;--sub2:#2a2a2a;
  --green:#00e87a;--red:#ff3b3b;--blue:#4f8fff;
}
html,body{background:var(--bg);color:var(--text);font-family:'Geist',-apple-system,sans-serif;height:100dvh;overflow:hidden;-webkit-font-smoothing:antialiased}

/* ── SPLASH ── */
#splash{
  position:fixed;inset:0;background:#000;z-index:999;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
  transition:opacity .5s ease, transform .5s ease;
}
#splash.hide{opacity:0;transform:scale(1.05);pointer-events:none}
.splash-dev{font-size:12px;font-weight:500;color:#333;letter-spacing:3px;text-transform:uppercase;opacity:0;animation:fadeIn .6s .2s forwards}
.splash-logo{font-size:52px;font-weight:800;letter-spacing:-3px;opacity:0;animation:slideUp .7s .5s cubic-bezier(.34,1.56,.64,1) forwards}
.splash-logo span{color:#fff}
.splash-bar{width:48px;height:2px;background:#1a1a1a;border-radius:2px;margin-top:8px;overflow:hidden;opacity:0;animation:fadeIn .4s .9s forwards}
.splash-progress{height:100%;background:#fff;border-radius:2px;width:0;animation:load 1.2s 1s cubic-bezier(.4,0,.2,1) forwards}
@keyframes fadeIn{to{opacity:1}}
@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@keyframes load{to{width:100%}}

/* ── APP ── */
#app{height:100dvh;display:flex;flex-direction:column;opacity:0;transition:opacity .4s}
#app.show{opacity:1}

/* ── TOPBAR ── */
.topbar{
  padding:calc(env(safe-area-inset-top,44px) + 10px) 18px 12px;
  display:flex;align-items:center;justify-content:space-between;
  flex-shrink:0;
}
.brand{display:flex;flex-direction:column}
.brand-dev{font-size:10px;font-weight:600;color:#333;letter-spacing:2px;text-transform:uppercase}
.brand-name{font-size:22px;font-weight:800;letter-spacing:-1px;line-height:1}

/* ── NAV TABS ── */
.nav{
  display:flex;gap:6px;padding:0 18px 12px;flex-shrink:0;
}
.nav-tab{
  flex:1;padding:10px 8px;border-radius:12px;
  background:var(--card);border:1px solid var(--border);
  font-family:inherit;font-size:12px;font-weight:600;color:var(--sub);
  cursor:pointer;transition:all .2s;text-align:center;
  display:flex;flex-direction:column;align-items:center;gap:3px;
}
.nav-tab .tab-ico{font-size:18px}
.nav-tab.active{background:#fff;border-color:#fff;color:#000}
.nav-tab:active{transform:scale(.96)}

/* ── SCROLL ── */
.scroll{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 16px;display:flex;flex-direction:column;gap:10px;padding-bottom:calc(env(safe-area-inset-bottom,20px) + 16px)}

/* ── INPUT ── */
.input-card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:10px}
.input-row{display:flex;gap:10px;align-items:center}
.url-input{flex:1;min-width:0;background:var(--card2);border:1.5px solid var(--border);border-radius:12px;color:var(--text);font-family:inherit;font-size:15px;padding:13px 14px;outline:none;transition:border-color .15s}
.url-input:focus{border-color:#333}
.url-input::placeholder{color:#2a2a2a}
.go-btn{width:48px;height:48px;background:#fff;color:#000;border:none;border-radius:12px;font-size:20px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:transform .1s,opacity .15s;font-weight:700}
.go-btn:active{transform:scale(.92);opacity:.8}
.go-btn:disabled{opacity:.25}
.paste-btn{background:var(--card2);border:1px solid var(--border);border-radius:10px;color:var(--sub);font-family:inherit;font-size:14px;font-weight:500;padding:11px;cursor:pointer;transition:background .15s,color .15s}
.paste-btn:active{background:#222;color:#fff}

/* ── STATUS ── */
.status{display:none;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);border-radius:100px;padding:10px 16px;font-size:13px;font-weight:500;color:var(--sub)}
.status.show{display:flex}
.status.ok{color:var(--green);border-color:rgba(0,232,122,.2);background:rgba(0,232,122,.05)}
.status.err{color:var(--red);border-color:rgba(255,59,59,.2);background:rgba(255,59,59,.05)}
.spinner{width:14px;height:14px;border:2px solid #222;border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── RESULT CARD ── */
.result{display:none;background:var(--card);border:1px solid var(--border);border-radius:18px;overflow:hidden;animation:pop .35s cubic-bezier(.34,1.56,.64,1)}
.result.show{display:block}
@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}

.thumb{width:100%;aspect-ratio:16/9;background:#0a0a0a;position:relative;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover}
.thumb-grad{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 40%,rgba(0,0,0,.75));display:flex;align-items:flex-end;padding:12px}
.thumb-badge{background:rgba(255,255,255,.12);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.2);border-radius:100px;padding:4px 10px;font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase}

.result-body{padding:16px;display:flex;flex-direction:column;gap:8px}
.result-meta{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.result-dot{width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0}
.result-sub{font-size:12px;color:var(--sub);font-weight:500}

/* ── DL BUTTON ── */
.dl-btn{display:flex;align-items:center;justify-content:space-between;background:var(--card2);border:1px solid var(--border);border-radius:14px;padding:14px;cursor:pointer;text-decoration:none;color:inherit;transition:background .15s;gap:12px;margin-bottom:8px}
.dl-btn:last-child{margin-bottom:0}
.dl-btn:active{background:#222}
.dl-btn.primary{background:#fff;border-color:#fff}
.dl-btn.primary .dl-title{color:#000}
.dl-btn.primary .dl-sub2{color:rgba(0,0,0,.45)}
.dl-btn.primary .dl-arr{color:rgba(0,0,0,.3)}
.dl-btn.primary .dl-ico2{background:rgba(0,0,0,.07)}
.dl-left{display:flex;align-items:center;gap:12px;flex:1;min-width:0}
.dl-ico2{width:36px;height:36px;background:rgba(255,255,255,.07);border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px}
.dl-title{font-size:15px;font-weight:600}
.dl-sub2{font-size:12px;color:var(--sub);margin-top:1px}
.dl-arr{color:var(--sub);font-size:18px;flex-shrink:0}

/* ── PHOTO GRID ── */
.photo-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.photo-item{aspect-ratio:1;border-radius:12px;overflow:hidden;background:var(--card2);position:relative;cursor:pointer;border:1px solid var(--border);text-decoration:none;display:block}
.photo-item img{width:100%;height:100%;object-fit:cover;display:block}
.photo-overlay{position:absolute;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:22px;opacity:0;transition:opacity .2s}
.photo-item:active .photo-overlay{opacity:1}

/* ── PROFILE ── */
.profile-header{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:16px;display:flex;align-items:center;gap:14px}
.profile-avatar{width:52px;height:52px;border-radius:50%;background:var(--card2);border:1px solid var(--border);overflow:hidden;flex-shrink:0}
.profile-avatar img{width:100%;height:100%;object-fit:cover}
.profile-name{font-size:16px;font-weight:700}
.profile-handle{font-size:13px;color:var(--sub);margin-top:2px}
.profile-count{font-size:12px;color:var(--sub);margin-top:6px}

.media-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:3px}
.media-item{aspect-ratio:1;background:var(--card2);position:relative;overflow:hidden;cursor:pointer}
.media-item img{width:100%;height:100%;object-fit:cover;display:block}
.media-item-overlay{position:absolute;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:18px;opacity:0;transition:opacity .15s}
.media-item:active .media-item-overlay{opacity:1}
.media-video-badge{position:absolute;top:5px;right:5px;background:rgba(0,0,0,.6);border-radius:4px;padding:2px 5px;font-size:10px;font-weight:600}

/* ── iOS TIP ── */
.tip{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:14px 16px;display:flex;align-items:flex-start;gap:12px}
.tip.gone{display:none}
.tip-ico{font-size:19px;flex-shrink:0}
.tip-body{flex:1}
.tip-title{font-size:13px;font-weight:600;margin-bottom:3px}
.tip-desc{font-size:12px;color:var(--sub);line-height:1.4}
.tip-x{background:none;border:none;color:var(--sub);font-size:22px;cursor:pointer;padding:0;line-height:1}
</style>
</head>
<body>

<!-- SPLASH -->
<div id="splash">
  <div class="splash-dev">matty dev</div>
  <div class="splash-logo"><span>X</span>Load</div>
  <div class="splash-bar"><div class="splash-progress"></div></div>
</div>

<!-- APP -->
<div id="app">
  <div class="topbar">
    <div class="brand">
      <div class="brand-dev">matty dev</div>
      <div class="brand-name">XLoad</div>
    </div>
  </div>

  <!-- NAV -->
  <div class="nav">
    <button class="nav-tab active" id="tab-video" onclick="switchTab('video')">
      <span class="tab-ico">🎬</span>Video
    </button>
    <button class="nav-tab" id="tab-photo" onclick="switchTab('photo')">
      <span class="tab-ico">🖼️</span>Foto
    </button>
    <button class="nav-tab" id="tab-profile" onclick="switchTab('profile')">
      <span class="tab-ico">👤</span>Profil
    </button>
  </div>

  <div class="scroll" id="mainScroll">

    <!-- iOS Tip -->
    <div class="tip" id="tip">
      <span class="tip-ico">📲</span>
      <div class="tip-body">
        <div class="tip-title">Als App speichern</div>
        <div class="tip-desc">Tippe <strong>Teilen ↑</strong> → <strong>Zum Home-Bildschirm</strong></div>
      </div>
      <button class="tip-x" onclick="closeTip()">×</button>
    </div>

    <!-- Input -->
    <div class="input-card">
      <div class="input-row">
        <input class="url-input" id="urlInput" type="url"
          placeholder="x.com/… Link einfügen"
          autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        <button class="go-btn" id="goBtn" onclick="go()">↓</button>
      </div>
      <button class="paste-btn" onclick="doPaste()">📋&nbsp;&nbsp;Aus Zwischenablage einfügen</button>
    </div>

    <!-- Status -->
    <div class="status" id="status">
      <div class="spinner" id="spinner"></div>
      <span id="statusText"></span>
    </div>

    <!-- Result -->
    <div class="result" id="result">
      <div class="thumb" id="thumbWrap" style="display:none">
        <img id="thumbImg" src="" alt="">
        <div class="thumb-grad"><span class="thumb-badge" id="thumbBadge">Video</span></div>
      </div>
      <div class="result-body">
        <div class="result-meta">
          <div class="result-dot"></div>
          <span class="result-sub" id="resultSub"></span>
        </div>
        <div id="resultContent"></div>
      </div>
    </div>

  </div>
</div>

<script>
const S = window.location.origin;
let activeTab = 'video';

// ── Splash ─────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  setTimeout(() => {
    document.getElementById('splash').classList.add('hide');
    document.getElementById('app').classList.add('show');
  }, 2200);
});

// ── iOS Tip ────────────────────────────────────────────────────────
(function(){
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!ios || navigator.standalone || localStorage.getItem('xs_tip'))
    document.getElementById('tip').classList.add('gone');
})();
function closeTip(){ localStorage.setItem('xs_tip','1'); document.getElementById('tip').classList.add('gone'); }

// ── Tabs ───────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  reset();
  const placeholders = { video: 'x.com/… Video-Link einfügen', photo: 'x.com/… Foto-Link einfügen', profile: 'x.com/username — Profil-Link' };
  document.getElementById('urlInput').placeholder = placeholders[tab];
  document.getElementById('urlInput').value = '';
  document.getElementById('urlInput').focus();
}

// ── Paste ──────────────────────────────────────────────────────────
async function doPaste() {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (!t) return;
    document.getElementById('urlInput').value = t;
    if (/x\\.com|twitter\\.com/i.test(t)) go();
  } catch { document.getElementById('urlInput').focus(); }
}

document.getElementById('urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });

// ── Go ─────────────────────────────────────────────────────────────
async function go() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) return;
  if (!/x\\.com|twitter\\.com/i.test(url)) { setStatus('Kein gültiger X / Twitter Link.', 'err'); return; }

  reset();
  document.getElementById('goBtn').disabled = true;

  if (activeTab === 'profile') {
    await loadProfile(url);
  } else {
    await loadMedia(url);
  }

  document.getElementById('goBtn').disabled = false;
}

// ── Load single tweet ──────────────────────────────────────────────
async function loadMedia(url) {
  setStatus('Lade Medien…', 'loading');
  try {
    const res = await fetch(S + '/info', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    hideStatus();
    renderMedia(data, url);
  } catch(e) {
    setStatus('⚠ ' + (e.message || 'Fehler'), 'err');
  }
}

function renderMedia(data, tweetUrl) {
  if (data.thumbnail) {
    document.getElementById('thumbImg').src = data.thumbnail;
    document.getElementById('thumbWrap').style.display = 'block';
    document.getElementById('thumbBadge').textContent = data.type === 'video' ? 'Video' : 'Foto';
  }

  document.getElementById('resultSub').textContent = data.uploader ? '@' + data.uploader : 'Medien gefunden';

  const content = document.getElementById('resultContent');
  content.innerHTML = '';

  if (data.formats && data.formats.length > 0) {
    data.formats.forEach((f, i) => {
      const size = f.filesize ? ' · ' + (f.filesize/1024/1024).toFixed(1) + ' MB' : '';
      const dlUrl = S + '/download?url=' + encodeURIComponent(tweetUrl) + '&quality=' + encodeURIComponent(f.quality);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.className = 'dl-btn' + (i === 0 ? ' primary' : '');
      a.innerHTML = '<div class="dl-left"><div class="dl-ico2">↓</div><div><div class="dl-title">' + f.quality + '</div><div class="dl-sub2">MP4' + size + '</div></div></div><span class="dl-arr">›</span>';
      content.appendChild(a);
    });
  } else if (data.photos && data.photos.length > 0) {
    const grid = document.createElement('div');
    grid.className = 'photo-grid';
    data.photos.forEach((p, i) => {
      const a = document.createElement('a');
      a.className = 'photo-item';
      a.href = p.url;
      a.download = 'xload_photo_' + (i+1) + '.jpg';
      a.target = '_blank';
      a.innerHTML = '<img src="' + (p.thumb || p.url) + '" loading="lazy"><div class="photo-overlay">↓</div>';
      grid.appendChild(a);
    });
    content.appendChild(grid);
  } else {
    content.innerHTML = '<div style="text-align:center;color:#444;font-size:13px;padding:16px 0">Keine herunterladbaren Medien gefunden.</div>';
  }

  document.getElementById('result').classList.add('show');
}

// ── Load profile ───────────────────────────────────────────────────
async function loadProfile(url) {
  setStatus('Lade Profil… (kann 10–20 Sek. dauern)', 'loading');
  try {
    const res = await fetch(S + '/profile', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    hideStatus();
    renderProfile(data);
  } catch(e) {
    setStatus('⚠ ' + (e.message || 'Fehler'), 'err');
  }
}

function renderProfile(data) {
  const content = document.getElementById('resultContent');
  content.innerHTML = '';
  document.getElementById('resultSub').textContent = data.uploader ? '@' + data.uploader + ' · ' + data.items.length + ' Medien' : data.items.length + ' Medien';

  if (!data.items.length) {
    content.innerHTML = '<div style="text-align:center;color:#444;font-size:13px;padding:16px">Keine Medien gefunden.</div>';
    document.getElementById('result').classList.add('show');
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'media-grid';

  data.items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'media-item';
    div.onclick = () => { document.getElementById('urlInput').value = item.url; switchTab(item.type === 'video' ? 'video' : 'photo'); go(); };
    div.innerHTML =
      '<img src="' + (item.thumbnail || '') + '" loading="lazy">' +
      '<div class="media-item-overlay">↓</div>' +
      (item.type === 'video' ? '<div class="media-video-badge">▶</div>' : '');
    grid.appendChild(div);
  });

  content.appendChild(grid);
  document.getElementById('result').classList.add('show');
}

// ── UI helpers ─────────────────────────────────────────────────────
function setStatus(t, type) {
  const el = document.getElementById('status');
  el.className = 'status show ' + type;
  document.getElementById('statusText').textContent = t;
  document.getElementById('spinner').style.display = type === 'loading' ? 'block' : 'none';
}
function hideStatus() { document.getElementById('status').className = 'status'; }
function reset() {
  document.getElementById('result').classList.remove('show');
  document.getElementById('thumbWrap').style.display = 'none';
  document.getElementById('resultContent').innerHTML = '';
  hideStatus();
}
</script>
</body>
</html>`;
