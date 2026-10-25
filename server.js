const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const mime = require('mime-types');
const crypto = require('crypto');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const metadata = require('./metadata-store');
const { faceConfiguration } = require('./config');
const jellyfin = require('./jellyfin-sync');
const refinement = require('./refinement-store');

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
const manualProcessRuns = new Map();
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const ACCESS_COOKIE_SECURE = process.env.ACCESS_COOKIE_SECURE === undefined ? '0' : process.env.ACCESS_COOKIE_SECURE;
const ACCESS_COOKIE_SAMESITE = process.env.ACCESS_COOKIE_SAMESITE === undefined ? 'Strict' : process.env.ACCESS_COOKIE_SAMESITE;
const ACCESS_COOKIE = 'pcloud_video_session';
const ACCESS_COOKIE_MAX_AGE = process.env.ACCESS_COOKIE_MAX_AGE_SECONDS === undefined
  ? 30 * 24 * 60 * 60 : Number(process.env.ACCESS_COOKIE_MAX_AGE_SECONDS);
if (!Number.isSafeInteger(ACCESS_COOKIE_MAX_AGE) || ACCESS_COOKIE_MAX_AGE < 60 * 60 || ACCESS_COOKIE_MAX_AGE > 365 * 24 * 60 * 60) {
  throw new Error('ACCESS_COOKIE_MAX_AGE_SECONDS must be an integer between 3600 and 31536000');
}
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
    const requestOrigin = new URL(`${req.protocol}://${req.get('host')}`);
    return parsed.origin === requestOrigin.origin;
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
  if (typeof requestedPath !== 'string' || requestedPath.length > 4096
    || requestedPath.includes('\0') || path.isAbsolute(requestedPath)) return null;
  const resolved = path.resolve(ROOT_RESOLVED, requestedPath);
  const relative = path.relative(ROOT_RESOLVED, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  try {
    const realRoot = fs.realpathSync(ROOT_RESOLVED);
    const realPath = fs.realpathSync(resolved);
    const realRelative = path.relative(realRoot, realPath);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`)) return null;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EINVAL', 'ENAMETOOLONG', 'ERR_INVALID_ARG_VALUE'].includes(error.code)) throw error;
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

let faceTimerStatusCache = { checkedAt: 0, value: null };
async function getFaceTimerStatus() {
  if (faceTimerStatusCache.value && Date.now() - faceTimerStatusCache.checkedAt < 10000) {
    return faceTimerStatusCache.value;
  }
  let value;
  try {
    const { stdout } = await execFileAsync('systemctl', [
      'show', 'pcloud-video-face-indexer.timer',
      '--property=LoadState,ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec', '--no-pager'
    ], { timeout: 2000, maxBuffer: 10000 });
    const fields = Object.fromEntries(stdout.trim().split('\n').map(line => {
      const separator = line.indexOf('=');
      return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    value = {
      available: fields.LoadState === 'loaded', load_state: fields.LoadState || 'unknown',
      active: fields.ActiveState === 'active', enabled: fields.UnitFileState === 'enabled',
      next_run: fields.NextElapseUSecRealtime || null, last_run: fields.LastTriggerUSec || null
    };
  } catch {
    value = { available: false, load_state: 'unknown', active: false, enabled: false, next_run: null, last_run: null };
  }
  faceTimerStatusCache = { checkedAt: Date.now(), value };
  return value;
}

async function getPipelineTimerStatus() {
  try {
    const { stdout } = await execFileAsync('systemctl', [
      'show', 'pcloud-video-pipeline.timer',
      '--property=LoadState,ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec',
      '--no-pager'
    ], { timeout: 2000, maxBuffer: 10000 });
    const fields = Object.fromEntries(stdout.trim().split('\n').map(line => {
      const separator = line.indexOf('=');
      return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return {
      available: fields.LoadState === 'loaded', load_state: fields.LoadState || 'unknown',
      active: fields.ActiveState === 'active', enabled: fields.UnitFileState === 'enabled',
      next_run: fields.NextElapseUSecRealtime || null, last_run: fields.LastTriggerUSec || null
    };
  } catch {
    return { available: false, load_state: 'unknown', active: false, enabled: false, next_run: null, last_run: null };
  }
}

async function getRefinementTimerStatus() {
  try {
    const { stdout } = await execFileAsync('systemctl', [
      'show', 'pcloud-video-refinement.timer',
      '--property=LoadState,ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec', '--no-pager'
    ], { timeout: 2000, maxBuffer: 10000 });
    const fields = Object.fromEntries(stdout.trim().split('\n').map(line => {
      const separator = line.indexOf('=');
      return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return {
      available: fields.LoadState === 'loaded', load_state: fields.LoadState || 'unknown',
      active: fields.ActiveState === 'active', enabled: fields.UnitFileState === 'enabled',
      next_run: fields.NextElapseUSecRealtime || null, last_run: fields.LastTriggerUSec || null
    };
  } catch {
    return { available: false, load_state: 'unknown', active: false, enabled: false, next_run: null, last_run: null };
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get('/api/index/status', asyncRoute(async (_req, res) => {
  const [visualTimer, pipelineTimer, faceTimer, refinementTimer] = await Promise.all([
    getVisualTimerStatus(), getPipelineTimerStatus(), getFaceTimerStatus(), getRefinementTimerStatus()
  ]);
  res.json({ ...metadata.status(), visual_timer: visualTimer, pipeline_timer: pipelineTimer,
    face_timer: faceTimer, refinement_timer: refinementTimer, refinement_progress: refinement.progress(),
    can_control_automation: Boolean(process.env.METADATA_EDIT_TOKEN),
    manual_process_runs: [...manualProcessRuns.values()] });
}));

app.post('/api/index/control', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  if (typeof req.body?.paused !== 'boolean') return res.status(400).json({ error: 'paused must be a boolean' });
  res.json({ automation_control: metadata.setAutomationPaused(req.body.paused) });
});

const manualProcessDefinitions = {
  technical: { label: 'inventario técnico', script: 'indexer.js', worker: 'indexer' },
  visual: { label: 'fichas visuales', script: 'visual-analyzer.js', worker: 'visual-analyzer' },
  faces: { label: 'indexación local de rostros', script: 'face-indexer.js', worker: 'face-embedding-indexer' },
  refinement: { label: 'redacción de fichas', script: 'refinement-worker.js', worker: 'refinement-writer' },
  pipeline: { label: 'pipeline técnico y visual', script: 'pipeline.js', worker: 'pipeline' }
};

function manualProcessEnvironment(processName) {
  const env = { ...process.env };
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  for (const name of Object.keys(env)) {
    if (['ACCESS_TOKEN', 'METADATA_EDIT_TOKEN', 'CORS_ORIGINS'].includes(name) || name.startsWith('JELLYFIN_')) delete env[name];
  }
  if (!['visual', 'refinement', 'pipeline'].includes(processName)) {
    delete env.OPENROUTER_API_KEY;
    delete env.OPENROUTER_API_URL;
    delete env.OPENROUTER_MODEL;
  }
  if (processName === 'visual' || processName === 'pipeline') {
    env.MAX_VISUAL ||= '5';
    env.RETRY_VISUAL_FAILED ||= '1';
  }
  if (processName === 'faces') {
    env.FACE_INDEXING_ENABLED = '1';
    env.FACE_PYTHON ||= path.join(dataDir, 'face-runtime', 'bin', 'python');
    env.FACE_MODEL_DIR ||= path.join(dataDir, 'models', 'faces');
    env.FACE_MAX_VIDEOS ||= '10';
    env.FACE_SAMPLE_INTERVAL_SECONDS ||= '20';
    env.FACE_MAX_FRAMES_PER_VIDEO ||= '24';
    env.FACE_MAX_DIMENSION ||= '960';
    env.FACE_MIN_FACE_SIZE ||= '48';
    env.FACE_DETECTION_THRESHOLD ||= '0.75';
    env.FACE_RETRY_FAILED ||= '0';
  }
  if (processName === 'refinement') {
    env.MAX_REFINEMENTS ||= '5';
    env.MAX_REFINEMENT_REQUESTS_PER_DAY ||= '30';
  }
  return env;
}

app.post('/api/index/run', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const processName = req.body?.process;
  const definition = manualProcessDefinitions[processName];
  if (!definition) return res.status(400).json({ error: 'Unknown process' });
  if (metadata.getAutomationControl().paused) {
    return res.status(409).json({ error: 'El procesamiento está pausado. Reanudalo antes de iniciar una tarea.' });
  }
  if (['visual', 'refinement', 'pipeline'].includes(processName) && !process.env.OPENROUTER_API_KEY) {
    return res.status(503).json({ error: 'Falta configurar OPENROUTER_API_KEY en el servicio web.' });
  }
  const providerControl = metadata.getVisualProviderControl();
  if (processName === 'visual' && providerControl &&
      (!providerControl.paused_until || new Date(`${providerControl.paused_until.replace(' ', 'T')}Z`).getTime() > Date.now())) {
    return res.status(409).json({ error: `El proveedor visual está pausado: ${providerControl.reason}` });
  }
  if ([...manualProcessRuns.values()].some(run => ['starting', 'running'].includes(run.status))) {
    return res.status(409).json({ error: 'Ya hay una ejecución manual iniciada.' });
  }
  const lock = metadata.db.prepare('SELECT owner_pid, owner_host FROM process_locks WHERE name = ?').get('video-library-pipeline');
  if (lock) {
    let ownerAlive = true;
    if (lock.owner_host === os.hostname()) {
      try { process.kill(lock.owner_pid, 0); }
      catch (error) { ownerAlive = error.code !== 'ESRCH'; }
    }
    if (ownerAlive) return res.status(409).json({ error: 'Otro proceso está trabajando en la biblioteca. Esperá a que termine y volvé a intentar.' });
  }

  const runId = crypto.randomUUID();
  const run = { id: runId, process: processName, label: definition.label, status: 'starting', started_at: new Date().toISOString() };
  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, definition.script)], {
      cwd: __dirname, env: manualProcessEnvironment(processName),
      stdio: ['ignore', 'inherit', 'inherit']
    });
  } catch (error) {
    console.error(`Could not start manual ${processName} process: ${error.message}`);
    return res.status(500).json({ error: 'No se pudo iniciar el proceso.' });
  }
  run.pid = child.pid || null;
  run.status = 'running';
  manualProcessRuns.set(runId, run);
  if (processName === 'faces' && child.pid) {
    try { os.setPriority(child.pid, 10); }
    catch (error) { console.warn(`Could not lower priority for manual face indexing: ${error.message}`); }
  }
  child.once('error', error => {
    console.error(`Manual ${processName} process failed to start: ${error.message}`);
    run.status = 'failed';
    run.finished_at = new Date().toISOString();
    setTimeout(() => manualProcessRuns.delete(runId), 60000).unref();
  });
  child.once('close', (code, signal) => {
    run.status = code === 0 ? 'done' : 'failed';
    run.exit_code = code;
    run.signal = signal;
    run.finished_at = new Date().toISOString();
    console.log(`Manual ${processName} process finished: ${run.status}${code == null ? ` (${signal || 'unknown signal'})` : ` (exit ${code})`}`);
    setTimeout(() => manualProcessRuns.delete(runId), 60000).unref();
  });
  res.status(202).json({ accepted: true, run });
});

app.get('/api/people', (_req, res) => {
  res.json({ items: metadata.listPeople(), merges: metadata.listPersonMerges(),
    can_edit_people: Boolean(process.env.METADATA_EDIT_TOKEN) });
});

app.get('/api/faces/inbox', (req, res) => {
  const afterId = req.query.after === undefined ? 0 : Number(req.query.after);
  const limit = req.query.limit === undefined ? 36 : Number(req.query.limit);
  if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
    return res.status(400).json({ error: 'Invalid face inbox page' });
  }
  const modelVersion = faceConfiguration().index_version;
  res.json({ ...metadata.listFaceInbox({ afterId, limit, modelVersion }),
    progress: metadata.faceProgress(modelVersion, faceConfiguration().model_version), can_edit_people: Boolean(process.env.METADATA_EDIT_TOKEN) });
});

app.get('/api/faces/automatic', (req, res) => {
  const afterId = req.query.after === undefined ? 0 : Number(req.query.after);
  const limit = req.query.limit === undefined ? 36 : Number(req.query.limit);
  if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
    return res.status(400).json({ error: 'Invalid automatic face page' });
  }
  const modelVersion = faceConfiguration().index_version;
  res.json({ ...metadata.listAutoAssignedFaces({ afterId, limit, modelVersion }),
    progress: metadata.faceProgress(modelVersion, faceConfiguration().model_version), can_edit_people: Boolean(process.env.METADATA_EDIT_TOKEN) });
});

app.get('/api/faces/:id/neighbors', (req, res) => {
  const faceId = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
  const limit = req.query.limit === undefined ? 24 : Number(req.query.limit);
  if (!Number.isSafeInteger(faceId) || faceId < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
    return res.status(400).json({ error: 'Invalid face or result limit' });
  }
  const faceConfig = faceConfiguration();
  const result = metadata.findFaceNeighbors(faceId, faceConfig.index_version, limit,
    faceConfig.suggestion_threshold, faceConfig.auto_assignment_threshold);
  if (!result) return res.status(404).json({ error: 'Face observation is no longer available' });
  res.json(result);
});

app.get('/api/faces/:id/preview', asyncRoute(async (req, res) => {
  const faceId = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
  if (!Number.isSafeInteger(faceId) || faceId < 1) return res.status(400).json({ error: 'Invalid face ID' });
  const face = metadata.getFaceObservation(faceId, faceConfiguration().index_version);
  if (!face || face.fingerprint !== face.current_fingerprint || !['done', 'failed'].includes(face.video_status)) {
    return res.status(404).json({ error: 'Face preview is no longer available' });
  }
  const safePath = safeResolve(face.relative_path);
  if (!safePath) return res.status(404).json({ error: 'Video not found' });
  try {
    const realPath = await fs.promises.realpath(safePath);
    const realRoot = await fs.promises.realpath(ROOT_RESOLVED);
    const relative = path.relative(realRoot, realPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return res.status(404).json({ error: 'Video not found' });
    }
    const stat = await fs.promises.stat(realPath);
    if (`${stat.size}:${Math.round(stat.mtimeMs)}` !== face.fingerprint) {
      return res.status(404).json({ error: 'Video changed since face indexing' });
    }
    const x = Math.max(0, Math.min(face.x, face.frame_width - 1));
    const y = Math.max(0, Math.min(face.y, face.frame_height - 1));
    const width = Math.max(1, Math.min(face.width, face.frame_width - x));
    const height = Math.max(1, Math.min(face.height, face.frame_height - y));
    const filter = `scale=${face.frame_width}:${face.frame_height},crop=${width}:${height}:${x}:${y},scale=320:320:force_original_aspect_ratio=decrease`;
    const { stdout } = await execFileAsync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(face.at_seconds),
      '-i', realPath, '-frames:v', '1', '-vf', filter, '-q:v', '4',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'
    ], { timeout: 20000, maxBuffer: 1024 * 1024, encoding: 'buffer' });
    if (!stdout.length || stdout.length > 1024 * 1024) return res.status(404).json({ error: 'Face preview unavailable' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', stdout.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(stdout);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ETIMEDOUT') return res.status(404).json({ error: 'Face preview unavailable' });
    console.error('Face preview error:', error.message);
    res.status(500).json({ error: 'Face preview failed' });
  }
}));

app.post('/api/faces/assign', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const faceIds = req.body?.face_ids;
  const personId = req.body?.person_id;
  const personName = req.body?.person_name;
  if (!Array.isArray(faceIds) || !faceIds.length || faceIds.length > 100 ||
      faceIds.some(id => !Number.isSafeInteger(id) || id < 1) ||
      (personId != null && (!Number.isSafeInteger(personId) || personId < 1)) ||
      (personName != null && (typeof personName !== 'string' || personName.trim().length < 1 || personName.trim().length > 80)) ||
      (personId != null && personName != null)) {
    return res.status(400).json({ error: 'Invalid face IDs or identity' });
  }
  try {
    const result = metadata.assignFaceObservations({
      faceIds: [...new Set(faceIds)], personId, personName,
      modelVersion: faceConfiguration().index_version
    });
    res.json({ ...result, items: metadata.listPeople() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/faces/reject', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const faceIds = req.body?.face_ids;
  if (!Array.isArray(faceIds) || !faceIds.length || faceIds.length > 100 ||
      faceIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    return res.status(400).json({ error: 'Invalid face IDs' });
  }
  const rejected = metadata.rejectFaceObservations([...new Set(faceIds)], faceConfiguration().index_version);
  res.json({ rejected });
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

app.patch('/api/people/:id/description', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
  if (!Number.isSafeInteger(id) || id < 1 || typeof req.body?.description !== 'string' ||
      req.body.description.length > 500) return res.status(400).json({ error: 'Invalid person description' });
  const person = metadata.updatePersonDescription(id, req.body.description);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  refinement.refreshApprovedSearch(null, true);
  res.json({ person, items: metadata.listPeople() });
});

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 100);
  if (req.query.mode !== undefined && req.query.mode !== 'text') {
    return res.status(400).json({ error: 'mode must be text' });
  }
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
  refinement.refreshApprovedSearch();
  const matches = metadata.search({ query, from, to, personId, folder, limit: limit + 1, offset });
  for (const match of matches) {
    const approved = refinement.stateForVideo(metadata.getById.get(match.id)).approved;
    if (approved) {
      match.visual_title = approved.title;
      match.visual_summary = approved.summary;
    }
  }
  const hasMore = matches.length > limit;
  res.json({ items: matches.slice(0, limit), limit, offset, has_more: hasMore });
});

app.get('/api/metadata', (req, res) => {
  const relativePath = req.query.path;
  if (!relativePath || !safeResolve(relativePath)) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const row = metadata.getByPath.get(relativePath);
  if (!row) return res.status(404).json({ error: 'Video not indexed' });
  const identifiedPeople = metadata.identifiedPeopleForVideo(row.id);
  const identifiedFaces = metadata.identifiedFacesForVideo(row.id, faceConfiguration().index_version);
  res.json({
    ...metadata.parseVideo(row),
    identified_people: identifiedPeople.legacy,
    identified_people_all: identifiedPeople.all,
    identified_faces: identifiedFaces,
    stale_identifications: metadata.staleIdentificationsForVideo(row.id),
    identity_history: metadata.identityHistoryForVideo(row.id),
    refinement: refinement.stateForVideo(row),
    jellyfin_configured: jellyfin.isConfigured(),
    can_edit_people: Boolean(process.env.METADATA_EDIT_TOKEN)
  });
});

function jellyfinSyncInput(req, res) {
  const relativePath = req.body?.path;
  const videoPath = safeResolve(relativePath);
  if (typeof relativePath !== 'string' || !videoPath) {
    res.status(400).json({ error: 'Invalid video path' });
    return null;
  }
  const row = metadata.getByPath.get(relativePath);
  if (!row) {
    res.status(404).json({ error: 'Video not indexed' });
    return null;
  }
  if (row.status !== 'done' || row.visual_status !== 'done' || row.visual_fingerprint !== row.fingerprint) {
    res.status(409).json({ error: 'A current technical and visual sheet is required before synchronization' });
    return null;
  }
  if (refinement.stateForVideo(row).stale_approved) {
    res.status(409).json({ error: 'The approved text is outdated; review the new proposal before syncing' });
    return null;
  }
  return { relativePath, videoPath, row };
}

async function verifySyncFingerprint(input, res) {
  let stat;
  try { stat = await fs.promises.stat(input.videoPath); }
  catch { res.status(404).json({ error: 'Video file not found' }); return false; }
  const fingerprint = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  if (fingerprint !== input.row.fingerprint) {
    res.status(409).json({ error: 'Video changed since its metadata was indexed' });
    return false;
  }
  return true;
}

function jellyfinSyncData(row) {
  const identifiedPeople = metadata.identifiedPeopleForVideo(row.id);
  return {
    parsed: metadata.parseVideo(row),
    approvedRefinement: refinement.stateForVideo(row).approved,
    identifiedPeople,
    identifiedFaces: metadata.identifiedFacesForVideo(row.id, faceConfiguration().index_version)
  };
}

app.post('/api/jellyfin/preview', asyncRoute(async (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const input = jellyfinSyncInput(req, res);
  if (!input || !await verifySyncFingerprint(input, res)) return;
  try {
    const result = await jellyfin.preview({ targetPath: input.videoPath, ...jellyfinSyncData(input.row) });
    res.json({ ...result, refinement_token: refinement.stateForVideo(input.row).sync_token || null });
  } catch (error) {
    if (error instanceof jellyfin.JellyfinError) return res.status(error.status === 404 ? 404 : 502).json({ error: error.message });
    throw error;
  }
}));

app.post('/api/jellyfin/sync', asyncRoute(async (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const input = jellyfinSyncInput(req, res);
  if (!input || !await verifySyncFingerprint(input, res)) return;
  if (req.body?.fingerprint !== input.row.fingerprint || req.body?.visual_revision !== input.row.visual_revision) {
    return res.status(409).json({ error: 'Video metadata changed after preview; preview the changes again' });
  }
  if (req.body?.refinement_token !== refinement.stateForVideo(input.row).sync_token) {
    return res.status(409).json({ error: 'Refinement changed after preview; preview the changes again' });
  }
  try {
    const result = await jellyfin.sync({ targetPath: input.videoPath, ...jellyfinSyncData(input.row) });
    res.json(result);
  } catch (error) {
    if (error instanceof jellyfin.JellyfinError) return res.status(error.status === 404 ? 404 : 502).json({ error: error.message });
    throw error;
  }
}));

app.post('/api/refinement/review', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const relativePath = req.body?.path;
  if (typeof relativePath !== 'string' || !safeResolve(relativePath)) return res.status(400).json({ error: 'Invalid path' });
  const row = metadata.getByPath.get(relativePath);
  if (!row) return res.status(404).json({ error: 'Video not indexed' });
  const result = refinement.review(row.id, req.body?.input_hash, req.body?.action, req.body?.title, req.body?.summary);
  if (result.error) return res.status(result.error === 'invalid' ? 400 : 409).json({ error: result.error === 'stale'
    ? 'The source information changed; reload the sheet before reviewing'
    : result.error === 'missing' ? 'The proposal is no longer available' : 'Invalid review' });
  refinement.refreshApprovedSearch(row.id);
  res.json({ refinement: refinement.stateForVideo(metadata.getByPath.get(relativePath)) });
});

app.get('/api/refinement/review-queue', (_req, res) => {
  res.json({ ...refinement.reviewQueue(), can_edit: Boolean(process.env.METADATA_EDIT_TOKEN) });
});

app.post('/api/refinement/retry', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const relativePath = req.body?.path;
  if (typeof relativePath !== 'string' || !safeResolve(relativePath)) return res.status(400).json({ error: 'Invalid path' });
  const row = metadata.getByPath.get(relativePath);
  if (!row) return res.status(404).json({ error: 'Video not indexed' });
  if (!refinement.retry(row.id, req.body?.input_hash)) return res.status(409).json({ error: 'Source information changed; reload the sheet' });
  res.json({ refinement: refinement.stateForVideo(row) });
});

app.post('/api/metadata/export', asyncRoute(async (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const relativePath = req.body?.path;
  const videoPath = safeResolve(relativePath);
  if (typeof relativePath !== 'string' || !videoPath) {
    return res.status(400).json({ error: 'Invalid video path' });
  }
  const row = metadata.getByPath.get(relativePath);
  if (!row) return res.status(404).json({ error: 'Video not indexed' });
  if (row.status !== 'done' || row.visual_status !== 'done' || row.visual_fingerprint !== row.fingerprint) {
    return res.status(409).json({ error: 'A current technical and visual sheet is required before export' });
  }

  let stat;
  try { stat = await fs.promises.stat(videoPath); }
  catch { return res.status(404).json({ error: 'Video file not found' }); }
  const currentFingerprint = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  if (currentFingerprint !== row.fingerprint) {
    return res.status(409).json({ error: 'Video changed since its metadata was indexed' });
  }

  const parsed = metadata.parseVideo(row);
  const identifiedPeople = metadata.identifiedPeopleForVideo(row.id);
  const narrativeAssignments = Object.entries(identifiedPeople.all).map(([index, identities]) => {
    const observationIndex = Number(index);
    return {
      observation_index: observationIndex,
      observation: parsed.visual_people[observationIndex] || null,
      identities
    };
  });
  const faceAssignments = metadata.identifiedFacesForVideo(row.id, faceConfiguration().index_version);
  const editorialState = refinement.stateForVideo(row);
  const approvedRefinement = editorialState.approved;
  const exportData = {
    schema: 'pcloud-video-metadata/v1',
    exported_at: new Date().toISOString(),
    video: {
      relative_path: row.relative_path,
      fingerprint_algorithm: 'size-mtime-ms-rounded-v1',
      fingerprint: row.fingerprint,
      size_bytes: row.size_bytes,
      modified_at: new Date(row.mtime_ms).toISOString()
    },
    technical: {
      analyzed_at: row.analyzed_at,
      duration_ms: row.duration_ms,
      width: row.width,
      height: row.height,
      codec: row.codec,
      recorded_at: row.recorded_at,
      date_precision: row.date_precision,
      date_source: row.date_source,
      date_candidates: parsed.date_candidates,
      location: parsed.technical.location || null,
      capture_device: parsed.technical.capture_device || null
    },
    visual: {
      revision: row.visual_revision,
      analyzed_at: row.visual_analyzed_at,
      model: row.visual_model,
      prompt_version: row.visual_prompt_version,
      title: row.visual_title,
      summary: row.visual_summary,
      uncertainty: row.visual_uncertainty,
      people_observed: parsed.visual_people,
      people_confirmed: narrativeAssignments.map(assignment => ({
        ...assignment,
        identities: assignment.identities.map(person => ({ name: person.name }))
      })),
      events: parsed.visual_events,
      places: parsed.visual_places,
      keywords: parsed.visual_keywords,
      date_clues: parsed.visual_date_clues,
      confirmed_names: parsed.confirmed_people
    },
    editorial: approvedRefinement ? { title: approvedRefinement.title, summary: approvedRefinement.summary,
      status: 'approved', model: editorialState.proposal.model,
      generated_title: editorialState.proposal.generated_title,
      generated_summary: editorialState.proposal.generated_summary,
      prompt_version: editorialState.proposal.prompt_version,
      generated_at: editorialState.proposal.generated_at,
      reviewed_at: editorialState.proposal.reviewed_at } : null,
    face_model_version: faceConfiguration().index_version,
    face_identity_summary: faceAssignments.map(person => ({
      name: person.name, appearances: person.appearances, first_at_seconds: person.first_at_seconds
    }))
  };

  const sidecarPath = `${videoPath}.metadata.json`;
  let fileHandle;
  try {
    fileHandle = await fs.promises.open(sidecarPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      return res.status(409).json({ error: 'A sidecar already exists; it was not overwritten' });
    }
    throw error;
  }
  try {
    await fileHandle.writeFile(`${JSON.stringify(exportData, null, 2)}\n`, 'utf8');
  } catch (error) {
    await fileHandle.close().catch(() => {});
    await fs.promises.unlink(sidecarPath).catch(() => {});
    throw error;
  }
  await fileHandle.close();
  res.status(201).json({
    exported: true,
    sidecar_path: path.relative(ROOT_RESOLVED, sidecarPath).split(path.sep).join('/'),
    fingerprint: row.fingerprint
  });
}));

app.post('/api/metadata/import', asyncRoute(async (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const relativePath = req.body?.path;
  const videoPath = safeResolve(relativePath);
  if (typeof relativePath !== 'string' || !videoPath) {
    return res.status(400).json({ error: 'Invalid video path' });
  }
  const row = metadata.getByPath.get(relativePath);
  if (!row) return res.status(404).json({ error: 'Video not indexed' });
  let videoStat;
  try { videoStat = await fs.promises.stat(videoPath); }
  catch { return res.status(404).json({ error: 'Video file not found' }); }
  const currentFingerprint = `${videoStat.size}:${Math.round(videoStat.mtimeMs)}`;
  if (currentFingerprint !== row.fingerprint) {
    return res.status(409).json({ error: 'Video changed since its metadata was indexed' });
  }

  const sidecarPath = `${videoPath}.metadata.json`;
  let sidecarHandle;
  try {
    sidecarHandle = await fs.promises.open(sidecarPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Sidecar not found' });
    if (error.code === 'ELOOP') return res.status(400).json({ error: 'Sidecar must not be a symbolic link' });
    throw error;
  }
  let sidecar;
  try {
    const sidecarStat = await sidecarHandle.stat();
    if (!sidecarStat.isFile() || sidecarStat.size > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Sidecar must be a regular file smaller than 2 MiB' });
    }
    const buffer = Buffer.alloc(sidecarStat.size);
    const { bytesRead } = await sidecarHandle.read(buffer, 0, buffer.length, 0);
    sidecar = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'Sidecar contains invalid JSON' });
    throw error;
  } finally {
    await sidecarHandle.close();
  }
  if (!sidecar || sidecar.schema !== 'pcloud-video-metadata/v1' ||
      sidecar.video?.relative_path !== relativePath ||
      sidecar.video?.fingerprint_algorithm !== 'size-mtime-ms-rounded-v1' ||
      typeof sidecar.video?.fingerprint !== 'string') {
    return res.status(400).json({ error: 'Unsupported sidecar schema or video path' });
  }
  const visual = {
    ...sidecar.visual,
    technical_location: sidecar.technical?.location || null,
    technical_capture_device: sidecar.technical?.capture_device || null
  };
  let result;
  try { result = metadata.importVisualSidecar(relativePath, sidecar.video.fingerprint, visual); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (result.error === 'VIDEO_NOT_FOUND') return res.status(404).json({ error: 'Video not indexed' });
  if (result.error === 'FINGERPRINT_MISMATCH') return res.status(409).json({ error: 'Sidecar belongs to a different version of the video' });
  if (result.error === 'TECHNICAL_METADATA_REQUIRED') return res.status(409).json({ error: 'Technical metadata must be indexed before import' });
  if (result.error === 'VISUAL_METADATA_EXISTS') return res.status(409).json({ error: 'A visual sheet or earlier revision already exists; it was not replaced' });
  const faceIdentityCount = Array.isArray(sidecar.face_identity_summary) ? sidecar.face_identity_summary.length : 0;
  res.status(201).json({
    imported: true,
    revision: result.revision,
    imported_assignments: result.imported_assignments,
    location_restored: result.location_restored,
    capture_device_restored: result.capture_device_restored,
    face_identity_summary_not_restored: faceIdentityCount
  });
}));

app.get('/api/metadata/evidence', asyncRoute(async (req, res) => {
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
}));

function authorizeMetadataEdit(req, res) {
  const expected = process.env.METADATA_EDIT_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'Editing is not configured' });
    return false;
  }
  // With library login enabled, that persistent authenticated session is the
  // single credential for both reading and editing. Keep the standalone edit
  // bearer token for deployments that do not enable ACCESS_TOKEN.
  if (ACCESS_TOKEN) {
    if (hasValidSession(req)) return true;
    res.status(401).json({ error: 'Authentication required' });
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
  const { path: relativePath, analysis_revision: expectedRevision,
    observation_index: observationIndex, person_id: personId, person_ids: personIds, person_name: personName } = req.body || {};
  const stale = req.body?.stale_observation;
  if (typeof relativePath !== 'string' || !safeResolve(relativePath) ||
      typeof expectedRevision !== 'string' || !expectedRevision || expectedRevision.length > 200 ||
      !Number.isInteger(observationIndex) || observationIndex < 0 ||
      (personId != null && !Number.isInteger(personId)) ||
      (personIds != null && (!Array.isArray(personIds) || personIds.length > 30 ||
        personIds.some(id => !Number.isSafeInteger(id) || id < 1))) ||
      (personName != null && (typeof personName !== 'string' || personName.trim().length > 80)) ||
      (stale != null && (typeof stale.analysis_revision !== 'string' || stale.analysis_revision.length > 200 ||
        !Number.isInteger(stale.observation_index) || stale.observation_index < 0))) {
    return res.status(400).json({ error: 'Invalid video, observation, or person' });
  }
  try {
    const assignedPeople = metadata.setVideoPerson({
      relativePath, expectedRevision, observationIndex, personId, personIds, personName,
      staleObservation: stale ? {
        analysisRevision: stale.analysis_revision,
        observationIndex: stale.observation_index
      } : undefined
    });
    if (assignedPeople === false) return res.status(404).json({ error: 'Video or observation not found' });
    res.json({ person: assignedPeople[0] || null, assigned_people: assignedPeople, people: metadata.listPeople() });
  } catch (error) {
    if (error.code === 'STALE_VISUAL_REVISION') return res.status(409).json({ error: error.message });
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/metadata/visual/retry', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const relativePath = req.body?.path;
  if (typeof relativePath !== 'string' || !safeResolve(relativePath)) {
    return res.status(400).json({ error: 'Invalid video path' });
  }
  const result = metadata.retryVisualAnalysis(relativePath);
  if (!result) return res.status(409).json({ error: 'Only a failed visual analysis can be retried' });
  res.json(result);
});

app.post('/api/metadata/technical/retry', (req, res) => {
  if (!authorizeMetadataEdit(req, res)) return;
  const relativePath = req.body?.path;
  if (typeof relativePath !== 'string' || !safeResolve(relativePath)) {
    return res.status(400).json({ error: 'Invalid video path' });
  }
  const result = metadata.retryTechnicalAnalysis(relativePath);
  if (!result) return res.status(409).json({ error: 'Only a failed technical probe can be retried' });
  res.json(result);
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
  const expectedRevision = req.body?.analysis_revision;
  const names = req.body?.names;
  if (typeof relativePath !== 'string' || !safeResolve(relativePath) ||
      typeof expectedRevision !== 'string' || !expectedRevision || expectedRevision.length > 200 ||
      !Array.isArray(names) || names.length > 20 ||
      names.some(name => typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80)) {
    return res.status(400).json({ error: 'Invalid path, revision, or names' });
  }
  const uniqueNames = [...new Set(names.map(name => name.trim()))];
  try {
    if (!metadata.setConfirmedPeople(relativePath, expectedRevision, uniqueNames)) {
      return res.status(404).json({ error: 'Video not indexed' });
    }
    res.json({ names: uniqueNames });
  } catch (error) {
    if (error.code === 'STALE_VISUAL_REVISION') return res.status(409).json({ error: error.message });
    res.status(400).json({ error: error.message });
  }
});

// GET /api/list?path=relative/path - List directory contents
app.get('/api/list', asyncRoute(async (req, res) => {
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
}));

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
app.get('/api/stream', asyncRoute(async (req, res) => {
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
}));

app.use((req, res, next) => {
  if (req.path !== '/api' && !req.path.startsWith('/api/')) return next();
  return res.status(404).json({ error: 'API route not found' });
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

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Video root: ${VIDEO_ROOT}`);
  if (!ACCESS_TOKEN) {
    console.warn('WARNING: ACCESS_TOKEN is not configured; API and video streaming are unauthenticated');
  }
  if (!process.env.METADATA_EDIT_TOKEN) {
    console.warn('WARNING: METADATA_EDIT_TOKEN is not configured; identity editing is disabled');
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping HTTP server gracefully`);
  const forceCloseTimer = setTimeout(() => {
    console.warn('Graceful shutdown timed out; closing remaining HTTP connections');
    server.closeAllConnections();
  }, 25000);
  forceCloseTimer.unref();
  server.close(error => {
    clearTimeout(forceCloseTimer);
    if (error) {
      console.error('HTTP server shutdown failed:', error);
      process.exitCode = 1;
    }
    try { metadata.db.close(); }
    catch (closeError) {
      console.error('Database shutdown failed:', closeError);
      process.exitCode = 1;
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
