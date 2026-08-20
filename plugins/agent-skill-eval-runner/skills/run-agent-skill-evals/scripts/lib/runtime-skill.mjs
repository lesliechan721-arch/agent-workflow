import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const ALWAYS_IGNORED = new Set(['.git', 'node_modules']);
const AUTHOR_ONLY_ROOTS = new Set(['evals', 'reports']);

export function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

export function pathsOverlap(left, right) {
  return isPathInside(left, right) || isPathInside(right, left);
}

export async function runtimeSkillFiles(root) {
  const rootStat = await stat(root);
  if (rootStat.isFile()) {
    return [{ absolutePath: root, relativePath: path.basename(root) }];
  }
  if (!rootStat.isDirectory()) throw new Error(`Skill target is not a file or directory: ${root}`);

  const files = [];
  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (ALWAYS_IGNORED.has(entry.name)) continue;
      if (relativeDirectory === '' && AUTHOR_ONLY_ROOTS.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Skill target cannot contain symlinks: ${relativePath}`);
      if (entry.isDirectory()) await walk(absolutePath, relativePath);
      else if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: relativePath.split(path.sep).join('/'),
        });
      }
    }
  }
  await walk(root);
  return files;
}

export async function runtimeSkillDigest(root) {
  const canonicalRoot = await realpath(root);
  const hash = createHash('sha256');
  for (const file of await runtimeSkillFiles(canonicalRoot)) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(await readFile(file.absolutePath));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function copyRuntimeSkill(sourceRoot, destinationRoot) {
  const canonicalSource = await realpath(sourceRoot);
  await mkdir(destinationRoot, { recursive: true });
  for (const file of await runtimeSkillFiles(canonicalSource)) {
    const destination = path.join(destinationRoot, ...file.relativePath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(file.absolutePath, destination);
  }
  return destinationRoot;
}
