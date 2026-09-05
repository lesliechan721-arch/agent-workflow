import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeTreeDigest } from '../../../../scripts/build/build-cache.mjs';

const tempDirs: string[] = [];

function updateLengthPrefixed(hash: crypto.Hash, value: string | Buffer): void {
  const contents = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(contents.length));
  hash.update(length);
  hash.update(contents);
}

async function computeLegacyTreeDigest(
  repoRoot: string,
  roots: string[],
  exclude: (relativePath: string) => boolean = () => false,
): Promise<string> {
  type Entry = {
    kind: 'missing' | 'directory' | 'file' | 'symlink' | 'other';
    path: string;
    mode?: number;
    contents?: Buffer;
    target?: string;
    referentDigest?: string;
  };
  const collect = async (
    relativePath: string,
    entries: Entry[],
    traversal: { absolutePath?: string; ancestorRealPaths?: Set<string> } = {},
  ): Promise<void> => {
    if (exclude(relativePath)) return;
    const absolutePath = traversal.absolutePath ?? path.join(repoRoot, relativePath);
    const ancestorRealPaths = traversal.ancestorRealPaths ?? new Set<string>();
    let stats;
    try {
      stats = await fs.lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        entries.push({ kind: 'missing', path: relativePath.split(path.sep).join('/') });
        return;
      }
      throw error;
    }
    const normalizedPath = relativePath.split(path.sep).join('/');
    if (stats.isSymbolicLink()) {
      let referentDigest: string;
      try {
        const referentPath = await fs.realpath(absolutePath);
        if (ancestorRealPaths.has(referentPath)) {
          referentDigest = 'cycle';
        } else {
          const referentEntries: Entry[] = [];
          await collect(relativePath, referentEntries, {
            absolutePath: referentPath,
            ancestorRealPaths,
          });
          referentDigest = digestEntries(referentEntries);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ELOOP') throw error;
        referentDigest = `unresolved:${code}`;
      }
      entries.push({
        kind: 'symlink',
        mode: stats.mode & 0o777,
        path: normalizedPath,
        referentDigest,
        target: await fs.readlink(absolutePath),
      });
      return;
    }
    if (stats.isDirectory()) {
      entries.push({ kind: 'directory', mode: stats.mode & 0o777, path: normalizedPath });
      const nextAncestors = new Set(ancestorRealPaths);
      nextAncestors.add(await fs.realpath(absolutePath));
      for (const name of (await fs.readdir(absolutePath)).sort()) {
        await collect(path.join(relativePath, name), entries, {
          absolutePath: path.join(absolutePath, name),
          ancestorRealPaths: nextAncestors,
        });
      }
      return;
    }
    if (stats.isFile()) {
      entries.push({
        kind: 'file',
        contents: await fs.readFile(absolutePath),
        mode: stats.mode & 0o777,
        path: normalizedPath,
      });
      return;
    }
    entries.push({ kind: 'other', mode: stats.mode, path: normalizedPath });
  };
  const digestEntries = (entries: Entry[]): string => {
    entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const hash = crypto.createHash('sha256');
    for (const entry of entries) {
      const entryHash = crypto.createHash('sha256');
      updateLengthPrefixed(entryHash, entry.kind);
      updateLengthPrefixed(entryHash, entry.path);
      if (entry.kind === 'file') {
        updateLengthPrefixed(entryHash, String(entry.mode));
        updateLengthPrefixed(entryHash, entry.contents ?? Buffer.alloc(0));
      } else if (entry.kind === 'symlink') {
        updateLengthPrefixed(entryHash, String(entry.mode));
        updateLengthPrefixed(entryHash, entry.target ?? '');
        updateLengthPrefixed(entryHash, entry.referentDigest ?? '');
      } else if (entry.kind === 'directory' || entry.kind === 'other') {
        updateLengthPrefixed(entryHash, String(entry.mode));
      }
      updateLengthPrefixed(hash, entryHash.digest());
    }
    return hash.digest('hex');
  };
  const entries: Entry[] = [];
  for (const root of [...roots].sort()) await collect(root, entries);
  return digestEntries(entries);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('streaming build tree digest', () => {
  it('preserves the legacy digest bytes for every existing entry contract', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-build-digest-'));
    tempDirs.push(repoRoot);
    await fs.mkdir(path.join(repoRoot, 'tree', 'z-dir'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, 'tree', 'empty-dir'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'tree', 'z-dir', 'z.txt'), 'z\0value');
    await fs.writeFile(path.join(repoRoot, 'tree', 'a.txt'), 'a\n');
    await fs.writeFile(path.join(repoRoot, 'tree', 'empty.txt'), '');
    await fs.writeFile(path.join(repoRoot, 'tree', 'excluded.txt'), 'excluded');
    await fs.chmod(path.join(repoRoot, 'tree', 'a.txt'), 0o744);
    await fs.symlink('a.txt', path.join(repoRoot, 'tree', 'relative-link'));
    await fs.symlink('missing.txt', path.join(repoRoot, 'tree', 'broken-link'));
    await fs.mkdir(path.join(repoRoot, 'cycle'));
    await fs.symlink('.', path.join(repoRoot, 'cycle', 'self'));

    const roots = ['missing-root', 'tree', 'cycle'];
    const exclude = (relativePath: string): boolean => relativePath.endsWith('excluded.txt');
    await expect(computeTreeDigest(repoRoot, roots, exclude)).resolves.toBe(
      await computeLegacyTreeDigest(repoRoot, roots, exclude),
    );
    await expect(computeTreeDigest(repoRoot, [...roots].reverse(), exclude)).resolves.toBe(
      await computeLegacyTreeDigest(repoRoot, roots, exclude),
    );
  });
});
