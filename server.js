const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const mime = require('mime-types');
const crypto = require('crypto');
const metadata = require('./metadata-store');

const app = express();
const PORT = process.env.PORT || 3000;
const VIDEO_ROOT = process.env.VIDEO_ROOT || '/mnt/pcloud/My Videos';
const ROOT_RESOLVED = path.resolve(VIDEO_ROOT);
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const ACCESS_COOKIE = 'pcloud_video_session';
const ACCESS_COOKIE_MAX_AGE = 12 * 60 * 60;
if (ACCESS_TOKEN && Buffer.byteLength(ACCESS_TOKEN) < 32) {
  throw new Error('ACCESS_TOKEN must contain at least 32 bytes');
}
const ALLOWED_ORIGINS = new Set((process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid CORS_ORIGINS entry: ${value}`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) {
    throw new Error(`CORS_ORIGINS entries must be exact HTTP(S) origins: ${value}`);
  }
  return value;
}));

function constantTimeEqual(expected, supplied) {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

function expectedSessionValue() {
  return crypto.createHmac('sha256', ACCESS_TOKEN).update('pcloud-video-session-v1').digest('base64url');
}

function hasValidSession(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  const cookie = cookies.map(value => value.trim()).find(value => value.startsWith(`${ACCESS_COOKIE}=`));
  if (!cookie) return false;
  try {
    return constantTimeEqual(expectedSessionValue(), decodeURIComponent(cookie.slice(ACCESS_COOKIE.length + 1)));
  } catch {
    return false;
  }
}

function sameOrigin(req, origin) {
  try {
    const parsed = new URL(origin);
    return parsed.host === req.get('host') && parsed.protocol === `${req.protocol}:`;
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (!origin || sameOrigin(req, origin)) return next();
  if (ALLOWED_ORIGINS.has(origin)) return cors({ origin, credentials: true })(req, res, next);
  return res.status(403).json({ error: 'Origin not allowed' });
});
app.use(express.json({ limit: '4kb' }));
app.use(express.static('public'));

app.get('/api/access/status', (req, res) => {
  res.json({ required: Boolean(ACCESS_TOKEN), authenticated: !ACCESS_TOKEN || hasValidSession(req) });
});

app.post('/api/access/session', (req, res) => {
  if (!ACCESS_TOKEN) return res.status(404).json({ error: 'Access authentication is not enabled' });
  const supplied = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!constantTimeEqual(ACCESS_TOKEN, supplied)) return res.status(401).json({ error: 'Unauthorized' });
  const secure = process.env.ACCESS_COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${ACCESS_COOKIE}=${expectedSessionValue()}; Path=/; Max-Age=${ACCESS_COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict${secure}`);
  res.json({ authenticated: true });
});

app.delete('/api/access/session', (_req, res) => {
  const secure = process.env.ACCESS_COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${ACCESS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`);
  res.status(204).end();
});

app.use('/api', (req, res, next) => {
  if (!ACCESS_TOKEN || hasValidSession(req)) return next();
  res.status(401).json({ error: 'Authentication required' });
});

// Helper: safely resolve path within VIDEO_ROOT
function safeResolve(requestedPath) {
  if (typeof requestedPath !== 'string' || path.isAbsolute(requestedPath)) return null;
  const resolved = path.resolve(ROOT_RESOLVED, requestedPath);
  const relative = path.relative(ROOT_RESOLVED, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  try {
    const realRoot = fs.realpathSync(ROOT_RESOLVED);
    const realPath = fs.realpathSync(resolved);
    const realRelative = path.relative(realRoot, realPath);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`)) return null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resolved;
}

app.get('/api/index/status', (_req, res) => {
  res.json(metadata.status());
});

app.get('/api/people', (_req, res) => {
  res.json({ items: metadata.listPeople() });
});

app.get('/api/search', (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 100);
  const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
  const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;
  const personIdRaw = req.query.person_id;
  const personId = personIdRaw === undefined ? null : /^\d+$/.test(String(personIdRaw)) ? Number(personIdRaw) : NaN;
  if (personId !== null && (!Number.isSafeInteger(personId) || personId < 1)) {
    return res.status(400).json({ error: 'Invalid person_id' });
  }
  const folder = req.query.folder === undefined || req.query.folder === '' ? null : req.query.folder;
  if (folder !== null && (typeof folder !== 'string' || folder.length > 1000 || !safeResolve(folder))) {
    return res.status(400).json({ error: 'Invalid folder' });
  }
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  res.json({ items: metadata.search({ query, from, to, personId, folder, limit, offset }), limit, offset });
});

app.get('/api/metadata', (req, res) => {
  const relativePath = req.query.path;
  if (!relativePath || !safeResolve(relativePath)) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const row = metadata.getByPath.get(relativePath);
  if (!row) return res.status(404).json({ error: 'Video not indexed' });
  res.json({
    ...metadata.parseVideo(row),
    identified_people: metadata.identifiedPeopleForVideo(row.id),
    stale_identifications: metadata.staleIdentificationsForVideo(row.id),
    can_edit_people: Boolean(process.env.METADATA_EDIT_TOKEN)
  });
});

function authorizeMetadataEdit(req, res) {
  const expected = process.env.METADATA_EDIT_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'Editing is not configured' });
    return false;
  }
  const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  if (expectedBytes.length !== suppliedBytes.length || !crypto.timingSafeEqual(expectedBytes, suppliedBytes)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.put('/api/metadata/person', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const { path: relativePath, observation_index: observationIndex, person_id: personId, person_name: personName } = req.body || {};
  const stale = req.body?.stale_observation;
  if (typeof relativePath !== 'string' || !safeResolve(relativePath) ||
      !Number.isInteger(observationIndex) || observationIndex < 0 ||
      (personId != null && !Number.isInteger(personId)) ||
      (personName != null && (typeof personName !== 'string' || personName.trim().length > 80)) ||
      (stale != null && (typeof stale.analysis_revision !== 'string' || stale.analysis_revision.length > 200 ||
        !Number.isInteger(stale.observation_index) || stale.observation_index < 0))) {
    return res.status(400).json({ error: 'Invalid video, observation, or person' });
  }
  try {
    const person = metadata.setVideoPerson({
      relativePath, observationIndex, personId, personName,
      staleObservation: stale ? {
        analysisRevision: stale.analysis_revision,
        observationIndex: stale.observation_index
      } : undefined
    });
    if (person === false) return res.status(404).json({ error: 'Video or observation not found' });
    res.json({ person, people: metadata.listPeople() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/metadata/people', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const relativePath = req.body?.path;
  const names = req.body?.names;
  if (!relativePath || !safeResolve(relativePath) || !Array.isArray(names) || names.length > 20 ||
      names.some(name => typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80)) {
    return res.status(400).json({ error: 'Invalid path or names' });
  }
  const uniqueNames = [...new Set(names.map(name => name.trim()))];
  if (!metadata.setConfirmedPeople(relativePath, uniqueNames)) {
    return res.status(404).json({ error: 'Video not indexed' });
  }
  res.json({ names: uniqueNames });
});

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
