const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIES_PATH = '/tmp/cookies.txt';
const APP_PASSWORD = process.env.APP_PASSWORD || 'xload';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Auto-load cookies from env ────────────────────────────────────
(function() {
  const c = process.env.TWITTER_COOKIES;
  if (c) { fs.writeFileSync(COOKIES_PATH, c, 'utf8'); console.log('[COOKIES] Loaded from env'); }
})();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── AUTH ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health' || (req.method === 'GET' && req.path === '/')) return next();
  const auth = req.headers['x-password'] || req.query.pw;
  if (auth === APP_PASSWORD) return next();
  res.status(401).json({ error: 'Nicht autorisiert' });
});

// ── YT-DLP ────────────────────────────────────────────────────────
function runYtDlp(argsArray) {
  return new Promise((resolve, reject) => {
    const params = ['--user-agent', UA, '--no-check-certificate', '--no-warnings'];
    if (fs.existsSync(COOKIES_PATH)) params.push('--cookies', COOKIES_PATH);
    params.push(...argsArray);
    const proc = spawn('yt-dlp', params);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) {
        const msg = stderr.includes('Inappropriate') || stderr.includes('login')
          ? 'NSFW Block — Cookies aktualisieren 🔑'
          : stderr.split('\n').find(l => l.includes('ERROR')) || 'Fehler';
        reject(new Error(msg));
      } else resolve(stdout.trim());
    });
  });
}

// ── COOKIES ───────────────────────────────────────────────────────
app.post('/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies) return res.status(400).json({ error: 'Keine Cookies' });
  fs.writeFileSync(COOKIES_PATH, cookies, 'utf8');
  res.json({ ok: true });
});
app.get('/cookies/status', (_, res) => res.json({ active: fs.existsSync(COOKIES_PATH) }));
app.delete('/cookies', (_, res) => {
  if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH);
  res.json({ ok: true });
});

