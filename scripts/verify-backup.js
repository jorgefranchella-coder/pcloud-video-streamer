const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const backupDirArg = process.argv[2];

async function measureTree(root) {
  let files = 0;
  let bytes = 0;
  async function visit(directory) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in evidence backup: ${child}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await fs.promises.stat(child)).size;
      } else throw new Error(`Unsupported evidence entry: ${child}`);
    }
  }
  await visit(root);
  return { files, bytes };
}

async function main() {
  if (!backupDirArg || !path.isAbsolute(backupDirArg)) {
    throw new Error('Usage: node scripts/verify-backup.js /absolute/path/to/backup');
  }
  const backupDir = path.resolve(backupDirArg);
  const backupStat = await fs.promises.lstat(backupDir);
  if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) throw new Error('Backup path must be a real directory');
  const completePath = path.join(backupDir, 'COMPLETE');
  const manifestPath = path.join(backupDir, 'manifest.json');
  for (const markerPath of [completePath, manifestPath]) {
    const stat = await fs.promises.lstat(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Backup marker must be a regular file: ${path.basename(markerPath)}`);
  }
  const complete = await fs.promises.readFile(completePath, 'utf8');
  if (complete.trim() !== 'ok') throw new Error('Backup completion marker is invalid');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Backup manifest must be a JSON object');
  }
  if (typeof manifest.created_at !== 'string' || !Number.isFinite(Date.parse(manifest.created_at))) {
    throw new Error('Backup manifest has an invalid creation date');
  }
  if (typeof manifest.evidence_copied !== 'boolean'
    || !Number.isSafeInteger(manifest.evidence_files) || manifest.evidence_files < 0
    || !Number.isSafeInteger(manifest.evidence_bytes) || manifest.evidence_bytes < 0
    || !Number.isSafeInteger(manifest.stale_locks_removed) || manifest.stale_locks_removed < 0) {
    throw new Error('Backup manifest has invalid evidence or lock counts');
  }
  if (manifest.sqlite_integrity_check !== 'ok') throw new Error('Manifest does not report a clean SQLite integrity check');

  const databasePath = path.join(backupDir, 'videos.sqlite');
  const databaseStat = await fs.promises.lstat(databasePath);
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error('Backup database must be a regular file');
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  let integrity;
  let foreignKeyErrors;
  let videoCount;
  let currentEvidenceReferences = [];
  try {
    integrity = db.pragma('integrity_check', { simple: true });
    foreignKeyErrors = db.pragma('foreign_key_check');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    for (const table of ['videos', 'people', 'video_person_observations']) {
      if (!tables.has(table)) throw new Error(`Required table missing: ${table}`);
    }
    if (tables.has('process_locks') && db.prepare('SELECT COUNT(*) AS count FROM process_locks').get().count !== 0) {
      throw new Error('Backup contains process locks; workers must be stopped before backup');
    }
    videoCount = db.prepare('SELECT COUNT(*) AS count FROM videos').get().count;
    currentEvidenceReferences = db.prepare(`SELECT id, visual_revision, visual_evidence_json
      FROM videos WHERE visual_revision IS NOT NULL AND visual_fingerprint = fingerprint`).all()
      .flatMap(video => {
        if (!Number.isSafeInteger(video.id) || video.id < 1) {
          throw new Error('Invalid video ID in current evidence reference');
        }
        let entries;
        try { entries = JSON.parse(video.visual_evidence_json || '[]'); }
        catch { throw new Error(`Invalid visual evidence JSON for video ${video.id}`); }
        if (!Array.isArray(entries)) throw new Error(`Invalid visual evidence list for video ${video.id}`);
        if (!entries.length) return [];
        if (!/^[0-9a-f-]{36}$/i.test(video.visual_revision)) {
          throw new Error(`Invalid active evidence revision for video ${video.id}`);
        }
        return entries.map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)
            || !Number.isSafeInteger(item.at_seconds) || item.at_seconds < 0 || item.at_seconds > 999999) {
            throw new Error(`Invalid evidence timestamp for video ${video.id}`);
          }
          return { videoId: video.id, revision: video.visual_revision, atSeconds: item.at_seconds };
        });
      });
  } finally {
    db.close();
  }
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
  if (foreignKeyErrors.length) throw new Error(`SQLite foreign key check failed (${foreignKeyErrors.length} violations)`);

  let evidenceSummary = { files: 0, bytes: 0 };
  let evidenceExists = false;
  const evidencePath = path.join(backupDir, 'evidence');
  try {
    const stat = await fs.promises.lstat(evidencePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Evidence backup is not a real directory');
    evidenceExists = true;
    evidenceSummary = await measureTree(evidencePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (Boolean(manifest.evidence_copied) !== evidenceExists) {
    throw new Error('Evidence directory does not match manifest');
  }
  if (manifest.evidence_files !== evidenceSummary.files || manifest.evidence_bytes !== evidenceSummary.bytes) {
    throw new Error('Evidence file count or size does not match manifest');
  }
  for (const evidence of currentEvidenceReferences) {
    const imagePath = path.join(evidencePath, String(evidence.videoId), evidence.revision, `${evidence.atSeconds}.jpg`);
    let stat;
    try { stat = await fs.promises.lstat(imagePath); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Current evidence image is missing: video ${evidence.videoId}, ${evidence.atSeconds}s`);
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 700000) {
      throw new Error(`Current evidence image is invalid: video ${evidence.videoId}, ${evidence.atSeconds}s`);
    }
  }
  console.log(`Backup verified: ${videoCount} videos, ${evidenceSummary.files} evidence files, SQLite integrity and foreign keys clean.`);
}

main().catch(error => {
  console.error(`Backup verification failed: ${error.message}`);
  process.exitCode = 1;
});
