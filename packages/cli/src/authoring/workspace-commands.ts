import path from 'node:path';
import fs from 'fs-extra';

import {
  buildCatalogWorkspace,
  buildCatalogWorkspacePlugin,
  initializeCatalogWorkspace,
  mutateCatalogWorkspaceVersion,
  readCatalogWorkspace,
  validateCatalogSnapshotComplete,
  type CatalogVersionBump,
  type CatalogWorkspaceBuildAdapter,
  type CatalogWorkspacePluginBuildAdapter,
} from '@lesliechan721/aw-plugin-core';

import {
  bundleLocalPlugin,
  createCatalogRuntimeImportResolver,
} from '../../scripts/plugin-staging.js';
import { runPluginScriptTests } from '../../scripts/test-plugin-scripts.js';
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js';
import type { CatalogWorkspaceResolvedFrom } from '../commands/catalog-workspace-resolution.js';

export interface AuthoringCommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const catalogBuildAdapter: CatalogWorkspaceBuildAdapter = {
  async build(options) {
    await bundleLocalPlugin(options.plugin, options.outputRoot, {
      buildMode: 'staging',
      runtimeResolver: createCatalogRuntimeImportResolver(options.plugins),
    });
  },
};

const pluginBuildAdapter: CatalogWorkspacePluginBuildAdapter = {
  async build(options) {
    await bundleLocalPlugin(options.plugin, options.outputRoot, {
      buildMode: 'staging',
      runtimeResolver: createCatalogRuntimeImportResolver(options.plugins),
    });
  },
};

