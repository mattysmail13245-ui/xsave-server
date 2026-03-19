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

// ── Password protection (GEFIXT) ──────────────────────────────────
const APP_PASSWORD = process.env.APP_PASSWORD || 'xload';

app.use((req, res, next) => {
  if (req.path === '/health' || (req.method === 'GET' && req.path === '/')) return next();
  
  // Prüft Header ODER Query-Parameter (für den Download-Link wichtig)
  const auth = req.headers['x-password'] || req.query.pw;
  
  const sessionCookie = req.headers.cookie?.split(';').find(c => c.trim().startsWith('xs_session='));
  const sessionVal = sessionCookie ? sessionCookie.split('=')[1]?.trim() : null;

  if (auth === APP_PASSWORD || sessionVal === APP_PASSWORD) return next();
  
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
    // Nutze Anführungszeichen um die URL, falls Sonderzeichen drin sind
    exec(`yt-dlp ${cookies} ${args}`, { timeout: 60000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ── POST /cookies ─────────────────────────────────────────────────
app.post('/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies) return res.status(400).json({ error: 'Keine Cookies' });
  fs.writeFileSync(COOKIES_PATH, cookies, 'utf8');
  res.json({ ok: true });
});

app.get('/cookies/check', (_, res) => {
  if (!fs.existsSync(COOKIES_PATH)) return res.json({ ok: false, msg: 'Keine Cookies' });
  const content = fs.readFileSync(COOKIES_PATH, 'utf8');
  const hasAuth = content.includes('auth_token');
  res.json({ ok: hasAuth, msg: hasAuth ? 'Cookies OK' : 'auth_token fehlt' });
});

app.get('/cookies/status', (_, res) => res.json({ active: fs.existsSync(COOKIES_PATH) }));
app.delete('/cookies', (_, res) => { if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH); res.json({ ok: true }); });

// ── POST /info ────────────────────────────────────────────────────
app.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Keine URL' });
  try {
    const raw = await ytdlp(`--dump-json --no-playlist "${url}"`);
    const info = JSON.parse(raw.split('\n')[0]);

    const formats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url)
      .map(f => ({ quality: f.height ? f.height + 'p' : 'SD', height: f.height || 0, directUrl: f.url }))
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
  } catch(e) { res.status(500).json({ error: 'Fehler: ' + e.message }); }
});

// ── GET /download (GEFIXT) ────────────────────────────────────────
app.get('/download', (req, res) => {
  const { url, pw } = req.query;
  if (!url) return res.status(400).send('Keine URL');
  if (pw !== APP_PASSWORD) return res.status(401).send('Nicht autorisiert');

  res.setHeader('Content-Disposition', 'attachment; filename="xload.mp4"');
  
  const cookieArgs = fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
  const args = [...cookieArgs, '-f', 'best[ext=mp4]/best', '--no-playlist', '-o', '-', url];
  
  const proc = spawn('yt-dlp', args);
  proc.stdout.pipe(res);
  req.on('close', () => proc.kill());
});

app.get('/', (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(HTML); });
app.listen(PORT, () => console.log('XLoad running on port ' + PORT));

// ── HTML ──────────────────────────────────────────────────────────
const HTML = `
<script>
// ... (Splash, Tabs, Paste Funktionen bleiben gleich) ...

function renderMedia(d, tweetUrl) {
  // Thumbnail & Meta
  if (d.thumbnail) {
    document.getElementById('tImg').src = d.thumbnail;
    document.getElementById('tWrap').style.display = 'block';
  }
  document.getElementById('resSub').textContent = d.uploader || 'Medien gefunden';
  
  const c = document.getElementById('resContent');
  c.innerHTML = '';

  if (d.formats && d.formats.length) {
    d.formats.forEach((f, i) => {
      const a = document.createElement('a');
      // FIX: PW wird hier in die URL gepackt, damit der Download klappt
      a.href = window.location.origin + '/download?url=' + encodeURIComponent(tweetUrl) + '&pw=' + encodeURIComponent(_pw);
      a.className = 'dl' + (i === 0 ? ' p' : '');
      a.innerHTML = '<div class="dl-l"><div class="dl-i">↓</div><div><div class="dl-t">'+f.quality+'</div><div class="dl-s">MP4</div></div></div><span class="dl-a">›</span>';
      c.appendChild(a);
    });
  } else if (d.photos && d.photos.length) {
    // Foto-Grid Logik wie gehabt
  }
  document.getElementById('res').classList.add('on');
}

// ... (Restliche Funktionen) ...
</script>
`;
