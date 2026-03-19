const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

/**
 * XLoad Server v2.1 - Enhanced for NSFW & Stability
 * ------------------------------------------------
 * Dieser Server nutzt yt-dlp mit optimierten Headern und Cookie-Handling.
 */

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIES_PATH = '/tmp/cookies.txt';
const APP_PASSWORD = process.env.APP_PASSWORD || 'xload';

// Standard User-Agent, der einen echten Browser imitiert
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health' || (req.method === 'GET' && req.path === '/')) return next();
  
  // WICHTIG: Prüft Header (App) oder Query-String (Browser-Download)
  const auth = req.headers['x-password'] || req.query.pw;
  
  // Session Cookie Support
  const sessionCookie = req.headers.cookie?.split(';').find(c => c.trim().startsWith('xs_session='));
  const sessionVal = sessionCookie ? sessionCookie.split('=')[1]?.trim() : null;

  if (auth === APP_PASSWORD || sessionVal === APP_PASSWORD) return next();
  
  console.log(`[AUTH] Abgelehnt: ${req.method} ${req.path}`);
  res.status(401).json({ error: 'Nicht autorisiert' });
});

// ── YT-DLP WRAPPER (SPAWN STATT EXEC FÜR NSFW) ─────────────────────
/**
 * Nutzt spawn für bessere Performance bei großen JSON-Daten und Streams.
 * Fügt automatisch Cookies und User-Agent hinzu.
 */
