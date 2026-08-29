#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { readCatalogWorkspace } from '@lesliechan721/aw-plugin-core';

import {
  parseStablePluginVersion,
  readManifestDocument,
  resolveBaseCommit,
  runGit,
} from './lib/plugin-version-check.mjs';
import { assertCanonicalAuthoringPluginRoot } from './lib/plugin-root.mjs';
import { CLI_RESERVED_IMPORTS } from '../../src/utils/manifest.js';

const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class PluginRemovalError extends Error {
  constructor(code, message, recoveryCommand) {
    super(message);
    this.name = 'PluginRemovalError';
    this.code = code;
    this.recoveryCommand = recoveryCommand;
  }
}

function fail(code, message, recoveryCommand) {
  throw new PluginRemovalError(code, message, recoveryCommand);
}

function readOptionValue(args, index, flag) {
  const current = args[index];
  const eqIndex = current.indexOf('=');
  if (eqIndex >= 0) return { value: current.slice(eqIndex + 1), nextIndex: index };
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail('invalidArguments', `${flag} requires a value.`);
  return { value, nextIndex: index + 1 };
}

function printUsage() {
  console.log(`Usage:
  aw plugin remove <plugin-name> --workspace-root <path> --yes [--json]

Options:
  --workspace-root <path>  Catalog Workspace root. Required.
  --yes                    Confirm deletion of the committed, unchanged plugin tree.
  --json                   Emit one schema 1 JSON object.
  -h, --help               Show this help message.

The command deletes only the canonical plugins/<plugin-name> source root.
It does not change the Catalog version, commit, build, or publish.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = { json: false, yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--') continue;
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--yes') {
      options.yes = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      if (options.pluginName === undefined) {
        options.pluginName = arg;
        continue;
      }
      fail('invalidArguments', `Unexpected positional argument: ${arg}`);
    }
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const { value, nextIndex } = readOptionValue(args, index, flag);
    index = nextIndex;
    if (flag === '--workspace-root') options.workspaceRoot = value;
    else fail('invalidArguments', `Unknown option: ${flag}`);
  }
  if (!options.pluginName) fail('invalidArguments', 'Provide one plugin name.');
  if (!PLUGIN_NAME_PATTERN.test(options.pluginName)) {
    fail('invalidPluginName', `Plugin name must use lowercase hyphen-case: ${JSON.stringify(options.pluginName)}.`);
  }
  if (!options.workspaceRoot) fail('invalidArguments', '--workspace-root is required.');
  return options;
}

async function lstatOrNull(filePath) {
  return fs.lstat(filePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
}

async function assertWorkspaceInputPathHasNoSymlinks(workspaceRoot) {
  const absoluteRoot = path.resolve(workspaceRoot);
  const parsed = path.parse(absoluteRoot);
  const segments = absoluteRoot.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let currentPath = parsed.root;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const stat = await lstatOrNull(currentPath);
    if (!stat) return absoluteRoot;
    if (stat.isSymbolicLink()) {
      fail('unsafePluginPath', `Workspace root path must not contain symbolic links: ${currentPath}`);
    }
    if (!stat.isDirectory()) {
      fail('unsafePluginPath', `Workspace root path component is not a directory: ${currentPath}`);
    }
  }
  return absoluteRoot;
}

function parseTreeRecord(record) {
  const tabIndex = record.indexOf('\t');
  if (tabIndex < 0) fail('gitInspectionFailed', `Invalid Git tree record: ${JSON.stringify(record)}.`);
  const metadata = record.slice(0, tabIndex).split(' ');
  return {
    mode: metadata[0],
    type: metadata[1],
    objectId: metadata[2],
    filePath: record.slice(tabIndex + 1),
  };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function resolveGitWorkspace(workspaceRoot) {
  let repoRoot;
  let baseCommit;
  try {
    repoRoot = path.resolve((await runGit(workspaceRoot, ['rev-parse', '--show-toplevel'], {
      code: 'gitWorkspaceInvalid',
      label: 'Git repository discovery',
    })).trim());
    baseCommit = await resolveBaseCommit(repoRoot, 'HEAD');
  } catch (error) {
    const code = error?.code === 'invalidBase' ? 'sourceHeadMissing' : (error?.code ?? 'gitWorkspaceInvalid');
    fail(code, error.message);
  }
  if (!isInside(repoRoot, workspaceRoot)) {
    fail('workspaceOutsideRepository', 'Catalog Workspace must stay inside its Git worktree root.');
  }
  return { repoRoot, baseCommit };
}

async function scanCurrentTree(root) {
  const entries = new Map();
  async function visit(currentRoot, prefix = '') {
    const children = await fs.readdir(currentRoot, { withFileTypes: true });
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const absolutePath = path.join(currentRoot, child.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        fail('unsafePluginTree', `Plugin tree must not contain symbolic links: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        entries.set(relativePath, { mode: '040000', type: 'tree', absolutePath });
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        fail('unsafePluginTree', `Plugin tree node must be a regular file or directory: ${absolutePath}`);
      }
      entries.set(relativePath, {
        mode: (stat.mode & 0o111) === 0 ? '100644' : '100755',
        type: 'blob',
        absolutePath,
      });
    }
  }
  await visit(root);
  return entries;
}

