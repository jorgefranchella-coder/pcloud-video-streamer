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
  const complete = await fs.promises.readFile(path.join(backupDir, 'COMPLETE'), 'utf8');
  if (complete.trim() !== 'ok') throw new Error('Backup completion marker is invalid');
  const manifest = JSON.parse(await fs.promises.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  if (manifest.sqlite_integrity_check !== 'ok') throw new Error('Manifest does not report a clean SQLite integrity check');

  const db = new Database(path.join(backupDir, 'videos.sqlite'), { readonly: true, fileMustExist: true });
  let integrity;
  let foreignKeyErrors;
  let videoCount;
  try {
    integrity = db.pragma('integrity_check', { simple: true });
    foreignKeyErrors = db.pragma('foreign_key_check');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    for (const table of ['videos', 'people', 'video_person_observations']) {
      if (!tables.has(table)) throw new Error(`Required table missing: ${table}`);
    }
    videoCount = db.prepare('SELECT COUNT(*) AS count FROM videos').get().count;
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
  console.log(`Backup verified: ${videoCount} videos, ${evidenceSummary.files} evidence files, SQLite integrity and foreign keys clean.`);
}

main().catch(error => {
  console.error(`Backup verification failed: ${error.message}`);
  process.exitCode = 1;
});