function runYtDlp(argsArray) {
  return new Promise((resolve, reject) => {
    const params = [
      '--user-agent', UA,
      '--no-check-certificate',
      '--no-warnings'
    ];

    if (fs.existsSync(COOKIES_PATH)) {
      params.push('--cookies', COOKIES_PATH);
    }

    params.push(...argsArray);

    console.log(`[YT-DLP] Start: ${params.join(' ')}`);

    const proc = spawn('yt-dlp', params);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => stdout += data.toString());
    proc.stderr.on('data', (data) => stderr += data.toString());

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[YT-DLP] Error (Code ${code}):`, stderr);
        // Spezielle Fehlermeldung für NSFW/Login Probleme
        if (stderr.includes('Inappropriate') || stderr.includes('login')) {
          reject(new Error('NSFW Block: Bitte Cookies im 🔑 Menü aktualisieren!'));
        } else {
          reject(new Error(stderr.split('\n')[0] || 'Unbekannter Fehler'));
        }
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// ── API ROUTES ─────────────────────────────────────────────────────

app.post('/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies) return res.status(400).json({ error: 'Keine Cookies geliefert' });
  try {
    fs.writeFileSync(COOKIES_PATH, cookies, 'utf8');
    console.log('[COOKIES] Neue Cookies gespeichert');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Speichern der Cookies' });
  }
});

app.get('/cookies/status', (_, res) => {
  res.json({ active: fs.existsSync(COOKIES_PATH) });
});

app.get('/cookies/check', (_, res) => {
  if (!fs.existsSync(COOKIES_PATH)) return res.json({ ok: false, msg: 'Keine Cookies' });
  const content = fs.readFileSync(COOKIES_PATH, 'utf8');
  const hasAuth = content.includes('auth_token');
  const hasCt0 = content.includes('ct0');
  res.json({
    ok: hasAuth,
    msg: hasAuth ? 'Cookies OK (auth_token gefunden)' : 'auth_token fehlt in Cookies!'
  });
});

app.delete('/cookies', (_, res) => {
  if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH);
  res.json({ ok: true });
});

// INFO ROUTE
app.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL fehlt' });

  try {
    const raw = await runYtDlp(['--dump-json', '--no-playlist', url]);
    const info = JSON.parse(raw.split('\n')[0]);

    // Formate filtern (Video + Audio kombiniert)
    const formats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url)
      .map(f => ({
        quality: f.height ? f.height + 'p' : 'SD',
        height: f.height || 0,
        ext: f.ext || 'mp4'
      }))
      .sort((a, b) => b.height - a.height);

    // Doppelte Qualitäten entfernen
    const seen = new Set();
    const uniqueFormats = formats.filter(f => {
      if (seen.has(f.quality)) return false;
      seen.add(f.quality);
      return true;
    });

    res.json({
      type: uniqueFormats.length ? 'video' : 'photo',
      uploader: info.uploader || info.uploader_id || 'X User',
      thumbnail: info.thumbnail || null,
      formats: uniqueFormats,
      photos: (info.thumbnails || [])
        .filter(t => t.url.includes('media'))
        .map(t => ({ url: t.url.split('?')[0] + '?name=orig', thumb: t.url }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DOWNLOAD ROUTE (STREAMING)
app.get('/download', (req, res) => {
  const { url, q, pw } = req.query;
  if (pw !== APP_PASSWORD) return res.status(401).send('Nicht autorisiert');

  console.log(`[DOWNLOAD] Start: ${url} (${q || 'best'})`);
  res.setHeader('Content-Disposition', 'attachment; filename="xload_video.mp4"');
  res.setHeader('Content-Type', 'video/mp4');

  const args = [
    '--user-agent', UA,
    '-f', q ? `bestvideo[height<=${parseInt(q)}][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best` : 'best[ext=mp4]/best',
    '--no-playlist',
    '-o', '-',
    url
  ];

  if (fs.existsSync(COOKIES_PATH)) {
    args.push('--cookies', COOKIES_PATH);
  }

  const proc = spawn('yt-dlp', args);
  proc.stdout.pipe(res);

  proc.stderr.on('data', (d) => {
    if (d.toString().includes('ERROR')) console.error('[STREAM ERR]', d.toString());
  });

  req.on('close', () => {
    console.log('[DOWNLOAD] Verbindung vom User geschlossen');
    proc.kill();
  });
});

app.get('/health', (_, res) => res.json({ ok: true, version: '2.1' }));

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

app.listen(PORT, () => console.log(`
🚀 XLoad Server Online
📍 Port: ${PORT}
🔑 Passwort: ${APP_PASSWORD}
🍪 Cookies: ${fs.existsSync(COOKIES_PATH) ? 'Aktiv' : 'Fehlen'}
`));

// ── UI / HTML ──────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#000">
<title>XLoad</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
:root { --bg:#000; --card:#111; --border:#222; --text:#fff; --accent:#fff; --sub:#555; --green:#00e87a; --red:#ff3b3b; }
* { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
body { background:var(--bg); color:var(--text); font-family:'Geist',sans-serif; height:100dvh; display:flex; flex-direction:column; overflow:hidden; }

/* Splash */
#splash { position:fixed; inset:0; background:#000; z-index:999; display:flex; flex-direction:column; align-items:center; justify-content:center; transition:opacity .5s; }
#splash.hide { opacity:0; pointer-events:none; }
.logo { font-size:42px; font-weight:800; letter-spacing:-2px; }

/* Layout */
#app { flex:1; display:flex; flex-direction:column; padding:20px; max-width:500px; margin:0 auto; width:100%; opacity:0; transition:opacity .5s; }
#app.on { opacity:1; }
.header { display:flex; justify-content:space-between; align-items:center; margin-bottom:30px; padding-top:env(safe-area-inset-top); }
.dot { width:10px; height:10px; border-radius:50%; background:var(--border); transition:0.3s; }
.dot.on { background:var(--green); box-shadow:0 0 10px var(--green); }

/* Input */
.card { background:var(--card); border:1px solid var(--border); border-radius:24px; padding:20px; margin-bottom:15px; }
.url-input { width:100%; background:#1a1a1a; border:1px solid #333; border-radius:14px; color:#fff; padding:15px; font-size:16px; outline:none; margin-bottom:12px; font-family:inherit; }
.btn-main { width:100%; background:#fff; color:#000; border:none; border-radius:14px; padding:15px; font-weight:700; font-size:16px; cursor:pointer; transition:transform 0.1s; }
.btn-main:active { transform:scale(0.98); }

/* Results */
#res { display:none; flex-direction:column; gap:10px; overflow-y:auto; padding-bottom:40px; }
#res.on { display:flex; }
.thumb { width:100%; aspect-ratio:16/9; border-radius:16px; object-fit:cover; margin-bottom:10px; border:1px solid var(--border); }
.dl-btn { display:flex; justify-content:space-between; align-items:center; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:16px; text-decoration:none; color:#fff; }
.dl-btn:active { background:#1a1a1a; }
.dl-btn.pri { background:#fff; color:#000; border-color:#fff; }
.dl-info { display:flex; flex-direction:column; }
.dl-q { font-weight:700; font-size:16px; }
.dl-ext { font-size:12px; opacity:0.6; }

/* Status */
#stat { font-size:13px; color:var(--sub); text-align:center; margin-top:10px; min-height:1.5em; }
.err { color:var(--red) !important; }

/* Keys Modal */
.modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.9); z-index:1000; padding:20px; align-items:center; justify-content:center; }
.modal.on { display:flex; }
.modal-content { background:var(--card); border:1px solid var(--border); border-radius:24px; padding:20px; width:100%; max-width:400px; }
textarea { width:100%; height:150px; background:#000; color:var(--green); border:1px solid var(--border); border-radius:12px; padding:10px; font-size:10px; font-family:monospace; margin:10px 0; outline:none; }
</style>
</head>
<body>

<div id="splash"><div class="logo">XLoad</div></div>

<div id="app">
  <div class="header">
    <div class="logo" style="font-size:24px">XLoad</div>
    <div style="display:flex; align-items:center; gap:15px">
      <div class="dot" id="cdot"></div>
      <div onclick="openModal()" style="cursor:pointer; font-size:20px">🔑</div>
    </div>
  </div>

  <div class="card">
    <input type="url" id="urlInp" class="url-input" placeholder="X Link hier einfügen..." autocomplete="off">
    <button class="btn-main" onclick="go()">Medien finden</button>
    <div id="stat"></div>
  </div>

  <div id="res">
    <img id="rThumb" class="thumb">
    <div id="rUploader" style="font-size:14px; color:var(--sub); margin-bottom:10px"></div>
    <div id="rLinks" style="display:flex; flex-direction:column; gap:8px"></div>
  </div>
</div>

<div class="modal" id="modal">
  <div class="modal-content">
    <h3>🔑 Cookies & Auth</h3>
    <p style="font-size:12px; color:var(--sub); margin:10px 0">Füge hier deine Netscape-Cookies ein (für NSFW nötig).</p>
    <textarea id="cookTxt" placeholder="# Netscape HTTP Cookie File..."></textarea>
    <button class="btn-main" onclick="saveCookies()">Speichern</button>
    <button class="btn-main" onclick="closeModal()" style="background:transparent; color:var(--sub); margin-top:8px">Schließen</button>
  </div>
</div>

<script>
let _pw = localStorage.getItem('xl_pw') || '';
const S = window.location.origin;

// Splash & Init
window.onload = () => {
  setTimeout(() => { 
    document.getElementById('splash').classList.add('hide');
    document.getElementById('app').classList.add('on');
  }, 1000);
  checkStatus();
};

async function checkStatus() {
  const r = await fetch(S + '/cookies/status');
  const d = await r.json();
  document.getElementById('cdot').classList.toggle('on', d.active);
}

function openModal() { document.getElementById('modal').classList.add('on'); }
function closeModal() { document.getElementById('modal').classList.remove('on'); }

async function saveCookies() {
  const val = document.getElementById('cookTxt').value.trim();
  if(!val) return;
  await api('/cookies', { method:'POST', body: JSON.stringify({cookies: val}) });
  closeModal();
  checkStatus();
}

async function api(path, opts = {}) {
  if(!_pw) { _pw = prompt('Passwort eingeben:'); localStorage.setItem('xl_pw', _pw); }
  opts.headers = { ...opts.headers, 'Content-Type': 'application/json', 'x-password': _pw };
  const r = await fetch(S + path, opts);
  if(r.status === 401) { localStorage.removeItem('xl_pw'); _pw = ''; location.reload(); }
  return r;
}

async function go() {
  const url = document.getElementById('urlInp').value.trim();
  if(!url) return;
  
  const stat = document.getElementById('stat');
  const resDiv = document.getElementById('res');
  stat.textContent = 'Analysiere Link...';
  stat.className = '';
  resDiv.classList.remove('on');

  try {
    const r = await api('/info', { method:'POST', body: JSON.stringify({url}) });
    const d = await r.json();
    if(!r.ok) throw new Error(d.error);

    stat.textContent = '';
    document.getElementById('rThumb').src = d.thumbnail || '';
    document.getElementById('rUploader').textContent = '@' + d.uploader;
    
    const links = document.getElementById('rLinks');
    links.innerHTML = '';

    if(d.formats && d.formats.length) {
      d.formats.forEach((f, i) => {
        const a = document.createElement('a');
        a.className = 'dl-btn' + (i === 0 ? ' pri' : '');
        // WICHTIG: pw wird hier für den Download-Link angehängt!
        a.href = \`\${S}/download?url=\${encodeURIComponent(url)}&q=\${f.height}&pw=\${_pw}\`;
        a.innerHTML = \`<div class="dl-info"><span class="dl-q">\${f.quality} Video</span><span class="dl-ext">MP4 / \${f.ext}</span></div><span>↓</span>\`;
        links.appendChild(a);
      });
    }

    resDiv.classList.add('on');
  } catch (e) {
    stat.textContent = e.message;
    stat.className = 'err';
  }
}
</script>
</body>
</html>`;
