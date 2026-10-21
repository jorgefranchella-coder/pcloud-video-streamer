const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const mime = require('mime-types');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const metadata = require('./metadata-store');

const app = express();
app.disable('x-powered-by');
const portRaw = process.env.PORT;
const PORT = portRaw === undefined ? 3000 : /^\d+$/.test(portRaw) ? Number(portRaw) : NaN;
if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
const VIDEO_ROOT = process.env.VIDEO_ROOT || '/mnt/pcloud/My Videos';
const ROOT_RESOLVED = path.resolve(VIDEO_ROOT);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const execFileAsync = promisify(execFile);
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const ACCESS_COOKIE_SECURE = process.env.ACCESS_COOKIE_SECURE || '0';
const ACCESS_COOKIE_SAMESITE = process.env.ACCESS_COOKIE_SAMESITE || 'Strict';
const ACCESS_COOKIE = 'pcloud_video_session';
const ACCESS_COOKIE_MAX_AGE = 12 * 60 * 60;
if (!['0', '1'].includes(ACCESS_COOKIE_SECURE)) {
  throw new Error('ACCESS_COOKIE_SECURE must be 0 or 1');
}
if (!['Strict', 'Lax', 'None'].includes(ACCESS_COOKIE_SAMESITE)) {
  throw new Error('ACCESS_COOKIE_SAMESITE must be Strict, Lax, or None');
}
if (ACCESS_COOKIE_SAMESITE === 'None' && ACCESS_COOKIE_SECURE !== '1') {
  throw new Error('ACCESS_COOKIE_SAMESITE=None requires ACCESS_COOKIE_SECURE=1');
}
if (ACCESS_TOKEN && Buffer.byteLength(ACCESS_TOKEN) < 32) {
  throw new Error('ACCESS_TOKEN must contain at least 32 bytes');
}
if (process.env.METADATA_EDIT_TOKEN && Buffer.byteLength(process.env.METADATA_EDIT_TOKEN) < 32) {
  throw new Error('METADATA_EDIT_TOKEN must contain at least 32 bytes');
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

function sessionSignature(expiresAt) {
  return crypto.createHmac('sha256', ACCESS_TOKEN)
    .update(`pcloud-video-session-v1:${expiresAt}`).digest('base64url');
}

function createSessionValue() {
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_COOKIE_MAX_AGE;
  return `${expiresAt}.${sessionSignature(expiresAt)}`;
}

function hasValidSession(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  const cookie = cookies.map(value => value.trim()).find(value => value.startsWith(`${ACCESS_COOKIE}=`));
  if (!cookie) return false;
  try {
    const value = decodeURIComponent(cookie.slice(ACCESS_COOKIE.length + 1));
    const separator = value.indexOf('.');
    if (separator < 1 || value.indexOf('.', separator + 1) !== -1) return false;
    const expiresText = value.slice(0, separator);
    if (!/^\d+$/.test(expiresText)) return false;
    const expiresAt = Number(expiresText);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
    return constantTimeEqual(sessionSignature(expiresAt), value.slice(separator + 1));
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
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdn.tailwindcss.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "media-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/access/status', (req, res) => {
  res.json({ required: Boolean(ACCESS_TOKEN), authenticated: !ACCESS_TOKEN || hasValidSession(req) });
});

app.post('/api/access/session', (req, res) => {
  if (!ACCESS_TOKEN) return res.status(404).json({ error: 'Access authentication is not enabled' });
  const supplied = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!constantTimeEqual(ACCESS_TOKEN, supplied)) return res.status(401).json({ error: 'Unauthorized' });
  const secure = ACCESS_COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${ACCESS_COOKIE}=${createSessionValue()}; Path=/; Max-Age=${ACCESS_COOKIE_MAX_AGE}; HttpOnly; SameSite=${ACCESS_COOKIE_SAMESITE}${secure}`);
  res.json({ authenticated: true });
});

app.delete('/api/access/session', (_req, res) => {
  const secure = ACCESS_COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${ACCESS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=${ACCESS_COOKIE_SAMESITE}${secure}`);
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

let visualTimerStatusCache = { checkedAt: 0, value: null };
async function getVisualTimerStatus() {
  if (visualTimerStatusCache.value && Date.now() - visualTimerStatusCache.checkedAt < 10000) {
    return visualTimerStatusCache.value;
  }
  let value;
  try {
    const { stdout } = await execFileAsync('systemctl', [
      'show', 'pcloud-video-visual.timer',
      '--property=LoadState,ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec',
      '--no-pager'
    ], { timeout: 2000, maxBuffer: 10000 });
    const fields = Object.fromEntries(stdout.trim().split('\n').map(line => {
      const separator = line.indexOf('=');
      return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    value = {
      available: fields.LoadState === 'loaded',
      load_state: fields.LoadState || 'unknown',
      active: fields.ActiveState === 'active',
      enabled: fields.UnitFileState === 'enabled',
      next_run: fields.NextElapseUSecRealtime || null,
      last_run: fields.LastTriggerUSec || null
    };
  } catch {
    value = { available: false, load_state: 'unknown', active: false, enabled: false, next_run: null, last_run: null };
  }
  visualTimerStatusCache = { checkedAt: Date.now(), value };
  return value;
}

app.get('/api/index/status', async (_req, res) => {
  res.json({ ...metadata.status(), visual_timer: await getVisualTimerStatus() });
});

app.get('/api/people', (_req, res) => {
  res.json({ items: metadata.listPeople(), merges: metadata.listPersonMerges(),
    can_edit_people: Boolean(process.env.METADATA_EDIT_TOKEN) });
});

app.patch('/api/people/:id/merge', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const sourceId = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
  const targetId = Number.isSafeInteger(req.body?.target_person_id) ? req.body.target_person_id : NaN;
  if (!Number.isSafeInteger(sourceId) || sourceId < 1 || !Number.isSafeInteger(targetId) || targetId < 1) {
    return res.status(400).json({ error: 'Invalid source or target person ID' });
  }
  try {
    const merge = metadata.mergePeople(sourceId, targetId);
    if (!merge) return res.status(404).json({ error: 'Source or target person not found' });
    res.json({ merge, items: metadata.listPeople(), merges: metadata.listPersonMerges() });
  } catch (error) {
    const conflict = error.message.includes('fusión activa');
    res.status(conflict ? 409 : 400).json({ error: error.message });
  }
});

app.post('/api/people/merges/:id/undo', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const mergeId = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
  if (!Number.isSafeInteger(mergeId) || mergeId < 1) return res.status(400).json({ error: 'Invalid merge ID' });
  try {
    const merge = metadata.undoPeopleMerge(mergeId);
    if (!merge) return res.status(404).json({ error: 'Active merge not found' });
    res.json({ merge, items: metadata.listPeople(), merges: metadata.listPersonMerges() });
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

app.patch('/api/people/:id', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
  const name = req.body?.name;
  if (!Number.isSafeInteger(id) || id < 1 || typeof name !== 'string') {
    return res.status(400).json({ error: 'Invalid person ID or name' });
  }
  try {
    const person = metadata.renamePerson(id, name);
    if (!person) return res.status(404).json({ error: 'Person not found' });
    res.json({ person, items: metadata.listPeople(), merges: metadata.listPersonMerges() });
  } catch (error) {
    res.status(error.message.startsWith('Ya existe') ? 409 : 400).json({ error: error.message });
  }
});

app.get('/api/search', (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 100);
  const isDate = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  const fromRaw = req.query.from;
  const toRaw = req.query.to;
  if ((fromRaw !== undefined && fromRaw !== '' && !isDate(fromRaw))
    || (toRaw !== undefined && toRaw !== '' && !isDate(toRaw))) {
    return res.status(400).json({ error: 'from and to must be valid dates in YYYY-MM-DD format' });
  }
  const from = fromRaw || null;
  const to = toRaw || null;
  if (from && to && from > to) return res.status(400).json({ error: 'from must not be after to' });
  const personIdRaw = req.query.person_id;
  const personId = personIdRaw === undefined ? null : /^\d+$/.test(String(personIdRaw)) ? Number(personIdRaw) : NaN;
  if (personId !== null && (!Number.isSafeInteger(personId) || personId < 1)) {
    return res.status(400).json({ error: 'Invalid person_id' });
  }
  const folder = req.query.folder === undefined || req.query.folder === '' ? null : req.query.folder;
  if (folder !== null && (typeof folder !== 'string' || folder.length > 1000 || !safeResolve(folder))) {
    return res.status(400).json({ error: 'Invalid folder' });
  }
  const limitRaw = req.query.limit;
  const offsetRaw = req.query.offset;
  const limit = limitRaw === undefined ? 50
    : typeof limitRaw === 'string' && /^\d+$/.test(limitRaw) ? Number(limitRaw) : NaN;
  const offset = offsetRaw === undefined ? 0
    : typeof offsetRaw === 'string' && /^\d+$/.test(offsetRaw) ? Number(offsetRaw) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
    return res.status(400).json({ error: 'offset must be an integer between 0 and 1000000' });
  }
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
    identity_history: metadata.identityHistoryForVideo(row.id),
    can_edit_people: Boolean(process.env.METADATA_EDIT_TOKEN)
  });
});

