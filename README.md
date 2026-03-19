# XSave Server

X/Twitter Video Downloader — eigener Server mit yt-dlp.

## Setup (10 Minuten)

### 1. GitHub Account
→ https://github.com — kostenlos registrieren

### 2. Neues Repository erstellen
- Auf GitHub: "+ New repository"
- Name: `xsave-server`
- Public oder Private (egal)
- "Create repository"

### 3. Dateien hochladen
- Alle Dateien aus diesem Ordner auf GitHub hochladen
- Entweder per GitHub Desktop oder per Drag & Drop im Browser

### 4. Railway Account
→ https://railway.app — kostenlos mit GitHub einloggen

### 5. Projekt deployen
- "New Project" → "Deploy from GitHub repo"
- `xsave-server` auswählen
- Railway erkennt nixpacks.toml automatisch
- yt-dlp + ffmpeg werden automatisch installiert
- Warten bis Build fertig ist (~3 Min)

### 6. Domain holen
- Im Railway Dashboard: Settings → Networking → "Generate Domain"
- Du bekommst eine URL wie: `https://xsave-server-production.up.railway.app`

### 7. PWA auf iPhone
- Diese URL in Safari öffnen
- Teilen → Zum Home-Bildschirm
- ✅ Fertig — echte App mit eigenem Backend!

## Wie es funktioniert
```
iPhone PWA → POST /info → Server → yt-dlp → Video-Links zurück
iPhone PWA → GET /download → Server streamt Video → gespeichert
```

## Kosten
- Railway: $5 Guthaben gratis beim Start (reicht für Monate bei privatem Gebrauch)
- Danach: ~$0.50-2/Monat je nach Nutzung
