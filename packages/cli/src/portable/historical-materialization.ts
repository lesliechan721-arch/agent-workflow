import crypto from 'node:crypto';
import path from 'node:path';

import { computeSkillDigest } from '@lesliechan721/agent-skill-eval';
import fs from 'fs-extra';

import { readAwSourceBinding, type AwSourceBindingV2 } from '../review/source-binding.js';
import type { PortableMaterializeReceipt } from './commands.js';
import { validatePortableSkillName } from '../utils/dynamic-skill-tree.js';

export interface HistoricalPortableMaterialization {
  rootDir: string;
  marker: PortableMaterializeReceipt;
  binding: AwSourceBindingV2;
}

export function portableJsonDigest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** Reject aliases before reading either provider paths or materialization evidence. */
export async function assertPortablePath(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('portableOutputConflict');
  }
  let current = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    const info = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) return false;
    if (info.isSymbolicLink() || (!info.isDirectory() && current !== target)) {
      throw new Error('portableOutputConflict');
    }
  }
  return true;
}

/** The materializer's digest includes every regular file, including hidden files. */
export async function portableSkillTreeDigest(root: string): Promise<string> {
  const files: Array<[string, Buffer]> = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('portableOutputConflict');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('portableOutputConflict');
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push([relative, await fs.readFile(absolute)]);
      else throw new Error('portableOutputConflict');
    }
  };
  await visit(root, '');
  const hash = crypto.createHash('sha256');
  for (const [name, bytes] of files.sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(name).update('\0').update(bytes).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Validate the old generation itself without applying current Workspace inputs. */
export async function readHistoricalPortableMaterialization(options: {
  projectRoot: string;
  rootDir: string;
  pluginId?: string;
  logicalIdentity?: string;
}): Promise<HistoricalPortableMaterialization> {
  const base = path.join(options.projectRoot, '.agent-workflows', '.local', 'portable');
  if (!await assertPortablePath(options.projectRoot, options.rootDir)
    || !await assertPortablePath(base, options.rootDir)
    || path.relative(base, options.rootDir).split(path.sep).length !== 2) {
    throw new Error('portableOutputConflict');
  }
  for (const name of ['.aw-materialization.json', 'aw-source-binding.json']) {
    const info = await fs.lstat(path.join(options.rootDir, name));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('portableOutputConflict');
  }
  const binding = await readAwSourceBinding(path.join(options.rootDir, 'aw-source-binding.json'));
  const marker = await fs.readJson(path.join(options.rootDir, '.aw-materialization.json')) as
    PortableMaterializeReceipt & { schemaVersion: number; config?: { pluginConfigDigest?: string } };
  if (binding.source.kind !== 'catalog-snapshot' || binding.profile.kind !== 'portable'
    || binding.profile.scope !== 'project'
    || (options.logicalIdentity !== undefined && binding.source.logicalIdentity !== options.logicalIdentity)
    || marker.schemaVersion !== 1 || marker.receiptSchemaVersion !== 5
    || marker.command !== 'skill:materialize' || marker.scope !== 'project'
    || typeof marker.plugin?.id !== 'string'
    || (options.pluginId !== undefined && marker.plugin.id !== options.pluginId)
    || marker.plugin.id !== `${binding.source.sourceId}/${binding.subject.plugin}`
    || marker.plugin.sourceId !== binding.source.sourceId
    || marker.plugin.sourceIdentity !== binding.source.catalogSourceIdentity
    || marker.config?.pluginConfigDigest !== binding.profile.inputDigest
    || !Array.isArray(marker.selectedSkills)
    || marker.selectedSkills.length !== binding.artifacts.length) {
    throw new Error('portableOutputConflict');
  }
  const names = new Set<string>();
  for (const candidate of marker.selectedSkills) {
    if (typeof candidate.name !== 'string' || names.has(candidate.name)) throw new Error('portableOutputConflict');
    validatePortableSkillName(candidate.name);
    names.add(candidate.name);
    const artifact = binding.artifacts.find((entry) => entry.kind === 'portable-skill'
      && entry.skill === candidate.name);
    if (!artifact || artifact.kind !== 'portable-skill'
      || artifact.path !== `skills/${candidate.name}`
      || candidate.providerPluginId !== `${binding.source.sourceId}/${artifact.plugin}`) {
      throw new Error('portableOutputConflict');
    }
    const skillPath = path.join(options.rootDir, artifact.path);
    await assertPortablePath(options.rootDir, skillPath);
    if (await portableSkillTreeDigest(skillPath) !== candidate.filesDigest
      || await computeSkillDigest(skillPath) !== artifact.digest) throw new Error('portableOutputConflict');
  }
  const children = await fs.readdir(path.join(options.rootDir, 'skills'));
  if (children.length !== names.size || children.some((name) => !names.has(name))
    || marker.outputDigest !== portableJsonDigest(marker.selectedSkills.map((entry) => [entry.name, entry.filesDigest]))
    || marker.materializationDigest !== marker.outputDigest) throw new Error('portableOutputConflict');
  const rootChildren = await fs.readdir(options.rootDir);
  if (rootChildren.some((name) => !['skills', '.aw-materialization.json', 'aw-source-binding.json'].includes(name))) {
    throw new Error('portableOutputConflict');
  }
  return { rootDir: options.rootDir, marker, binding };
}
