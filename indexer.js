const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { db, getByPath, upsert, withJobLock, setWorkerConfiguration, setWorkerActivity } = require('./metadata-store');
const { indexerConfiguration } = require('./config');

const execFileAsync = promisify(execFile);
const VIDEO_ROOT = path.resolve(process.env.VIDEO_ROOT || '/mnt/pcloud/My Videos');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg']);
const CONFIG = indexerConfiguration();
const PROBE_TIMEOUT_MS = CONFIG.probe_timeout_ms;
const INVENTORY_ONLY = CONFIG.inventory_only;
const MAX_PROBES = CONFIG.max_probes;
const RETRY_FAILED = CONFIG.retry_failed;

function dateFromFilename(filename) {
  const match = filename.match(/(?:^|[^0-9])(19\d{2}|20\d{2})[-_. ]?(0[1-9]|1[0-2])[-_. ]?([0-2]\d|3[01])(?:[^0-9]|$)/);
  if (!match) return null;
  const value = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function collectDates(probe, relativePath, fileStat) {
  const candidates = [];
  const sources = [probe.format, ...(probe.streams || [])];
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.tags || {})) {
      if (!/creation.time|date|com\.apple\.quicktime\.creationdate/i.test(key)) continue;
      const raw = String(value);
      const date = raw.match(/^(\d{4}-\d{2}-\d{2})/);
      if (date && validDay(date[1])) {
        candidates.push({ date: date[1], source: `embedded:${key}`, raw });
      }
    }
  }
  const filenameDate = dateFromFilename(path.basename(relativePath));
  if (filenameDate) candidates.push({ date: filenameDate, source: 'filename' });
  candidates.push({ date: new Date(fileStat.mtimeMs).toISOString().slice(0, 10), source: 'file_mtime' });
  const captureDates = candidates.filter(candidate => candidate.source !== 'file_mtime');
  const distinct = new Set(captureDates.map(candidate => candidate.date));
  const selected = distinct.size === 1 ? captureDates[0] : null;
  return { candidates, selected };
}

async function probeVideo(fullPath, relativePath, fileStat) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', fullPath
  ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const video = (probe.streams || []).find(stream => stream.codec_type === 'video');
  const rawDuration = Number(probe.format?.duration || video?.duration);
  const dates = collectDates(probe, relativePath, fileStat);
  return {
    duration_ms: Number.isFinite(rawDuration) ? Math.round(rawDuration * 1000) : null,
    width: video?.width || null,
    height: video?.height || null,
    codec: video?.codec_name || null,
    recorded_at: dates.selected?.date || null,
    date_precision: dates.selected ? 'day' : null,
    date_source: dates.selected?.source || null,
    date_candidates_json: JSON.stringify(dates.candidates),
    technical_json: JSON.stringify({ format_name: probe.format?.format_name || null, streams: (probe.streams || []).map(stream => ({ type: stream.codec_type, codec: stream.codec_name })) })
  };
}

async function scanDirectory(relativeDir, scanId, counters) {
  const absoluteDir = path.join(VIDEO_ROOT, relativeDir);
  const entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await scanDirectory(relativePath, scanId, counters);
      continue;
    }
    if (!entry.isFile() || !VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const fullPath = path.join(VIDEO_ROOT, relativePath);
    // A failed stat makes the inventory incomplete, so the scan must not mark unseen files missing.
    const stat = await fs.promises.stat(fullPath);
    try {
      const fingerprint = `${stat.size}:${Math.round(stat.mtimeMs)}`;
      const normalizedPath = relativePath.split(path.sep).join('/');
      const previous = getByPath.get(normalizedPath);
      upsert.run({ relative_path: normalizedPath, size_bytes: stat.size, mtime_ms: Math.round(stat.mtimeMs), fingerprint, scan_id: scanId });
      counters.seen++;
      if (counters.seen % 100 === 0) {
        db.prepare('UPDATE scans SET seen_count = ? WHERE id = ?').run(counters.seen, scanId);
        setWorkerActivity('indexer', { phase: 'inventory', path: normalizedPath, result: `${counters.seen} videos recorridos` });
      }
      if (INVENTORY_ONLY) continue;
      if (previous && previous.fingerprint === fingerprint && previous.status === 'done') continue;
      if (previous && previous.fingerprint === fingerprint && previous.status === 'failed' && !RETRY_FAILED) continue;
      if (MAX_PROBES > 0 && counters.attempted >= MAX_PROBES) continue;
      counters.attempted++;

      setWorkerActivity('indexer', { phase: 'ffprobe', path: normalizedPath });
      const metadata = await probeVideo(fullPath, normalizedPath, stat);
      db.prepare(`UPDATE videos SET status = 'done', duration_ms = @duration_ms,
        width = @width, height = @height, codec = @codec, recorded_at = @recorded_at,
        date_precision = @date_precision, date_source = @date_source,
        date_candidates_json = @date_candidates_json, technical_json = @technical_json,
        error = NULL, analyzed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE relative_path = @relative_path`).run({ ...metadata, relative_path: normalizedPath });
      counters.probed++;
    } catch (error) {
      counters.failed++;
      db.prepare(`UPDATE videos SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE relative_path = ?`).run(String(error.message).slice(0, 1000), relativePath.split(path.sep).join('/'));
      console.error(`Failed: ${relativePath}: ${error.message}`);
    }
  }
}

async function runScanLocked() {
  db.prepare(`UPDATE scans SET status = 'interrupted', completed_at = CURRENT_TIMESTAMP,
      error = COALESCE(error, 'El proceso anterior terminó antes de completar el recorrido')
    WHERE status = 'running'`).run();
  const rootStat = await fs.promises.stat(VIDEO_ROOT);
  if (!rootStat.isDirectory()) throw new Error(`VIDEO_ROOT is not a directory: ${VIDEO_ROOT}`);
  const scan = db.prepare("INSERT INTO scans (status) VALUES ('running')").run();
  const counters = { seen: 0, attempted: 0, probed: 0, failed: 0 };
  try {
    await scanDirectory('', scan.lastInsertRowid, counters);
    const existingCount = db.prepare('SELECT COUNT(*) AS count FROM videos').get().count;
    if (counters.seen === 0 && existingCount > 0) {
      throw new Error('Scan found no videos while the index has videos; check the pCloud mount');
    }
    db.prepare("UPDATE videos SET status = 'missing', updated_at = CURRENT_TIMESTAMP WHERE last_seen_scan != ? OR last_seen_scan IS NULL")
      .run(scan.lastInsertRowid);
    db.prepare("UPDATE scans SET status = 'done', completed_at = CURRENT_TIMESTAMP, seen_count = ? WHERE id = ?")
      .run(counters.seen, scan.lastInsertRowid);
    setWorkerActivity('indexer', { result: `${counters.probed} fichas técnicas completas` });
    console.log(JSON.stringify({ scan_id: scan.lastInsertRowid, ...counters }));
  } catch (error) {
    db.prepare("UPDATE scans SET status = 'failed', completed_at = CURRENT_TIMESTAMP, seen_count = ?, error = ? WHERE id = ?")
      .run(counters.seen, String(error.message).slice(0, 1000), scan.lastInsertRowid);
    throw error;
  }
}

function runScan() {
  return withJobLock('indexer', () => {
    setWorkerConfiguration('technical', {
      probe_timeout_ms: PROBE_TIMEOUT_MS, max_probes: MAX_PROBES,
      retry_failed: RETRY_FAILED, inventory_only: INVENTORY_ONLY
    });
    return runScanLocked();
  });
}

if (require.main === module) {
  runScan().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { runScan };
