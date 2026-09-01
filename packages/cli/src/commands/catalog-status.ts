import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import {
  calculateCatalogWorkspaceSourceIdentity,
  DEFAULT_CATALOG_OUTPUT_PATH,
  deriveCatalogChannel,
  readCatalogWorkspace,
  validateCatalogSnapshotComplete,
  type CatalogWorkspace,
} from '@lesliechan721/aw-plugin-core';

import {
  resolveCatalogWorkspaceRoot,
  type CatalogWorkspaceResolvedFrom,
} from './catalog-workspace-resolution.js';
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js';

const execFileAsync = promisify(execFile);

export interface CatalogStatusReceipt {
  schemaVersion: 2;
  command: 'catalog:status';
  ok: boolean;
  workspaceRoot: string;
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom | null;
  workspace: {
    root: string;
    resolvedFrom: CatalogWorkspaceResolvedFrom | null;
    valid: boolean;
    identity: string | null;
  };
  catalog: {
    valid: boolean;
    version: string | null;
    channel: 'latest' | 'beta' | null;
    ownerName: string | null;
    ownerUrl: string | null;
    displayName: string | null;
  };
  plugins: Array<{
    name: string;
    version: string;
    dependencies: string[];
    sourceValid: true;
  }>;
  dependencyGraph: {
    valid: boolean;
    order: string[];
  };
  git: {
    checked: boolean;
    sourceHead: string | null;
    clean: boolean | null;
  };
  snapshot: {
    path: string;
    state: 'absent' | 'current' | 'stale' | 'invalid';
    valid: boolean;
    catalogVersion: string | null;
    snapshotDigest: string | null;
    sourceIdentityMatches: boolean | null;
  };
  issues: Array<{ code: string; message: string; blocking: boolean }>;
}

function safeIssueMessage(message: string, workspaceRoot: string): string {
  return message.replaceAll(workspaceRoot, '<workspace>');
}

function dependencyOrder(workspace: CatalogWorkspace): string[] {
  const byName = new Map(workspace.plugins.map((plugin) => [plugin.manifest.name, plugin]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: string[] = [];
  const visit = (name: string): void => {
    if (visiting.has(name)) throw new Error(`Plugin dependency cycle includes ${JSON.stringify(name)}.`);
    if (visited.has(name)) return;
    const plugin = byName.get(name);
    if (!plugin) throw new Error(`Missing same-source plugin dependency ${JSON.stringify(name)}.`);
    visiting.add(name);
    for (const dependency of [...(plugin.manifest.dependencies ?? [])].sort()) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    result.push(name);
  };
  for (const plugin of [...workspace.plugins].sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name))) {
    visit(plugin.manifest.name);
  }
  return result;
}

function applyWorkspaceFacts(
  receipt: CatalogStatusReceipt,
  workspace: CatalogWorkspace,
  reportedRoot: string,
  resolvedFrom: CatalogWorkspaceResolvedFrom | null = receipt.workspace.resolvedFrom,
): void {
  receipt.issues = receipt.issues.filter((issue) =>
    issue.code !== 'workspaceInvalid' && issue.code !== 'dependencyGraphInvalid');
  receipt.workspace = {
    root: reportedRoot,
    resolvedFrom,
    valid: true,
    identity: workspace.workspaceIdentity,
  };
  receipt.workspaceRoot = reportedRoot;
  receipt.workspaceRootResolvedFrom = resolvedFrom;
  receipt.catalog = {
    valid: true,
    version: workspace.metadata.catalog.version,
    channel: deriveCatalogChannel(workspace.metadata.catalog.version),
    ownerName: workspace.metadata.owner.name,
    ownerUrl: workspace.metadata.owner.url,
    displayName: workspace.metadata.interface.displayName,
  };
  receipt.plugins = workspace.plugins.map((plugin) => ({
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    dependencies: [...(plugin.manifest.dependencies ?? [])].sort(),
    sourceValid: true,
  }));
  receipt.dependencyGraph = { valid: false, order: [] };
  try {
    receipt.dependencyGraph = { valid: true, order: dependencyOrder(workspace) };
  } catch (error) {
    receipt.issues.push({
      code: 'dependencyGraphInvalid',
      message: safeIssueMessage(error instanceof Error ? error.message : String(error), reportedRoot),
      blocking: true,
    });
  }
}

async function inspectSnapshot(receipt: CatalogStatusReceipt, workspace: CatalogWorkspace): Promise<void> {
  const snapshotPath = path.join(workspace.workspaceRoot, DEFAULT_CATALOG_OUTPUT_PATH);
  receipt.snapshot.path = snapshotPath;
  if (!(await fs.pathExists(snapshotPath))) return;
  try {
    const [validation, marker, sourceIdentity] = await Promise.all([
      validateCatalogSnapshotComplete(snapshotPath),
      fs.readJson(path.join(snapshotPath, '.aw-generated.json')) as Promise<{
        workspaceIdentity: string;
        sourceIdentity: string;
      }>,
      calculateCatalogWorkspaceSourceIdentity(workspace),
    ]);
    const sourceIdentityMatches = marker.workspaceIdentity === workspace.workspaceIdentity
      && marker.sourceIdentity === sourceIdentity;
    receipt.snapshot = {
      path: snapshotPath,
      state: sourceIdentityMatches ? 'current' : 'stale',
      valid: true,
      catalogVersion: validation.manifest.catalogVersion,
      snapshotDigest: validation.snapshotDigest,
      sourceIdentityMatches,
    };
  } catch {
    receipt.snapshot = {
      path: snapshotPath,
      state: 'invalid',
      valid: false,
      catalogVersion: null,
      snapshotDigest: null,
      sourceIdentityMatches: null,
    };
  }
}