async function assertTreeMatchesHead(options) {
  const { repoRoot, baseCommit, relativePluginRoot, pluginRoot } = options;
  const rootOutput = await runGit(repoRoot, [
    '--literal-pathspecs', 'ls-tree', '-z', baseCommit, '--', relativePluginRoot,
  ], { buffer: true, label: 'Git plugin root tree' });
  const rootRecords = rootOutput.toString('utf8').split('\0').filter(Boolean).map(parseTreeRecord);
  if (rootRecords.length !== 1 || rootRecords[0].filePath !== relativePluginRoot) {
    fail('pluginNotCommitted', `Plugin is not present in HEAD: ${relativePluginRoot}`);
  }
  if (rootRecords[0].mode !== '040000' || rootRecords[0].type !== 'tree') {
    fail('pluginNotCommitted', `Plugin path in HEAD is not a directory tree: ${relativePluginRoot}`);
  }

  const status = await runGit(repoRoot, [
    '--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all',
    '--', relativePluginRoot,
  ], { buffer: true, label: 'Git plugin worktree status' });
  const statusEntries = status.toString('utf8').split('\0').filter(Boolean);
  if (statusEntries.length > 0) {
    fail(
      'pluginTreeDirty',
      `Plugin tree differs from HEAD: ${statusEntries.slice(0, 10).join(', ')}`,
    );
  }

  const treeOutput = await runGit(repoRoot, [
    '--literal-pathspecs', 'ls-tree', '-r', '-t', '-z', '--full-tree', baseCommit, '--', relativePluginRoot,
  ], { buffer: true, label: 'Git plugin tree inventory' });
  const headEntries = new Map();
  for (const record of treeOutput.toString('utf8').split('\0').filter(Boolean).map(parseTreeRecord)) {
    if (record.filePath === relativePluginRoot) continue;
    if (relativePluginRoot.startsWith(`${record.filePath}/`)) continue;
    const prefix = `${relativePluginRoot}/`;
    if (!record.filePath.startsWith(prefix)) {
      fail('gitInspectionFailed', `Git returned a path outside the plugin tree: ${record.filePath}`);
    }
    headEntries.set(record.filePath.slice(prefix.length), record);
  }
  const currentEntries = await scanCurrentTree(pluginRoot);
  const inventory = new Set([...headEntries.keys(), ...currentEntries.keys()]);
  const mismatches = [];
  for (const relativePath of [...inventory].sort()) {
    const head = headEntries.get(relativePath);
    const current = currentEntries.get(relativePath);
    if (!head || !current || head.mode !== current.mode || head.type !== current.type) {
      mismatches.push(relativePath);
      continue;
    }
    if (head.type === 'blob') {
      const headBytes = await runGit(repoRoot, ['cat-file', 'blob', head.objectId], {
        buffer: true,
        label: `Git blob ${head.objectId}`,
      });
      const currentBytes = await fs.readFile(current.absolutePath);
      if (!headBytes.equals(currentBytes)) mismatches.push(relativePath);
    }
  }
  if (mismatches.length > 0) {
    fail(
      'pluginTreeMismatch',
      `Plugin tree inventory, bytes, or modes differ from HEAD: ${mismatches.slice(0, 10).join(', ')}`,
    );
  }
}

