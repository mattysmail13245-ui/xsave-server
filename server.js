const express = require('express');
const { exec, spawn } = require('child_process');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIES_PATH = '/tmp/cookies.txt';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── Password protection ───────────────────────────────────────────
const APP_PASSWORD = process.env.APP_PASSWORD || 'xload';

app.use((req, res, next) => {
  // Allow health check without auth
  if (req.path === '/health') return next();
  // Allow GET / (the HTML page itself)
  if (req.method === 'GET' && req.path === '/') return next();
  // Check session cookie
  const sessionCookie = req.headers.cookie?.split(';').find(c => c.trim().startsWith('xs_session='));
  if (sessionCookie) {
    const val = sessionCookie.split('=')[1]?.trim();
    if (val === APP_PASSWORD) return next();
  }
  // Check Authorization header (for API calls from PWA)
  const auth = req.headers['x-password'];
  if (auth === APP_PASSWORD) return next();
  // Not authenticated
  res.status(401).json({ error: 'Nicht autorisiert' });
});

// ── Cookie helpers ────────────────────────────────────────────────
function getCookieArgs() {
  if (fs.existsSync(COOKIES_PATH)) return `--cookies "${COOKIES_PATH}"`;
  return '';
}

function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const cookies = getCookieArgs();
    exec(`yt-dlp ${cookies} ${args}`, { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ── POST /cookies — save cookies from browser ─────────────────────
app.post('/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies || typeof cookies !== 'string')
    return res.status(400).json({ error: 'Keine Cookies' });
  fs.writeFileSync(COOKIES_PATH, cookies, 'utf8');
  res.json({ ok: true });
});

app.get('/cookies/status', (_, res) => {
  res.json({ active: fs.existsSync(COOKIES_PATH) });
});

app.delete('/cookies', (_, res) => {
  if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH);
  res.json({ ok: true });
});

// ── POST /info — single tweet ─────────────────────────────────────
app.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url || !/x\.com|twitter\.com/i.test(url))
    return res.status(400).json({ error: 'Ungültige URL' });
  try {
    const raw = await ytdlp(`--dump-json --no-playlist "${url}"`);
    const info = JSON.parse(raw.split('\n')[0]);

    const formats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url)
      .map(f => ({ quality: f.height ? f.height + 'p' : 'SD', height: f.height || 0, directUrl: f.url, filesize: f.filesize }))
      .sort((a, b) => b.height - a.height);

    const seen = new Set();
    const unique = formats.filter(f => { if (seen.has(f.quality)) return false; seen.add(f.quality); return true; });

    const photos = (info.thumbnails || [])
      .filter(t => t.url && t.url.includes('twimg.com/media'))
      .map(t => ({ url: t.url.split('?')[0] + '?name=orig', thumb: t.url }));

    res.json({
      type: unique.length ? 'video' : photos.length ? 'photo' : 'unknown',
      uploader: info.uploader || info.uploader_id || '',
      thumbnail: info.thumbnail || null,
      formats: unique,
      photos,
      duration: info.duration || null,
    });
  } catch(e) {
    res.status(500).json({ error: 'Nicht gefunden. Cookie eingeloggt?' });
  }
});

// ── POST /playlist — profile/likes/bookmarks ──────────────────────
app.post('/playlist', async (req, res) => {
  const { url } = req.body;
  if (!url || !/x\.com|twitter\.com/i.test(url))
    return res.status(400).json({ error: 'Ungültige URL' });
  try {
    const raw = await ytdlp(`--dump-json --flat-playlist --playlist-end 60 --no-warnings "${url}"`);
    const lines = raw.split('\n').filter(l => l.startsWith('{'));
    const items = lines.map(l => {
      try {
        const d = JSON.parse(l);
        return { id: d.id, url: d.url || d.webpage_url, thumbnail: d.thumbnail, type: d.duration ? 'video' : 'photo', title: d.title || '' };
      } catch { return null; }
    }).filter(Boolean);
    const uploader = items.length && lines[0] ? (() => { try { return JSON.parse(lines[0]).uploader || ''; } catch { return ''; } })() : '';
    res.json({ items, uploader });
  } catch(e) {
    res.status(500).json({ error: 'Nicht gefunden. Cookies nötig für Likes/Bookmarks.' });
  }
});

