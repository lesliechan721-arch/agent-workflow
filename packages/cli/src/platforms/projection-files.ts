import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import type { PluginComponent, ResourceFile } from '@lesliechan721/aw-plugin-core/manifest';
import type { ProjectionInput, ProjectionResult } from './contracts.js';
import { canonicalizePathThroughExistingAncestor } from '../utils/state-paths.js';
import { createDynamicSkillTreeContentDigest } from '../utils/dynamic-skill-tree.js';

export interface ProjectedFile { bytes: Buffer; mode: number }

export function safeProjectionPath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..' || /[:\u0000-\u001f\u007f]/u.test(part))) {
    throw new Error('platformProjectionPathInvalid');
  }
  return value;
}

export function nativeComponentName(value: string): string {
  const name = value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!name || name.length > 128) throw new Error('platformProjectionNameInvalid');
  return name;
}

/** Every path is reserved before staging is touched, including case aliases. */
export class ProjectionFiles {
  readonly files = new Map<string, ProjectedFile>();
  readonly components: ProjectionResult['components'] = [];
  private readonly names = new Set<string>();
  private readonly paths = new Set<string>();

  component(component: PluginComponent, name: string): void {
    const key = `${component.kind}:${name.toLowerCase()}`;
    if (this.names.has(key)) throw new Error('platformProjectionNameConflict');
    this.names.add(key);
    this.components.push({ id: component.id, nativeName: name, relativeOutputs: [] });
  }

  add(relative: string, content: string | Buffer, componentIds: readonly string[] = [], mode = 0o644): void {
    safeProjectionPath(relative);
    const folded = relative.toLowerCase();
    if (this.paths.has(folded) || [...this.paths].some((other) => other.startsWith(`${folded}/`) || folded.startsWith(`${other}/`))) {
      throw new Error('platformProjectionPathConflict');
    }
    this.paths.add(folded);
    this.files.set(relative, { bytes: typeof content === 'string' ? Buffer.from(content) : Buffer.from(content), mode: mode & 0o777 });
    this.link(relative, componentIds);
  }

  json(relative: string, content: unknown, componentIds: readonly string[] = []): void {
    this.add(relative, `${JSON.stringify(content, null, 2)}\n`, componentIds);
  }

  link(relative: string, componentIds: readonly string[]): void {
    for (const id of componentIds) {
      const component = this.components.find((entry) => entry.id === id);
      if (component && !component.relativeOutputs.includes(relative)) component.relativeOutputs.push(relative);
    }
  }

  digest(prefix = ''): string {
    const exactFile = this.files.get(prefix);
    if (exactFile) return `sha256:${createHash('sha256').update(exactFile.bytes).digest('hex')}`;
    const treeFiles: Record<string, Buffer> = {};
    const fileModes: Record<string, 0o755> = {};
    for (const [relative, file] of this.files) {
      if (prefix && !relative.startsWith(`${prefix}/`)) continue;
      const name = prefix ? relative.slice(prefix.length + 1) : relative;
      treeFiles[name] = file.bytes;
      if (file.mode & 0o111) fileModes[name] = 0o755;
    }
    return createDynamicSkillTreeContentDigest({ skillKey: '', files: treeFiles, fileModes });
  }

  async write(root: string, signal?: AbortSignal): Promise<void> {
    for (const [relative, file] of this.files) {
      signal?.throwIfAborted();
      const destination = path.join(root, ...relative.split('/'));
      await fs.ensureDir(path.dirname(destination));
      await fs.writeFile(destination, file.bytes, { flag: 'wx', mode: file.mode });
      await fs.chmod(destination, file.mode);
    }
  }
}

export function resourceBytes(input: ProjectionInput, componentId: string, relative: string, resource: ResourceFile): { bytes: Buffer; mode: number } {
  safeProjectionPath(relative);
  const frozen = input.resources.files.find((file) => file.componentId === componentId && file.path === relative);
  if (frozen) {
    if ('text' in resource && !Buffer.from(resource.text).equals(frozen.bytes)) throw new Error('platformProjectionResourceMismatch');
    if ('source' in resource && JSON.stringify(resource.source) !== JSON.stringify(frozen.source)) throw new Error('platformProjectionResourceMismatch');
    return { bytes: frozen.bytes, mode: frozen.mode ?? 0o644 };
  }
  if ('text' in resource) return { bytes: Buffer.from(resource.text), mode: 0o644 };
  throw new Error('platformProjectionResourceMissing');
}

/** Reject symlink staging roots and ancestors; never follow a caller's link. */
export async function prepareProjectionRoot(stagingRoot: string): Promise<string> {
  if (!path.isAbsolute(stagingRoot)) throw new Error('platformProjectionStagingInvalid');
  try {
    const stat = await fs.lstat(stagingRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('platformProjectionStagingInvalid');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const canonicalRoot = await canonicalizePathThroughExistingAncestor(stagingRoot);
  await fs.ensureDir(canonicalRoot);
  return fs.mkdtemp(path.join(canonicalRoot, 'projection-'));
}
