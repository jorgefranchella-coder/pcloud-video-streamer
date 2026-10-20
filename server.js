const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const mime = require('mime-types');

const app = express();
const PORT = process.env.PORT || 3000;
const VIDEO_ROOT = process.env.VIDEO_ROOT || '/mnt/pcloud/My Videos';

app.use(cors());
app.use(express.static('public'));

// Helper: safely resolve path within VIDEO_ROOT
function safeResolve(requestedPath) {
  const resolved = path.resolve(VIDEO_ROOT, requestedPath);
  const rootResolved = path.resolve(VIDEO_ROOT);
  if (!resolved.startsWith(rootResolved)) {
    return null;
  }
  return resolved;
}

// GET /api/list?path=relative/path - List directory contents
app.get('/api/list', async (req, res) => {
  const relativePath = req.query.path || '';
  const fullPath = safeResolve(relativePath);
  
  if (!fullPath) {
    return res.status(403).json({ error: 'Forbidden: path traversal attempt' });
  }
  
  try {
    const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
    const items = entries
      .filter(entry => entry.isDirectory() || isVideoFile(entry.name))
      .map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'folder' : 'video',
        path: path.join(relativePath, entry.name).replace(/\\/g, '/')
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: relativePath, items });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Directory not found' });
    }
    console.error('List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stream?path=relative/path - Stream video with Range Requests
app.get('/api/stream', async (req, res) => {
  const relativePath = req.query.path;
  if (!relativePath) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }
  
  const fullPath = safeResolve(relativePath);
  if (!fullPath) {
    return res.status(403).json({ error: 'Forbidden: path traversal attempt' });
  }
  
  try {
    const stat = await fs.promises.stat(fullPath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'Not a file' });
    }
    
    const fileSize = stat.size;
    const range = req.headers.range;
    
    if (!range) {
      // No range header - serve whole file (or first chunk for large files)
      const contentType = mime.lookup(fullPath) || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Accept-Ranges', 'bytes');
      
      const stream = fs.createReadStream(fullPath);
      stream.pipe(res);
      return;
    }
    
    // Parse Range header: bytes=start-end
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    
    // Validate range
    if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).json({ error: 'Range not satisfiable' });
    }
    
    const chunkSize = end - start + 1;
    const contentType = mime.lookup(fullPath) || 'application/octet-stream';
    
    res.status(206);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', chunkSize);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    
    const stream = fs.createReadStream(fullPath, { start, end });
    stream.pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    console.error('Stream error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function isVideoFile(filename) {
  const videoExtensions = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg'];
  const ext = path.extname(filename).toLowerCase();
  return videoExtensions.includes(ext);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Video root: ${VIDEO_ROOT}`);
});