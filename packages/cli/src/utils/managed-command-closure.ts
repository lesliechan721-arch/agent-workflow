import { createHash } from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import {
  canonicalizeIdentityValue,
  getCommandPackageInjectedReaders,
  validateCommandEntryFiles,
  validateManagedCommandSources,
  type CommandLaunch,
  type CommandRoutes,
  type NormalizedPluginManifest,
} from '@lesliechan721/aw-plugin-core/manifest';
import { listCatalogBundleFiles } from '@lesliechan721/aw-plugin-core';

import type { PluginMeta } from '../types.js';
import { resolveCommandSourceDirectory } from './artifact-sources.js';
import { calculateFileDigest } from './bundle-integrity.js';
import { ManagedCommandError } from './managed-command-errors.js';
import { scanNodeImportContract } from './plugin-script-contract.js';

const NODE_FILE = /\.[cm]?js$/iu;

export function commandRouteEntries(routes: CommandRoutes): CommandLaunch[] {
  return routes.fallback === undefined ? routes.subcommands : [...routes.subcommands, routes.fallback];
}

async function readCommandTree(root: string): Promise<Array<{ path: string; mode: number; digest?: string }>> {
  const entries: Array<{ path: string; mode: number; digest?: string }> = [];
  async function visit(relative: string): Promise<void> {
    const location = path.join(root, relative);
    const stat = await fs.lstat(location);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new ManagedCommandError('commandResourceInvalid', 'Command package resources must be ordinary files and directories.');
    }
    if (stat.isDirectory()) {
      if (relative) entries.push({ path: relative, mode: 0 });
      for (const name of (await fs.readdir(location)).sort()) await visit(path.posix.join(relative, name));
    } else {
      entries.push({ path: relative, mode: stat.mode & 0o111, digest: await calculateFileDigest(location) });
    }
  }

  await visit('');
  return entries;
}

/** Validate against the copied command package itself, without searching its plugin's dependencies. */
export async function validateManagedCommandPackageClosure(
  resourceRoot: string,
  entries: readonly CommandLaunch[],
  injectedReaders: readonly string[] = [],
): Promise<void> {
  await validateCommandEntryFiles(resourceRoot, entries);
  const entryFiles = entries.filter((entry) => entry.runner === 'node').map((entry) => entry.entry);
  if (entryFiles.length === 0) return;
  const filePaths = await listCatalogBundleFiles(resourceRoot);
  const files: Record<string, string> = Object.fromEntries(injectedReaders.map((file) => [file, '']));
  for (const relative of filePaths) {
    const location = path.join(resourceRoot, relative);
    if (!(await fs.lstat(location)).isFile()) throw new ManagedCommandError('commandResourceInvalid', 'Invalid command resource file.');
    if (entryFiles.includes(relative) || NODE_FILE.test(relative) || path.posix.basename(relative) === 'package.json') {
      files[relative] = await fs.readFile(location, 'utf8');
    }
  }
  const scan = scanNodeImportContract({ files, filePaths, entryFiles });
  if (scan.errors.length > 0) throw new ManagedCommandError('commandResourceInvalid', `Invalid command package runtime imports:\n${scan.errors.join('\n')}`);
}

async function commandSourceRoot(pluginRoot: string, manifest: NormalizedPluginManifest): Promise<string> {
  try {
    await validateManagedCommandSources(pluginRoot, manifest);
    return await resolveCommandSourceDirectory({ bundleRoot: pluginRoot, pluginRelativePath: manifest.command!.sourceDir });
  } catch (error) {
    throw new ManagedCommandError('commandResourceInvalid', (error as Error).message);
  }
}

export async function validateManagedCommandSourceClosure(pluginRoot: string, manifest: NormalizedPluginManifest): Promise<void> {
  const command = manifest.command;
  if (!command) return;
  const resourceRoot = await commandSourceRoot(pluginRoot, manifest);
  if (command.mode !== 'static') return;
  const readers = getCommandPackageInjectedReaders(manifest);
  await validateManagedCommandPackageClosure(resourceRoot, commandRouteEntries(command.routes), readers?.paths);
}

