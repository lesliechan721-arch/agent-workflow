import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  deriveCatalogChannel,
  readCatalogWorkspace,
  type CatalogWorkspace,
} from '@lesliechan721/aw-plugin-core';

import {
  CatalogPublicationInspectionError,
  disposeCatalogPublicationInspection,
  prepareCatalogPublicationInspection,
  sanitizedGitEnvironment,
  type CatalogPublicationIssue,
} from './catalog-publication-inspection.js';
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js';

const execFileAsync = promisify(execFile);

export interface CatalogStatusReceipt {
  schemaVersion: 1;
  command: 'catalog:status';
  ok: boolean;
  workspace: {
    root: string;
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
  publication: {
    checked: boolean;
    remote: string | null;
    remoteUrl: string | null;
    branch: string | null;
    publishedVersion: string | null;
    parent: string | null;
    tag: string | null;
    tagAvailable: boolean | null;
    attemptAvailable: boolean | null;
    snapshotDigest: string | null;
    planId: string | null;
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
): void {
  receipt.issues = receipt.issues.filter((issue) =>
    issue.code !== 'workspaceInvalid' && issue.code !== 'dependencyGraphInvalid');
  receipt.workspace = {
    root: reportedRoot,
    valid: true,
    identity: workspace.workspaceIdentity,
  };
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
    });
  }
}

async function inspectGit(workspaceRoot: string, env: NodeJS.ProcessEnv): Promise<{
  checked: boolean;
  sourceHead: string | null;
  clean: boolean | null;
}> {
  const gitEnv = sanitizedGitEnvironment(env);
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
    schemaVersion: 1,
    command: 'catalog:status',
    ok: false,
    workspace: { root: workspaceRoot, valid: false, identity: null },
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
    publication: {
      checked: preflight,
      remote: null,
      remoteUrl: null,
      branch: null,
      publishedVersion: null,
      parent: null,
      tag: null,
      tagAvailable: null,
      attemptAvailable: null,
      snapshotDigest: null,
      planId: null,
      publishable: preflight ? false : null,
    },
    issues: [],
  };
}

export async function getCatalogStatus(options: {
  workspaceRoot: string;
  remote?: string;
  branch?: string;
  preflight?: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<CatalogStatusReceipt> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const receipt = emptyReceipt(workspaceRoot, options.preflight === true);
  if (options.preflight) {
    receipt.publication.remote = options.remote ?? 'origin';
    receipt.publication.branch = options.branch ?? 'catalog';
  }
  try {
    const workspace = await readCatalogWorkspace(workspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS });
    applyWorkspaceFacts(receipt, workspace, workspace.workspaceRoot);
  } catch (error) {
    receipt.issues.push({
      code: 'workspaceInvalid',
      message: safeIssueMessage(error instanceof Error ? error.message : String(error), workspaceRoot),
    });
  }
  receipt.git = await inspectGit(workspaceRoot, options.env);
  if (receipt.git.checked && receipt.git.clean === false) {
    receipt.issues.push({ code: 'sourceDirty', message: 'The complete source Git worktree is not clean.' });
  }
  if (!options.preflight) {
    receipt.ok = receipt.issues.length === 0;
    return receipt;
  }
  if (!receipt.git.checked) {
    receipt.issues.push({
      code: 'gitUnavailable',
      message: 'Publication preflight requires a committed Git HEAD and a readable source worktree.',
    });
  }
  if (receipt.git.clean !== true) {
    receipt.ok = false;
    return receipt;
  }
  try {
    const inspection = await prepareCatalogPublicationInspection(options);
    try {
      applyWorkspaceFacts(receipt, inspection.catalogWorkspace, inspection.catalogWorkspaceRoot);
      receipt.publication = {
        checked: true,
        remote: inspection.remote,
        remoteUrl: inspection.safePushUrl,
        branch: inspection.branch,
        publishedVersion: inspection.publishedVersion,
        parent: inspection.parent,
        tag: inspection.tag,
        tagAvailable: inspection.tagAvailable,
        attemptAvailable: inspection.attemptAvailable,
        snapshotDigest: inspection.prepared.snapshotDigest,
        planId: inspection.prepared.planId,
        publishable: inspection.tagAvailable && inspection.attemptAvailable,
      };
      if (!inspection.tagAvailable) {
        receipt.issues.push({
          code: 'tagUnavailable',
          message: `Remote Catalog tag ${inspection.tag} already exists. Increase the Catalog version.`,
        });
      }
      if (!inspection.attemptAvailable) {
        receipt.issues.push({
          code: 'attemptUnavailable',
          message: `Catalog ${inspection.prepared.catalogVersion} already has an attempted publication record. Increase the Catalog version.`,
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
      });
    }
    if (code === 'tagUnavailable') receipt.publication.tagAvailable = false;
    if (code === 'attemptUnavailable') receipt.publication.attemptAvailable = false;
  }
  receipt.ok = receipt.issues.length === 0 && receipt.publication.publishable === true;
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
