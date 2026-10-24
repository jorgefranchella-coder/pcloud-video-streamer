const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { db, getByPath, upsert, withJobLock, setWorkerConfiguration, setWorkerActivity, getAutomationControl, refreshSearchTextForVideos } = require('./metadata-store');
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

function parseGpsCoordinate(rawValue, directionPattern) {
  const raw = String(rawValue).trim();
  const direction = raw.match(directionPattern)?.[0]?.toUpperCase();
  const directionSign = direction === 'S' || direction === 'W' ? -1 : direction ? 1 : null;
  const value = raw.replace(/[NSEW]/gi, '').trim();
  const rational = value.match(/^([+-]?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (rational) {
    const denominator = Number(rational[2]);
    if (!denominator) return NaN;
    const parsed = Number(rational[1]) / denominator;
    return directionSign == null ? parsed : directionSign * Math.abs(parsed);
  }
  const decimal = value.match(/^([+-]?\d+(?:\.\d+)?)$/);
  if (decimal) {
    const parsed = Number(decimal[1]);
    return directionSign == null ? parsed : directionSign * Math.abs(parsed);
  }
  const dms = value.match(/^([+-]?\d+(?:\.\d+)?)(?:[°:\s]+)(\d+(?:\.\d+)?)(?:(?:['′:\s]+)(\d+(?:\.\d+)?))?(?:["″])?$/);
  if (!dms) return NaN;
  const degrees = Math.abs(Number(dms[1]));
  const minutes = Number(dms[2]);
  const seconds = dms[3] == null ? 0 : Number(dms[3]);
  if (minutes >= 60 || seconds >= 60) return NaN;
  const sign = directionSign == null ? (Number(dms[1]) < 0 ? -1 : 1) : directionSign;
  return sign * (degrees + minutes / 60 + seconds / 3600);
}

function collectLocation(probe) {
  const tags = [];
  for (const source of [probe.format, ...(probe.streams || [])]) {
    for (const [key, value] of Object.entries(source.tags || {})) {
      if (value == null || !/location|gps|iso6709/i.test(key)) continue;
      const raw = String(value).trim();
      if (raw) tags.push({ key: key.slice(0, 200), raw: raw.slice(0, 1000) });
    }
  }
  const iso = tags.find(tag => /iso6709/i.test(tag.key) || /^[+-]\d{2,6}(?:\.\d+)?[+-]\d{3,7}(?:\.\d+)?/.test(tag.raw));
  let coordinates = null;
  if (iso) {
    const match = iso.raw.match(/^([+-])(\d{2,6}(?:\.\d+)?)([+-])(\d{3,7}(?:\.\d+)?)(?:([+-])(\d+(?:\.\d+)?))?/);
    if (match) {
      const parseCoordinate = (sign, raw, isLatitude) => {
        const direction = sign === '-' ? -1 : 1;
        const degreesDigits = isLatitude ? 2 : 3;
        const integerPart = raw.split('.', 1)[0];
        if (raw.includes('.') && integerPart.length !== degreesDigits + 4) return direction * Number(raw);
        if (!raw.includes('.') && raw.length <= degreesDigits) return direction * Number(raw);
        if (integerPart.length !== degreesDigits + 4) return NaN;
        const degrees = Number(raw.slice(0, degreesDigits));
        const minutes = Number(raw.slice(degreesDigits, degreesDigits + 2));
        const seconds = Number(raw.slice(degreesDigits + 2));
        if (minutes >= 60 || seconds >= 60) return NaN;
        return direction * (degrees + minutes / 60 + seconds / 3600);
      };
      const latitude = parseCoordinate(match[1], match[2], true);
      const longitude = parseCoordinate(match[3], match[4], false);
      if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
        coordinates = { latitude, longitude };
        if (match[5]) coordinates.altitude_m = Number(match[5] + match[6]);
      }
    }
  }
  let coordinateSource = iso ? `embedded:${iso.key}` : null;
  if (!coordinates) {
    const latitudeTag = tags.find(tag => /latitude|gpslat/i.test(tag.key));
    const longitudeTag = tags.find(tag => /longitude|gpslon/i.test(tag.key));
    const latitude = latitudeTag && parseGpsCoordinate(latitudeTag.raw, /[NS]/i);
    const longitude = longitudeTag && parseGpsCoordinate(longitudeTag.raw, /[EW]/i);
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      coordinates = { latitude, longitude };
      coordinateSource = `embedded:${latitudeTag.key}+${longitudeTag.key}`;
    }
  }
  const preferred = tags.find(tag => !/iso6709|latitude|gpslat|longitude|gpslon/i.test(tag.key)) || iso;
  if (preferred) return {
    raw: preferred.raw,
    source: `embedded:${preferred.key}`,
    coordinates,
    coordinates_source: coordinateSource
  };
  if (coordinates) return {
    raw: `${coordinates.latitude}, ${coordinates.longitude}`,
    source: coordinateSource,
    coordinates,
    coordinates_source: coordinateSource
  };
  if (tags.length) {
    const source = tags.slice(0, 4).map(tag => tag.key).join('+');
    const raw = tags.slice(0, 4).map(tag => `${tag.key}: ${tag.raw}`).join('; ').slice(0, 1000);
    return { raw, source: `embedded:${source}`, coordinates: null, coordinates_source: null };
  }
  return null;
}

function collectCaptureDevice(probe) {
  const tags = [];
  for (const source of [probe.format, ...(probe.streams || [])]) {
    for (const [key, value] of Object.entries(source.tags || {})) {
      if (value == null) continue;
      const raw = String(value).trim().slice(0, 200);
      if (!raw) continue;
      if (/^(?:com\.apple\.quicktime\.)?make$|device[_ .-]?manufacturer|manufacturer/i.test(key)) {
        tags.push({ field: 'manufacturer', raw, source: `embedded:${key.slice(0, 200)}` });
      } else if (/^(?:com\.apple\.quicktime\.)?model$|camera[_ .-]?model|device[_ .-]?model/i.test(key)) {
        tags.push({ field: 'model', raw, source: `embedded:${key.slice(0, 200)}` });
      }
    }
  }
  const device = {};
  for (const field of ['manufacturer', 'model']) {
    const tag = tags.find(item => item.field === field);
    if (tag) device[field] = { value: tag.raw, source: tag.source };
  }
  return Object.keys(device).length ? device : null;
}

async function probeVideo(fullPath, relativePath, fileStat) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', fullPath
  ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const video = (probe.streams || []).find(stream => stream.codec_type === 'video');
  const rawDuration = Number(probe.format?.duration || video?.duration);
  const dates = collectDates(probe, relativePath, fileStat);
  const location = collectLocation(probe);
  const capture_device = collectCaptureDevice(probe);
  return {
    duration_ms: Number.isFinite(rawDuration) ? Math.round(rawDuration * 1000) : null,
    width: video?.width || null,
    height: video?.height || null,
    codec: video?.codec_name || null,
    recorded_at: dates.selected?.date || null,
    date_precision: dates.selected ? 'day' : null,
    date_source: dates.selected?.source || null,
    date_candidates_json: JSON.stringify(dates.candidates),
    technical_json: JSON.stringify({ format_name: probe.format?.format_name || null, streams: (probe.streams || []).map(stream => ({ type: stream.codec_type, codec: stream.codec_name })), location, capture_device })
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
      if (previous && previous.fingerprint === fingerprint && previous.status === 'done' && previous.native_metadata_version >= 1) continue;
      if (previous && previous.fingerprint === fingerprint && previous.status === 'failed' && !RETRY_FAILED) continue;
      if (MAX_PROBES > 0 && counters.attempted >= MAX_PROBES) continue;
      counters.attempted++;

      setWorkerActivity('indexer', { phase: 'ffprobe', path: normalizedPath });
      const metadata = await probeVideo(fullPath, normalizedPath, stat);
      db.prepare(`UPDATE videos SET status = 'done', duration_ms = @duration_ms,
        width = @width, height = @height, codec = @codec, recorded_at = @recorded_at,
        date_precision = @date_precision, date_source = @date_source,
        date_candidates_json = @date_candidates_json, technical_json = @technical_json,
        native_metadata_version = 1,
        error = NULL, analyzed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE relative_path = @relative_path`).run({ ...metadata, relative_path: normalizedPath });
      refreshSearchTextForVideos([getByPath.get(normalizedPath).id]);
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
    if (getAutomationControl().paused) {
      setWorkerActivity('indexer', { phase: 'pausado', result: 'La automatización está pausada; no se inició el inventario' });
      return;
    }
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