function findReverseDependencies(plugins, targetName) {
  return plugins
    .filter((plugin) => (
      plugin.manifest.name !== targetName
      && plugin.manifest.dependencies.includes(targetName)
    ))
    .map((plugin) => plugin.manifest.name)
    .sort();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function createReceipt(options = {}) {
  return {
    schemaVersion: 1,
    command: 'plugin:remove',
    ok: options.ok ?? false,
    workspaceRoot: options.workspaceRoot ?? null,
    workspaceRootResolvedFrom: process.env.AW_AUTHORING_WORKSPACE_ROOT_RESOLVED_FROM ?? null,
    baseCommit: options.baseCommit ?? null,
    plugin: options.plugin ?? null,
    removed: options.removed ?? false,
    errors: options.errors ?? [],
  };
}

async function removePlugin(options, state) {
  const requestedWorkspaceRoot = await assertWorkspaceInputPathHasNoSymlinks(options.workspaceRoot);
  const pluginRoot = path.join(requestedWorkspaceRoot, 'plugins', options.pluginName);
  state.workspaceRoot = requestedWorkspaceRoot;
  state.plugin = { name: options.pluginName, version: null, root: pluginRoot };

  let fenced;
  try {
    fenced = assertCanonicalAuthoringPluginRoot({
      workspaceRoot: requestedWorkspaceRoot,
      pluginRoot,
      pluginName: options.pluginName,
      requirePluginRoot: true,
      requireManifest: true,
    });
  } catch (error) {
    fail((await lstatOrNull(pluginRoot)) ? 'unsafePluginPath' : 'pluginNotFound', error.message);
  }
  state.workspaceRoot = fenced.repoRoot;
  state.plugin.root = fenced.pluginRoot;
  const git = await resolveGitWorkspace(fenced.repoRoot);
  state.baseCommit = git.baseCommit;
  const relativePluginRoot = path.relative(git.repoRoot, fenced.pluginRoot).split(path.sep).join('/');

  let document;
  try {
    document = await readManifestDocument(fenced.pluginRoot);
    if (document.manifest.name !== options.pluginName) {
      fail(
        'manifestNameMismatch',
        `Manifest name ${JSON.stringify(document.manifest.name)} does not match ${JSON.stringify(options.pluginName)}.`,
      );
    }
    state.plugin.version = parseStablePluginVersion(
      document.manifest.version,
      'plugin version',
    ).raw;
  } catch (error) {
    if (error instanceof PluginRemovalError) throw error;
    fail('invalidPlugin', error.message);
  }

  let workspace;
  try {
    workspace = await readCatalogWorkspace(fenced.repoRoot, {
      reservedImports: CLI_RESERVED_IMPORTS,
    });
  } catch (error) {
    fail('workspaceInvalid', error.message);
  }

  await assertTreeMatchesHead({
    repoRoot: git.repoRoot,
    baseCommit: git.baseCommit,
    relativePluginRoot,
    pluginRoot: fenced.pluginRoot,
  });
  const dependents = findReverseDependencies(workspace.plugins, options.pluginName);
  if (dependents.length > 0) {
    fail(
      'reverseDependencies',
      `Cannot remove ${JSON.stringify(options.pluginName)}; required by: ${dependents.join(', ')}.`,
    );
  }
  if (!options.yes) {
    fail('confirmationRequired', 'Plugin removal requires --yes.');
  }

  const recoveryCommand = `git --literal-pathspecs -C ${shellQuote(git.repoRoot)} restore --source=${git.baseCommit} -- ${shellQuote(relativePluginRoot)}`;
  try {
    await fs.rm(fenced.pluginRoot, { recursive: true });
  } catch (error) {
    fail(
      'removalFailed',
      `Could not remove plugin root ${fenced.pluginRoot}: ${error.message}. Restore it from HEAD with: ${recoveryCommand}`,
      recoveryCommand,
    );
  }
  return createReceipt({
    ok: true,
    workspaceRoot: state.workspaceRoot,
    baseCommit: state.baseCommit,
    plugin: state.plugin,
    removed: true,
  });
}

async function main() {
  const jsonRequested = process.argv.slice(2).includes('--json')
    || process.argv.slice(2).some((arg) => arg.startsWith('--json='));
  const state = { workspaceRoot: null, baseCommit: null, plugin: null };
  try {
    const options = parseArgs(process.argv);
    const receipt = await removePlugin(options, state);
    if (options.json) console.log(JSON.stringify(receipt));
    else console.log(`[OK] Removed plugin source ${JSON.stringify(receipt.plugin.name)}: ${receipt.plugin.root}`);
  } catch (error) {
    const code = error?.code ?? 'unexpectedError';
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = `[ERROR] ${message}`;
    if (jsonRequested) {
      console.log(JSON.stringify(createReceipt({
        workspaceRoot: state.workspaceRoot,
        baseCommit: state.baseCommit,
        plugin: state.plugin,
        errors: [{
          code,
          message,
          ...(error?.recoveryCommand ? { recoveryCommand: error.recoveryCommand } : {}),
        }],
      })));
    }
    console.error(diagnostic);
    process.exitCode = 1;
  }
}

await main();
