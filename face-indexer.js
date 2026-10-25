'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  db, withJobLock, setWorkerConfiguration, setWorkerActivity, saveFaceIndex,
  markFaceIndexFailed, migrateFaceIndexVersion, getAutomationControl, autoAssignFaceObservations
} = require('./metadata-store');
const { faceConfiguration } = require('./config');

const execFileAsync = promisify(execFile);
const CONFIG = faceConfiguration();
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || '/mnt/pcloud/My Videos');
const PYTHON = path.resolve(process.env.FACE_PYTHON || path.join(DATA_DIR, 'face-runtime', 'bin', 'python'));
const MODEL_DIR = path.resolve(process.env.FACE_MODEL_DIR || path.join(DATA_DIR, 'models', 'faces'));
const YUNET_MODEL = path.join(MODEL_DIR, 'yunet.onnx');
const SFACE_MODEL = path.join(MODEL_DIR, 'sface.onnx');
const WORKER = 'face-embedding-indexer';

async function safeVideoPath(relativePath) {
  const fullPath = path.resolve(VIDEO_ROOT, relativePath);
  const realRoot = await fs.realpath(VIDEO_ROOT);
  const realPath = await fs.realpath(fullPath);
  const relative = path.relative(realRoot, realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Video path is outside VIDEO_ROOT');
  }
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new Error('Video path is not a file');
  return { fullPath: realPath, stat };
}

function sampleTimes(durationMs) {
  const duration = Number(durationMs) / 1000;
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const count = Math.max(1, Math.min(CONFIG.max_frames_per_video,
    Math.ceil(duration / CONFIG.sample_interval_seconds)));
  return [...new Set(Array.from({ length: count }, (_, index) =>
    Number((((index + 0.5) * duration) / count).toFixed(2))))];
}

