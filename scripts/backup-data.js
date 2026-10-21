const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const backupRootArg = process.argv[2];

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
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
  await fs.promises.chmod(backupRoot, 0o700);

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const backupDir = path.join(backupRoot, `pcloud-video-${timestamp}-${process.pid}`);
  await fs.promises.mkdir(backupDir, { mode: 0o700 });

  const databaseBackupPath = path.join(backupDir, 'videos.sqlite.partial');
  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(databaseBackupPath);
  } finally {
    source.close();
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
  try {
    const stat = await fs.promises.lstat(evidenceSource);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('DATA_DIR/evidence must be a real directory');
    await fs.promises.cp(evidenceSource, path.join(backupDir, 'evidence'), { recursive: true, errorOnExist: true, force: false });
    await lockDownTree(path.join(backupDir, 'evidence'));
    evidenceCopied = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const manifest = {
    created_at: new Date().toISOString(),
    sqlite_integrity_check: integrity,
    evidence_copied: evidenceCopied
  };
  const manifestPath = path.join(backupDir, 'manifest.json');
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.promises.writeFile(path.join(backupDir, 'COMPLETE'), 'ok\n', { mode: 0o600, flag: 'wx' });
  console.log(`Backup complete: ${backupDir}`);
}

main().catch(error => {
  console.error(`Backup failed: ${error.message}`);
  process.exitCode = 1;
});