function writeJson(io: AuthoringCommandIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

export async function runCatalogInitCommand(options: {
  workspaceRoot: string;
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom;
  force?: boolean;
  json?: boolean;
  ownerName?: string;
  ownerUrl?: string;
  displayName?: string;
  catalogVersion?: string;
  io: AuthoringCommandIo;
}): Promise<void> {
  const result = await initializeCatalogWorkspace(options);
  const receipt = {
    command: 'catalog:init',
    ok: true,
    workspaceRoot: result.workspaceRoot,
    workspaceRootResolvedFrom: options.workspaceRootResolvedFrom,
    metadataPath: result.metadataPath,
    catalogVersion: result.metadata.catalog.version,
  };
  if (options.json) writeJson(options.io, receipt);
  else options.io.stdout(`Catalog Workspace initialized at ${result.workspaceRoot}.\n`);
}

export async function runCatalogVersionCommand(options: {
  workspaceRoot: string;
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom;
  version?: string;
  bump?: CatalogVersionBump;
  json?: boolean;
  io: AuthoringCommandIo;
}): Promise<{
  command: 'catalog:version';
  ok: true;
  workspaceRoot: string;
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom;
  catalogVersion: string;
  changed: boolean;
}> {
  if (options.version !== undefined && options.bump !== undefined) {
    throw new Error('Catalog version accepts an exact version or --bump, not both.');
  }
  const current = await readCatalogWorkspace(options.workspaceRoot, {
    reservedImports: CLI_RESERVED_IMPORTS,
  });
  const metadata = options.version === undefined && options.bump === undefined
    ? current.metadata
    : await mutateCatalogWorkspaceVersion(options.workspaceRoot, {
        ...(options.version === undefined ? {} : { version: options.version }),
        ...(options.bump === undefined ? {} : { bump: options.bump }),
      }, { reservedImports: CLI_RESERVED_IMPORTS });
  const receipt = {
    command: 'catalog:version' as const,
    ok: true as const,
    workspaceRoot: path.resolve(options.workspaceRoot),
    workspaceRootResolvedFrom: options.workspaceRootResolvedFrom,
    catalogVersion: metadata.catalog.version,
    changed: metadata.catalog.version !== current.metadata.catalog.version,
  };
  if (options.json) writeJson(options.io, receipt);
  else options.io.stdout(`${metadata.catalog.version}\n`);
  return receipt;
}

export async function runCatalogBuildCommand(options: {
  workspaceRoot: string;
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom;
  out?: string;
  force?: boolean;
  json?: boolean;
  io: AuthoringCommandIo;
}): Promise<{
  command: 'catalog:build';
  ok: true;
  workspaceRoot: string;
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom;
  outputRoot: string;
  catalogVersion: string;
  channel: 'latest' | 'beta';
  pluginNames: string[];
}> {
  const result = await buildCatalogWorkspace({
    workspaceRoot: options.workspaceRoot,
    ...(options.out ? { outputPath: options.out } : {}),
    force: options.force,
    adapter: catalogBuildAdapter,
    reservedImports: CLI_RESERVED_IMPORTS,
  });
  const receipt = {
    command: 'catalog:build' as const,
    ok: true as const,
    workspaceRoot: path.resolve(options.workspaceRoot),
    workspaceRootResolvedFrom: options.workspaceRootResolvedFrom,
    ...result,
  };
  if (options.json) writeJson(options.io, receipt);
  else options.io.stdout(`Catalog snapshot built at ${result.outputRoot}.\n`);
  return receipt;
}

export async function runCatalogValidateCommand(options: {
  snapshotDirectory: string;
  json?: boolean;
  io: AuthoringCommandIo;
}): Promise<void> {
  const result = await validateCatalogSnapshotComplete(options.snapshotDirectory);
  const receipt = {
    command: 'catalog:validate',
    ok: true,
    snapshotDirectory: result.rootDir,
    catalogVersion: result.manifest.catalogVersion,
    channel: result.manifest.channel,
    snapshotDigest: result.snapshotDigest,
  };
  if (options.json) writeJson(options.io, receipt);
  else options.io.stdout(`Catalog snapshot is valid: ${result.rootDir}.\n`);
}

export async function runPluginBuildCommand(options: {
  workspaceRoot: string;
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom;
  pluginDirectory: string;
  out?: string;
  force?: boolean;
  json?: boolean;
  io: AuthoringCommandIo;
}): Promise<void> {
  const result = await buildCatalogWorkspacePlugin({
    workspaceRoot: options.workspaceRoot,
    pluginDirectory: options.pluginDirectory,
    ...(options.out ? { outputPath: options.out } : {}),
    force: options.force,
    adapter: pluginBuildAdapter,
    reservedImports: CLI_RESERVED_IMPORTS,
  });
  const receipt = {
    command: 'plugin:build',
    ok: true,
    workspaceRoot: path.resolve(options.workspaceRoot),
    workspaceRootResolvedFrom: options.workspaceRootResolvedFrom,
    ...result,
  };
  if (options.json) writeJson(options.io, receipt);
  else options.io.stdout(`Plugin bundle built at ${result.outputRoot}.\n`);
}

export async function runPluginTestCommand(options: {
  workspaceRoot: string;
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom;
  pluginDirectory: string;
  json?: boolean;
  io: AuthoringCommandIo;
}): Promise<number> {
  const catalogWorkspace = await readCatalogWorkspace(options.workspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS });
  const pluginRoot = await fs.realpath(path.resolve(catalogWorkspace.workspaceRoot, options.pluginDirectory));
  const plugin = catalogWorkspace.plugins.find((entry) => entry.rootDir === pluginRoot);
  if (!plugin) throw new Error(`Plugin directory is not part of this Catalog Workspace source: ${pluginRoot}`);
  let stdout = '';
  let stderr = '';
  const exitCode = await runPluginScriptTests([plugin.manifest.name], {
    repoRoot: catalogWorkspace.workspaceRoot,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  if (options.json) {
    writeJson(options.io, {
      command: 'plugin:test',
      ok: exitCode === 0,
      workspaceRoot: catalogWorkspace.workspaceRoot,
      workspaceRootResolvedFrom: options.workspaceRootResolvedFrom,
      pluginName: plugin.manifest.name,
      exitCode,
      stdout,
      stderr,
    });
  } else {
    if (stdout) options.io.stdout(stdout);
    if (stderr) options.io.stderr(stderr);
  }
  return exitCode;
}