// ── INFO ──────────────────────────────────────────────────────────
app.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL fehlt' });
  try {
    const raw = await runYtDlp(['--dump-json', '--no-playlist', url]);
    const info = JSON.parse(raw.split('\n')[0]);
    const formats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url)
      .map(f => ({ quality: f.height ? f.height + 'p' : 'SD', height: f.height || 0, ext: f.ext || 'mp4' }))
      .sort((a, b) => b.height - a.height);
    const seen = new Set();
    const unique = formats.filter(f => { if (seen.has(f.quality)) return false; seen.add(f.quality); return true; });
    res.json({
      type: unique.length ? 'video' : 'photo',
      uploader: info.uploader || info.uploader_id || 'X User',
      thumbnail: info.thumbnail || null,
      duration: info.duration || null,
      formats: unique,
      photos: (info.thumbnails || [])
        .filter(t => t.url && t.url.includes('media'))
        .map(t => ({ url: t.url.split('?')[0] + '?name=orig', thumb: t.url }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PLAYLIST (profile/likes/bookmarks) ───────────────────────────
app.post('/playlist', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL fehlt' });
  try {
    const raw = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', '60', url]);
    const items = raw.split('\n').filter(l => l.startsWith('{')).map(l => {
      try {
        const d = JSON.parse(l);
        return { id: d.id, url: d.url || d.webpage_url, thumbnail: d.thumbnail, type: d.duration ? 'video' : 'photo' };
      } catch { return null; }
    }).filter(Boolean);
    res.json({ items });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PREVIEW — 10 sec, max 20MB ────────────────────────────────────
app.get('/preview', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Keine URL');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache');
  const args = ['--user-agent', UA, '--no-check-certificate', '--no-warnings'];
  if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
  args.push('-f', 'worst[ext=mp4]/worst', '--no-playlist', '-o', '-', url);
  const proc = spawn('yt-dlp', args);
  let bytes = 0;
  const MAX = 20 * 1024 * 1024; // 20MB
  proc.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > MAX) { proc.kill(); res.end(); return; }
    res.write(chunk);
  });
  proc.on('close', () => { if (!res.writableEnded) res.end(); });
  req.on('close', () => proc.kill());
});

// ── DOWNLOAD ─────────────────────────────────────────────────────
app.get('/download', (req, res) => {
  const { url, q, pw } = req.query;
  if (pw !== APP_PASSWORD) return res.status(401).send('Nicht autorisiert');
  res.setHeader('Content-Disposition', 'attachment; filename="xload_video.mp4"');
  res.setHeader('Content-Type', 'video/mp4');
  const args = ['--user-agent', UA, '--no-check-certificate', '--no-warnings'];
  if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
  args.push('-f', q ? `bestvideo[height<=${parseInt(q)}][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best` : 'best[ext=mp4]/best', '--no-playlist', '-o', '-', url);
  const proc = spawn('yt-dlp', args);
  proc.stdout.pipe(res);
  proc.stderr.on('data', d => console.error('[DL]', d.toString().slice(0,150)));
  req.on('close', () => proc.kill());
});

app.get('/health', (_, res) => res.json({ ok: true, cookies: fs.existsSync(COOKIES_PATH) }));
app.get('/', (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(HTML); });
app.listen(PORT, () => console.log(`XLoad running :${PORT}`));

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
:root{--bg:#000;--card:#111;--card2:#181818;--border:#1e1e1e;--text:#fff;--sub:#555;--sub2:#2a2a2a;--green:#00e87a;--red:#ff3b3b}
html,body{background:var(--bg);color:var(--text);font-family:'Geist',-apple-system,sans-serif;height:100dvh;overflow:hidden;-webkit-font-smoothing:antialiased}

/* SPLASH */
#splash{position:fixed;inset:0;background:#000;z-index:999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;transition:opacity .7s ease,transform .7s ease}
#splash.out{opacity:0;transform:scale(1.05);pointer-events:none}
.sp-dev{font-size:10px;font-weight:600;color:#1e1e1e;letter-spacing:3.5px;text-transform:uppercase;opacity:0;animation:fadeIn .5s .2s forwards}
.sp-title{font-size:56px;font-weight:800;letter-spacing:-5px;line-height:1;opacity:0;animation:slideUp .8s .5s cubic-bezier(.34,1.56,.64,1) forwards}
.sp-title span{color:#fff}
.sp-bar{width:36px;height:1.5px;background:#111;border-radius:2px;margin-top:8px;overflow:hidden;opacity:0;animation:fadeIn .3s 1.1s forwards}
.sp-prog{height:100%;background:#fff;width:0;animation:prog 1.5s 1.2s cubic-bezier(.4,0,.2,1) forwards}
@keyframes fadeIn{to{opacity:1}}
@keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
@keyframes prog{to{width:100%}}

/* APP */
#app{height:100dvh;display:flex;flex-direction:column;opacity:0;transition:opacity .4s}
#app.on{opacity:1}

/* TOPBAR */
.tb{padding:calc(env(safe-area-inset-top,44px) + 12px) 18px 10px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.brand .dev{font-size:10px;font-weight:600;color:#222;letter-spacing:2.5px;text-transform:uppercase;line-height:1}
.brand .name{font-size:23px;font-weight:800;letter-spacing:-1.2px;line-height:1.1}
.tb-right{display:flex;align-items:center;gap:10px}
.cdot{width:8px;height:8px;border-radius:50%;background:#1e1e1e;transition:.3s}
.cdot.on{background:var(--green);box-shadow:0 0 8px var(--green)}
.ibtn{width:36px;height:36px;background:var(--card);border:1px solid var(--border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:15px;transition:background .15s}
.ibtn:active{background:var(--card2)}

/* TABS */
.tabs{display:flex;gap:5px;padding:4px 16px 10px;overflow-x:auto;flex-shrink:0;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:1;min-width:58px;padding:9px 4px 8px;border-radius:13px;background:var(--card);border:1px solid var(--border);font-family:inherit;font-size:11px;font-weight:600;color:var(--sub);cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;transition:all .18s;white-space:nowrap}
.tab .ti{font-size:17px;line-height:1}
.tab.on{background:#fff;border-color:#fff;color:#000}
.tab:active{transform:scale(.94)}

/* SCROLL */
.scr{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 14px;display:flex;flex-direction:column;gap:10px;padding-bottom:calc(env(safe-area-inset-bottom,20px) + 20px)}

/* INPUT */
.icard{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:14px;display:flex;flex-direction:column;gap:9px}
.irow{display:flex;gap:8px;align-items:center}
.uinp{flex:1;min-width:0;background:var(--card2);border:1.5px solid var(--border);border-radius:12px;color:#fff;font-family:inherit;font-size:15px;padding:12px 13px;outline:none;-webkit-appearance:none;transition:border-color .15s}
.uinp:focus{border-color:#333}
.uinp::placeholder{color:#252525}
.gbtn{width:46px;height:46px;background:#fff;color:#000;border:none;border-radius:12px;font-size:22px;font-weight:700;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:transform .1s,opacity .15s}
.gbtn:active{transform:scale(.9);opacity:.8}
.gbtn:disabled{opacity:.2}
.pbtn{background:var(--card2);border:1px solid var(--border);border-radius:10px;color:var(--sub);font-family:inherit;font-size:14px;font-weight:500;padding:11px;cursor:pointer;transition:background .15s,color .15s}
.pbtn:active{background:#222;color:#fff}

/* STATUS */
.stat{display:none;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);border-radius:100px;padding:9px 14px;font-size:13px;font-weight:500;color:var(--sub)}
.stat.on{display:flex}
.stat.ok{color:var(--green);border-color:rgba(0,232,122,.2);background:rgba(0,232,122,.05)}
.stat.err{color:var(--red);border-color:rgba(255,59,59,.2);background:rgba(255,59,59,.05)}
.spin{width:13px;height:13px;border:2px solid #222;border-top-color:#777;border-radius:50%;animation:rot .6s linear infinite;flex-shrink:0}
@keyframes rot{to{transform:rotate(360deg)}}

/* RESULT */
.res{display:none;background:var(--card);border:1px solid var(--border);border-radius:18px;overflow:hidden;animation:pop .32s cubic-bezier(.34,1.56,.64,1)}
.res.on{display:block}
@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}

/* PREVIEW PLAYER */
.pvwrap{position:relative;width:100%;aspect-ratio:16/9;background:#050505;overflow:hidden;cursor:pointer}
.pvwrap img,.pvwrap video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.pvwrap video{display:none;z-index:2}
.pvwrap video.show{display:block}
.pvplay{position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.3);transition:opacity .2s}
.pvplay.hide{opacity:0;pointer-events:none}
.pvplay-btn{width:56px;height:56px;background:rgba(255,255,255,.15);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1.5px solid rgba(255,255,255,.25);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px}
.pvbadge{position:absolute;bottom:10px;left:10px;z-index:4;background:rgba(0,0,0,.55);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-radius:100px;padding:4px 10px;font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase}
.pvtime{position:absolute;bottom:10px;right:10px;z-index:4;background:rgba(0,0,0,.55);border-radius:100px;padding:4px 8px;font-size:10px;font-weight:600;display:none}
.pvprogbar{position:absolute;bottom:0;left:0;right:0;z-index:5;height:2px;background:rgba(255,255,255,.15)}
.pvprogfill{height:100%;background:#fff;width:0;transition:width .5s linear}

/* RESULT BODY */
.rbody{padding:14px;display:flex;flex-direction:column;gap:8px}
.rmeta{display:flex;align-items:center;gap:6px}
.rdot{width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0}
.rsub{font-size:12px;color:var(--sub);font-weight:500}

/* DL BUTTONS */
.dl{display:flex;align-items:center;justify-content:space-between;background:var(--card2);border:1px solid var(--border);border-radius:13px;padding:13px 14px;text-decoration:none;color:inherit;transition:background .15s;gap:10px;margin-bottom:7px}
.dl:last-child{margin-bottom:0}
.dl:active{background:#222}
.dl.p{background:#fff;border-color:#fff}
.dl.p .dt{color:#000}.dl.p .ds{color:rgba(0,0,0,.45)}.dl.p .da{color:rgba(0,0,0,.3)}.dl.p .di{background:rgba(0,0,0,.07)}
.dl-l{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.di{width:34px;height:34px;background:rgba(255,255,255,.07);border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px}
.dt{font-size:15px;font-weight:600}
.ds{font-size:12px;color:var(--sub);margin-top:1px}
.da{color:var(--sub);font-size:17px;flex-shrink:0}

/* PHOTO GRID */
.pgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
.pitem{aspect-ratio:1;border-radius:10px;overflow:hidden;background:var(--card2);position:relative;cursor:pointer;text-decoration:none;display:block;border:1px solid var(--border)}
.pitem img{width:100%;height:100%;object-fit:cover;display:block}
.pov{position:absolute;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:20px;opacity:0;transition:opacity .15s}
.pitem:active .pov{opacity:1}

/* MEDIA GRID */
.mgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}
.mitem{aspect-ratio:1;background:var(--card2);position:relative;overflow:hidden;cursor:pointer}
.mitem img{width:100%;height:100%;object-fit:cover;display:block;background:#111}
.mov{position:absolute;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:16px;opacity:0;transition:opacity .15s}
.mitem:active .mov{opacity:1}
.mvbadge{position:absolute;bottom:3px;right:4px;background:rgba(0,0,0,.7);border-radius:3px;padding:1px 4px;font-size:9px;font-weight:700}

/* COOKIE MODAL */
.mbg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:100;align-items:flex-end;justify-content:center}
.mbg.on{display:flex}
.mc{background:#111;border:1px solid #1e1e1e;border-radius:24px 24px 0 0;width:100%;max-width:480px;padding:22px 20px calc(env(safe-area-inset-bottom,20px) + 22px);animation:mup .32s cubic-bezier(.34,1.56,.64,1)}
@keyframes mup{from{transform:translateY(100%)}to{transform:none}}
.mc h2{font-size:17px;font-weight:700;margin-bottom:6px}
.mc p{font-size:12px;color:var(--sub);line-height:1.5;margin-bottom:12px}
.mc ol{font-size:12px;color:var(--sub);line-height:1.9;padding-left:16px;margin-bottom:14px}
.mc ol b{color:#aaa}
.mc textarea{width:100%;background:var(--card2);border:1.5px solid var(--border);border-radius:12px;color:#fff;font-family:monospace;font-size:11px;padding:11px;outline:none;resize:none;height:90px;margin-bottom:10px}
.mrow{display:flex;gap:7px}
.mb{flex:1;padding:13px;border-radius:12px;border:none;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}
.mb.pri{background:#fff;color:#000}
.mb.sec{background:var(--card2);color:var(--sub);border:1px solid var(--border)}

/* TIP */
.tip{background:var(--card);border:1px solid var(--border);border-radius:13px;padding:12px 14px;display:flex;align-items:center;gap:10px}
.tip.gone{display:none}
.tip p{flex:1;font-size:12px;color:var(--sub);line-height:1.4}
.tip p b{color:#777}
.tipx{background:none;border:none;color:#222;font-size:20px;cursor:pointer;padding:0;line-height:1;flex-shrink:0}
</style>
</head>
<body>

<!-- SPLASH -->
<div id="splash">
  <div class="sp-dev">matty dev</div>
  <div class="sp-title"><span>X</span>Load</div>
  <div class="sp-bar"><div class="sp-prog"></div></div>
</div>

<!-- APP -->
<div id="app">
  <div class="tb">
    <div class="brand">
      <div class="dev">matty dev</div>
      <div class="name">XLoad</div>
    </div>
    <div class="tb-right">
      <div class="cdot" id="cdot"></div>
      <div class="ibtn" onclick="openModal()">🔑</div>
    </div>
  </div>

  <div class="tabs">
    <button class="tab on" id="t-video" onclick="sw('video')"><span class="ti">🎬</span>Video</button>
    <button class="tab" id="t-photo" onclick="sw('photo')"><span class="ti">🖼️</span>Foto</button>
    <button class="tab" id="t-profile" onclick="sw('profile')"><span class="ti">👤</span>Profil</button>
    <button class="tab" id="t-likes" onclick="sw('likes')"><span class="ti">❤️</span>Likes</button>
    <button class="tab" id="t-saves" onclick="sw('saves')"><span class="ti">🔖</span>Saves</button>
  </div>

  <div class="scr">
    <div class="tip" id="tip">
      <p>📲 <b>Teilen ↑</b> → <b>Zum Home-Bildschirm</b></p>
      <button class="tipx" onclick="closeTip()">×</button>
    </div>

    <div class="icard">
      <div class="irow">
        <input class="uinp" id="uinp" type="url" placeholder="x.com/… Link einfügen"
          autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false">
        <button class="gbtn" id="gbtn" onclick="go()">↓</button>
      </div>
      <button class="pbtn" onclick="doPaste()">📋&nbsp; Aus Zwischenablage</button>
    </div>

    <div class="stat" id="stat">
      <div class="spin" id="spin"></div>
      <span id="stxt"></span>
    </div>

    <div class="res" id="res">
      <!-- Preview player -->
      <div class="pvwrap" id="pvwrap" style="display:none" onclick="togglePreview()">
        <img id="pvthumb" src="" alt="">
        <video id="pvvideo" preload="none" playsinline muted></video>
        <div class="pvplay" id="pvplay"><div class="pvplay-btn">▶</div></div>
        <div class="pvbadge" id="pvbadge">VIDEO</div>
        <div class="pvtime" id="pvtime">0:10</div>
        <div class="pvprogbar"><div class="pvprogfill" id="pvprog"></div></div>
      </div>
      <div class="rbody">
        <div class="rmeta"><div class="rdot"></div><span class="rsub" id="rsub"></span></div>
        <div id="rcontent"></div>
      </div>
    </div>
  </div>
</div>

<!-- COOKIE MODAL -->
<div class="mbg" id="mbg" onclick="if(event.target===this)closeModal()">
  <div class="mc">
    <h2>🔑 Cookie-Login</h2>
    <p>Für NSFW, Likes und Bookmarks brauchst du deine Twitter-Cookies.</p>
    <ol>
      <li>Installiere <b>„Get cookies.txt LOCALLY"</b> im Browser</li>
      <li>Öffne <b>x.com</b> eingeloggt</li>
      <li>Extension → <b>Copy</b></li>
      <li>Hier einfügen → Speichern</li>
    </ol>
    <textarea id="ctxt" placeholder="# Netscape HTTP Cookie File..."></textarea>
    <div class="mrow">
      <button class="mb sec" onclick="closeModal()">Abbrechen</button>
      <button class="mb sec" id="delbtn" style="display:none" onclick="delCookies()">🗑 Reset</button>
      <button class="mb pri" onclick="saveCookies()">Speichern</button>
    </div>
  </div>
</div>

<script>
const S = window.location.origin;
let tab = 'video';
let _pw = localStorage.getItem('xs_pw') || '';
let _pvUrl = null, _pvLoaded = false, _pvTimer = null, _pvSecs = 0;
let _obs = null;

// ── Splash ─────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  initCookies();
  setTimeout(() => {
    document.getElementById('splash').classList.add('out');
    document.getElementById('app').classList.add('on');
  }, 2600);
});

// ── iOS tip ────────────────────────────────────────────────────────
(function(){
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent);
  if(!ios||navigator.standalone||localStorage.getItem('xs_tip')) document.getElementById('tip').classList.add('gone');
})();
function closeTip(){ localStorage.setItem('xs_tip','1'); document.getElementById('tip').classList.add('gone'); }

// ── API ────────────────────────────────────────────────────────────
async function api(path, opts={}) {
  if (!_pw) { _pw=prompt('XLoad Passwort:')||''; localStorage.setItem('xs_pw',_pw); }
  opts.headers={...(opts.headers||{}),'Content-Type':'application/json','x-password':_pw};
  const r=await fetch(S+path,opts);
  if(r.status===401){_pw='';localStorage.removeItem('xs_pw');throw new Error('Falsches Passwort');}
  return r;
}

// ── Tabs ───────────────────────────────────────────────────────────
const hints={video:'x.com/… Video-Link',photo:'x.com/… Foto-Link',profile:'x.com/username/media',likes:'x.com/username/likes',saves:'x.com/i/bookmarks'};
function sw(t){
  tab=t;
  document.querySelectorAll('.tab').forEach(e=>e.classList.remove('on'));
  document.getElementById('t-'+t).classList.add('on');
  reset();
  document.getElementById('uinp').placeholder=hints[t]||'x.com/…';
  document.getElementById('uinp').value=t==='saves'?'https://x.com/i/bookmarks':'';
}

// ── Paste ──────────────────────────────────────────────────────────
async function doPaste(){
  try{
    const t=(await navigator.clipboard.readText()).trim();
    if(!t)return;
    document.getElementById('uinp').value=t;
    if(/x\\.com|twitter\\.com/i.test(t))go();
  }catch{document.getElementById('uinp').focus();}
}
document.getElementById('uinp').addEventListener('keydown',e=>{if(e.key==='Enter')go();});

// ── Go ─────────────────────────────────────────────────────────────
async function go(){
  const url=document.getElementById('uinp').value.trim();
  if(!url)return;
  if(!/x\\.com|twitter\\.com/i.test(url)){setStat('Kein gültiger X Link.','err');return;}
  reset();
  document.getElementById('gbtn').disabled=true;
  if(tab==='profile'||tab==='likes'||tab==='saves') await loadPlaylist(url);
  else await loadMedia(url);
  document.getElementById('gbtn').disabled=false;
}

// ── Single media ───────────────────────────────────────────────────
async function loadMedia(url){
  setStat('Lade Medien…','loading');
  try{
    const r=await api('/info',{method:'POST',body:JSON.stringify({url})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    hideStat();
    renderMedia(d,url);
  }catch(e){setStat('⚠ '+e.message,'err');}
}

function renderMedia(d,tweetUrl){
  _pvUrl=null;_pvLoaded=false;
  if(d.thumbnail){
    document.getElementById('pvthumb').src=d.thumbnail;
    document.getElementById('pvwrap').style.display='block';
    document.getElementById('pvbadge').textContent=d.type==='video'?'VIDEO · Tippen für Preview':'FOTO';
    if(d.type==='video') _pvUrl=S+'/preview?url='+encodeURIComponent(tweetUrl)+'&pw='+encodeURIComponent(_pw);
  }
  document.getElementById('rsub').textContent=d.uploader?'@'+d.uploader:'Medien gefunden';
  const c=document.getElementById('rcontent');
  c.innerHTML='';
  if(d.formats&&d.formats.length){
    d.formats.forEach((f,i)=>{
      const a=document.createElement('a');
      a.href=S+'/download?url='+encodeURIComponent(tweetUrl)+'&q='+f.height+'&pw='+encodeURIComponent(_pw);
      a.className='dl'+(i===0?' p':'');
      a.innerHTML='<div class="dl-l"><div class="di">↓</div><div><div class="dt">'+f.quality+'</div><div class="ds">MP4</div></div></div><span class="da">›</span>';
      c.appendChild(a);
    });
  } else if(d.photos&&d.photos.length){
    const g=document.createElement('div');g.className='pgrid';
    d.photos.forEach((p,i)=>{
      const a=document.createElement('a');
      a.className='pitem';a.href=p.url;a.download='xload_'+(i+1)+'.jpg';a.target='_blank';
      a.innerHTML='<img src="'+(p.thumb||p.url)+'" loading="lazy"><div class="pov">↓</div>';
      g.appendChild(a);
    });
    c.appendChild(g);
  } else {
    c.innerHTML='<div style="text-align:center;color:#444;font-size:13px;padding:16px">Keine Medien gefunden.</div>';
  }
  document.getElementById('res').classList.add('on');
}

// ── Preview ────────────────────────────────────────────────────────
function togglePreview(){
  if(!_pvUrl)return;
  const vid=document.getElementById('pvvideo');
  const play=document.getElementById('pvplay');
  const prog=document.getElementById('pvprog');
  const timeEl=document.getElementById('pvtime');

  if(!_pvLoaded){
    _pvLoaded=true;
    vid.src=_pvUrl;
    vid.classList.add('show');
    play.classList.add('hide');
    timeEl.style.display='block';
    vid.play().catch(()=>{});

    // Progress bar + 10 sec countdown
    _pvSecs=0;
    prog.style.width='0%';
    clearInterval(_pvTimer);
    _pvTimer=setInterval(()=>{
      _pvSecs++;
      prog.style.width=(_pvSecs/10*100)+'%';
      timeEl.textContent='0:'+(10-_pvSecs).toString().padStart(2,'0');
      if(_pvSecs>=10){ clearInterval(_pvTimer); vid.pause(); play.classList.remove('hide'); prog.style.width='100%'; }
    },1000);

  } else if(vid.paused){
    vid.play().catch(()=>{});
    play.classList.add('hide');
    _pvSecs=0; prog.style.width='0%';
    clearInterval(_pvTimer);
    _pvTimer=setInterval(()=>{
      _pvSecs++;
      prog.style.width=(_pvSecs/10*100)+'%';
      timeEl.textContent='0:'+(10-_pvSecs).toString().padStart(2,'0');
      if(_pvSecs>=10){ clearInterval(_pvTimer); vid.pause(); play.classList.remove('hide'); }
    },1000);
  } else {
    vid.pause(); clearInterval(_pvTimer); play.classList.remove('hide');
  }
}

// ── Playlist ───────────────────────────────────────────────────────
async function loadPlaylist(url){
  setStat('Lade Profil… (bis 30 Sek.)','loading');
  try{
    const r=await api('/playlist',{method:'POST',body:JSON.stringify({url})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    hideStat();
    renderPlaylist(d);
  }catch(e){setStat('⚠ '+e.message,'err');}
}

function renderPlaylist(d){
  document.getElementById('rsub').textContent=d.items.length+' Medien geladen';
  const c=document.getElementById('rcontent');
  c.innerHTML='';
  if(!d.items.length){
    c.innerHTML='<div style="text-align:center;color:#444;font-size:13px;padding:16px">Keine Medien gefunden. Cookies aktuell?</div>';
    document.getElementById('res').classList.add('on');return;
  }
  if(_obs)_obs.disconnect();
  _obs=new IntersectionObserver(entries=>{
    entries.forEach(e=>{
      const img=e.target.querySelector('img');
      if(!img)return;
      if(e.isIntersecting){if(img.dataset.src)img.src=img.dataset.src;}
      else if(Math.abs(e.boundingClientRect.top)>window.innerHeight*2.5&&img.dataset.src)img.src='';
    });
  },{rootMargin:'300px'});
  const g=document.createElement('div');g.className='mgrid';
  d.items.forEach(item=>{
    const div=document.createElement('div');div.className='mitem';
    div.innerHTML='<img data-src="'+(item.thumbnail||'')+'" src="" alt=""><div class="mov">↓</div>'+(item.type==='video'?'<div class="mvbadge">▶</div>':'');
    div.onclick=()=>{document.getElementById('uinp').value=item.url;sw(item.type==='video'?'video':'photo');go();};
    g.appendChild(div);_obs.observe(div);
  });
  c.appendChild(g);
  document.getElementById('res').classList.add('on');
}

// ── Cookies ────────────────────────────────────────────────────────
async function initCookies(){
  try{
    const r=await fetch(S+'/cookies/status');
    const d=await r.json();
    document.getElementById('cdot').classList.toggle('on',d.active);
    document.getElementById('delbtn').style.display=d.active?'flex':'none';
  }catch{}
}
function openModal(){document.getElementById('mbg').classList.add('on');}
function closeModal(){document.getElementById('mbg').classList.remove('on');}
async function saveCookies(){
  const v=document.getElementById('ctxt').value.trim();
  if(!v)return;
  try{
    const r=await api('/cookies',{method:'POST',body:JSON.stringify({cookies:v})});
    const d=await r.json();
    if(d.ok){closeModal();initCookies();document.getElementById('ctxt').value='';}
  }catch(e){alert(e.message);}
}
async function delCookies(){
  await api('/cookies',{method:'DELETE'});
  closeModal();initCookies();
}

// ── UI ─────────────────────────────────────────────────────────────
function setStat(t,type){
  const el=document.getElementById('stat');
  el.className='stat on '+type;
  document.getElementById('stxt').textContent=t;
  document.getElementById('spin').style.display=type==='loading'?'block':'none';
}
function hideStat(){document.getElementById('stat').className='stat';}
function reset(){
  document.getElementById('res').classList.remove('on');
  document.getElementById('pvwrap').style.display='none';
  const vid=document.getElementById('pvvideo');
  vid.pause();vid.src='';vid.classList.remove('show');
  document.getElementById('pvplay').classList.remove('hide');
  document.getElementById('pvtime').style.display='none';
  document.getElementById('pvprog').style.width='0%';
  document.getElementById('rcontent').innerHTML='';
  clearInterval(_pvTimer);_pvUrl=null;_pvLoaded=false;
  hideStat();
  if(_obs){_obs.disconnect();_obs=null;}
}
</script>
</body>
</html>`;