async function processVideo(row) {
  const { fullPath, stat } = await safeVideoPath(row.relative_path);
  if (`${stat.size}:${Math.round(stat.mtimeMs)}` !== row.fingerprint) return 'changed';
  const times = sampleTimes(row.duration_ms);
  setWorkerActivity(WORKER, {
    phase: `detectando caras en ${times.length} fotogramas`, videoId: row.id,
    path: row.relative_path, result: null
  });
  const { stdout } = await execFileAsync(PYTHON, [
    path.join(__dirname, 'scripts', 'extract-face-embeddings.py'),
    '--video', fullPath,
    '--yunet', YUNET_MODEL,
    '--sface', SFACE_MODEL,
    '--times', JSON.stringify(times),
    '--max-dimension', String(CONFIG.max_dimension),
    '--min-face-size', String(CONFIG.min_face_size),
    '--detection-threshold', String(CONFIG.detection_threshold)
  ], { timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
  const output = JSON.parse(stdout);
  if (!Number.isSafeInteger(output.frames_processed) || !Array.isArray(output.faces)) {
    throw new Error('Face worker returned an invalid result');
  }
  const faces = output.faces.map(face => {
    const bytes = Buffer.from(face.vector || '', 'base64');
    if (!bytes.length || bytes.length % Float32Array.BYTES_PER_ELEMENT !== 0 || bytes.length > 4096) {
      throw new Error('Face worker returned an invalid embedding');
    }
    const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / Float32Array.BYTES_PER_ELEMENT);
    if ([...values].some(value => !Number.isFinite(value))) throw new Error('Face worker returned non-finite values');
    return { ...face, vector: Array.from(values) };
  });
  const current = await fs.stat(fullPath);
  if (`${current.size}:${Math.round(current.mtimeMs)}` !== row.fingerprint) return 'changed';
  if (!saveFaceIndex(row.id, row.fingerprint, CONFIG.index_version, {
    frames_processed: output.frames_processed, faces
  })) return 'changed';
  return { frames_processed: output.frames_processed, faces_detected: faces.length };
}

async function run() {
  if (!CONFIG.enabled) {
    console.log('Local face indexing is disabled; set FACE_INDEXING_ENABLED=1 to enable it.');
    return;
  }
  await Promise.all([fs.access(PYTHON), fs.access(YUNET_MODEL), fs.access(SFACE_MODEL)]);
  return withJobLock(WORKER, async () => {
    const migrated = migrateFaceIndexVersion({
      currentVersion: CONFIG.index_version, modelVersion: CONFIG.model_version,
      sampleIntervalSeconds: CONFIG.sample_interval_seconds,
      maxFramesPerVideo: CONFIG.max_frames_per_video, maxDimension: CONFIG.max_dimension,
      minFaceSize: CONFIG.min_face_size, detectionThreshold: CONFIG.detection_threshold
    });
    if (migrated) console.log('Migrated existing face index to the parameter-aware version.');
    setWorkerConfiguration(WORKER, {
      enabled: true, model_version: CONFIG.index_version, model_family: CONFIG.model_version, max_videos: CONFIG.max_videos,
      sample_interval_seconds: CONFIG.sample_interval_seconds,
      max_frames_per_video: CONFIG.max_frames_per_video, max_dimension: CONFIG.max_dimension,
      min_face_size: CONFIG.min_face_size, detection_threshold: CONFIG.detection_threshold,
      suggestion_threshold: CONFIG.suggestion_threshold,
      auto_assignment_threshold: CONFIG.auto_assignment_threshold,
      retry_failed: CONFIG.retry_failed, max_retry_attempts: CONFIG.max_retry_attempts,
      retry_slots: CONFIG.retry_slots
    });
    const candidates = db.prepare(`SELECT v.id, v.relative_path, v.fingerprint, v.duration_ms,
        fi.status AS face_status, fi.fingerprint AS face_fingerprint,
        fi.attempts AS face_attempts, fi.next_attempt_at AS face_next_attempt_at
      FROM videos v LEFT JOIN face_video_indexes fi
        ON fi.video_id = v.id AND fi.model_version = ?
      WHERE v.status = 'done' AND (? IS NULL OR v.id = ?)
        AND (fi.video_id IS NULL OR fi.fingerprint != v.fingerprint
          OR (? = 1 AND fi.status = 'failed' AND fi.fingerprint = v.fingerprint
            AND fi.attempts < ? AND (fi.next_attempt_at IS NULL OR fi.next_attempt_at <= CURRENT_TIMESTAMP))
          OR (? IS NOT NULL AND v.id = ? AND fi.status = 'failed'))
      ORDER BY v.id`).all(CONFIG.index_version, CONFIG.video_id, CONFIG.video_id,
        CONFIG.retry_failed ? 1 : 0, CONFIG.max_retry_attempts, CONFIG.video_id, CONFIG.video_id);
    const fresh = candidates.filter(row => row.face_status !== 'failed' || row.face_fingerprint !== row.fingerprint);
    const retries = candidates.filter(row => row.face_status === 'failed' && row.face_fingerprint === row.fingerprint)
      .sort((a, b) => a.face_next_attempt_at?.localeCompare(b.face_next_attempt_at || '') || a.id - b.id);
    const retryQuota = fresh.length ? Math.min(CONFIG.retry_slots, CONFIG.max_videos) : CONFIG.max_videos;
    const batch = [...fresh.slice(0, CONFIG.max_videos - retryQuota), ...retries.slice(0, retryQuota)];
    if (batch.length < CONFIG.max_videos) {
      batch.push(...fresh.slice(CONFIG.max_videos - retryQuota,
        CONFIG.max_videos - retryQuota + CONFIG.max_videos - batch.length));
    }
    if (batch.length < CONFIG.max_videos) {
      batch.push(...retries.slice(retryQuota, retryQuota + CONFIG.max_videos - batch.length));
    }
    let indexed = 0;
    let failed = 0;
    setWorkerActivity(WORKER, { phase: 'preparando lote', result: `Lote local: ${batch.length} videos pendientes` });
    for (const row of batch) {
      if (getAutomationControl().paused) break;
      try {
        const result = await processVideo(row);
        if (result === 'changed') continue;
        indexed += 1;
        setWorkerActivity(WORKER, {
          phase: null, videoId: row.id, path: row.relative_path,
          result: `${result.faces_detected} caras en ${result.frames_processed} fotogramas`
        });
      } catch (error) {
        failed += 1;
        const reason = String(error.stderr || '').trim().slice(0, 420) || String(error.message).slice(-420);
        markFaceIndexFailed(row.id, row.fingerprint, CONFIG.index_version, reason, CONFIG.max_retry_attempts);
        setWorkerActivity(WORKER, {
          phase: 'error procesando video', videoId: row.id, path: row.relative_path,
          error: reason, result: null
        });
        console.error(`Local face indexing failed for video ${row.id}: ${reason}`);
      }
    }
    const autoAssignment = autoAssignFaceObservations({
      modelVersion: CONFIG.index_version,
      threshold: CONFIG.auto_assignment_threshold,
      limit: CONFIG.auto_assignment_batch_size
    });
    setWorkerActivity(WORKER, {
      phase: null, result: `Lote terminado: ${indexed} videos indexados, ${failed} errores, ${autoAssignment.assigned} rostros asignados automáticamente`
    });
    console.log(JSON.stringify({ worker: WORKER, indexed, failed, selected: batch.length,
      auto_assigned: autoAssignment.assigned, auto_assignment_considered: autoAssignment.considered }));
  });
}

run().then(() => process.exit(0)).catch(error => {
  console.error(`Local face indexer failed: ${error.message}`);
  process.exit(1);
});
