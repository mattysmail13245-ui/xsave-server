const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const TMP = '/tmp/xsave';

app.use(cors());
app.use(express.json());

// Serve the PWA
app.use(express.static('public'));

// Ensure tmp dir exists
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// ── GET /info — tweet info + download links ───────────────────────
app.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url || !/x\.com|twitter\.com/i.test(url)) {
    return res.status(400).json({ error: 'Ungültige URL' });
  }

  const cmd = `yt-dlp --dump-json --no-playlist "${url}" 2>&1`;

  exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp error:', stderr || err.message);
      return res.status(500).json({ error: 'Kein Video gefunden oder privater Tweet.' });
    }

    try {
      const info = JSON.parse(stdout.trim().split('\n')[0]);

      const formats = (info.formats || [])
        .filter(f => f.ext === 'mp4' && f.url)
        .map(f => ({
          quality: f.format_note || f.height ? `${f.height}p` : 'SD',
          height: f.height || 0,
          url: f.url,
          filesize: f.filesize,
        }))
        .sort((a, b) => b.height - a.height);

      // Deduplicate by quality
      const seen = new Set();
      const unique = formats.filter(f => {
        if (seen.has(f.quality)) return false;
        seen.add(f.quality);
        return true;
      });

      // Thumbnail
      const thumb = info.thumbnail || (info.thumbnails && info.thumbnails[0]?.url) || null;

      res.json({
        title: info.title || '',
        uploader: info.uploader || info.uploader_id || '',
        thumbnail: thumb,
        duration: info.duration,
        formats: unique.length > 0 ? unique : [{
          quality: 'Best',
          height: 0,
          url: info.url,
          filesize: null
        }]
      });

    } catch (e) {
      res.status(500).json({ error: 'Fehler beim Parsen der Video-Infos.' });
    }
  });
});

// ── GET /download — proxy download so PWA can save it ────────────
app.get('/download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).send('Keine URL');

  const fname = (filename || 'video') + '.mp4';
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.setHeader('Content-Type', 'video/mp4');

  const cmd = `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" -o - "${url}" 2>/dev/null`;

  const proc = exec(cmd, { maxBuffer: 500 * 1024 * 1024 });
  proc.stdout.pipe(res);
  proc.stderr.on('data', d => console.error('yt-dlp:', d));
  proc.on('error', err => {
    console.error('Proc error:', err);
    if (!res.headersSent) res.status(500).send('Download fehlgeschlagen');
  });
});

// Health check
app.get('/health', (_, res) => res.json({ ok: true, version: '1.0' }));

app.listen(PORT, () => console.log(`XSave Server läuft auf Port ${PORT}`));