// ── GET /download ─────────────────────────────────────────────────
app.get('/download', (req, res) => {
  const { url, direct, pw } = req.query;
  if (!url) return res.status(400).send('Keine URL');
  if (pw !== APP_PASSWORD) return res.status(401).send('Nicht autorisiert');

  res.setHeader('Content-Disposition', 'attachment; filename="xload.mp4"');
  res.setHeader('Content-Type', 'video/mp4');

  const cookieArgs = fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
  const args = [...cookieArgs, '-f', 'best[ext=mp4]/best', '--no-playlist', '-o', '-', url];
  const proc = spawn('yt-dlp', args);
  proc.stdout.pipe(res);
  proc.stderr.on('data', d => console.error('yt-dlp:', d.toString().slice(0,200)));
  proc.on('error', () => { if (!res.headersSent) res.status(500).send('Fehler'); });
  req.on('close', () => proc.kill());
});

app.get('/health', (_, res) => res.json({ ok: true, cookies: fs.existsSync(COOKIES_PATH) }));

// ── HTML ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

app.listen(PORT, () => console.log('XLoad running on port ' + PORT));

// ─────────────────────────────────────────────────────────────────
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
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none}
:root{
  --bg:#000;--card:#111;--card2:#181818;--border:#1e1e1e;
  --text:#fff;--sub:#555;--sub2:#2a2a2a;
  --green:#00e87a;--red:#ff3b3b;--accent:#fff;
}
html{height:100dvh;overflow:hidden}
body{background:var(--bg);color:var(--text);font-family:'Geist',-apple-system,sans-serif;height:100dvh;overflow:hidden;-webkit-font-smoothing:antialiased;overscroll-behavior:none}