app.get('/api/metadata/evidence', async (req, res) => {
  const relativePath = req.query.path;
  const revision = req.query.revision;
  const atSeconds = typeof req.query.at_seconds === 'string' && /^(0|[1-9]\d{0,5})$/.test(req.query.at_seconds)
    ? Number(req.query.at_seconds) : NaN;
  if (typeof relativePath !== 'string' || !safeResolve(relativePath) ||
      typeof revision !== 'string' || !/^[0-9a-f-]{36}$/i.test(revision) || !Number.isSafeInteger(atSeconds)) {
    return res.status(400).json({ error: 'Invalid evidence request' });
  }
  const row = metadata.getByPath.get(relativePath);
  if (!row) return res.status(404).json({ error: 'Evidence not found' });
  let currentEvidence = false;
  if (row.visual_revision === revision && row.visual_fingerprint === row.fingerprint) {
    try { currentEvidence = JSON.parse(row.visual_evidence_json || '[]').some(item => item.at_seconds === atSeconds); }
    catch { currentEvidence = false; }
  }
  const staleEvidence = !currentEvidence && Boolean(metadata.db.prepare(`SELECT 1 FROM video_person_observations
    WHERE video_id = ? AND analysis_revision = ? AND at_seconds = ? AND reviewed_at IS NULL
      AND analysis_revision != COALESCE(?, '') LIMIT 1`)
    .get(row.id, revision, atSeconds, row.visual_revision));
  if (!currentEvidence && !staleEvidence) return res.status(404).json({ error: 'Evidence not found' });
  const imagePath = path.join(DATA_DIR, 'evidence', String(row.id), revision, `${atSeconds}.jpg`);
  try {
    const stat = await fs.promises.stat(imagePath);
    if (!stat.isFile() || stat.size > 700000) return res.status(404).json({ error: 'Evidence not found' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    pipeFileStream(imagePath, {}, res);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Evidence not found' });
    console.error('Evidence access error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
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

app.post('/api/metadata/person/review-stale', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const { path: relativePath, analysis_revision: analysisRevision, observation_index: observationIndex } = req.body || {};
  if (typeof relativePath !== 'string' || !safeResolve(relativePath) ||
      typeof analysisRevision !== 'string' || !analysisRevision || analysisRevision.length > 200 ||
      !Number.isInteger(observationIndex) || observationIndex < 0) {
    return res.status(400).json({ error: 'Invalid video or stale observation' });
  }
  try {
    const dismissed = metadata.dismissStaleIdentification({ relativePath, analysisRevision, observationIndex });
    if (!dismissed) return res.status(404).json({ error: 'Pending stale identification not found' });
    res.json({ dismissed: true });
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

function parseByteRange(header, fileSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(fileSize - suffixLength, 0), end: fileSize - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= fileSize || start > requestedEnd) return null;
  return { start, end: Math.min(requestedEnd, fileSize - 1) };
}

function pipeFileStream(fullPath, options, res) {
  const stream = fs.createReadStream(fullPath, options);
  stream.on('error', error => {
    console.error('Stream read error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    else res.destroy();
  });
  res.on('close', () => {
    if (!res.writableEnded) stream.destroy();
  });
  stream.pipe(res);
}

// GET /api/stream?path=relative/path - Stream video with Range Requests
app.get('/api/stream', async (req, res) => {
  const relativePath = req.query.path;
  if (typeof relativePath !== 'string' || !relativePath) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }
  if (!isVideoFile(relativePath)) return res.status(400).json({ error: 'Unsupported video file type' });
  
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
      // No range header: serve the complete file.
      const contentType = mime.lookup(fullPath) || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Accept-Ranges', 'bytes');
      
      pipeFileStream(fullPath, {}, res);
      return;
    }
    
    const parsedRange = parseByteRange(range, fileSize);
    if (!parsedRange) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).json({ error: 'Range not satisfiable' });
    }
    const { start, end } = parsedRange;
    const chunkSize = end - start + 1;
    const contentType = mime.lookup(fullPath) || 'application/octet-stream';
    
    res.status(206);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', chunkSize);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    
    pipeFileStream(fullPath, { start, end }, res);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    console.error('Stream error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use((error, req, res, next) => {
  if (!req.path.startsWith('/api/')) return next(error);
  if (res.headersSent) return next(error);
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error('API request error:', error.message);
  return res.status(500).json({ error: 'Internal server error' });
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
