# pCloud Video Streamer

Lightweight self-hosted web application to browse and stream videos from a pCloud-mounted directory on a Linux server.

## Features

- 📁 **Folder browser** - Navigate directory tree with lazy-loading
- 🎬 **Video streaming** - HTTP Range Requests for seeking/buffering
- 📱 **Responsive UI** - Tailwind CSS dark mode, mobile-friendly sidebar
- 🔒 **Secure** - Path traversal protection
- 🐳 **Docker ready** - Multi-stage build, non-root user
- ⚙️ **systemd service** - Auto-start on boot

## Quick Start

### 1. Mount pCloud with rclone

```bash
# Configure rclone (one-time)
rclone config  # create remote named "pcloud"

# Create systemd mount service
sudo cp rclone-pcloud.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rclone-pcloud
```

### 2. Run the streamer

**Development:**
```bash
npm install
VIDEO_ROOT=/mnt/pcloud/My\ Videos PORT=3001 node server.js
```

**Production (systemd):**
```bash
sudo cp pcloud-video-streamer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pcloud-video-streamer
```

**Docker:**
```bash
docker build -t pcloud-video-streamer .
docker run -d \
  --name pcloud-streamer \
  -p 3000:3000 \
  -v /mnt/pcloud/My\ Videos:/mnt/pcloud/My\ Videos \
  -e VIDEO_ROOT=/mnt/pcloud/My\ Videos \
  --restart unless-stopped \
  pcloud-video-streamer
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/list?path=relative/path` | List directory contents |
| GET | `/api/stream?path=relative/path` | Stream video (supports Range requests) |

## Project Structure

```
├── server.js              # Express backend with Range Request support
├── public/
│   ├── index.html         # Tailwind CSS + HTML5 video player
│   └── app.js             # Vanilla JS folder tree + player logic
├── Dockerfile             # Multi-stage production build
├── .dockerignore
├── package.json
├── pcloud-video-streamer.service  # systemd service
├── rclone-pcloud.service          # systemd mount service
└── docs/plans/            # Implementation plan
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `VIDEO_ROOT` | `/mnt/pcloud/My Videos` | Mounted pCloud path |

## Supported Video Formats

MP4, MKV, WebM, MOV, AVI, M4V, FLV, WMV, MPG, MPEG

## Requirements

- Node.js 18+
- rclone (for pCloud mount)
- Linux with FUSE support
- systemd (for services)

## License

MIT