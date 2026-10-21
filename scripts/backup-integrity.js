const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function hashTree(root) {
  const files = [];
  async function collect(directory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in evidence tree: ${fullPath}`);
      if (entry.isDirectory()) await collect(fullPath);
      else if (entry.isFile()) files.push(fullPath);
      else throw new Error(`Unsupported evidence entry: ${fullPath}`);
    }
  }
  await collect(root);

  const treeHash = crypto.createHash('sha256');
  for (const fullPath of files) {
    const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
    const stat = await fs.promises.stat(fullPath);
    const contentHash = await hashFile(fullPath);
    treeHash.update(`${relativePath}\0${stat.size}\0${contentHash}\n`);
  }
  return treeHash.digest('hex');
}

module.exports = { hashFile, hashTree };