/* SPLASH */
#splash{position:fixed;inset:0;background:#000;z-index:999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;transition:opacity .6s ease,transform .6s ease}
#splash.out{opacity:0;transform:scale(1.04);pointer-events:none}
.sp-dev{font-size:11px;font-weight:600;color:#2a2a2a;letter-spacing:3px;text-transform:uppercase;opacity:0;animation:fin .5s .3s forwards}
.sp-logo{font-size:58px;font-weight:800;letter-spacing:-4px;opacity:0;animation:sup .7s .6s cubic-bezier(.34,1.56,.64,1) forwards;line-height:1}
.sp-logo b{color:#fff;font-weight:800}
.sp-bar{width:44px;height:2px;background:#111;border-radius:2px;margin-top:6px;overflow:hidden;opacity:0;animation:fin .3s 1s forwards}
.sp-fill{height:100%;background:#333;border-radius:2px;animation:prog 1.4s 1.1s cubic-bezier(.4,0,.2,1) forwards}
@keyframes fin{to{opacity:1}}
@keyframes sup{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
@keyframes prog{to{width:100%;background:#fff}}

/* APP SHELL */
#app{height:100dvh;display:flex;flex-direction:column;opacity:0;transition:opacity .4s}
#app.on{opacity:1}

/* TOPBAR */
.tb{padding:calc(env(safe-area-inset-top,44px) + 10px) 18px 10px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.tb-brand{display:flex;flex-direction:column;line-height:1}
.tb-dev{font-size:10px;font-weight:600;color:#2a2a2a;letter-spacing:2.5px;text-transform:uppercase}
.tb-name{font-size:24px;font-weight:800;letter-spacing:-1.5px}
.tb-right{display:flex;align-items:center;gap:8px}
.cookie-dot{width:8px;height:8px;border-radius:50%;background:#2a2a2a;transition:background .3s;flex-shrink:0}
.cookie-dot.on{background:var(--green)}
.icon-btn{width:36px;height:36px;background:var(--card);border:1px solid var(--border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;flex-shrink:0;transition:background .15s}
.icon-btn:active{background:var(--card2)}

/* NAV */
.nav{display:flex;gap:5px;padding:0 14px 10px;flex-shrink:0;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.ntab{flex:1;min-width:64px;padding:9px 6px 8px;border-radius:14px;background:var(--card);border:1px solid var(--border);font-family:inherit;font-size:11px;font-weight:600;color:var(--sub);cursor:pointer;transition:all .2s;text-align:center;display:flex;flex-direction:column;align-items:center;gap:3px;white-space:nowrap}
.ntab .ni{font-size:19px;line-height:1}
.ntab.on{background:#fff;border-color:#fff;color:#000}
.ntab:active{transform:scale(.95)}

/* SCROLL */
.scr{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 14px;display:flex;flex-direction:column;gap:10px;padding-bottom:calc(env(safe-area-inset-bottom,20px) + 20px)}

/* INPUT */
.inp-card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:14px}
.inp-row{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.url-inp{flex:1;min-width:0;background:var(--card2);border:1.5px solid var(--border);border-radius:12px;color:var(--text);font-family:inherit;font-size:15px;padding:12px 13px;outline:none;transition:border-color .15s;-webkit-appearance:none}
.url-inp:focus{border-color:#333}
.url-inp::placeholder{color:#272727}
.go-btn{width:46px;height:46px;background:#fff;color:#000;border:none;border-radius:12px;font-size:20px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:transform .1s,opacity .15s;font-weight:700}
.go-btn:active{transform:scale(.9)}
.go-btn:disabled{opacity:.2}
.paste-btn{width:100%;background:var(--card2);border:1px solid var(--border);border-radius:10px;color:var(--sub);font-family:inherit;font-size:14px;font-weight:500;padding:11px;cursor:pointer;transition:background .15s,color .15s;display:block}
.paste-btn:active{background:#222;color:#fff}

/* STATUS */
.stat{display:none;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);border-radius:100px;padding:9px 14px;font-size:13px;font-weight:500;color:var(--sub)}
.stat.on{display:flex}
.stat.ok{color:var(--green);border-color:rgba(0,232,122,.2);background:rgba(0,232,122,.05)}
.stat.err{color:var(--red);border-color:rgba(255,59,59,.2);background:rgba(255,59,59,.05)}
.spin{width:13px;height:13px;border:2px solid #222;border-top-color:#888;border-radius:50%;animation:rot .6s linear infinite;flex-shrink:0}
@keyframes rot{to{transform:rotate(360deg)}}

/* RESULT */
.res{display:none;background:var(--card);border:1px solid var(--border);border-radius:18px;overflow:hidden;animation:pop .3s cubic-bezier(.34,1.56,.64,1)}
.res.on{display:block}
@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}
.thumb{width:100%;aspect-ratio:16/9;background:#0a0a0a;position:relative;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb-g{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 30%,rgba(0,0,0,.8));display:flex;align-items:flex-end;padding:12px}
.tbadge{background:rgba(255,255,255,.1);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.15);border-radius:100px;padding:4px 10px;font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase}
.res-body{padding:14px;display:flex;flex-direction:column;gap:8px}
.res-meta{display:flex;align-items:center;gap:6px}
.res-dot{width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0}
.res-sub{font-size:12px;color:var(--sub);font-weight:500}

/* DL BUTTONS */
.dl{display:flex;align-items:center;justify-content:space-between;background:var(--card2);border:1px solid var(--border);border-radius:14px;padding:13px;cursor:pointer;text-decoration:none;color:inherit;transition:background .15s;gap:10px;margin-bottom:7px}
.dl:last-child{margin-bottom:0}
.dl:active{background:#222}
.dl.p{background:#fff;border-color:#fff}
.dl.p .dl-t{color:#000}.dl.p .dl-s{color:rgba(0,0,0,.45)}.dl.p .dl-a{color:rgba(0,0,0,.3)}.dl.p .dl-i{background:rgba(0,0,0,.07)}
.dl-l{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.dl-i{width:34px;height:34px;background:rgba(255,255,255,.07);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:15px}
.dl-t{font-size:15px;font-weight:600}
.dl-s{font-size:12px;color:var(--sub);margin-top:1px}
.dl-a{color:var(--sub);font-size:17px;flex-shrink:0}

/* PHOTO GRID */
.pgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
.pi{aspect-ratio:1;border-radius:10px;overflow:hidden;background:var(--card2);position:relative;cursor:pointer;border:1px solid var(--border);text-decoration:none;display:block}
.pi img{width:100%;height:100%;object-fit:cover;display:block}
.pi-ov{position:absolute;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:20px;opacity:0;transition:opacity .15s}
.pi:active .pi-ov{opacity:1}

/* MEDIA GRID (profile) */
.mgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}
.mi{aspect-ratio:1;background:var(--card2);position:relative;overflow:hidden;cursor:pointer}
.mi img{width:100%;height:100%;object-fit:cover;display:block;background:#111}
.mi-ov{position:absolute;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font-size:16px;opacity:0;transition:opacity .15s}
.mi:active .mi-ov{opacity:1}
.mi-vbadge{position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,.7);border-radius:3px;padding:2px 4px;font-size:9px;font-weight:700}

/* COOKIE MODAL */
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:100;align-items:flex-end;justify-content:center;padding:0 0 env(safe-area-inset-bottom,20px)}
.modal-bg.on{display:flex}
.modal{background:#111;border:1px solid #222;border-radius:24px 24px 0 0;width:100%;max-width:480px;padding:20px 20px calc(env(safe-area-inset-bottom,20px) + 20px);animation:slideUp .3s cubic-bezier(.34,1.56,.64,1)}
@keyframes slideUp{from{transform:translateY(100%)}to{transform:none}}
.modal h2{font-size:18px;font-weight:700;margin-bottom:6px}
.modal p{font-size:13px;color:var(--sub);line-height:1.5;margin-bottom:14px}
.modal ol{font-size:13px;color:var(--sub);line-height:1.8;padding-left:18px;margin-bottom:16px}
.modal ol li b{color:#ccc}
.modal textarea{width:100%;background:var(--card2);border:1.5px solid var(--border);border-radius:12px;color:var(--text);font-family:inherit;font-size:12px;padding:12px;outline:none;resize:none;height:100px;margin-bottom:10px}
.modal-row{display:flex;gap:8px}
.mbtn{flex:1;padding:13px;border-radius:12px;border:none;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s}
.mbtn:active{opacity:.8}
.mbtn.pri{background:#fff;color:#000}
.mbtn.sec{background:var(--card2);color:var(--sub);border:1px solid var(--border)}

/* IOS TIP */
.tip{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:13px 14px;display:flex;align-items:center;gap:10px}
.tip.gone{display:none}
.tip-body{flex:1;font-size:12px;color:var(--sub);line-height:1.4}
.tip-body b{color:#888}
.tip-x{background:none;border:none;color:var(--sub2);font-size:20px;cursor:pointer;padding:0;line-height:1;flex-shrink:0}
</style>
</head>
<body>

<!-- SPLASH -->
<div id="splash">
  <div class="sp-dev">matty dev</div>
  <div class="sp-logo"><b>X</b>Load</div>
  <div class="sp-bar"><div class="sp-fill"></div></div>
</div>

<!-- APP -->
<div id="app">
  <div class="tb">
    <div class="tb-brand">
      <div class="tb-dev">matty dev</div>
      <div class="tb-name">XLoad</div>
    </div>
    <div class="tb-right">
      <div class="cookie-dot" id="cdot" title="Cookie Status"></div>
      <div class="icon-btn" onclick="openCookieModal()" title="Login / Cookies">🔑</div>
    </div>
  </div>

  <div class="nav">
    <button class="ntab on" id="t-video" onclick="sw('video')"><span class="ni">🎬</span>Video</button>
    <button class="ntab" id="t-photo" onclick="sw('photo')"><span class="ni">🖼️</span>Foto</button>
    <button class="ntab" id="t-profile" onclick="sw('profile')"><span class="ni">👤</span>Profil</button>
    <button class="ntab" id="t-likes" onclick="sw('likes')"><span class="ni">❤️</span>Likes</button>
    <button class="ntab" id="t-bookmarks" onclick="sw('bookmarks')"><span class="ni">🔖</span>Saves</button>
  </div>

  <div class="scr" id="scr">

    <div class="tip" id="tip">
      <div class="tip-body">📲 <b>Teilen ↑</b> → <b>Zum Home-Bildschirm</b> für App-Icon</div>
      <button class="tip-x" onclick="closeTip()">×</button>
    </div>

    <div class="inp-card">
      <div class="inp-row">
        <input class="url-inp" id="urlInp" type="url" placeholder="x.com/… Link einfügen"
          autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false">
        <button class="go-btn" id="goBtn" onclick="go()">↓</button>
      </div>
      <button class="paste-btn" onclick="doPaste()">📋&nbsp; Aus Zwischenablage einfügen</button>
    </div>

    <div class="stat" id="stat">
      <div class="spin" id="spin"></div>
      <span id="statTxt"></span>
    </div>

    <div class="res" id="res">
      <div class="thumb" id="tWrap" style="display:none">
        <img id="tImg" src="" alt="">
        <div class="thumb-g"><span class="tbadge" id="tBadge">Video</span></div>
      </div>
      <div class="res-body">
        <div class="res-meta"><div class="res-dot"></div><span class="res-sub" id="resSub"></span></div>
        <div id="resContent"></div>
      </div>
    </div>

  </div>
</div>

<!-- COOKIE MODAL -->
<div class="modal-bg" id="modalBg" onclick="e=>e.target===this&&closeModal()">
  <div class="modal">
    <h2>🔑 Cookie-Login</h2>
    <p>Damit XLoad auf NSFW, Likes und Bookmarks zugreifen kann, brauchst du deine Twitter-Cookies.</p>
    <ol>
      <li>Installiere <b>„Get cookies.txt LOCALLY"</b> im Browser</li>
      <li>Geh auf <b>x.com</b> und logge dich ein</li>
      <li>Klick auf das Extension-Icon → <b>Export</b></li>
      <li>Kopiere den gesamten Text und füge ihn hier ein</li>
    </ol>
    <textarea id="cookieTxt" placeholder="# Netscape HTTP Cookie File&#10;.twitter.com TRUE / FALSE ..."></textarea>
    <div class="modal-row">
      <button class="mbtn sec" onclick="closeModal()">Abbrechen</button>
      <button class="mbtn sec" onclick="deleteCookies()" id="delBtn" style="display:none">🗑 Entfernen</button>
      <button class="mbtn pri" onclick="saveCookies()">Speichern</button>
    </div>
  </div>
</div>

<script>
const S = window.location.origin;
let tab = 'video';
let _obs = null;

// ── Password ───────────────────────────────────────────────────────
let _pw = localStorage.getItem('xs_pw') || '';

function apiFetch(path, opts={}) {
  if (!_pw) {
    _pw = prompt('XLoad Passwort:') || '';
    localStorage.setItem('xs_pw', _pw);
  }
  opts.headers = { ...(opts.headers||{}), 'x-password': _pw, 'Content-Type': 'application/json' };
  return fetch(S + path, opts).then(async r => {
    if (r.status === 401) {
      _pw = '';
      localStorage.removeItem('xs_pw');
      throw new Error('Falsches Passwort');
    }
    return r;
  });
}

// ── Splash ─────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  checkCookies();
  setTimeout(() => {
    document.getElementById('splash').classList.add('out');
    document.getElementById('app').classList.add('on');
  }, 2400);
});

// ── iOS tip ────────────────────────────────────────────────────────
(function(){
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if(!ios||navigator.standalone||localStorage.getItem('xs_tip')) document.getElementById('tip').classList.add('gone');
})();
function closeTip(){ localStorage.setItem('xs_tip','1'); document.getElementById('tip').classList.add('gone'); }

// ── Tabs ───────────────────────────────────────────────────────────
const tabPlaceholders = {
  video: 'x.com/… Video-Link einfügen',
  photo: 'x.com/… Foto-Link einfügen',
  profile: 'x.com/username/media',
  likes: 'x.com/username/likes',
  bookmarks: 'x.com/i/bookmarks',
};

function sw(t) {
  tab = t;
  document.querySelectorAll('.ntab').forEach(el => el.classList.remove('on'));
  document.getElementById('t-' + t).classList.add('on');
  reset();
  document.getElementById('urlInp').placeholder = tabPlaceholders[t] || 'x.com/…';
  document.getElementById('urlInp').value = '';

  // Auto-fill for likes/bookmarks
  if (t === 'bookmarks') document.getElementById('urlInp').value = 'https://x.com/i/bookmarks';
}

// ── Paste ──────────────────────────────────────────────────────────
async function doPaste() {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (!t) return;
    document.getElementById('urlInp').value = t;
    if (/x\.com|twitter\.com/i.test(t)) go();
  } catch { document.getElementById('urlInp').focus(); }
}

document.getElementById('urlInp').addEventListener('keydown', e => { if (e.key==='Enter') go(); });

// ── Go ─────────────────────────────────────────────────────────────
async function go() {
  const url = document.getElementById('urlInp').value.trim();
  if (!url) return;
  if (!/x\.com|twitter\.com/i.test(url)) { setStat('Kein gültiger X / Twitter Link.','err'); return; }
  reset();
  document.getElementById('goBtn').disabled = true;
  if (tab === 'profile' || tab === 'likes' || tab === 'bookmarks') {
    await loadPlaylist(url);
  } else {
    await loadMedia(url);
  }
  document.getElementById('goBtn').disabled = false;
}

// ── Single tweet ───────────────────────────────────────────────────
async function loadMedia(url) {
  setStat('Lade Medien…','loading');
  try {
    const r = await apiFetch('/info',{method:'POST',body:JSON.stringify({url})});
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    hideStat();
    renderMedia(d, url);
  } catch(e) { setStat('⚠ '+(e.message||'Fehler'),'err'); }
}

function renderMedia(d, tweetUrl) {
  if (d.thumbnail) {
    document.getElementById('tImg').src = d.thumbnail;
    document.getElementById('tWrap').style.display = 'block';
    document.getElementById('tBadge').textContent = d.type==='video'?'Video':'Foto';
  }
  document.getElementById('resSub').textContent = d.uploader ? '@'+d.uploader : 'Medien gefunden';
  const c = document.getElementById('resContent');
  c.innerHTML = '';
  if (d.formats && d.formats.length) {
    d.formats.forEach((f,i) => {
      const sz = f.filesize ? ' · '+(f.filesize/1024/1024).toFixed(1)+' MB':'';
      const a = document.createElement('a');
      a.href = S+'/download?url='+encodeURIComponent(tweetUrl)+'&q='+encodeURIComponent(f.quality)+'&pw='+encodeURIComponent(_pw);
      a.className = 'dl'+(i===0?' p':'');
      a.innerHTML = '<div class="dl-l"><div class="dl-i">↓</div><div><div class="dl-t">'+f.quality+'</div><div class="dl-s">MP4'+sz+'</div></div></div><span class="dl-a">›</span>';
      c.appendChild(a);
    });
  } else if (d.photos && d.photos.length) {
    const g = document.createElement('div'); g.className='pgrid';
    d.photos.forEach((p,i) => {
      const a = document.createElement('a');
      a.className='pi'; a.href=p.url; a.download='xload_'+(i+1)+'.jpg'; a.target='_blank';
      a.innerHTML='<img src="'+(p.thumb||p.url)+'" loading="lazy"><div class="pi-ov">↓</div>';
      g.appendChild(a);
    });
    c.appendChild(g);
  } else {
    c.innerHTML='<div style="text-align:center;color:#444;font-size:13px;padding:14px">Keine Medien gefunden.</div>';
  }
  document.getElementById('res').classList.add('on');
}

// ── Playlist (profile/likes/bookmarks) ────────────────────────────
async function loadPlaylist(url) {
  setStat('Lade… (kann 15–30 Sek. dauern)','loading');
  try {
    const r = await apiFetch('/playlist',{method:'POST',body:JSON.stringify({url})});
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    hideStat();
    renderPlaylist(d);
  } catch(e) { setStat('⚠ '+(e.message||'Fehler'),'err'); }
}

function renderPlaylist(d) {
  document.getElementById('resSub').textContent = d.uploader ? '@'+d.uploader+' · '+d.items.length+' Medien' : d.items.length+' Medien geladen';
  const c = document.getElementById('resContent');
  c.innerHTML='';
  if (!d.items.length) {
    c.innerHTML='<div style="text-align:center;color:#444;font-size:13px;padding:14px">Keine Medien gefunden. Cookies eingeloggt?</div>';
    document.getElementById('res').classList.add('on');
    return;
  }
  // Lazy observer
  if (_obs) _obs.disconnect();
  _obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      const img = e.target.querySelector('img');
      if (!img) return;
      if (e.isIntersecting) {
        if (img.dataset.src) { img.src=img.dataset.src; }
      } else if (Math.abs(e.boundingClientRect.top) > window.innerHeight*2.5) {
        if (img.dataset.src && img.src) img.src='';
      }
    });
  }, { rootMargin:'300px' });

  const g = document.createElement('div'); g.className='mgrid';
  d.items.forEach(item => {
    const div = document.createElement('div'); div.className='mi';
    div.innerHTML='<img data-src="'+(item.thumbnail||'')+'" src="" alt=""><div class="mi-ov">↓</div>'+(item.type==='video'?'<div class="mi-vbadge">▶</div>':'');
    div.onclick = () => {
      document.getElementById('urlInp').value = item.url;
      sw(item.type==='video'?'video':'photo');
      go();
    };
    g.appendChild(div);
    _obs.observe(div);
  });
  c.appendChild(g);
  document.getElementById('res').classList.add('on');
}

// ── Cookies ────────────────────────────────────────────────────────
async function checkCookies() {
  try {
    const r = await apiFetch('/cookies/status');
    const d = await r.json();
    document.getElementById('cdot').classList.toggle('on', d.active);
    document.getElementById('delBtn').style.display = d.active ? 'flex':'none';
  } catch {}
}

function openCookieModal() {
  document.getElementById('modalBg').classList.add('on');
}

function closeModal() {
  document.getElementById('modalBg').classList.remove('on');
}

document.getElementById('modalBg').addEventListener('click', e => {
  if (e.target === document.getElementById('modalBg')) closeModal();
});

async function saveCookies() {
  const txt = document.getElementById('cookieTxt').value.trim();
  if (!txt) return;
  try {
    const r = await apiFetch('/cookies',{method:'POST',body:JSON.stringify({cookies:txt})});
    const d = await r.json();
    if (d.ok) { closeModal(); checkCookies(); document.getElementById('cookieTxt').value=''; }
  } catch(e) { alert('Fehler: '+e.message); }
}

async function deleteCookies() {
  await apiFetch('/cookies',{method:'DELETE'});
  closeModal(); checkCookies();
}

// ── UI ─────────────────────────────────────────────────────────────
function setStat(t,type){
  const el=document.getElementById('stat');
  el.className='stat on '+type;
  document.getElementById('statTxt').textContent=t;
  document.getElementById('spin').style.display=type==='loading'?'block':'none';
}
function hideStat(){ document.getElementById('stat').className='stat'; }
function reset(){
  document.getElementById('res').classList.remove('on');
  document.getElementById('tWrap').style.display='none';
  document.getElementById('resContent').innerHTML='';
  hideStat();
  if(_obs){_obs.disconnect();_obs=null;}
}
</script>
</body>
</html>`;