function dependencyNames(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

/** Use the same import contract as bundle generation to identify the renderer's transitive imports. */
async function rendererClosureDigest(plugin: PluginMeta): Promise<string | undefined> {
  const renderer = plugin.manifest.scripts?.artifacts?.render;
  if (!renderer) return undefined;
  const bundleRoot = await fs.realpath(plugin.rootDir);
  const entry = renderer.path.replace(/^\.\//u, '');
  const allFiles = await listCatalogBundleFiles(bundleRoot);
  const runtimeFiles = allFiles.filter((file) => !file.split('/').includes('node_modules'));
  const runtimeFileSet = new Set(runtimeFiles);
  const files: Record<string, string> = {};
  for (const file of runtimeFiles) {
    if (file !== entry && !NODE_FILE.test(file) && path.posix.basename(file) !== 'package.json') continue;
    const location = path.join(bundleRoot, file);
    if ((await fs.lstat(location)).isFile()) files[file] = await fs.readFile(location, 'utf8');
  }
  const packageRoot = plugin.manifest.scripts?.node?.packageRoot?.replace(/^\.\//u, '');
  const packageJson = packageRoot === undefined ? undefined : path.posix.join(packageRoot, 'package.json');
  const packageInfo = packageJson === undefined ? {} : JSON.parse(files[packageJson] ?? '{}');
  const scan = scanNodeImportContract({ files, filePaths: runtimeFiles, entryFiles: [entry],
    dependencies: dependencyNames(packageInfo.dependencies), devDependencies: dependencyNames(packageInfo.devDependencies),
    runtimeConfigSkillRoots: plugin.manifest.artifacts?.sourceDirs });
  if (scan.errors.length) throw new ManagedCommandError('commandResourceInvalid', `Invalid command renderer imports:\n${scan.errors.join('\n')}`);

  const closure = new Set(scan.files);
  for (const file of scan.files) {
    let directory = path.posix.dirname(file);
    while (true) {
      const metadata = path.posix.join(directory, 'package.json');
      if (runtimeFileSet.has(metadata)) closure.add(metadata);
      if (directory === '.') break;
      directory = path.posix.dirname(directory);
    }
  }
  if (packageRoot !== undefined && packageJson !== undefined && scan.bareSpecifiers.length) {
    closure.add(packageJson);
    const dependencyRoot = path.posix.join(packageRoot, 'node_modules');
    for (const file of allFiles) if (file.startsWith(`${dependencyRoot}/`)) closure.add(file);
  }
  const digests = [];
  for (const file of [...closure].sort()) {
    const location = path.join(bundleRoot, file);
    const stat = await fs.lstat(location);
    if (stat.isFile()) digests.push({ path: file, digest: await calculateFileDigest(location) });
    else if (stat.isSymbolicLink() && file.split('/').includes('node_modules')) {
      digests.push({ path: file, link: await fs.readlink(location) });
    } else throw new ManagedCommandError('commandResourceInvalid', 'The command renderer closure contains an unsafe file.');
  }
  return commandInputDigest(digests);
}

export function commandInputDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalizeIdentityValue(value)).digest('hex')}`;
}

export interface ManagedCommandSource {
  sourceRoot: string;
  sourceTreeDigest: string;
  sourceContentDigest: string;
}

export async function calculateManagedCommandResourceDigest(resourceRoot: string): Promise<string> {
  const root = await fs.lstat(resourceRoot);
  if (!root.isDirectory()) throw new ManagedCommandError('commandResourceInvalid', 'The command source must be a regular directory.');
  return commandInputDigest(await readCommandTree(resourceRoot));
}

export async function readManagedCommandSource(plugin: PluginMeta): Promise<ManagedCommandSource> {
  const declaration = plugin.manifest.command;
  if (!declaration) throw new ManagedCommandError('commandPackageDeclarationMissing', 'The active plugin does not declare a command package.');
  const sourceRoot = await commandSourceRoot(plugin.rootDir, plugin.manifest);
  const [sourceTreeDigest, manifestDigest, rendererDigest] = await Promise.all([
    calculateManagedCommandResourceDigest(sourceRoot), calculateFileDigest(plugin.manifestPath), rendererClosureDigest(plugin),
  ]);
  return { sourceRoot, sourceTreeDigest,
    sourceContentDigest: commandInputDigest({ sourceDir: declaration.sourceDir, sourceTreeDigest, manifestDigest, rendererDigest: rendererDigest ?? null }) };
}
