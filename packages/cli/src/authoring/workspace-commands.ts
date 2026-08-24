import path from 'node:path';

import {
  buildWorkspaceCatalog,
  buildWorkspacePlugin,
  initializePluginWorkspace,
  readPluginWorkspace,
  setWorkspaceCatalogVersion,
  validateCatalogSnapshot,
  type WorkspaceCatalogBuildAdapter,
  type WorkspacePluginBuildAdapter,
} from '@lesliechan721/aw-plugin-core';

import {
  bundleLocalPlugin,
  createCatalogRuntimeImportResolver,
} from '../../scripts/plugin-staging.js';
import { runPluginScriptTests } from '../../scripts/test-plugin-scripts.js';
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js';

export interface AuthoringCommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const catalogBuildAdapter: WorkspaceCatalogBuildAdapter = {
  async build(options) {
    await bundleLocalPlugin(options.plugin, options.outputRoot, {
      buildMode: 'staging',
      runtimeResolver: createCatalogRuntimeImportResolver(options.plugins),
    });
  },
};

const pluginBuildAdapter: WorkspacePluginBuildAdapter = {
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
  force?: boolean;
  json?: boolean;
  ownerName?: string;
  ownerUrl?: string;
  displayName?: string;
  catalogVersion?: string;
  io: AuthoringCommandIo;
}): Promise<void> {
  const result = await initializePluginWorkspace(options);
  const receipt = {
    command: 'catalog:init',
    ok: true,
    workspaceRoot: result.workspaceRoot,
    metadataPath: result.metadataPath,
    catalogVersion: result.metadata.catalog.version,
  };
  if (options.json) writeJson(options.io, receipt);
  else options.io.stdout(`Catalog workspace initialized at ${result.workspaceRoot}.\n`);
}

export async function runCatalogVersionCommand(options: {
  workspaceRoot: string;
  version?: string;
  json?: boolean;
  io: AuthoringCommandIo;
}): Promise<void> {
  const metadata = options.version === undefined
    ? (await readPluginWorkspace(options.workspaceRoot)).metadata
    : await setWorkspaceCatalogVersion(options.workspaceRoot, options.version);
  const receipt = {
    command: 'catalog:version',
    ok: true,
    workspaceRoot: path.resolve(options.workspaceRoot),
    catalogVersion: metadata.catalog.version,
    changed: options.version !== undefined,
  };
  if (options.json) writeJson(options.io, receipt);
  else options.io.stdout(`${metadata.catalog.version}\n`);
}

export async function runCatalogBuildCommand(options: {
  workspaceRoot: string;
  out?: string;
  force?: boolean;
  json?: boolean;
  io: AuthoringCommandIo;
}): Promise<void> {
  const result = await buildWorkspaceCatalog({
    workspaceRoot: options.workspaceRoot,
    ...(options.out ? { outputPath: options.out } : {}),
    force: options.force,
    adapter: catalogBuildAdapter,
    reservedImports: CLI_RESERVED_IMPORTS,
  });
  const receipt = { command: 'catalog:build', ok: true, ...result };
  if (options.json) writeJson(options.io, receipt);
  else options.io.stdout(`Catalog snapshot built at ${result.outputRoot}.\n`);
}

export async function runCatalogValidateCommand(options: {
  snapshotDirectory: string;
  json?: boolean;
  io: AuthoringCommandIo;
}): Promise<void> {
  const result = await validateCatalogSnapshot(options.snapshotDirectory);
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
  pluginDirectory: string;
  out?: string;
  force?: boolean;
  json?: boolean;
  io: AuthoringCommandIo;
}): Promise<void> {
  const result = await buildWorkspacePlugin({
    workspaceRoot: options.workspaceRoot,
    pluginDirectory: options.pluginDirectory,
    ...(options.out ? { outputPath: options.out } : {}),
    force: options.force,
    adapter: pluginBuildAdapter,
    reservedImports: CLI_RESERVED_IMPORTS,
  });
  const receipt = { command: 'plugin:build', ok: true, ...result };
  if (options.json) writeJson(options.io, receipt);
  else options.io.stdout(`Plugin bundle built at ${result.outputRoot}.\n`);
}

export async function runPluginTestCommand(options: {
  workspaceRoot: string;
  pluginDirectory: string;
  json?: boolean;
  io: AuthoringCommandIo;
}): Promise<number> {
  const workspace = await readPluginWorkspace(options.workspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS });
  const pluginRoot = path.resolve(workspace.workspaceRoot, options.pluginDirectory);
  const plugin = workspace.plugins.find((entry) => entry.rootDir === pluginRoot);
  if (!plugin) throw new Error(`Plugin directory is not part of this workspace source: ${pluginRoot}`);
  let stdout = '';
  let stderr = '';
  const exitCode = await runPluginScriptTests([plugin.manifest.name], {
    repoRoot: workspace.workspaceRoot,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  if (options.json) {
    writeJson(options.io, {
      command: 'plugin:test',
      ok: exitCode === 0,
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
