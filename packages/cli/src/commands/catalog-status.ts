import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import {
  calculateCatalogWorkspaceSourceIdentity,
  DEFAULT_CATALOG_OUTPUT_PATH,
  deriveCatalogChannel,
  readCatalogWorkspace,
  resolveCatalogWorkspaceRoot,
  validateCatalogSnapshotComplete,
  type CatalogWorkspaceResolvedFrom,
  type CatalogWorkspace,
} from '@lesliechan721/aw-plugin-core';

import {
  CatalogPublicationInspectionError,
  disposeCatalogPublicationInspection,
  prepareCatalogPublicationInspection,
  sanitizedGitEnvironment,
  type CatalogPublicationIssue,
} from './catalog-publication-inspection.js';
import { catalogPublicationDescriptorDigest } from './catalog-publish.js';
import {
  resolveCatalogPublicationTarget,
  type CatalogBranchResolvedFrom,
  type CatalogRemoteResolvedFrom,
} from './catalog-publication-target.js';
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
  publication: {
    checked: boolean;
    remote: string | null;
    remoteResolvedFrom: CatalogRemoteResolvedFrom | null;
    remoteUrl: string | null;
    fetchUrl: string | null;
    pushUrl: string | null;
    branch: string | null;
    branchResolvedFrom: CatalogBranchResolvedFrom | null;
    publishedVersion: string | null;
    parent: string | null;
    tag: string | null;
    tagAvailable: boolean | null;
    attemptAvailable: boolean | null;
    snapshotDigest: string | null;
    planId: string | null;
    descriptorDigest: string | null;
    publishable: boolean | null;
  };
  issues: CatalogPublicationIssue[];
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
  const gitEnv = { ...sanitizedGitEnvironment(env), GIT_OPTIONAL_LOCKS: '0' };
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

function emptyReceipt(workspaceRoot: string, preflight: boolean): CatalogStatusReceipt {
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
    publication: {
      checked: preflight,
      remote: null,
      remoteResolvedFrom: null,
      remoteUrl: null,
      fetchUrl: null,
      pushUrl: null,
      branch: null,
      branchResolvedFrom: null,
      publishedVersion: null,
      parent: null,
      tag: null,
      tagAvailable: null,
      attemptAvailable: null,
      snapshotDigest: null,
      planId: null,
      descriptorDigest: null,
      publishable: preflight ? false : null,
    },
    issues: [],
  };
}

