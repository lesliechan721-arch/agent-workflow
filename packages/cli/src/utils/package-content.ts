import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { catalogFileMode } from '@lesliechan721/aw-plugin-core';

export function compareSkillPaths(left: string, right: string): number {
  const byteOrder = Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  if (byteOrder !== 0 || left === right) return byteOrder;
  return left < right ? -1 : 1;
}

export function sortedSkillFileEntries(files: Record<string, Buffer>): Array<[string, Buffer]> {
  const entries = Object.entries(files);
  for (const [relativePath] of entries) {
    if (Buffer.from(relativePath, 'utf8').toString('utf8') !== relativePath) {
      throw new Error(`Skill 文件路径必须是有效 Unicode：${JSON.stringify(relativePath)}`);
    }
  }
  return entries.sort(([left], [right]) => compareSkillPaths(left, right));
}

export function createFileTreeContentDigest(tree: {
  files: Record<string, Buffer>; fileModes?: Record<string, 0o755>;
}): string {
  const hash = crypto.createHash('sha256');
  for (const [relativePath, content] of sortedSkillFileEntries(tree.files)) {
    const relativePathBytes = Buffer.from(relativePath, 'utf8');
    const pathLength = Buffer.alloc(8);
    const contentLength = Buffer.alloc(8);
    pathLength.writeBigUInt64BE(BigInt(relativePathBytes.length));
    contentLength.writeBigUInt64BE(BigInt(content.length));
    hash.update(pathLength);
    hash.update(relativePathBytes);
    hash.update(catalogFileMode(relativePath, tree.fileModes?.[relativePath] ?? 0o644));
    hash.update(contentLength);
    hash.update(content);
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function readPackageContentDigest(root: string, ownerMarker: string, verifyDirectories = false): Promise<string | undefined> {
  const stat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  const files: Record<string, Buffer> = Object.create(null);
  const fileModes: Record<string, 0o755> = Object.create(null);
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    // Published bundles only create directories needed by their files.
    if (verifyDirectories && prefix && !entries.length) throw new Error('platformContentInvalid');
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === ownerMarker) continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) throw new Error('platformContentInvalid');
      if (entry.isDirectory()) await visit(file, relative);
      else {
        files[relative] = await fs.readFile(file);
        if ((await fs.stat(file)).mode & 0o111) fileModes[relative] = 0o755;
      }
    }
  }
  await visit(root, '');
  return createFileTreeContentDigest({ files, fileModes });
}
