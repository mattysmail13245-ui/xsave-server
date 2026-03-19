const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIES_PATH = '/tmp/cookies.txt';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const APP_PASSWORD = process.env.APP_PASSWORD || 'xload';

// Auth Middleware
app.use((req, res, next) => {
    if (req.path === '/health' || (req.method === 'GET' && req.path === '/')) return next();
    
    // Check Header or Query (Query ist wichtig für den direkten Download-Link)
    const auth = req.headers['x-password'] || req.query.pw;
    
    if (auth === APP_PASSWORD) return next();
    res.status(401).json({ error: 'Nicht autorisiert' });
});

function ytdlp(argsArray) {
    return new Promise((resolve, reject) => {
        const params = [];
        if (fs.existsSync(COOKIES_PATH)) params.push('--cookies', COOKIES_PATH);
        params.push('--user-agent', UA);
        params.push(...argsArray);

        const proc = spawn('yt-dlp', params);
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());
        proc.on('close', code => {
            if (code !== 0) reject(new Error(stderr.substring(0, 200)));
            else resolve(stdout.trim());
        });
    });
}

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
        const raw = await ytdlp(['--dump-json', '--no-playlist', url]);
        const info = JSON.parse(raw);
        const formats = (info.formats || [])
            .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
            .map(f => ({ quality: f.height ? f.height + 'p' : 'SD', height: f.height || 0 }))
            .sort((a, b) => b.height - a.height);

        const unique = Array.from(new Set(formats.map(f => f.quality)))
            .map(q => formats.find(f => f.quality === q));

        res.json({
            type: unique.length ? 'video' : 'photo',
            uploader: info.uploader || '',
            thumbnail: info.thumbnail || null,
            formats: unique,
            photos: (info.thumbnails || []).filter(t => t.url.includes('media')).map(t => ({ url: t.url.split('?')[0] + '?name=orig' }))
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/download', (req, res) => {
    const { url, q, pw } = req.query;
    if (pw !== APP_PASSWORD) return res.status(401).send('Falsches Passwort');

    res.setHeader('Content-Disposition', 'attachment; filename="xload.mp4"');
    const args = [];
    if (fs.existsSync(COOKIES_PATH)) args.push('--cookies', COOKIES_PATH);
    args.push('--user-agent', UA, '-f', `bestvideo[height<=${parseInt(q)||1080}][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`, '--no-playlist', '-o', '-', url);
    
    const proc = spawn('yt-dlp', args);
    proc.stdout.pipe(res);
    req.on('close', () => proc.kill());
});

app.get('/', (req, res) => { res.send(HTML); });
app.listen(PORT, () => console.log('Server läuft!'));

const HTML = `
<script>
// WICHTIGER FIX IM FRONTEND:
function renderMedia(d, tweetUrl) {
    // ... dein restlicher Code ...
    if (d.formats && d.formats.length) {
        d.formats.forEach((f, i) => {
            const a = document.createElement('a');
            // Hier wird das Passwort (pw) korrekt an die URL angehängt
            a.href = \`/download?url=\${encodeURIComponent(tweetUrl)}&q=\${f.height}&pw=\${encodeURIComponent(_pw)}\`;
            a.className = 'dl' + (i === 0 ? ' p' : '');
            a.innerHTML = \`<div class="dl-l"><div class="dl-i">↓</div><div><div class="dl-t">\${f.quality}</div><div class="dl-s">MP4</div></div></div>\`;
            c.appendChild(a);
        });
    }
}
</script>
`;