async function inspectGit(workspaceRoot: string, env: NodeJS.ProcessEnv): Promise<{
  checked: boolean;
  sourceHead: string | null;
  clean: boolean | null;
}> {
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
  gitEnv.GIT_OPTIONAL_LOCKS = '0';
  try {
    const repoRoot = (await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workspaceRoot,
      env: gitEnv,
      encoding: 'utf8',
    })).stdout.trim();
    const sourceHead = (await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoRoot,
      env: gitEnv,
      encoding: 'utf8',
    })).stdout.trim();
    const status = (await execFileAsync('git', [
      'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none',
    ], {
      cwd: repoRoot,
      env: gitEnv,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })).stdout.trim();
    return { checked: true, sourceHead, clean: status === '' };
  } catch {
    return { checked: false, sourceHead: null, clean: null };
  }
}

function emptyReceipt(workspaceRoot: string): CatalogStatusReceipt {
  return {
    schemaVersion: 2,
    command: 'catalog:status',
    ok: false,
    workspaceRoot,
    workspaceRootResolvedFrom: null,
    workspace: { root: workspaceRoot, resolvedFrom: null, valid: false, identity: null },
    catalog: {
      valid: false,
      version: null,
      channel: null,
      ownerName: null,
      ownerUrl: null,
      displayName: null,
    },
    plugins: [],
    dependencyGraph: { valid: false, order: [] },
    git: { checked: false, sourceHead: null, clean: null },
    snapshot: {
      path: path.join(workspaceRoot, DEFAULT_CATALOG_OUTPUT_PATH),
      state: 'absent',
      valid: false,
      catalogVersion: null,
      snapshotDigest: null,
      sourceIdentityMatches: null,
    },
    issues: [],
  };
}

export async function getCatalogStatus(options: {
  cwd: string;
  workspaceRoot?: string;
  env: NodeJS.ProcessEnv;
}): Promise<CatalogStatusReceipt> {
  const requestedRoot = path.resolve(options.cwd, options.workspaceRoot ?? '.');
  let resolution: Awaited<ReturnType<typeof resolveCatalogWorkspaceRoot>> | null = null;
  try {
    resolution = await resolveCatalogWorkspaceRoot({
      cwd: options.cwd,
      ...(options.workspaceRoot === undefined ? {} : { explicitRoot: options.workspaceRoot }),
      mode: 'existing',
    });
  } catch {
    // Preserve a structured status receipt below.
  }
  const workspaceRoot = resolution?.workspaceRoot ?? requestedRoot;
  const receipt = emptyReceipt(workspaceRoot);
  receipt.workspace.resolvedFrom = resolution?.workspaceRootResolvedFrom ?? null;
  receipt.workspaceRootResolvedFrom = resolution?.workspaceRootResolvedFrom ?? null;
  try {
    if (!resolution) {
      await resolveCatalogWorkspaceRoot({
        cwd: options.cwd,
        ...(options.workspaceRoot === undefined ? {} : { explicitRoot: options.workspaceRoot }),
        mode: 'existing',
      });
    }
    const workspace = await readCatalogWorkspace(workspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS });
    applyWorkspaceFacts(receipt, workspace, workspace.workspaceRoot, resolution?.workspaceRootResolvedFrom ?? null);
    await inspectSnapshot(receipt, workspace);
  } catch (error) {
    receipt.issues.push({
      code: 'workspaceInvalid',
      message: safeIssueMessage(error instanceof Error ? error.message : String(error), workspaceRoot),
      blocking: true,
    });
  }
  receipt.git = await inspectGit(workspaceRoot, options.env);
  receipt.ok = !receipt.issues.some((issue) => issue.blocking);
  return receipt;
}

export function renderCatalogStatus(receipt: CatalogStatusReceipt): string {
  const lines = [
    `Catalog Workspace: ${receipt.workspace.valid ? 'valid' : 'invalid'}`,
    `Catalog: ${receipt.catalog.version ?? 'unavailable'}${receipt.catalog.channel ? ` (${receipt.catalog.channel})` : ''}`,
    `Plugins: ${receipt.plugins.length}`,
    `Dependency graph: ${receipt.dependencyGraph.valid ? 'valid' : 'invalid'}`,
    `Git: ${receipt.git.checked ? `${receipt.git.sourceHead} (${receipt.git.clean ? 'clean' : 'dirty'})` : 'not checked'}`,
  ];
  lines.push(`Snapshot: ${receipt.snapshot.state}${receipt.snapshot.snapshotDigest ? ` (${receipt.snapshot.snapshotDigest})` : ''}`);
  for (const issue of receipt.issues) lines.push(`Issue ${issue.code}: ${issue.message}`);
  return `${lines.join('\n')}\n`;
}
