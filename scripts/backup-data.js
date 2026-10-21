const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { hashFile, hashTree } = require('./backup-integrity');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const backupRootArg = process.argv[2];
let incompleteBackupDir = null;

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertNoLiveWorkerLocks(db) {
  const hasLockTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'process_locks'").get();
  if (!hasLockTable) return;
  const locks = db.prepare('SELECT name, owner_pid, owner_host FROM process_locks').all();
  for (const lock of locks) {
    let processIsAlive = true;
    if (lock.owner_host === os.hostname()) {
      try { process.kill(lock.owner_pid, 0); }
      catch (error) { processIsAlive = error.code !== 'ESRCH'; }
    }
    if (processIsAlive) {
      throw new Error(`Cannot back up while ${lock.name} is locked by ${lock.owner_host} (pid ${lock.owner_pid})`);
    }
  }
}

async function lockDownTree(root) {
  await fs.promises.chmod(root, 0o700);
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in evidence backup: ${child}`);
    if (entry.isDirectory()) await lockDownTree(child);
    else if (entry.isFile()) await fs.promises.chmod(child, 0o600);
    else throw new Error(`Unsupported evidence entry: ${child}`);
  }
}

async function measureTree(root) {
  let files = 0;
  let bytes = 0;
  async function visit(directory) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in evidence backup: ${child}`);
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
  if (!backupRootArg) throw new Error('Usage: node scripts/backup-data.js /absolute/private/backup-directory');
  const backupRoot = path.resolve(backupRootArg);
  if (!path.isAbsolute(backupRootArg)) throw new Error('Backup directory must be an absolute path');
  if (isWithin(DATA_DIR, backupRoot) || isWithin(backupRoot, DATA_DIR)) {
    throw new Error('Backup directory and DATA_DIR must be separate trees');
  }

  const databasePath = path.join(DATA_DIR, 'videos.sqlite');
  await fs.promises.access(databasePath, fs.constants.R_OK);
  await fs.promises.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupRootStat = await fs.promises.lstat(backupRoot);
  if (!backupRootStat.isDirectory() || backupRootStat.isSymbolicLink()) {
    throw new Error('Backup root must be a real directory, not a symlink');
  }
  const realDataDir = await fs.promises.realpath(DATA_DIR);
  const realBackupRoot = await fs.promises.realpath(backupRoot);
  if (isWithin(realDataDir, realBackupRoot) || isWithin(realBackupRoot, realDataDir)) {
    throw new Error('Resolved backup directory and DATA_DIR must be separate trees');
  }
  const destinationRoot = realBackupRoot;
  await fs.promises.chmod(destinationRoot, 0o700);

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const backupDir = path.join(destinationRoot, `pcloud-video-${timestamp}-${process.pid}`);
  await fs.promises.mkdir(backupDir, { mode: 0o700 });
  incompleteBackupDir = backupDir;

  const databaseBackupPath = path.join(backupDir, 'videos.sqlite.partial');
  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    assertNoLiveWorkerLocks(source);
    await source.backup(databaseBackupPath);
  } finally {
    source.close();
  }

  const backupMutableDb = new Database(databaseBackupPath);
  let staleLocksRemoved = 0;
  try {
    const hasLockTable = backupMutableDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'process_locks'").get();
    if (hasLockTable) {
      assertNoLiveWorkerLocks(backupMutableDb);
      staleLocksRemoved = backupMutableDb.prepare('SELECT COUNT(*) AS count FROM process_locks').get().count;
      backupMutableDb.prepare('DELETE FROM process_locks').run();
    }
    backupMutableDb.pragma('wal_checkpoint(TRUNCATE)');
    if (backupMutableDb.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
      throw new Error('Could not finalize the backup as a standalone SQLite database');
    }
  } finally {
    backupMutableDb.close();
  }

  const backupDb = new Database(databaseBackupPath, { readonly: true, fileMustExist: true });
  let integrity;
  try {
    integrity = backupDb.pragma('integrity_check', { simple: true });
  } finally {
    backupDb.close();
  }
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
  await fs.promises.chmod(databaseBackupPath, 0o600);
  await fs.promises.rename(databaseBackupPath, path.join(backupDir, 'videos.sqlite'));

  const evidenceSource = path.join(DATA_DIR, 'evidence');
  let evidenceCopied = false;
  let evidenceSummary = { files: 0, bytes: 0 };
  try {
    const stat = await fs.promises.lstat(evidenceSource);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('DATA_DIR/evidence must be a real directory');
    await fs.promises.cp(evidenceSource, path.join(backupDir, 'evidence'), { recursive: true, errorOnExist: true, force: false });
    await lockDownTree(path.join(backupDir, 'evidence'));
    evidenceSummary = await measureTree(path.join(backupDir, 'evidence'));
    evidenceCopied = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const finalSourceCheck = new Database(databasePath, { readonly: true, fileMustExist: true });
  try { assertNoLiveWorkerLocks(finalSourceCheck); }
  finally { finalSourceCheck.close(); }

  const manifest = {
    format_version: 2,
    created_at: new Date().toISOString(),
    sqlite_integrity_check: integrity,
    database_sha256: await hashFile(path.join(backupDir, 'videos.sqlite')),
    stale_locks_removed: staleLocksRemoved,
    evidence_copied: evidenceCopied,
    evidence_files: evidenceSummary.files,
    evidence_bytes: evidenceSummary.bytes,
    evidence_sha256: evidenceCopied ? await hashTree(path.join(backupDir, 'evidence')) : null
  };
  const manifestPath = path.join(backupDir, 'manifest.json');
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.promises.writeFile(path.join(backupDir, 'COMPLETE'), 'ok\n', { mode: 0o600, flag: 'wx' });
  incompleteBackupDir = null;
  console.log(`Backup complete: ${backupDir}`);
}

main().catch(error => {
  if (incompleteBackupDir) fs.promises.rm(incompleteBackupDir, { recursive: true, force: true }).catch(() => {});
  console.error(`Backup failed: ${error.message}`);
  process.exitCode = 1;
});
