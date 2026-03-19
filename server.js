const express = require('express');
const { exec, spawn } = require('child_process');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIES_PATH = '/tmp/cookies.txt';
const APP_PASSWORD = process.env.APP_PASSWORD || 'xload';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── AUTH MIDDLEWARE (FIXED FOR DOWNLOADS) ──────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health' || (req.method === 'GET' && req.path === '/')) return next();
  
  // Passwort aus Header ODER URL-Parameter (für Download-Buttons)
  const auth = req.headers['x-password'] || req.query.pw;
  
  if (auth === APP_PASSWORD) return next();
  res.status(401).json({ error: 'Nicht autorisiert' });
});

// ── YT-DLP HELPER ──────────────────────────────────────────────────
function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const cookies = fs.existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
    const ua = '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"';
    
    exec(`yt-dlp ${cookies} ${ua} ${args}`, { timeout: 60000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ── API ROUTES ─────────────────────────────────────────────────────
app.post('/cookies', (req, res) => {
  if (!req.body.cookies) return res.status(400).json({ error: 'Keine Cookies' });
  fs.writeFileSync(COOKIES_PATH, req.body.cookies, 'utf8');
  res.json({ ok: true });
});

app.get('/cookies/status', (_, res) => res.json({ active: fs.existsSync(COOKIES_PATH) }));
app.delete('/cookies', (_, res) => { if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH); res.json({ ok: true }); });

app.post('/info', async (req, res) => {
  const { url } = req.body;
  try {
    const raw = await ytdlp(`--dump-json --no-playlist "${url}"`);
    const info = JSON.parse(raw.split('\n')[0]);
    const formats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url)
      .map(f => ({ quality: f.height ? f.height + 'p' : 'SD', height: f.height || 0 }))
      .sort((a, b) => b.height - a.height);

    const seen = new Set();
    const unique = formats.filter(f => { if (seen.has(f.quality)) return false; seen.add(f.quality); return true; });

    res.json({
      type: unique.length ? 'video' : 'photo',
      uploader: info.uploader || '',
      thumbnail: info.thumbnail || null,
      formats: unique,
      photos: (info.thumbnails || []).filter(t => t.url.includes('media')).map(t => ({ url: t.url.split('?')[0] + '?name=orig', thumb: t.url })),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/download', (req, res) => {
  const { url, pw } = req.query;
  if (pw !== APP_PASSWORD) return res.status(401).send('Nicht autorisiert');

  res.setHeader('Content-Disposition', 'attachment; filename="xload.mp4"');
  const cookieArgs = fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
  const args = [...cookieArgs, '--user-agent', 'Mozilla/5.0', '-f', 'best[ext=mp4]/best', '--no-playlist', '-o', '-', url];
  
  const proc = spawn('yt-dlp', args);
  proc.stdout.pipe(res);
  req.on('close', () => proc.kill());
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/', (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(HTML); });

app.listen(PORT, () => console.log('XLoad gestartet auf Port ' + PORT));

// ── FULL HTML/UI ───────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#000">
<title>XLoad</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:#000;color:#fff;font-family:'Geist',sans-serif;height:100dvh;overflow:hidden}
#app{display:flex;flex-direction:column;height:100dvh;padding:20px}
.tb{margin-bottom:20px;display:flex;justify-content:space-between;align-items:center}
.tb-name{font-size:28px;font-weight:800;letter-spacing:-1.5px}
.inp-card{background:#111;border:1px solid #222;border-radius:20px;padding:15px;margin-bottom:15px}
.url-inp{width:100%;background:#181818;border:1px solid #333;border-radius:12px;color:#fff;padding:12px;font-size:16px;outline:none;margin-bottom:10px}
.go-btn{width:100%;background:#fff;color:#000;border:none;border-radius:12px;padding:12px;font-weight:700;font-size:16px;cursor:pointer}
.res{display:none;background:#111;border:1px solid #222;border-radius:20px;padding:15px;overflow-y:auto}
.res.on{display:block}
.dl{display:flex;align-items:center;background:#181818;border:1px solid #333;border-radius:12px;padding:12px;margin-bottom:8px;text-decoration:none;color:#fff}
.dl.p{background:#fff;color:#000}
.dl-t{font-weight:700;flex:1}
.cookie-dot{width:10px;height:10px;border-radius:50%;background:#333}
.cookie-dot.on{background:#00e87a}
#stat{font-size:12px;color:#555;margin-top:10px;text-align:center}
</style>
</head>
<body>
<div id="app">
  <div class="tb">
    <div class="tb-name">XLoad</div>
    <div class="cookie-dot" id="cdot"></div>
  </div>
  <div class="inp-card">
    <input class="url-inp" id="urlInp" placeholder="Link einfügen...">
    <button class="go-btn" onclick="go()">Download</button>
    <div id="stat"></div>
  </div>
  <div class="res" id="res">
    <div id="resContent"></div>
  </div>
</div>

<script>
let _pw = localStorage.getItem('xs_pw') || '';
const S = window.location.origin;

async function api(path, opts={}) {
  if(!_pw){ _pw = prompt('Passwort:'); localStorage.setItem('xs_pw', _pw); }
  opts.headers = {...(opts.headers||{}), 'x-password': _pw, 'Content-Type': 'application/json'};
  const r = await fetch(S+path, opts);
  if(r.status===401){ localStorage.removeItem('xs_pw'); _pw=''; location.reload(); }
  return r;
}

async function go() {
  const url = document.getElementById('urlInp').value;
  if(!url) return;
  document.getElementById('stat').textContent = 'Lade...';
  try {
    const r = await api('/info', {method:'POST', body:JSON.stringify({url})});
    const d = await r.json();
    if(!r.ok) throw new Error(d.error);
    render(d, url);
  } catch(e) { document.getElementById('stat').textContent = e.message; }
}

function render(d, url) {
  document.getElementById('stat').textContent = '';
  const c = document.getElementById('resContent');
  c.innerHTML = '<div style="margin-bottom:10px;color:#555">@'+d.uploader+'</div>';
  d.formats.forEach((f, i) => {
    const a = document.createElement('a');
    // FIX: Passwort wird für den Download an die URL gehängt
    a.href = S + '/download?url=' + encodeURIComponent(url) + '&pw=' + encodeURIComponent(_pw);
    a.className = 'dl' + (i===0?' p':'');
    a.innerHTML = '<div class="dl-t">'+f.quality+' Video</div><div>↓</div>';
    c.appendChild(a);
  });
  document.getElementById('res').classList.add('on');
}

fetch(S+'/cookies/status').then(r=>r.json()).then(d=>document.getElementById('cdot').classList.toggle('on', d.active));
</script>
</body>
</html>`;
