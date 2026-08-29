import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

export async function calculateFileDigest(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return `sha256:${hash.digest('hex')}`;
}

interface BundleEntry {
  type: 'directory' | 'file' | 'symlink';
  relativePath: string;
  payload: Buffer;
}

async function collectBundleEntries(
  rootDir: string,
  relativeDir = '',
): Promise<BundleEntry[]> {
  const absoluteDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const output: BundleEntry[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeDir
      ? path.join(relativeDir, entry.name).split(path.sep).join('/')
      : entry.name;
    const absolutePath = path.join(rootDir, ...relativePath.split('/'));
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      output.push({
        type: 'symlink',
        relativePath,
        payload: Buffer.from(await fs.readlink(absolutePath)),
      });
      continue;
    }
    if (stat.isDirectory()) {
      output.push({ type: 'directory', relativePath, payload: Buffer.alloc(0) });
      output.push(...await collectBundleEntries(rootDir, relativePath));
      continue;
    }
    if (stat.isFile()) {
      output.push({ type: 'file', relativePath, payload: await fs.readFile(absolutePath) });
      continue;
    }
    throw new Error(`Plugin bundle contains an unsupported entry: ${absolutePath}`);
  }

  return output;
}

function updateLength(hash: crypto.Hash, value: number): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  hash.update(encoded);
}

export async function calculatePluginBundleFingerprint(bundleRoot: string): Promise<string> {
  const rootStat = await fs.lstat(bundleRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Plugin bundle root must be a regular directory: ${bundleRoot}`);
  }

  const hash = crypto.createHash('sha256');
  hash.update('agent-workflows-plugin-bundle\0v2\0');
  for (const entry of await collectBundleEntries(bundleRoot)) {
    const type = entry.type === 'directory' ? 0x44 : entry.type === 'file' ? 0x46 : 0x4c;
    const pathBytes = Buffer.from(entry.relativePath);
    hash.update(Buffer.from([type]));
    updateLength(hash, pathBytes.length);
    hash.update(pathBytes);
    updateLength(hash, entry.payload.length);
    hash.update(entry.payload);
  }

  return `sha256:${hash.digest('hex')}`;
}
