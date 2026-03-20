const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIES_PATH = '/tmp/cookies.txt';
const APP_PASSWORD = process.env.APP_PASSWORD || 'xload';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APP_KEY = process.env.B2_APP_KEY;
const B2_BUCKET = process.env.B2_BUCKET;
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;

// B2 auth state — lazy init
let b2Auth = null;

// Auto-load cookies
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
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const base = ['--user-agent', UA, '--no-warnings', '--no-check-certificate'];
    if (fs.existsSync(COOKIES_PATH)) base.push('--cookies', COOKIES_PATH);
    const proc = spawn('yt-dlp', [...base, ...args]);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code !== 0) {
        const msg = err.includes('login') || err.includes('age') || err.includes('Inappropriate')
          ? 'NSFW Block — Cookies aktualisieren'
          : err.split('\n').find(l => l.includes('ERROR')) || 'Fehler';
        reject(new Error(msg));
      } else resolve(out.trim());
    });
  });
}

// ── B2 HELPERS ────────────────────────────────────────────────────
async function b2Authorize() {
  return new Promise((resolve, reject) => {
    const creds = Buffer.from(`${B2_KEY_ID}:${B2_APP_KEY}`).toString('base64');
    const req = https.request({
      hostname: 'api.backblazeb2.com',
      path: '/b2api/v2/b2_authorize_account',
      headers: { 'Authorization': `Basic ${creds}` }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getB2Auth() {
  if (!B2_KEY_ID || !B2_APP_KEY) throw new Error('B2 nicht konfiguriert — Railway Variables prüfen');
  if (!b2Auth || Date.now() - b2Auth.time > 3600000) {
    try {
      const auth = await b2Authorize();
      if (auth.status === 401) throw new Error('B2 Key ungültig');
      b2Auth = { ...auth, time: Date.now() };
    } catch(e) {
      b2Auth = null;
      throw new Error('B2 Auth fehlgeschlagen: ' + e.message);
    }
  }
  return b2Auth;
}

async function b2GetUploadUrl(auth) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ bucketId: B2_BUCKET_ID });
    const url = new URL(auth.apiUrl + '/b2api/v2/b2_get_upload_url');
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': auth.authorizationToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function b2UploadFile(uploadUrl, uploadAuthToken, filename, buffer, mimeType) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': uploadAuthToken,
        'X-Bz-File-Name': encodeURIComponent(filename),
        'Content-Type': mimeType || 'video/mp4',
        'Content-Length': buffer.length,
        'X-Bz-Content-Sha1': 'do_not_verify'
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

async function b2ListFiles() {
  const auth = await getB2Auth();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ bucketId: B2_BUCKET_ID, maxFileCount: 100 });
    const url = new URL(auth.apiUrl + '/b2api/v2/b2_list_file_names');
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': auth.authorizationToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function b2DeleteFile(fileId, fileName) {
  const auth = await getB2Auth();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ fileId, fileName });
    const url = new URL(auth.apiUrl + '/b2api/v2/b2_delete_file_version');
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': auth.authorizationToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── COOKIES ───────────────────────────────────────────────────────
app.post('/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies) return res.status(400).json({ error: 'Keine Cookies' });
  fs.writeFileSync(COOKIES_PATH, cookies);
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
    const photos = (info.thumbnails || [])
      .filter(t => t.url && t.url.includes('media'))
      .map(t => ({ url: t.url.split('?')[0] + '?name=orig', thumb: t.url }));
    res.json({
      type: unique.length ? 'video' : photos.length ? 'photo' : 'unknown',
      uploader: info.uploader || info.uploader_id || '',
      thumbnail: info.thumbnail || null,
      formats: unique,
      photos,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PROFILE ───────────────────────────────────────────────────────
app.post('/profile', async (req, res) => {
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
    res.json({ items, uploader: items[0]?.uploader || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PREVIEW ───────────────────────────────────────────────────────
app.get('/preview', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Keine URL');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache');
  const base = ['--user-agent', UA, '--no-warnings', '--no-check-certificate'];
  if (fs.existsSync(COOKIES_PATH)) base.push('--cookies', COOKIES_PATH);
  const proc = spawn('yt-dlp', [...base, '-f', 'worst[ext=mp4]/worst', '--no-playlist', '-o', '-', url]);
  let bytes = 0, killed = false;
  proc.stdout.on('data', chunk => {
    if (killed) return;
    bytes += chunk.length;
    if (bytes > 20 * 1024 * 1024) { killed = true; proc.kill(); if (!res.writableEnded) res.end(); return; }
    res.write(chunk);
  });
  proc.on('close', () => { if (!res.writableEnded) res.end(); });
  proc.stderr.on('data', () => {});
  req.on('close', () => proc.kill());
});

// ── DOWNLOAD ─────────────────────────────────────────────────────
app.get('/download', (req, res) => {
  const { url, q } = req.query;
  if (!url) return res.status(400).send('Keine URL');
  res.setHeader('Content-Disposition', 'attachment; filename="xload_video.mp4"');
  res.setHeader('Content-Type', 'video/mp4');
  const base = ['--user-agent', UA, '--no-warnings', '--no-check-certificate'];
  if (fs.existsSync(COOKIES_PATH)) base.push('--cookies', COOKIES_PATH);
  const fmt = q ? `bestvideo[height<=${parseInt(q)}][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best` : 'best[ext=mp4]/best';
  const proc = spawn('yt-dlp', [...base, '-f', fmt, '--no-playlist', '-o', '-', url]);
  proc.stdout.pipe(res);
  proc.stderr.on('data', d => { if (d.toString().includes('ERROR')) console.error('[DL]', d.toString().slice(0,150)); });
  req.on('close', () => proc.kill());
});

// ── CLOUD: Upload video from tweet to B2 ─────────────────────────
app.post('/cloud/save', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL fehlt' });
  if (!B2_KEY_ID) return res.status(500).json({ error: 'B2 nicht konfiguriert' });

  try {
    // Download video to buffer
    const base = ['--user-agent', UA, '--no-warnings', '--no-check-certificate'];
    if (fs.existsSync(COOKIES_PATH)) base.push('--cookies', COOKIES_PATH);

    // Get info first for filename
    const raw = await runYtDlp(['--dump-json', '--no-playlist', url]);
    const info = JSON.parse(raw.split('\n')[0]);
    const filename = `${info.uploader || 'xload'}_${info.id}_${Date.now()}.mp4`;

    // Download to buffer (max 500MB)
    const chunks = [];
    await new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', [...base, '-f', 'best[ext=mp4]/best', '--no-playlist', '-o', '-', url]);
      proc.stdout.on('data', d => chunks.push(d));
      proc.stderr.on('data', d => { if (d.toString().includes('ERROR')) console.error(d.toString()); });
      proc.on('close', code => { if (code === 0) resolve(); else reject(new Error('Download fehlgeschlagen')); });
    });

    const buffer = Buffer.concat(chunks);
    const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);

    // Upload to B2
    const auth = await getB2Auth();
    const uploadData = await b2GetUploadUrl(auth);
    const result = await b2UploadFile(uploadData.uploadUrl, uploadData.authorizationToken, filename, buffer, 'video/mp4');

    res.json({
      ok: true,
      filename,
      sizeMB,
      fileId: result.fileId,
      downloadUrl: `${auth.downloadUrl}/file/${B2_BUCKET}/${encodeURIComponent(filename)}`
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLOUD: List files ─────────────────────────────────────────────
app.get('/cloud/files', async (req, res) => {
  if (!B2_KEY_ID) return res.status(500).json({ error: 'B2 nicht konfiguriert' });
  try {
    const data = await b2ListFiles();
    const files = (data.files || []).map(f => ({
      id: f.fileId,
      name: f.fileName,
      size: f.contentLength,
      sizeMB: (f.contentLength / 1024 / 1024).toFixed(1),
      uploaded: new Date(f.uploadTimestamp).toLocaleDateString('de-DE')
    }));
    const totalMB = files.reduce((sum, f) => sum + parseFloat(f.sizeMB), 0);
    res.json({ files, totalMB: totalMB.toFixed(1), limitMB: 1024 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLOUD: Delete file ────────────────────────────────────────────
app.delete('/cloud/files/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const { name } = req.query;
  if (!B2_KEY_ID) return res.status(500).json({ error: 'B2 nicht konfiguriert' });
  try {
    await b2DeleteFile(fileId, decodeURIComponent(name));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLOUD: Download from B2 ───────────────────────────────────────
app.get('/cloud/download/:fileId', async (req, res) => {
  const { name } = req.query;
  try {
    const auth = await getB2Auth();
    const dlUrl = `${auth.downloadUrl}/file/${B2_BUCKET}/${encodeURIComponent(name)}`;
    res.redirect(dlUrl);
  } catch(e) { res.status(500).send('Fehler'); }
});

app.get('/health', (_, res) => res.json({ ok: true, cookies: fs.existsSync(COOKIES_PATH), b2: !!B2_KEY_ID }));
app.get('/', (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(HTML); });
app.listen(PORT, () => console.log(`XLoad :${PORT} | b2:${!!B2_KEY_ID}`));

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
:root{--bg:#000;--c1:#111;--c2:#181818;--bd:#1e1e1e;--tx:#fff;--sub:#444;--g:#00e87a;--r:#ff3b3b;--b:#4f8fff}
html,body{background:var(--bg);color:var(--tx);font-family:'Geist',-apple-system,sans-serif;height:100dvh;overflow:hidden;-webkit-font-smoothing:antialiased}

#splash{position:fixed;inset:0;background:#000;z-index:999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;transition:opacity .7s,transform .7s}
#splash.out{opacity:0;transform:scale(1.04);pointer-events:none}
.sp-dev{font-size:9px;font-weight:600;color:#1a1a1a;letter-spacing:3.5px;text-transform:uppercase;opacity:0;animation:fi .5s .4s forwards}
.sp-name{font-size:52px;font-weight:800;letter-spacing:-3px;line-height:1;color:#fff;opacity:0;animation:su .8s .7s cubic-bezier(.34,1.56,.64,1) forwards}
.sp-bar{width:32px;height:1px;background:#111;margin-top:6px;overflow:hidden;opacity:0;animation:fi .3s 1.1s forwards}
.sp-prog{height:100%;width:0;background:#fff;animation:pg 1.5s 1.2s cubic-bezier(.4,0,.2,1) forwards}
@keyframes fi{to{opacity:1}}
@keyframes su{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
@keyframes pg{to{width:100%}}

#app{height:100dvh;display:flex;flex-direction:column;opacity:0;transition:opacity .5s}
#app.on{opacity:1}

.tb{padding:calc(env(safe-area-inset-top,44px)+10px) 18px 10px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.brand .dev{font-size:9px;font-weight:600;color:#1a1a1a;letter-spacing:3px;text-transform:uppercase}
.brand .nm{font-size:24px;font-weight:800;letter-spacing:-1.5px;line-height:1.1}
.tr{display:flex;align-items:center;gap:10px}
.cdot{width:7px;height:7px;border-radius:50%;background:#1a1a1a;transition:.3s;flex-shrink:0}
.cdot.on{background:var(--g)}
.ibtn{width:34px;height:34px;background:var(--c1);border:1px solid var(--bd);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;color:var(--sub);transition:background .15s}
.ibtn:active{background:var(--c2)}

.tabs{display:flex;gap:0;border-bottom:1px solid #1a1a1a;padding:0 18px;flex-shrink:0}
.tab{padding:9px 16px;font-size:11px;font-weight:700;color:#2a2a2a;letter-spacing:.5px;cursor:pointer;border-bottom:1.5px solid transparent;margin-bottom:-1px;transition:all .2s}
.tab.on{color:#fff;border-bottom-color:#fff}

.scr{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 16px;display:flex;flex-direction:column;gap:10px;padding-bottom:calc(env(safe-area-inset-bottom,20px)+20px)}

.icard{background:var(--c1);border:1px solid var(--bd);border-radius:16px;padding:13px;display:flex;flex-direction:column;gap:8px}
.irow{display:flex;gap:7px;align-items:center}
.uinp{flex:1;min-width:0;background:var(--c2);border:1.5px solid var(--bd);border-radius:10px;color:#fff;font-family:inherit;font-size:15px;padding:11px 12px;outline:none;-webkit-appearance:none;transition:border-color .15s}
.uinp:focus{border-color:#333}
.uinp::placeholder{color:#222}
.gbtn{width:44px;height:44px;background:#fff;color:#000;border:none;border-radius:10px;font-size:20px;font-weight:700;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:transform .1s,opacity .15s}
.gbtn:active{transform:scale(.9)}
.gbtn:disabled{opacity:.2}
.pbtn{background:var(--c2);border:1px solid var(--bd);border-radius:8px;color:var(--sub);font-family:inherit;font-size:13px;font-weight:500;padding:10px;cursor:pointer;transition:background .15s,color .15s}
.pbtn:active{background:#222;color:#fff}

.stat{display:none;align-items:center;gap:8px;background:var(--c1);border:1px solid var(--bd);border-radius:100px;padding:8px 14px;font-size:13px;font-weight:500;color:var(--sub)}
.stat.on{display:flex}
.stat.ok{color:var(--g);border-color:rgba(0,232,122,.2);background:rgba(0,232,122,.05)}
.stat.err{color:var(--r);border-color:rgba(255,59,59,.2);background:rgba(255,59,59,.05)}
.spin{width:12px;height:12px;border:1.5px solid #222;border-top-color:#666;border-radius:50%;animation:rot .6s linear infinite;flex-shrink:0}
@keyframes rot{to{transform:rotate(360deg)}}

.res{display:none;background:var(--c1);border:1px solid var(--bd);border-radius:16px;overflow:hidden;animation:pop .3s cubic-bezier(.34,1.56,.64,1)}
.res.on{display:block}
@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}

.pvwrap{position:relative;width:100%;aspect-ratio:16/9;background:#080808;cursor:pointer;overflow:hidden;display:none}
.pvwrap img,.pvwrap video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.pvwrap video{display:none}
.pvplay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.3);transition:opacity .2s}
.pvplay svg{width:52px;height:52px}
.pvplay.hide{opacity:0;pointer-events:none}
.pvlabel{position:absolute;bottom:9px;left:10px;background:rgba(0,0,0,.55);border-radius:100px;padding:3px 9px;font-size:9px;font-weight:600;color:#888;letter-spacing:.5px}
.pvbar{position:absolute;bottom:0;left:0;right:0;height:2px;background:#111}
.pvprog{height:100%;width:0;background:var(--g)}

.fs-overlay{display:none;position:fixed;inset:0;background:#000;z-index:999;align-items:center;justify-content:center}
.fs-overlay.on{display:flex}
.fs-video{width:100%;max-height:100dvh;object-fit:contain}
.fs-close{position:absolute;top:calc(env(safe-area-inset-top,20px)+12px);right:16px;width:36px;height:36px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;color:#fff}

.rbody{padding:13px;display:flex;flex-direction:column;gap:7px}
.rmeta{display:flex;align-items:center;gap:5px;margin-bottom:2px}
.rdot{width:5px;height:5px;border-radius:50%;background:var(--g);flex-shrink:0}
.rsub{font-size:11px;color:var(--sub);font-weight:500}

.dl{display:flex;align-items:center;justify-content:space-between;background:var(--c2);border:1px solid var(--bd);border-radius:10px;padding:12px 13px;text-decoration:none;color:inherit;transition:background .15s;gap:10px;margin-bottom:6px}
.dl:last-child{margin-bottom:0}
.dl:active{background:#222}
.dl.p{background:#fff;border-color:#fff}
.dl.p .dt{color:#000}.dl.p .ds{color:rgba(0,0,0,.4)}.dl.p .da{color:rgba(0,0,0,.25)}
.dll{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.dt{font-size:14px;font-weight:600}
.ds{font-size:11px;color:var(--sub);margin-top:1px}
.da{color:#2a2a2a;font-size:16px;flex-shrink:0}

.cloud-btn{display:flex;align-items:center;justify-content:center;gap:8px;background:transparent;border:1px solid var(--bd);border-radius:10px;padding:11px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;color:var(--sub);transition:all .15s;margin-top:4px;width:100%}
.cloud-btn:active{background:var(--c2);color:#fff}
.cloud-btn.saving{color:var(--b);border-color:rgba(79,143,255,.3);background:rgba(79,143,255,.05)}
.cloud-btn.saved{color:var(--g);border-color:rgba(0,232,122,.3);background:rgba(0,232,122,.05)}

.pgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:5px}
.pi{aspect-ratio:1;border-radius:8px;overflow:hidden;background:var(--c2);position:relative;text-decoration:none;display:block;border:1px solid var(--bd)}
.pi img{width:100%;height:100%;object-fit:cover;display:block}
.piov{position:absolute;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:18px;color:#fff;opacity:0;transition:opacity .15s}
.pi:active .piov{opacity:1}

.mgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}
.mi{aspect-ratio:1;background:var(--c2);position:relative;overflow:hidden;cursor:pointer}
.mi img{width:100%;height:100%;object-fit:cover;display:block;background:#111}
.miov{position:absolute;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:14px;color:#fff;opacity:0;transition:opacity .15s}
.mi:active .miov{opacity:1}
.mivb{position:absolute;bottom:3px;right:4px;background:rgba(0,0,0,.7);border-radius:2px;padding:1px 4px;font-size:8px;font-weight:700;color:#fff}

/* CLOUD SECTION */
.storage-bar-wrap{background:var(--c1);border:1px solid var(--bd);border-radius:16px;padding:14px}
.storage-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.storage-title{font-size:13px;font-weight:600}
.storage-nums{font-size:11px;color:var(--sub)}
.storage-bar{height:4px;background:var(--c2);border-radius:2px;overflow:hidden;margin-bottom:4px}
.storage-fill{height:100%;background:var(--g);border-radius:2px;transition:width .5s}
.storage-fill.warn{background:#ffaa00}
.storage-fill.danger{background:var(--r)}

.cloud-upload-card{background:var(--c1);border:1px solid var(--bd);border-radius:16px;padding:13px;display:flex;flex-direction:column;gap:8px}
.cloud-upload-row{display:flex;gap:7px;align-items:center}
.cloud-uinp{flex:1;min-width:0;background:var(--c2);border:1.5px solid var(--bd);border-radius:10px;color:#fff;font-family:inherit;font-size:14px;padding:11px 12px;outline:none;-webkit-appearance:none}
.cloud-uinp::placeholder{color:#222}
.cloud-ubtn{height:44px;padding:0 16px;background:var(--b);color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;flex-shrink:0;transition:opacity .15s}
.cloud-ubtn:active{opacity:.8}
.cloud-ubtn:disabled{opacity:.3}

.file-list{display:flex;flex-direction:column;gap:6px}
.file-item{background:var(--c1);border:1px solid var(--bd);border-radius:12px;padding:12px 13px;display:flex;align-items:center;gap:10px}
.file-icon{width:32px;height:32px;background:var(--c2);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;color:var(--sub)}
.file-info{flex:1;min-width:0}
.file-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file-meta{font-size:11px;color:var(--sub);margin-top:2px}
.file-actions{display:flex;gap:5px;flex-shrink:0}
.file-btn{width:30px;height:30px;background:var(--c2);border:1px solid var(--bd);border-radius:7px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:12px;color:var(--sub);text-decoration:none;transition:background .15s}
.file-btn:active{background:#222}
.file-btn.del:active{background:rgba(255,59,59,.15)}
.empty-cloud{text-align:center;padding:24px 0;color:#2a2a2a;font-size:13px}

.mbg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:100;align-items:flex-end;justify-content:center}
.mbg.on{display:flex}
.mc{background:#111;border:1px solid #1e1e1e;border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:20px 18px calc(env(safe-area-inset-bottom,20px)+20px);animation:mup .3s cubic-bezier(.34,1.56,.64,1)}
@keyframes mup{from{transform:translateY(100%)}to{transform:none}}
.mc h2{font-size:16px;font-weight:700;margin-bottom:5px}
.mc p{font-size:12px;color:var(--sub);line-height:1.5;margin-bottom:12px}
.mc ol{font-size:12px;color:var(--sub);line-height:1.9;padding-left:16px;margin-bottom:14px}
.mc ol b{color:#888}
.mc textarea{width:100%;background:var(--c2);border:1.5px solid var(--bd);border-radius:10px;color:#fff;font-family:monospace;font-size:11px;padding:10px;outline:none;resize:none;height:80px;margin-bottom:10px}
.mrow{display:flex;gap:6px}
.mb{flex:1;padding:12px;border-radius:10px;border:none;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer}
.mb.pri{background:#fff;color:#000}
.mb.sec{background:var(--c2);color:var(--sub);border:1px solid var(--bd)}

.tip{background:var(--c1);border:1px solid var(--bd);border-radius:12px;padding:10px 13px;display:flex;align-items:center;gap:8px}
.tip.gone{display:none}
.tip p{flex:1;font-size:12px;color:#2a2a2a;line-height:1.4}
.tip p b{color:#3a3a3a}
.tipx{background:none;border:none;color:#222;font-size:18px;cursor:pointer;padding:0;line-height:1}
</style>
</head>
<body>

<div id="splash">
  <div class="sp-dev">matty dev</div>
  <div class="sp-name">XLoad</div>
  <div class="sp-bar"><div class="sp-prog"></div></div>
</div>

<div id="app">
  <div class="tb">
    <div class="brand">
      <div class="dev">matty dev</div>
      <div class="nm">XLoad</div>
    </div>
    <div class="tr">
      <div class="cdot" id="cdot"></div>
      <div class="ibtn" onclick="openModal()">⚿</div>
    </div>
  </div>

  <div class="tabs">
    <div class="tab on" id="t-video" onclick="sw('video')">Video</div>
    <div class="tab" id="t-profile" onclick="sw('profile')">Profil</div>
    <div class="tab" id="t-cloud" onclick="sw('cloud')">Cloud</div>
  </div>

  <div class="scr" id="scr">

    <div class="tip" id="tip">
      <p><b>Teilen</b> → <b>Zum Home-Bildschirm</b> für App-Icon</p>
      <button class="tipx" onclick="closeTip()">×</button>
    </div>

    <!-- VIDEO / PROFILE INPUT -->
    <div id="mediaSection">
      <div class="icard">
        <div class="irow">
          <input class="uinp" id="uinp" type="url" placeholder="x.com/… einfügen"
            autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false">
          <button class="gbtn" id="gbtn" onclick="go()">↓</button>
        </div>
        <button class="pbtn" onclick="doPaste()">Einfügen</button>
      </div>

      <div style="height:10px"></div>

      <div class="stat" id="stat">
        <div class="spin" id="spin"></div>
        <span id="stxt"></span>
      </div>

      <div class="res" id="res">
        <div class="pvwrap" id="pvwrap" onclick="openFullscreen()">
          <img id="pvthumb" src="" alt="">
          <video id="pvvid" preload="none" playsinline muted></video>
          <div class="pvplay" id="pvplay">
            <svg viewBox="0 0 60 60" fill="none">
              <circle cx="30" cy="30" r="29" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
              <polygon points="24,18 24,42 44,30" fill="rgba(255,255,255,0.88)"/>
            </svg>
          </div>
          <div class="pvlabel">10s preview</div>
          <div class="pvbar"><div class="pvprog" id="pvprog"></div></div>
        </div>
        <div class="rbody">
          <div class="rmeta"><div class="rdot"></div><span class="rsub" id="rsub"></span></div>
          <div id="rcontent"></div>
          <button class="cloud-btn" id="cloudSaveBtn" style="display:none" onclick="saveToCloud()">
            In Cloud speichern
          </button>
        </div>
      </div>
    </div>

    <!-- CLOUD SECTION -->
    <div id="cloudSection" style="display:none">
      <div class="storage-bar-wrap">
        <div class="storage-header">
          <span class="storage-title">Cloud Speicher</span>
          <span class="storage-nums" id="storageNums">Lädt…</span>
        </div>
        <div class="storage-bar">
          <div class="storage-fill" id="storageFill" style="width:0%"></div>
        </div>
        <div style="font-size:10px;color:#2a2a2a;margin-top:4px">Backblaze B2 · 1 GB</div>
      </div>

      <div style="height:2px"></div>

      <div class="cloud-upload-card">
        <div style="font-size:11px;font-weight:600;color:var(--sub);letter-spacing:.5px">TWEET SPEICHERN</div>
        <div class="cloud-upload-row">
          <input class="cloud-uinp" id="cloudInp" type="url" placeholder="x.com/… Link"
            autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false">
          <button class="cloud-ubtn" id="cloudUpBtn" onclick="uploadToCloud()">Speichern</button>
        </div>
        <div class="stat" id="cloudStat">
          <div class="spin"></div>
          <span id="cloudStxt"></span>
        </div>
      </div>

      <div style="height:2px"></div>

      <div class="file-list" id="fileList">
        <div class="empty-cloud">Keine Dateien</div>
      </div>
    </div>

  </div>
</div>

<!-- Fullscreen -->
<div class="fs-overlay" id="fsOverlay">
  <video class="fs-video" id="fsvid" playsinline controls></video>
  <button class="fs-close" onclick="closeFullscreen()">✕</button>
</div>

<!-- Cookie Modal -->
<div class="mbg" id="mbg" onclick="if(event.target===this)closeModal()">
  <div class="mc">
    <h2>Cookie Login</h2>
    <p>Für NSFW-Content brauchst du deine Twitter Cookies.</p>
    <ol>
      <li>Installiere <b>Get cookies.txt LOCALLY</b></li>
      <li>Geh auf <b>x.com</b> (eingeloggt)</li>
      <li>Extension öffnen → <b>Copy</b></li>
      <li>Hier einfügen</li>
    </ol>
    <textarea id="ctxt" placeholder="# Netscape HTTP Cookie File..."></textarea>
    <div class="mrow">
      <button class="mb sec" onclick="closeModal()">Abbrechen</button>
      <button class="mb sec" id="delbtn" style="display:none" onclick="delCookies()">Entfernen</button>
      <button class="mb pri" onclick="saveCookies()">Speichern</button>
    </div>
  </div>
</div>

<script>
const S = window.location.origin;
let tab = 'video';
let _pw = localStorage.getItem('xs_pw') || '';
let _pvUrl = null, _pvLoaded = false, _pvTimer = null;
let _obs = null;
let _currentUrl = null;

window.addEventListener('load', () => {
  // Show app after splash — wrapped in try/catch so errors don't block it
  const showApp = () => {
    document.getElementById('splash').classList.add('out');
    document.getElementById('app').classList.add('on');
  };
  setTimeout(showApp, 2200);
  // Fallback: force show after 4s no matter what
  setTimeout(showApp, 4000);
  
  try { initStatus(); } catch(e) { console.error('initStatus:', e); }
});

(function(){
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent);
  if(!ios||navigator.standalone||localStorage.getItem('xs_tip')) document.getElementById('tip').classList.add('gone');
})();
function closeTip(){ localStorage.setItem('xs_tip','1'); document.getElementById('tip').classList.add('gone'); }

async function api(path, opts={}) {
  if (!_pw) { _pw=prompt('Passwort:')||''; localStorage.setItem('xs_pw',_pw); }
  opts.headers={...(opts.headers||{}),'Content-Type':'application/json','x-password':_pw};
  const r=await fetch(S+path,opts);
  if(r.status===401){ _pw=''; localStorage.removeItem('xs_pw'); throw new Error('Falsches Passwort'); }
  return r;
}

function sw(t){
  tab=t;
  document.querySelectorAll('.tab').forEach(e=>e.classList.remove('on'));
  document.getElementById('t-'+t).classList.add('on');
  const isCloud = t==='cloud';
  document.getElementById('mediaSection').style.display = isCloud?'none':'block';
  document.getElementById('cloudSection').style.display = isCloud?'block':'none';
  if(isCloud) loadCloudFiles();
  else {
    reset();
    document.getElementById('uinp').placeholder=t==='video'?'x.com/… Video-Link':'x.com/username/media';
    document.getElementById('uinp').value='';
  }
}

async function doPaste(){
  try{
    const t=(await navigator.clipboard.readText()).trim();
    if(!t)return;
    document.getElementById('uinp').value=t;
    if(/x\.com|twitter\.com/i.test(t))go();
  }catch{ document.getElementById('uinp').focus(); }
}
document.getElementById('uinp').addEventListener('keydown',e=>{ if(e.key==='Enter')go(); });
document.getElementById('cloudInp').addEventListener('keydown',e=>{ if(e.key==='Enter')uploadToCloud(); });

async function go(){
  const url=document.getElementById('uinp').value.trim();
  if(!url)return;
  if(!/x\.com|twitter\.com/i.test(url)){setStat('Kein gültiger X Link.','err');return;}
  reset();
  _currentUrl=url;
  document.getElementById('gbtn').disabled=true;
  if(tab==='profile') await loadProfile(url);
  else await loadMedia(url);
  document.getElementById('gbtn').disabled=false;
}

async function loadMedia(url){
  setStat('Lade Medien…','loading');
  try{
    const r=await api('/info',{method:'POST',body:JSON.stringify({url})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    hideStat();
    renderMedia(d,url);
  }catch(e){ setStat('⚠ '+e.message,'err'); }
}

function renderMedia(d,tweetUrl){
  _pvUrl=null; _pvLoaded=false;
  const wrap=document.getElementById('pvwrap');
  if(d.thumbnail){
    document.getElementById('pvthumb').src=d.thumbnail;
    document.getElementById('pvthumb').style.display='block';
    document.getElementById('pvvid').style.display='none';
    wrap.style.display='block';
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
      a.innerHTML='<div class="dll"><div style="width:30px;height:30px;background:'+(i===0?'rgba(0,0,0,.08)':'rgba(255,255,255,.07)')+';border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">↓</div><div><div class="dt">'+f.quality+'</div><div class="ds">MP4</div></div></div><span class="da">›</span>';
      c.appendChild(a);
    });
    document.getElementById('cloudSaveBtn').style.display='flex';
  } else if(d.photos&&d.photos.length){
    const g=document.createElement('div');g.className='pgrid';
    d.photos.forEach((p,i)=>{
      const a=document.createElement('a');
      a.className='pi';a.href=p.url;a.download='xload_'+(i+1)+'.jpg';a.target='_blank';
      a.innerHTML='<img src="'+(p.thumb||p.url)+'" loading="lazy"><div class="piov">↓</div>';
      g.appendChild(a);
    });
    c.appendChild(g);
  } else {
    c.innerHTML='<div style="text-align:center;color:#2a2a2a;font-size:13px;padding:14px">Keine Medien gefunden</div>';
  }
  document.getElementById('res').classList.add('on');
}

// Preview — fullscreen
function openFullscreen(){
  if(!_pvUrl)return;
  const fsv=document.getElementById('fsvid');
  if(!_pvLoaded){
    _pvLoaded=true;
    fsv.src=_pvUrl;
  }
  document.getElementById('fsOverlay').classList.add('on');
  fsv.play().catch(()=>{});
}
function closeFullscreen(){
  const fsv=document.getElementById('fsvid');
  fsv.pause();
  document.getElementById('fsOverlay').classList.remove('on');
}

// Also start loading preview on thumb tap for non-fullscreen devices
document.getElementById('pvwrap').addEventListener('click',()=>{
  if(_pvUrl&&!_pvLoaded){
    _pvLoaded=true;
    const vid=document.getElementById('pvvid');
    vid.src=_pvUrl;
    vid.style.display='block';
    document.getElementById('pvthumb').style.display='none';
    document.getElementById('pvplay').classList.add('hide');
    vid.play().catch(()=>{});
    let prog=0;
    _pvTimer=setInterval(()=>{
      prog+=100/100;
      document.getElementById('pvprog').style.width=Math.min(prog,100)+'%';
      if(prog>=100){ clearInterval(_pvTimer); document.getElementById('pvplay').classList.remove('hide'); }
    },100);
    setTimeout(()=>{ vid.pause(); document.getElementById('pvplay').classList.remove('hide'); clearInterval(_pvTimer); },10000);
  }
});

// Cloud save from result
async function saveToCloud(){
  if(!_currentUrl)return;
  const btn=document.getElementById('cloudSaveBtn');
  btn.textContent='Speichert…';
  btn.className='cloud-btn saving';
  try{
    const r=await api('/cloud/save',{method:'POST',body:JSON.stringify({url:_currentUrl})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    btn.textContent='Gespeichert ✓';
    btn.className='cloud-btn saved';
  }catch(e){
    btn.textContent='Fehler: '+e.message;
    btn.className='cloud-btn';
    setTimeout(()=>{ btn.textContent='In Cloud speichern'; btn.className='cloud-btn'; },3000);
  }
}

// Profile
async function loadProfile(url){
  setStat('Lade Profil… (kann dauern)','loading');
  try{
    const r=await api('/profile',{method:'POST',body:JSON.stringify({url})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    hideStat();
    renderProfile(d);
  }catch(e){ setStat('⚠ '+e.message,'err'); }
}

function renderProfile(d){
  document.getElementById('rsub').textContent=(d.uploader?'@'+d.uploader+' · ':'')+d.items.length+' Medien';
  const c=document.getElementById('rcontent');c.innerHTML='';
  if(!d.items.length){c.innerHTML='<div style="text-align:center;color:#2a2a2a;font-size:13px;padding:14px">Keine Medien</div>';document.getElementById('res').classList.add('on');return;}
  if(_obs)_obs.disconnect();
  _obs=new IntersectionObserver(entries=>{
    entries.forEach(e=>{
      const img=e.target.querySelector('img');if(!img)return;
      if(e.isIntersecting){if(img.dataset.src)img.src=img.dataset.src;}
      else if(Math.abs(e.boundingClientRect.top)>window.innerHeight*2.5&&img.dataset.src)img.src='';
    });
  },{rootMargin:'300px'});
  const g=document.createElement('div');g.className='mgrid';
  d.items.forEach(item=>{
    const div=document.createElement('div');div.className='mi';
    div.innerHTML='<img data-src="'+(item.thumbnail||'')+'" src="" alt=""><div class="miov">↓</div>'+(item.type==='video'?'<div class="mivb">V</div>':'');
    div.onclick=()=>{document.getElementById('uinp').value=item.url;sw(item.type==='video'?'video':'photo');go();};
    g.appendChild(div);_obs.observe(div);
  });
  c.appendChild(g);
  document.getElementById('res').classList.add('on');
}

// Cloud
async function loadCloudFiles(){
  document.getElementById('storageNums').textContent='Lädt…';
  try{
    const r=await api('/cloud/files');
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    const pct=Math.min((d.totalMB/d.limitMB)*100,100);
    document.getElementById('storageNums').textContent=d.totalMB+' MB / '+d.limitMB+' MB';
    const fill=document.getElementById('storageFill');
    fill.style.width=pct+'%';
    fill.className='storage-fill'+(pct>90?' danger':pct>70?' warn':'');
    renderFiles(d.files);
  }catch(e){
    document.getElementById('storageNums').textContent='Fehler';
  }
}

function renderFiles(files){
  const list=document.getElementById('fileList');
  if(!files.length){list.innerHTML='<div class="empty-cloud">Noch keine Dateien in der Cloud</div>';return;}
  list.innerHTML='';
  files.forEach(f=>{
    const div=document.createElement('div');div.className='file-item';
    const shortName=f.name.split('_').slice(-1)[0]||f.name;
    div.innerHTML=
      '<div class="file-icon">▶</div>'+
      '<div class="file-info"><div class="file-name">'+f.name+'</div><div class="file-meta">'+f.sizeMB+' MB · '+f.uploaded+'</div></div>'+
      '<div class="file-actions">'+
      '<a class="file-btn" href="'+S+'/cloud/download/'+f.id+'?name='+encodeURIComponent(f.name)+'&pw='+encodeURIComponent(_pw)+'" download>↓</a>'+
      '<div class="file-btn del" onclick="deleteFile(\''+f.id+'\',\''+encodeURIComponent(f.name)+'\')">✕</div>'+
      '</div>';
    list.appendChild(div);
  });
}

async function uploadToCloud(){
  const url=document.getElementById('cloudInp').value.trim();
  if(!url)return;
  if(!/x\.com|twitter\.com/i.test(url)){setCloudStat('Kein X Link','err');return;}
  setCloudStat('Lädt Video herunter und speichert… (kann 1-2 Min. dauern)','loading');
  document.getElementById('cloudUpBtn').disabled=true;
  try{
    const r=await api('/cloud/save',{method:'POST',body:JSON.stringify({url})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error);
    setCloudStat('Gespeichert: '+d.filename+' ('+d.sizeMB+' MB)','ok');
    document.getElementById('cloudInp').value='';
    loadCloudFiles();
  }catch(e){
    setCloudStat('⚠ '+e.message,'err');
  }finally{
    document.getElementById('cloudUpBtn').disabled=false;
  }
}

async function deleteFile(fileId,name){
  if(!confirm('Datei löschen?'))return;
  try{
    await api('/cloud/files/'+fileId+'?name='+name,{method:'DELETE'});
    loadCloudFiles();
  }catch(e){ alert('Fehler: '+e.message); }
}

function setCloudStat(t,type){
  const el=document.getElementById('cloudStat');
  el.className='stat on '+type;
  document.getElementById('cloudStxt').textContent=t;
  el.querySelector('.spin').style.display=type==='loading'?'block':'none';
}

// Cookies
async function initStatus(){
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
  const v=document.getElementById('ctxt').value.trim();if(!v)return;
  try{const r=await api('/cookies',{method:'POST',body:JSON.stringify({cookies:v})});const d=await r.json();if(d.ok){closeModal();initStatus();document.getElementById('ctxt').value='';}}catch(e){alert(e.message);}
}
async function delCookies(){await api('/cookies',{method:'DELETE'});closeModal();initStatus();}

// UI
function setStat(t,type){const el=document.getElementById('stat');el.className='stat on '+type;document.getElementById('stxt').textContent=t;document.getElementById('spin').style.display=type==='loading'?'block':'none';}
function hideStat(){document.getElementById('stat').className='stat';}
function reset(){
  document.getElementById('res').classList.remove('on');
  document.getElementById('pvwrap').style.display='none';
  const vid=document.getElementById('pvvid');vid.pause();vid.src='';vid.style.display='none';
  document.getElementById('pvthumb').style.display='block';
  document.getElementById('pvplay').classList.remove('hide');
  document.getElementById('pvprog').style.width='0';
  document.getElementById('rcontent').innerHTML='';
  document.getElementById('cloudSaveBtn').style.display='none';
  document.getElementById('cloudSaveBtn').textContent='In Cloud speichern';
  document.getElementById('cloudSaveBtn').className='cloud-btn';
  clearInterval(_pvTimer);_pvUrl=null;_pvLoaded=false;_currentUrl=null;
  hideStat();if(_obs){_obs.disconnect();_obs=null;}
}
</script>
</body>
</html>`;
