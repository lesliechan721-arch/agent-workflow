import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './contracts.mjs';

export async function safePath(target, kind = 'file', { allowExecutableSymlink = false } = {}) {
  if (!path.isAbsolute(target) || target.includes('\0') || path.normalize(target) !== target) fail('pathInvalid', 'A runtime path must be absolute and normalized.');
  let current = path.parse(target).root;
  for (const segment of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); } catch { fail('pathMissing', 'A required runtime path is missing or unreadable.'); }
    if (stat.isSymbolicLink()) {
      if (allowExecutableSymlink) return safePath(await fs.realpath(target), kind);
      fail('pathSymlink', 'Symbolic links are not allowed in private runtime resources.');
    }
    if (current !== target && !stat.isDirectory()) fail('pathInvalid', 'A path parent is not a normal directory.');
  }
  const stat = await fs.lstat(target);
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) fail('pathInvalid', 'The path has an unsupported node type.');
  return target;
}
