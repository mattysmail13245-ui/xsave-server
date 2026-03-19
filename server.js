const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Serve PWA inline ──────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="XSave">
<meta name="theme-color" content="#000">
<title>XSave</title>
<link rel="apple-touch-icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%23000'/><path d='M57 46L71 27H66L55 43 45 27H30L45 51 30 73H35L47 56 58 73H73Z' fill='white'/></svg>">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
:root {
  --bg: #000; --card: #111; --card2: #1a1a1a;
  --border: #222; --text: #fff; --sub: #555;
  --green: #00e87a; --red: #ff3b3b;
}
html, body {
  background: var(--bg); color: var(--text);
  font-family: 'Geist', -apple-system, sans-serif;
  min-height: 100dvh; -webkit-font-smoothing: antialiased;
}
.app {
  max-width: 480px; margin: 0 auto;
  padding: env(safe-area-inset-top, 52px) 16px env(safe-area-inset-bottom, 32px);
  display: flex; flex-direction: column; gap: 12px; min-height: 100dvh;
}

/* Header */
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 8px 2px 4px; }
.logo { display: flex; align-items: center; gap: 10px; }
.logo-box { width: 32px; height: 32px; background: #fff; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
.logo-box svg { width: 16px; height: 16px; fill: #000; }
.logo-name { font-size: 18px; font-weight: 700; letter-spacing: -.4px; }
.hist-btn { width: 34px; height: 34px; background: var(--card); border: 1px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 15px; }

/* Tip */
.tip { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 14px 16px; display: flex; align-items: flex-start; gap: 12px; }
.tip.gone { display: none; }
.tip-ico { font-size: 19px; flex-shrink: 0; }
.tip-body { flex: 1; }
.tip-title { font-size: 13px; font-weight: 600; margin-bottom: 3px; }
.tip-desc { font-size: 12px; color: var(--sub); line-height: 1.4; }
.tip-x { background: none; border: none; color: var(--sub); font-size: 22px; cursor: pointer; padding: 0; line-height: 1; }

/* Input */
.input-card { background: var(--card); border: 1px solid var(--border); border-radius: 18px; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.input-row { display: flex; gap: 10px; align-items: center; }
.url-input { flex: 1; min-width: 0; background: var(--card2); border: 1.5px solid var(--border); border-radius: 12px; color: var(--text); font-family: inherit; font-size: 15px; padding: 13px 14px; outline: none; transition: border-color .15s; }
.url-input:focus { border-color: #3a3a3a; }
.url-input::placeholder { color: #2e2e2e; }
.go-btn { width: 48px; height: 48px; background: #fff; color: #000; border: none; border-radius: 12px; font-size: 22px; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; transition: transform .1s, opacity .15s; }
.go-btn:active { transform: scale(.92); opacity: .8; }
.go-btn:disabled { opacity: .3; }
.paste-btn { background: var(--card2); border: 1px solid var(--border); border-radius: 10px; color: var(--sub); font-family: inherit; font-size: 14px; font-weight: 500; padding: 11px; cursor: pointer; transition: background .15s, color .15s; }
.paste-btn:active { background: #222; color: #fff; }

/* Status */
.status { display: none; align-items: center; gap: 8px; background: var(--card); border: 1px solid var(--border); border-radius: 100px; padding: 10px 16px; font-size: 13px; font-weight: 500; color: var(--sub); }
.status.show { display: flex; }
.status.ok  { color: var(--green); border-color: rgba(0,232,122,.2); background: rgba(0,232,122,.05); }
.status.err { color: var(--red);   border-color: rgba(255,59,59,.2);  background: rgba(255,59,59,.05); }
.spinner { width: 14px; height: 14px; border: 2px solid #333; border-top-color: #fff; border-radius: 50%; animation: spin .6s linear infinite; flex-shrink: 0; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Result */
.result { display: none; background: var(--card); border: 1px solid var(--border); border-radius: 18px; overflow: hidden; animation: up .3s cubic-bezier(.34,1.56,.64,1); }
.result.show { display: block; }
@keyframes up { from { opacity: 0; transform: translateY(10px) scale(.97); } to { opacity: 1; transform: none; } }

.thumb-wrap { width: 100%; aspect-ratio: 16/9; background: #0a0a0a; position: relative; overflow: hidden; }
.thumb-wrap img { width: 100%; height: 100%; object-fit: cover; }
.thumb-overlay { position: absolute; inset: 0; background: linear-gradient(to bottom, transparent 40%, rgba(0,0,0,.7)); display: flex; align-items: flex-end; padding: 12px; }
.thumb-badge { background: rgba(255,255,255,.15); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,.2); border-radius: 100px; padding: 4px 10px; font-size: 11px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; }

.result-body { padding: 16px; display: flex; flex-direction: column; gap: 10px; }

.result-meta { display: flex; align-items: center; gap: 6px; }
.result-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
.result-uploader { font-size: 12px; color: var(--sub); font-weight: 500; }

.dl-btn { display: flex; align-items: center; justify-content: space-between; background: var(--card2); border: 1px solid var(--border); border-radius: 14px; padding: 14px; cursor: pointer; text-decoration: none; color: inherit; transition: background .15s; gap: 12px; }
.dl-btn:active { background: #222; }
.dl-btn.primary { background: #fff; border-color: #fff; }
.dl-btn.primary .dl-title { color: #000; }
.dl-btn.primary .dl-sub   { color: rgba(0,0,0,.45); }
.dl-btn.primary .dl-arrow { color: rgba(0,0,0,.3); }
.dl-btn.primary .dl-ico   { background: rgba(0,0,0,.07); }
.dl-left { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; }
.dl-ico { width: 36px; height: 36px; background: rgba(255,255,255,.07); border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 16px; }
.dl-title { font-size: 15px; font-weight: 600; }
.dl-sub   { font-size: 12px; color: var(--sub); margin-top: 1px; }
.dl-arrow { color: var(--sub); font-size: 18px; flex-shrink: 0; }

/* History */
.hist-card { background: var(--card); border: 1px solid var(--border); border-radius: 18px; overflow: hidden; }
.hist-head { padding: 12px 16px; font-size: 11px; font-weight: 600; color: var(--sub); letter-spacing: .8px; text-transform: uppercase; border-bottom: 1px solid var(--border); }
.hist-empty { padding: 20px; text-align: center; font-size: 13px; color: var(--sub); }
.hist-row { display: flex; align-items: center; gap: 10px; padding: 12px 16px; cursor: pointer; border-bottom: 1px solid var(--border); transition: background .15s; }
.hist-row:last-child { border-bottom: none; }
.hist-row:active { background: var(--card2); }
.hist-ico { width: 28px; height: 28px; background: var(--card2); border-radius: 7px; display: flex; align-items: center; justify-content: center; font-size: 11px; flex-shrink: 0; }
.hist-url { font-size: 12px; color: var(--sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hist-ts  { font-size: 11px; color: #2e2e2e; margin-top: 1px; }
</style>
</head>
<body>
<div class="app">

  <div class="topbar">
    <div class="logo">
      <div class="logo-box">
        <svg viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      </div>
      <span class="logo-name">XSave</span>
    </div>
    <div class="hist-btn" onclick="toggleHist()">🕐</div>
  </div>

  <div class="tip" id="tip">
    <span class="tip-ico">📲</span>
    <div class="tip-body">
      <div class="tip-title">Als App speichern</div>
      <div class="tip-desc">Tippe <strong>Teilen ↑</strong> → <strong>Zum Home-Bildschirm</strong></div>
    </div>
    <button class="tip-x" onclick="closeTip()">×</button>
  </div>

  <div class="input-card">
    <div class="input-row">
      <input class="url-input" id="urlInput" type="url"
        placeholder="x.com/… Link einfügen"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      <button class="go-btn" id="goBtn" onclick="go()">↓</button>
    </div>
    <button class="paste-btn" onclick="doPaste()">📋&nbsp;&nbsp;Aus Zwischenablage einfügen</button>
  </div>

  <div class="status" id="status">
    <div class="spinner" id="spinner"></div>
    <span id="statusText"></span>
  </div>

  <div class="result" id="result">
    <div class="thumb-wrap" id="thumbWrap" style="display:none">
      <img id="thumbImg" src="" alt="">
      <div class="thumb-overlay"><span class="thumb-badge">Video</span></div>
    </div>
    <div class="result-body">
      <div class="result-meta">
        <div class="result-dot"></div>
        <span class="result-uploader" id="uploader"></span>
      </div>
      <div id="dlButtons"></div>
    </div>
  </div>

  <div id="histSection" style="display:none">
    <div class="hist-card">
      <div class="hist-head">Verlauf</div>
      <div id="histList"></div>
    </div>
  </div>

</div>

<script>
// Server URL — wird automatisch gesetzt wenn auf Railway gehostet
const SERVER = window.location.origin;

let hist = JSON.parse(localStorage.getItem('xs_h') || '[]');
let histOpen = false;

// iOS tip
(function(){
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!ios || navigator.standalone || localStorage.getItem('xs_tip'))
    document.getElementById('tip').classList.add('gone');
})();

function closeTip() {
  localStorage.setItem('xs_tip','1');
  document.getElementById('tip').classList.add('gone');
}

async function doPaste() {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (!t) return;
    document.getElementById('urlInput').value = t;
    if (/x\\.com|twitter\\.com/i.test(t)) go();
  } catch { document.getElementById('urlInput').focus(); }
}

document.getElementById('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') go();
});

async function go() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) return;
  if (!/x\\.com|twitter\\.com/i.test(url)) {
    setStatus('Kein gültiger X / Twitter Link.', 'err'); return;
  }

  reset();
  setStatus('Lade Video-Infos…', 'loading');
  document.getElementById('goBtn').disabled = true;

  try {
    const res = await fetch(SERVER + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Serverfehler');

    hideStatus();
    render(data, url);
    addHist(url);
  } catch(e) {
    setStatus('⚠ ' + (e.message || 'Fehler'), 'err');
  } finally {
    document.getElementById('goBtn').disabled = false;
  }
}

function render(data, tweetUrl) {
  // Thumbnail
  if (data.thumbnail) {
    document.getElementById('thumbImg').src = data.thumbnail;
    document.getElementById('thumbWrap').style.display = 'block';
  }

  document.getElementById('uploader').textContent = data.uploader
    ? \`@\${data.uploader} · \${data.formats.length} Format\${data.formats.length > 1 ? 'e' : ''} verfügbar\`
    : \`\${data.formats.length} Format\${data.formats.length > 1 ? 'e' : ''} verfügbar\`;

  const btns = document.getElementById('dlButtons');
  btns.innerHTML = '';

  data.formats.forEach((f, i) => {
    const size = f.filesize ? \` · \${(f.filesize / 1024 / 1024).toFixed(1)} MB\` : '';
    const dlUrl = SERVER + '/download?url=' + encodeURIComponent(tweetUrl)
      + '&quality=' + encodeURIComponent(f.quality || 'best')
      + '&filename=xsave_' + f.quality;

    const a = document.createElement('a');
    a.href = dlUrl;
    a.className = 'dl-btn' + (i === 0 ? ' primary' : '');
    a.style.marginBottom = '8px';
    a.innerHTML = \`
      <div class="dl-left">
        <div class="dl-ico">↓</div>
        <div>
          <div class="dl-title">\${f.quality || 'Best'}</div>
          <div class="dl-sub">MP4\${size}</div>
        </div>
      </div>
      <span class="dl-arrow">›</span>
    \`;
    btns.appendChild(a);
  });

  document.getElementById('result').classList.add('show');
}

// History
function addHist(url) {
  hist = [{url, t: Date.now()}, ...hist.filter(h=>h.url!==url)].slice(0,20);
  localStorage.setItem('xs_h', JSON.stringify(hist));
}

function toggleHist() {
  histOpen = !histOpen;
  document.getElementById('histSection').style.display = histOpen ? 'block' : 'none';
  if (histOpen) renderHist();
}

function renderHist() {
  const list = document.getElementById('histList');
  if (!hist.length) { list.innerHTML = '<div class="hist-empty">Noch keine Downloads</div>'; return; }
  list.innerHTML = hist.map(h => \`
    <div class="hist-row" onclick="loadHist(\${JSON.stringify(h.url)})">
      <div class="hist-ico">𝕏</div>
      <div style="flex:1;min-width:0">
        <div class="hist-url">\${h.url}</div>
        <div class="hist-ts">\${rel(h.t)}</div>
      </div>
    </div>
  \`).join('');
}

function loadHist(url) {
  document.getElementById('urlInput').value = url;
  histOpen = false;
  document.getElementById('histSection').style.display = 'none';
  go();
}

function rel(ts) {
  const s = (Date.now()-ts)/1000;
  if (s<60) return 'gerade';
  if (s<3600) return Math.floor(s/60)+' Min.';
  if (s<86400) return Math.floor(s/3600)+' Std.';
  return Math.floor(s/86400)+' Tage';
}

// UI helpers
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
  document.getElementById('dlButtons').innerHTML = '';
  hideStatus();
}
</script>
</body>
</html>
`;

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

// ── /info ─────────────────────────────────────────────────────────
app.post('/info', (req, res) => {
  const { url } = req.body;
  if (!url || !/x\.com|twitter\.com/i.test(url)) {
    return res.status(400).json({ error: 'Ungültige URL' });
  }

  const cmd = `yt-dlp --dump-json --no-playlist "${url}" 2>&1`;
  exec(cmd, { timeout: 30000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'Kein Video gefunden oder privater Tweet.' });

    try {
      const info = JSON.parse(stdout.trim().split('\n')[0]);
      const formats = (info.formats || [])
        .filter(f => f.ext === 'mp4' && f.url)
        .map(f => ({ quality: f.height ? f.height + 'p' : 'SD', height: f.height || 0, url: f.url, filesize: f.filesize }))
        .sort((a, b) => b.height - a.height);

      const seen = new Set();
      const unique = formats.filter(f => { if (seen.has(f.quality)) return false; seen.add(f.quality); return true; });

      res.json({
        uploader: info.uploader || info.uploader_id || '',
        thumbnail: info.thumbnail || null,
        formats: unique.length ? unique : [{ quality: 'Best', height: 0, url: info.url, filesize: null }]
      });
    } catch(e) {
      res.status(500).json({ error: 'Parse-Fehler' });
    }
  });
});

// ── /download ─────────────────────────────────────────────────────
app.get('/download', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Keine URL');

  res.setHeader('Content-Disposition', 'attachment; filename="xsave.mp4"');
  res.setHeader('Content-Type', 'video/mp4');

  const cmd = `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" -o - "${url}" 2>/dev/null`;
  const proc = exec(cmd, { maxBuffer: 500 * 1024 * 1024 });
  proc.stdout.pipe(res);
  proc.on('error', err => { if (!res.headersSent) res.status(500).send('Fehler'); });
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log('XSave läuft auf Port ' + PORT));
