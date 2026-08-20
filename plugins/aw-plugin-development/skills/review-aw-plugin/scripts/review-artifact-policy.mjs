import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const AUTHOR_DIRECTORY_NAMES = new Set(['evals', 'reports']);

function portable(relativePath) {
  return relativePath.split(path.sep).join('/');
}

export function isSkillAuthorArtifact(relativePath, skillRoots) {
  const candidate = portable(relativePath);
  return skillRoots.some((skillRoot) => {
    const relativeToSkill = path.posix.relative(portable(skillRoot), candidate);
    if (!relativeToSkill || relativeToSkill.startsWith('../')) return false;
    return AUTHOR_DIRECTORY_NAMES.has(relativeToSkill.split('/')[0]);
  });
}

export function isPluginEvidenceArtifact(relativePath, skillRoots) {
  const candidate = portable(relativePath);
  return (
    candidate.startsWith('reports/') ||
    candidate === 'reports' ||
    isSkillAuthorArtifact(candidate, skillRoots)
  );
}

export async function findSkillRoots(pluginRoot, skillsDeclaration = './skills') {
  const skillsRoot = path.resolve(pluginRoot, skillsDeclaration);
  const roots = [];

  async function hasSkillFile(directory) {
    try {
      return (await stat(path.join(directory, 'SKILL.md'))).isFile();
    } catch {
      return false;
    }
  }

  async function visit(directory) {
    if (await hasSkillFile(directory)) {
      roots.push(portable(path.relative(pluginRoot, directory)));
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || ['.git', 'node_modules'].includes(entry.name)) continue;
      await visit(path.join(directory, entry.name));
    }
  }

  try {
    await visit(skillsRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return roots.sort();
}