export async function getCatalogStatus(options: {
  cwd: string;
  workspaceRoot?: string;
  remote?: string;
  branch?: string;
  preflight?: boolean;
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
  const receipt = emptyReceipt(workspaceRoot, options.preflight === true);
  receipt.workspace.resolvedFrom = resolution?.workspaceRootResolvedFrom ?? null;
  receipt.workspaceRootResolvedFrom = resolution?.workspaceRootResolvedFrom ?? null;
  const target = await resolveCatalogPublicationTarget({
    workspaceRoot,
    remote: options.remote,
    branch: options.branch,
    env: options.env,
  });
  receipt.publication.remote = target.remote;
  receipt.publication.remoteResolvedFrom = target.remoteResolvedFrom;
  receipt.publication.branch = target.branch;
  receipt.publication.branchResolvedFrom = target.branchResolvedFrom;
  let catalogWorkspace: CatalogWorkspace | null = null;
  try {
    if (!resolution) {
      await resolveCatalogWorkspaceRoot({
        cwd: options.cwd,
        ...(options.workspaceRoot === undefined ? {} : { explicitRoot: options.workspaceRoot }),
        mode: 'existing',
      });
    }
    const workspace = await readCatalogWorkspace(workspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS });
    catalogWorkspace = workspace;
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
  if (options.preflight && receipt.git.checked && receipt.git.clean === false) {
    receipt.issues.push({ code: 'sourceDirty', message: 'The complete source Git worktree is not clean.', blocking: true });
  }
  if (!options.preflight) {
    receipt.ok = !receipt.issues.some((issue) => issue.blocking);
    return receipt;
  }
  if (!receipt.git.checked) {
    receipt.issues.push({
      code: 'gitUnavailable',
      message: 'Publication preflight requires a committed Git HEAD and a readable source worktree.',
      blocking: true,
    });
  }
  if (receipt.git.clean !== true || !catalogWorkspace) {
    receipt.ok = false;
    return receipt;
  }
  if (target.remote === null) {
    receipt.issues.push({
      code: target.ambiguous ? 'remoteAmbiguous' : 'remoteUnavailable',
      message: target.ambiguous
        ? 'Catalog publication remote is ambiguous. Use --remote.'
        : 'Catalog publication remote is unavailable. Configure a Git remote or use --remote.',
      blocking: true,
    });
    receipt.ok = false;
    return receipt;
  }
  try {
    const inspection = await prepareCatalogPublicationInspection({
      workspaceRoot,
      remote: target.remote,
      branch: target.branch,
      env: options.env,
    });
    try {
      applyWorkspaceFacts(receipt, inspection.catalogWorkspace, inspection.catalogWorkspaceRoot, receipt.workspace.resolvedFrom);
      receipt.publication = {
        checked: true,
        remote: inspection.remote,
        remoteResolvedFrom: target.remoteResolvedFrom,
        remoteUrl: inspection.safeFetchUrl,
        fetchUrl: inspection.safeFetchUrl,
        pushUrl: inspection.safePushUrl,
        branch: inspection.branch,
        branchResolvedFrom: target.branchResolvedFrom,
        publishedVersion: inspection.publishedVersion,
        parent: inspection.parent,
        tag: inspection.tag,
        tagAvailable: inspection.tagAvailable,
        attemptAvailable: inspection.attemptAvailable,
        snapshotDigest: inspection.prepared.snapshotDigest,
        planId: inspection.prepared.planId,
        descriptorDigest: catalogPublicationDescriptorDigest(inspection.descriptor),
        publishable: inspection.tagAvailable && inspection.attemptAvailable,
      };
      if (!inspection.tagAvailable) {
        receipt.issues.push({
          code: 'tagUnavailable',
          message: `Remote Catalog tag ${inspection.tag} already exists. Increase the Catalog version.`,
          blocking: true,
        });
      }
      if (!inspection.attemptAvailable) {
        receipt.issues.push({
          code: 'attemptUnavailable',
          message: `Catalog ${inspection.prepared.catalogVersion} already has an attempted publication record. Increase the Catalog version.`,
          blocking: true,
        });
      }
    } finally {
      await disposeCatalogPublicationInspection(inspection);
    }
  } catch (error) {
    const code = error instanceof CatalogPublicationInspectionError
      ? error.code
      : 'catalogPreflightFailed';
    if (!receipt.issues.some((issue) => issue.code === code)) {
      receipt.issues.push({
        code,
        message: safeIssueMessage(error instanceof Error ? error.message : String(error), workspaceRoot),
        blocking: true,
      });
    }
    if (code === 'tagUnavailable') receipt.publication.tagAvailable = false;
    if (code === 'attemptUnavailable') receipt.publication.attemptAvailable = false;
  }
  receipt.ok = !receipt.issues.some((issue) => issue.blocking) && receipt.publication.publishable === true;
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
  if (receipt.publication.checked) {
    lines.push('Publication preflight: checked (plugin validation and build code executed)');
    lines.push(`Publishable: ${receipt.publication.publishable === true ? 'yes' : 'no'}`);
    if (receipt.publication.remote) {
      lines.push(`Remote: ${receipt.publication.remote}${receipt.publication.remoteUrl ? ` (${receipt.publication.remoteUrl})` : ''}`);
      lines.push(`Branch: refs/heads/${receipt.publication.branch}`);
    }
    if (receipt.publication.tag) lines.push(`Tag: refs/tags/${receipt.publication.tag}`);
    if (receipt.publication.snapshotDigest) lines.push(`Snapshot: ${receipt.publication.snapshotDigest}`);
  } else {
    lines.push('Publication preflight: not checked (use --preflight; it executes plugin validation and build code)');
  }
  for (const issue of receipt.issues) lines.push(`Issue ${issue.code}: ${issue.message}`);
  return `${lines.join('\n')}\n`;
}
