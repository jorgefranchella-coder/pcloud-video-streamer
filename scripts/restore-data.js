const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const Database = require('better-sqlite3');

const execFileAsync = promisify(execFile);
const backupDirArg = process.argv[2];
const targetDirArg = process.argv[3];

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function secureTree(root) {
  await fs.promises.chmod(root, 0o700);
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in evidence: ${child}`);
    if (entry.isDirectory()) await secureTree(child);
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
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in evidence: ${child}`);
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
  if (!backupDirArg || !targetDirArg || !path.isAbsolute(backupDirArg) || !path.isAbsolute(targetDirArg)) {
    throw new Error('Usage: node scripts/restore-data.js /absolute/path/to/backup /absolute/path/to/new-data-dir');
  }
  const backupDir = path.resolve(backupDirArg);
  const targetDir = path.resolve(targetDirArg);
  if (isWithin(backupDir, targetDir) || isWithin(targetDir, backupDir)) {
    throw new Error('Backup and restore directories must be separate trees');
  }

  await execFileAsync(process.execPath, [path.join(__dirname, 'verify-backup.js'), backupDir]);
  const manifest = JSON.parse(await fs.promises.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  await fs.promises.mkdir(path.dirname(targetDir), { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(targetDir, { mode: 0o700 });
  try {
    await fs.promises.copyFile(path.join(backupDir, 'videos.sqlite'), path.join(targetDir, 'videos.sqlite'), fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(path.join(targetDir, 'videos.sqlite'), 0o600);

    if (manifest.evidence_copied) {
      await fs.promises.cp(path.join(backupDir, 'evidence'), path.join(targetDir, 'evidence'), {
        recursive: true, errorOnExist: true, force: false
      });
      await secureTree(path.join(targetDir, 'evidence'));
    }

    const databasePath = path.join(targetDir, 'videos.sqlite');
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Restored SQLite integrity check failed');
      if (db.pragma('foreign_key_check').length) throw new Error('Restored SQLite foreign key check failed');
    } finally {
      db.close();
    }
    if (manifest.evidence_copied) {
      const actual = await measureTree(path.join(targetDir, 'evidence'));
      if (actual.files !== manifest.evidence_files || actual.bytes !== manifest.evidence_bytes) {
        throw new Error('Restored evidence does not match the verified backup manifest');
      }
    }
    await fs.promises.writeFile(path.join(targetDir, 'RESTORE_COMPLETE'), 'ok\n', { mode: 0o600, flag: 'wx' });
    console.log(`Restore complete: ${targetDir}`);
  } catch (error) {
    await fs.promises.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

main().catch(error => {
  console.error(`Restore failed: ${error.message}`);
  process.exitCode = 1;
});
