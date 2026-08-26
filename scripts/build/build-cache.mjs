import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STAMP_SCHEMA_VERSION = 9;
const DEFAULT_LOCK_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 100;

const INPUT_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'scripts/build',
  'packages/agent-skill-eval/package.json',
  'packages/agent-skill-eval/tsconfig.json',
  'packages/agent-skill-eval/vitest.config.ts',
  'packages/agent-skill-eval/src',
  'packages/agent-skill-eval/scripts',
  'packages/plugin-core/package.json',
  'packages/plugin-core/tsconfig.json',
  'packages/plugin-core/vitest.config.ts',
  'packages/plugin-core/src',
  'packages/plugin-core/schemas',
  'packages/plugin-core/scripts',
  'packages/cli/package.json',
  'packages/cli/tsconfig.json',
  'packages/cli/index.ts',
  'packages/cli/vitest.config.ts',
  'packages/cli/src',
  'packages/cli/scripts',
  'plugins',
  '.changes',
];

const OUTPUT_ROOTS = [
  'packages/agent-skill-eval/dist',
  'packages/plugin-core/dist',
  'packages/cli/dist',
  'packages/cli/plugins-dist',
];

const GENERATED_INPUT_ROOTS = [
  ...OUTPUT_ROOTS,
  '.release',
];

const REQUIRED_OUTPUTS = [
  { path: 'packages/agent-skill-eval/dist/index.js', type: 'text' },
  { path: 'packages/agent-skill-eval/dist/bin.js', type: 'text' },
  { path: 'packages/agent-skill-eval/dist/schemas/digests.json', type: 'text' },
  { path: 'packages/plugin-core/dist/index.js', type: 'text' },
  { path: 'packages/cli/dist/index.js', type: 'text' },
  { path: 'packages/cli/dist/scripts/bundle-plugins.js', type: 'text' },
  { path: 'packages/cli/plugins-dist/.claude-plugin/marketplace.json', type: 'marketplace' },
  { path: 'packages/cli/plugins-dist/.agents/plugins/marketplace.json', type: 'marketplace' },
  { path: 'packages/cli/plugins-dist/catalog-manifest.json', type: 'catalog' },
];

const STAMP_IDENTITY_KEYS = [
  'schemaVersion',
  'inputDigest',
  'nodeVersion',
  'nodeExecPath',
  'nodeExecRealPath',
  'nodeExecDigest',
  'platform',
  'arch',
  'packageManager',
  'npmExecPath',
  'npmExecRealPath',
  'npmExecDigest',
  'npmUserAgent',
];

function cachePaths(repoRoot) {
  const cacheDir = path.join(repoRoot, '.release', 'cache');
  return {
    cacheDir,
    stampPath: path.join(cacheDir, 'build-stamp.json'),
    lockPath: path.join(cacheDir, 'build.lock'),
  };
}

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function isExcludedInputPath(relativePath) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const segments = normalizedPath.split('/');
  if (segments.includes('node_modules')) {
    return true;
  }
  if (GENERATED_INPUT_ROOTS.some((root) =>
    normalizedPath === root || normalizedPath.startsWith(`${root}/`)
  )) {
    return true;
  }
  return (
    /^plugins\/[^/]+\/evals(?:\/|$)/.test(normalizedPath) ||
    /^plugins\/[^/]+\/reports(?:\/|$)/.test(normalizedPath) ||
    /^plugins\/[^/]+\/skills\/[^/]+\/(?:[^/]+\/)*(?:evals|reports)(?:\/|$)/.test(
      normalizedPath,
    )
  );
}

async function computeSymlinkReferentDigest(
  absolutePath,
  repoRoot,
  relativePath,
  exclude,
  ancestorRealPaths,
) {
  let referentPath;
  try {
    referentPath = await fs.realpath(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') {
      return `unresolved:${error.code}`;
    }
    throw error;
  }
  if (ancestorRealPaths.has(referentPath)) {
    return 'cycle';
  }

  const entries = [];
  await collectEntries(
    repoRoot,
    relativePath,
    entries,
    exclude,
    { absolutePath: referentPath, ancestorRealPaths },
  );
  return digestEntries(entries);
}

async function collectEntries(
  repoRoot,
  relativePath,
  entries,
  exclude = () => false,
  traversal = {},
) {
  if (exclude(relativePath)) {
    return;
  }

  const absolutePath = traversal.absolutePath ?? path.join(repoRoot, relativePath);
  const ancestorRealPaths = traversal.ancestorRealPaths ?? new Set();
  let stats;
  try {
    stats = await fs.lstat(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      entries.push({ kind: 'missing', path: normalizeRelativePath(relativePath) });
      return;
    }
    throw error;
  }

  const normalizedPath = normalizeRelativePath(relativePath);
  if (stats.isSymbolicLink()) {
    entries.push({
      kind: 'symlink',
      mode: stats.mode & 0o777,
      path: normalizedPath,
      referentDigest: await computeSymlinkReferentDigest(
        absolutePath,
        repoRoot,
        relativePath,
        exclude,
        ancestorRealPaths,
      ),
      target: await fs.readlink(absolutePath),
    });
    return;
  }
  if (stats.isDirectory()) {
    entries.push({ kind: 'directory', mode: stats.mode & 0o777, path: normalizedPath });
    const nextAncestorRealPaths = new Set(ancestorRealPaths);
    nextAncestorRealPaths.add(await fs.realpath(absolutePath));
    for (const childName of (await fs.readdir(absolutePath)).sort()) {
      await collectEntries(
        repoRoot,
        path.join(relativePath, childName),
        entries,
        exclude,
        {
          absolutePath: path.join(absolutePath, childName),
          ancestorRealPaths: nextAncestorRealPaths,
        },
      );
    }
    return;
  }
  if (stats.isFile()) {
    entries.push({
      contents: await fs.readFile(absolutePath),
      kind: 'file',
      mode: stats.mode & 0o777,
      path: normalizedPath,
    });
    return;
  }
  entries.push({ kind: 'other', mode: stats.mode, path: normalizedPath });
}

function digestEntries(entries) {
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const hash = crypto.createHash('sha256');
  for (const entry of entries) {
    const entryHash = crypto.createHash('sha256');
    updateLengthPrefixed(entryHash, entry.kind);
    updateLengthPrefixed(entryHash, entry.path);
    if (entry.kind === 'file') {
      updateLengthPrefixed(entryHash, String(entry.mode));
      updateLengthPrefixed(entryHash, entry.contents);
    } else if (entry.kind === 'symlink') {
      updateLengthPrefixed(entryHash, String(entry.mode));
      updateLengthPrefixed(entryHash, entry.target);
      updateLengthPrefixed(entryHash, entry.referentDigest);
    } else if (entry.kind === 'directory' || entry.kind === 'other') {
      updateLengthPrefixed(entryHash, String(entry.mode));
    }
    updateLengthPrefixed(hash, entryHash.digest());
  }
  return hash.digest('hex');
}

function updateLengthPrefixed(hash, value) {
  const contents = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(contents.length));
  hash.update(length);
  hash.update(contents);
}

async function computeTreeDigest(repoRoot, roots, exclude) {
  const entries = [];
  for (const relativePath of [...roots].sort()) {
    await collectEntries(repoRoot, relativePath, entries, exclude);
  }
  return digestEntries(entries);
}

export async function computeBuildInputDigest(repoRoot, inputPaths = INPUT_PATHS) {
  return computeTreeDigest(repoRoot, inputPaths, isExcludedInputPath);
}

export async function computeBuildOutputDigest(repoRoot) {
  return computeTreeDigest(repoRoot, OUTPUT_ROOTS);
}

async function readCliPackageMaterial(repoRoot) {
  const relativePath = 'packages/cli/package.json';
  const packageJsonPath = path.join(repoRoot, relativePath);
  let stats;
  try {
    stats = await fs.stat(packageJsonPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Missing CLI package metadata at ${packageJsonPath}.`);
    }
    throw error;
  }
  if (!stats.isFile()) {
    throw new Error(`CLI package metadata is not a regular file: ${packageJsonPath}.`);
  }
  return {
    contents: await fs.readFile(packageJsonPath),
    mode: stats.mode & 0o777,
    relativePath,
  };
}

function digestCliPackageMaterial(material) {
  const hash = crypto.createHash('sha256');
  updateLengthPrefixed(hash, 'file');
  updateLengthPrefixed(hash, material.relativePath);
  updateLengthPrefixed(hash, String(material.mode));
  updateLengthPrefixed(hash, material.contents);
  return hash.digest('hex');
}

export async function computeCliPackageDigest(repoRoot) {
  return digestCliPackageMaterial(await readCliPackageMaterial(repoRoot));
}

async function readPackageManagerIdentity(repoRoot) {
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  return packageJson.packageManager ?? null;
}

export function resolvePnpmInvocation(env = process.env) {
  const npmExecPath = env.npm_execpath?.trim();
  if (!npmExecPath) {
    throw new Error(
      'Cannot run the CLI build because npm_execpath is missing. Run the command through pnpm.',
    );
  }
  return {
    command: process.execPath,
    args: [
      path.resolve(npmExecPath),
      '--filter',
      '@lesliechan721/agent-skill-eval',
      '--filter',
      '@lesliechan721/aw-plugin-core',
      '--filter',
      '@lesliechan721/aw',
      'build',
    ],
  };
}

async function readNpmExecIdentity(invocation = resolvePnpmInvocation()) {
  const npmExecPath = invocation.args[0];
  const npmExecRealPath = await fs.realpath(npmExecPath);
  const contents = await fs.readFile(npmExecRealPath);
  return {
    npmExecPath,
    npmExecRealPath,
    npmExecDigest: crypto.createHash('sha256').update(contents).digest('hex'),
    npmUserAgent: process.env.npm_config_user_agent ?? null,
  };
}

async function readNodeExecIdentity() {
  const nodeExecPath = path.resolve(process.execPath);
  const nodeExecRealPath = await fs.realpath(nodeExecPath);
  const contents = await fs.readFile(nodeExecRealPath);
  return {
    nodeExecPath,
    nodeExecRealPath,
    nodeExecDigest: crypto.createHash('sha256').update(contents).digest('hex'),
  };
}

async function readBuildLauncher() {
  const requestedInvocation = resolvePnpmInvocation();
  const [nodeIdentity, npmIdentity] = await Promise.all([
    readNodeExecIdentity(),
    readNpmExecIdentity(requestedInvocation),
  ]);
  return {
    invocation: {
      command: nodeIdentity.nodeExecRealPath,
      args: [npmIdentity.npmExecRealPath, ...requestedInvocation.args.slice(1)],
    },
    identity: {
      ...nodeIdentity,
      ...npmIdentity,
    },
  };
}

async function readExpectedStampIdentity(repoRoot, launcherIdentity) {
  return {
    schemaVersion: STAMP_SCHEMA_VERSION,
    inputDigest: await computeBuildInputDigest(repoRoot),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    packageManager: await readPackageManagerIdentity(repoRoot),
    ...(launcherIdentity ?? (await readBuildLauncher()).identity),
  };
}

async function findRegisteredSymlink(repoRoot, roots, exclude = () => false) {
  async function findPathChainSymlink(relativePath) {
    const segments = normalizeRelativePath(relativePath).split('/').filter(Boolean);
    let currentPath = path.resolve(repoRoot);
    let currentRelativePath = '';
    for (const segment of segments) {
      currentPath = path.join(currentPath, segment);
      currentRelativePath = currentRelativePath
        ? `${currentRelativePath}/${segment}`
        : segment;
      let stats;
      try {
        stats = await fs.lstat(currentPath);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
        throw error;
      }
      if (stats.isSymbolicLink()) return currentRelativePath;
    }
    return null;
  }

  async function visit(relativePath) {
    if (exclude(relativePath)) {
      return null;
    }
    let stats;
    try {
      stats = await fs.lstat(path.join(repoRoot, relativePath));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      return normalizeRelativePath(relativePath);
    }
    if (!stats.isDirectory()) {
      return null;
    }
    for (const childName of (await fs.readdir(path.join(repoRoot, relativePath))).sort()) {
      const found = await visit(path.join(relativePath, childName));
      if (found) {
        return found;
      }
    }
    return null;
  }

  for (const root of roots) {
    const pathChainSymlink = await findPathChainSymlink(root);
    if (pathChainSymlink) return pathChainSymlink;
    const found = await visit(root);
    if (found) {
      return found;
    }
  }
  return null;
}

export async function assertBuildInputPathSafety(repoRoot) {
  const requestedRoot = path.resolve(repoRoot);
  const rootStats = await fs.lstat(requestedRoot);
  if (rootStats.isSymbolicLink()) {
    throw new Error('Refusing release snapshot: registered release input contains a symlink: .');
  }
  const inputSymlink = await findRegisteredSymlink(
    requestedRoot,
    INPUT_PATHS,
    isExcludedInputPath,
  );
  if (inputSymlink) {
    throw new Error(
      `Refusing release snapshot: registered release input contains a symlink: ${inputSymlink}.`,
    );
  }
}

async function findReuseDisabledReason(repoRoot) {
  const inputSymlink = await findRegisteredSymlink(repoRoot, INPUT_PATHS, isExcludedInputPath);
  if (inputSymlink) {
    return `reuse disabled: registered input contains symlink ${inputSymlink}`;
  }
  const pluginsRoot = path.join(repoRoot, 'plugins');
  let entries;
  try {
    entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  for (const entry of entries.filter((candidate) =>
    candidate.isDirectory() || candidate.isSymbolicLink()
  ).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    const manifestPath = path.join(pluginsRoot, entry.name, '.agents-plugin', 'plugin.json');
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue;
      }
      return `reuse disabled: plugin ${entry.name} has an unreadable source manifest`;
    }
    if (
      manifest?.scripts?.node &&
      Object.prototype.hasOwnProperty.call(manifest.scripts.node, 'build') &&
      manifest?.buildConfig?.cacheable !== true
    ) {
      return `reuse disabled: plugin ${entry.name} declares scripts.node.build`;
    }
  }
  return null;
}

async function validateRequiredOutputs(repoRoot) {
  for (const output of REQUIRED_OUTPUTS) {
    const outputPath = path.join(repoRoot, output.path);
    let contents;
    try {
      contents = await fs.readFile(outputPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { valid: false, reason: `missing output ${output.path}` };
      }
      return { valid: false, reason: `unreadable output ${output.path}` };
    }
    if (contents.trim().length === 0) {
      return { valid: false, reason: `empty output ${output.path}` };
    }
    if (output.type !== 'text') {
      try {
        const parsed = JSON.parse(contents);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { valid: false, reason: `invalid output ${output.path}` };
        }
        if (output.type === 'marketplace' && !Array.isArray(parsed.plugins)) {
          return { valid: false, reason: `incomplete output ${output.path}` };
        }
        if (
          output.type === 'catalog' &&
          (parsed.schemaVersion !== 4 ||
            !parsed.release ||
            (parsed.release.state !== 'development' && parsed.release.state !== 'published') ||
            !Array.isArray(parsed.entries) ||
            Object.hasOwn(parsed, 'packages') ||
            parsed.entries.some((entry) =>
              typeof entry?.contentDigest !== 'string'
              || !/^sha256:[0-9a-f]{64}$/.test(entry.contentDigest)))
        ) {
          return { valid: false, reason: `incomplete output ${output.path}` };
        }
        if (
          output.type === 'ledger'
          && (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records))
        ) {
          return { valid: false, reason: `incomplete output ${output.path}` };
        }
        if (
          output.type === 'receipt'
          && (
            parsed.schemaVersion !== 1
            || parsed.phase !== 'development'
            || parsed.publishable !== false
            || !Array.isArray(parsed.entries)
          )
        ) {
          return { valid: false, reason: `incomplete output ${output.path}` };
        }
        if (
          output.type === 'package' &&
          (parsed.name !== output.packageName || !Array.isArray(parsed.files))
        ) {
          return { valid: false, reason: `incomplete output ${output.path}` };
        }
      } catch {
        return { valid: false, reason: `invalid output ${output.path}` };
      }
    }
  }
  return { valid: true };
}

export async function inspectBuildCache(repoRoot, options = {}) {
  const expected = await readExpectedStampIdentity(repoRoot);
  const outputSymlink = await findRegisteredSymlink(
    repoRoot,
    ['packages/agent-skill-eval/dist', 'packages/plugin-core/dist', 'packages/cli/dist'],
  );
  if (outputSymlink) {
    return {
      reusable: false,
      reason: `registered output contains unsupported symlink ${outputSymlink}`,
      expected,
    };
  }
  const reuseDisabledReason = await findReuseDisabledReason(repoRoot);
  if (reuseDisabledReason) {
    return { reusable: false, reason: reuseDisabledReason, expected };
  }

  const { stampPath } = cachePaths(repoRoot);
  let stamp;
  try {
    stamp = JSON.parse(await fs.readFile(stampPath, 'utf8'));
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'missing stamp' : 'invalid stamp';
    return { reusable: false, reason, expected };
  }

  for (const key of STAMP_IDENTITY_KEYS) {
    if (stamp?.[key] !== expected[key]) {
      return { reusable: false, reason: `${key} changed`, expected };
    }
  }
  if (typeof stamp.generationId !== 'string' || !isUuid(stamp.generationId)) {
    return { reusable: false, reason: 'generationId changed', expected };
  }
  const cliPackageDigest = await computeCliPackageDigest(repoRoot);
  if (stamp.cliPackageDigest !== cliPackageDigest) {
    return { reusable: false, reason: 'cliPackageDigest changed', expected };
  }

  const outputs = await validateRequiredOutputs(repoRoot);
  if (!outputs.valid) {
    return { reusable: false, reason: outputs.reason, expected };
  }
  const outputDigest = await computeBuildOutputDigest(repoRoot);
  if (stamp.outputDigest !== outputDigest) {
    return { reusable: false, reason: 'outputDigest changed', expected };
  }

  // Internal test seam for changing an input at the final reuse boundary.
  // Production callers must not set it.
  await options.__testBeforeFinalInputCheck?.();
  const [finalExpected, finalCliPackageDigest] = await Promise.all([
    readExpectedStampIdentity(repoRoot),
    computeCliPackageDigest(repoRoot),
  ]);
  if (
    finalCliPackageDigest !== cliPackageDigest ||
    finalCliPackageDigest !== stamp.cliPackageDigest
  ) {
    return { reusable: false, reason: 'cliPackageDigest changed', expected };
  }
  for (const key of STAMP_IDENTITY_KEYS) {
    if (finalExpected[key] !== expected[key] || finalExpected[key] !== stamp[key]) {
      return { reusable: false, reason: `${key} changed`, expected };
    }
  }

  // Internal test seam for changing an output at the final reuse boundary.
  // Production callers must not set it.
  await options.__testBeforeFinalOutputCheck?.();
  const finalOutputSymlink = await findRegisteredSymlink(
    repoRoot,
    ['packages/agent-skill-eval/dist', 'packages/plugin-core/dist', 'packages/cli/dist'],
  );
  if (finalOutputSymlink) {
    return {
      reusable: false,
      reason: `registered output contains unsupported symlink ${finalOutputSymlink}`,
      expected,
    };
  }
  const finalOutputs = await validateRequiredOutputs(repoRoot);
  if (!finalOutputs.valid) {
    return { reusable: false, reason: finalOutputs.reason, expected };
  }
  const finalOutputDigest = await computeBuildOutputDigest(repoRoot);
  if (finalOutputDigest !== outputDigest || finalOutputDigest !== stamp.outputDigest) {
    return { reusable: false, reason: 'outputDigest changed', expected };
  }
  return {
    reusable: true,
    reason: 'stamp and output tree match',
    expected,
    stamp,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function forceIntentRoot(repoRoot) {
  return path.join(repoRoot, '.release', 'cache', 'build.force');
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function createForceIntentSync(repoRoot, options = {}) {
  const intentRoot = forceIntentRoot(repoRoot);
  const token = crypto.randomUUID();
  const intentPath = path.join(intentRoot, token);
  fsSync.mkdirSync(intentRoot, { recursive: true });
  fsSync.mkdirSync(intentPath);
  try {
    options.onForceIntentVisible?.({ intentPath, token });
    const owner = {
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
    };
    const contents = `${JSON.stringify(owner, null, 2)}\n`;
    if (options.writeForceOwnerSync) {
      options.writeForceOwnerSync(path.join(intentPath, 'owner.json'), contents);
    } else {
      fsSync.writeFileSync(path.join(intentPath, 'owner.json'), contents, { flag: 'wx' });
    }
  } catch (error) {
    fsSync.rmSync(intentPath, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  return {
    intentPath,
    token,
    async release() {
      if (released) {
        return false;
      }
      released = true;
      try {
        await fs.rm(intentPath, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch (error) {
        throw new Error(
          `Failed to remove build force intent ${intentPath}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      return true;
    },
  };
}

async function hasActiveForceIntent(repoRoot) {
  try {
    return (await fs.readdir(forceIntentRoot(repoRoot))).some(isUuid);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readBuildLockOwner(lockPath) {
  try {
    return (await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')).trim();
  } catch (error) {
    return `<unavailable: ${error?.code ?? String(error)}>`;
  }
}

function readBuildLockOwnerPid(owner) {
  try {
    const pid = JSON.parse(owner)?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    return null;
  }
}

function staleBuildLockError(lockPath, owner, pid) {
  return new Error(
    `Build lock owner PID ${pid} is not running for ${lockPath}. ` +
    `Current owner metadata: ${owner}. The lock was not recovered automatically. ` +
    'Stop all build processes, then remove the lock offline before retrying.',
  );
}

function buildLockTimeoutError(lockPath, owner, waitedMs) {
  return new Error(
    `Timed out after ${waitedMs}ms waiting for build lock ${lockPath}. ` +
    `Current owner metadata: ${owner}. The lock was not recovered automatically. ` +
    'Stop all build processes, then remove the lock offline before retrying.',
  );
}

export async function acquireBuildLock(repoRoot, options = {}) {
  const { cacheDir, lockPath } = cachePaths(repoRoot);
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();
  let waitReported = false;
  await fs.mkdir(cacheDir, { recursive: true });

  while (true) {
    try {
      await fs.mkdir(lockPath);
      const owner = {
        pid: process.pid,
        token: crypto.randomUUID(),
        acquiredAt: new Date().toISOString(),
      };
      try {
        // Internal test seam for owner-write failure. Production callers must not set it.
        const writeOwner = options.__testWriteBuildOwner ?? fs.writeFile;
        await writeOwner(
          path.join(lockPath, 'owner.json'),
          `${JSON.stringify(owner, null, 2)}\n`,
          { flag: 'wx' },
        );
      } catch (error) {
        await fs.rm(lockPath, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
        throw new Error(
          `Failed to write diagnostic owner metadata for build lock ${lockPath}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      let released = false;
      return {
        lockPath,
        owner,
        async release() {
          if (released) {
            return false;
          }
          released = true;
          await fs.rm(lockPath, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 50,
          });
          return true;
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
    }

    const owner = await readBuildLockOwner(lockPath);
    const ownerPid = readBuildLockOwnerPid(owner);
    if (ownerPid !== null && isProcessAlive(ownerPid) === false) {
      throw staleBuildLockError(lockPath, owner, ownerPid);
    }
    if (!waitReported) {
      console.error(
        `Build lock is held; waiting up to ${lockTimeoutMs}ms for ${lockPath}. ` +
        `Current owner metadata: ${owner}`,
      );
      waitReported = true;
    }

    if (Date.now() - startedAt >= lockTimeoutMs) {
      throw buildLockTimeoutError(
        lockPath,
        owner,
        lockTimeoutMs,
      );
    }
    await delay(pollIntervalMs);
  }
}

export async function runCliBuild(repoRoot, invocation, options = {}) {
  const fixedInvocation = invocation ?? (await readBuildLauncher()).invocation;
  await fs.rm(path.join(repoRoot, 'packages', 'cli', 'dist'), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(repoRoot, 'packages', 'agent-skill-eval', 'dist'), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(repoRoot, 'packages', 'plugin-core', 'dist'), {
    recursive: true,
    force: true,
  });
  await new Promise((resolve, reject) => {
    const child = spawn(fixedInvocation.command, fixedInvocation.args, {
      cwd: repoRoot,
      env: process.env,
      stdio: options.quiet ? 'ignore' : 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        signal
          ? `CLI build terminated by signal ${signal}.`
          : `CLI build exited with code ${code}.`,
      ));
    });
  });
}

async function writeBuildStamp(
  repoRoot,
  expected,
  outputDigest,
  generationId,
  cliPackageDigest,
) {
  const { cacheDir, stampPath } = cachePaths(repoRoot);
  await fs.mkdir(cacheDir, { recursive: true });
  const temporaryPath = `${stampPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const stamp = {
    ...expected,
    outputDigest,
    generationId,
    cliPackageDigest,
    builtAt: new Date().toISOString(),
  };
  await fs.writeFile(temporaryPath, `${JSON.stringify(stamp, null, 2)}\n`);
  await fs.rename(temporaryPath, stampPath);
  return stamp;
}

function buildSettings(options) {
  return {
    build: options.build,
    force: options.force ?? false,
    quiet: options.quiet ?? false,
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    snapshotRunToken: options.snapshotRunToken,
    onForceIntentVisible: options.onForceIntentVisible,
    writeForceOwnerSync: options.writeForceOwnerSync,
    // Internal test seams. Production callers must not set these options.
    __testAfterForceIntentCheck: options.__testAfterForceIntentCheck,
    __testCopyPath: options.__testCopyPath,
    __testCreateDependencyLink: options.__testCreateDependencyLink,
    __testRemoveSnapshot: options.__testRemoveSnapshot,
    __testSnapshotPlatform: options.__testSnapshotPlatform,
  };
}

function remainingLockOptions(settings, deadline) {
  return {
    lockTimeoutMs: Math.max(0, deadline - Date.now()),
    pollIntervalMs: settings.pollIntervalMs,
  };
}

async function buildUnderLock(repoRoot, settings, inspection) {
  const { stampPath } = cachePaths(repoRoot);
  await fs.rm(stampPath, { force: true });
  const launcherBeforeBuild = await readBuildLauncher();
  const identityBeforeBuild = await readExpectedStampIdentity(
    repoRoot,
    launcherBeforeBuild.identity,
  );
  const cliPackageDigestBeforeBuild = await computeCliPackageDigest(repoRoot);
  if (settings.build) {
    await settings.build();
  } else {
    await runCliBuild(repoRoot, launcherBeforeBuild.invocation, { quiet: settings.quiet });
  }

  const expected = await readExpectedStampIdentity(repoRoot);
  const cliPackageDigest = await computeCliPackageDigest(repoRoot);
  if (cliPackageDigest !== cliPackageDigestBeforeBuild) {
    throw new Error(
      'CLI package metadata changed while the build was running; refusing to publish a generation.',
    );
  }
  const changedIdentityKey = STAMP_IDENTITY_KEYS.find((key) =>
    expected[key] !== identityBeforeBuild[key]
  );
  if (changedIdentityKey) {
    throw new Error(
      `Build identity ${changedIdentityKey} changed while the build was running; refusing to write a stamp.`,
    );
  }
  const outputs = await validateRequiredOutputs(repoRoot);
  if (!outputs.valid) {
    throw new Error(`Build completed without required outputs: ${outputs.reason}.`);
  }
  const outputSymlink = await findRegisteredSymlink(
    repoRoot,
    ['packages/agent-skill-eval/dist', 'packages/plugin-core/dist', 'packages/cli/dist'],
  );
  if (outputSymlink) {
    throw new Error(
      `Build output contains unsupported symlink ${outputSymlink}; ` +
      'refusing to publish a generation or snapshot.',
    );
  }
  const outputDigest = await computeBuildOutputDigest(repoRoot);
  const reuseDisabledReason = await findReuseDisabledReason(repoRoot);
  const generationId = crypto.randomUUID();
  if (reuseDisabledReason) {
    return {
      reused: false,
      reason: reuseDisabledReason,
      generationId,
      outputDigest,
      inputDigest: expected.inputDigest,
      cliPackageDigest,
    };
  }
  await writeBuildStamp(
    repoRoot,
    expected,
    outputDigest,
    generationId,
    cliPackageDigest,
  );
  return {
    reused: false,
    reason: settings.force ? 'forced build' : inspection.reason,
    generationId,
    outputDigest,
    inputDigest: expected.inputDigest,
    cliPackageDigest,
  };
}

async function ensureUnderLock(repoRoot, settings) {
  const inspection = settings.force ? null : await inspectBuildCache(repoRoot);
  if (inspection?.reusable) {
    return {
      reused: true,
      reason: inspection.reason,
      generationId: inspection.stamp.generationId,
      outputDigest: inspection.stamp.outputDigest,
      inputDigest: inspection.stamp.inputDigest,
      cliPackageDigest: inspection.stamp.cliPackageDigest,
    };
  }
  return buildUnderLock(repoRoot, settings, inspection);
}

async function waitForForceIntents(repoRoot, settings, deadline) {
  while (await hasActiveForceIntent(repoRoot)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${settings.lockTimeoutMs}ms waiting for build force intent in ` +
        `${forceIntentRoot(repoRoot)}. Intents are not recovered automatically; ` +
        'stop all build processes and remove stale intents offline before retrying.',
      );
    }
    await delay(settings.pollIntervalMs);
  }
}

async function withStableBuildLock(repoRoot, settings, callback) {
  const deadline = Date.now() + settings.lockTimeoutMs;
  while (true) {
    const lock = await acquireBuildLock(repoRoot, remainingLockOptions(settings, deadline));
    let waitForForce = false;
    try {
      if (!settings.force) {
        const forceActive = await hasActiveForceIntent(repoRoot);
        await settings.__testAfterForceIntentCheck?.({ forceActive, lockPath: lock.lockPath });
        waitForForce = forceActive;
      }
      if (!waitForForce) {
        return await callback();
      }
    } finally {
      await lock.release();
    }
    await waitForForceIntents(repoRoot, settings, deadline);
  }
}

async function runBuildWithCache(repoRoot, settings) {
  return withStableBuildLock(repoRoot, settings, () => ensureUnderLock(repoRoot, settings));
}

function startWithForceIntent(repoRoot, settings, operation) {
  let forceIntent = null;
  try {
    if (settings.force) {
      forceIntent = createForceIntentSync(repoRoot, settings);
    }
  } catch (error) {
    return Promise.reject(error);
  }
  return operation().finally(() => forceIntent?.release());
}

export function buildWithCache(repoRoot, options = {}) {
  const settings = buildSettings(options);
  return startWithForceIntent(repoRoot, settings, () => runBuildWithCache(repoRoot, settings));
}

function snapshotCleanupError(primaryError, cleanupError, snapshotRoot) {
  return new AggregateError(
    [primaryError, cleanupError],
    `${primaryError instanceof Error ? primaryError.message : String(primaryError)} ` +
    `(snapshot cleanup also failed for ${snapshotRoot}: ` +
    `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`,
    { cause: primaryError },
  );
}

async function createSnapshotUnderLock(repoRoot, settings) {
  const ensured = await ensureUnderLock(repoRoot, settings);
  if (!ensured.generationId) {
    throw new Error(`Cannot create a build snapshot: ${ensured.reason}.`);
  }

  const snapshotRunToken = settings.snapshotRunToken ?? crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    snapshotRunToken,
  )) {
    throw new Error('Build snapshot run token must be a UUID.');
  }
  const snapshotRoot = path.join(
    repoRoot,
    '.release',
    'build-snapshots',
    `build-${snapshotRunToken}`,
  );
  const cliPackageRoot = path.join(snapshotRoot, 'packages', 'cli');
  const evalPackageRoot = path.join(snapshotRoot, 'packages', 'agent-skill-eval');
  const corePackageRoot = path.join(snapshotRoot, 'packages', 'plugin-core');
  const canonicalNodeModules = path.join(repoRoot, 'packages', 'cli', 'node_modules');
  const canonicalEvalNodeModules = path.join(repoRoot, 'packages', 'agent-skill-eval', 'node_modules');
  const canonicalCoreNodeModules = path.join(repoRoot, 'packages', 'plugin-core', 'node_modules');
  const copyPath = settings.__testCopyPath ?? ((source, target, copyOptions) =>
    fs.cp(source, target, copyOptions)
  );
  const removeSnapshot = settings.__testRemoveSnapshot ?? ((target) =>
    fs.rm(target, { recursive: true, force: true })
  );
  const createDependencyLink = settings.__testCreateDependencyLink ?? ((source, target, type) =>
    fs.symlink(source, target, type)
  );
  let ownsSnapshotRoot = false;

  try {
    await fs.mkdir(path.dirname(snapshotRoot), { recursive: true });
    await fs.mkdir(snapshotRoot);
    ownsSnapshotRoot = true;
    await Promise.all([
      fs.mkdir(cliPackageRoot, { recursive: true }),
      fs.mkdir(evalPackageRoot, { recursive: true }),
      fs.mkdir(corePackageRoot, { recursive: true }),
    ]);
    let dependencyStats;
    try {
      dependencyStats = await fs.stat(canonicalNodeModules);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          `Cannot create build snapshot: missing CLI dependencies at ${canonicalNodeModules}.`,
        );
      }
      throw error;
    }
    if (!dependencyStats.isDirectory()) {
      throw new Error(
        `Cannot create build snapshot: CLI dependencies path is not a directory: ` +
        `${canonicalNodeModules}.`,
      );
    }
    const cliPackageMaterial = await readCliPackageMaterial(repoRoot);
    const sourceCliPackageDigest = digestCliPackageMaterial(cliPackageMaterial);
    if (sourceCliPackageDigest !== ensured.cliPackageDigest) {
      throw new Error(
        `CLI package metadata changed before snapshot materialization for generation ` +
        `${ensured.generationId}.`,
      );
    }
    const snapshotPackageJsonPath = path.join(cliPackageRoot, 'package.json');
    await fs.writeFile(snapshotPackageJsonPath, cliPackageMaterial.contents, {
      mode: cliPackageMaterial.mode,
    });
    await fs.chmod(snapshotPackageJsonPath, cliPackageMaterial.mode);
    await copyPath(
      path.join(repoRoot, 'packages', 'agent-skill-eval', 'dist'),
      path.join(evalPackageRoot, 'dist'),
      { recursive: true, verbatimSymlinks: true },
    );
    await copyPath(
      path.join(repoRoot, 'packages', 'plugin-core', 'dist'),
      path.join(corePackageRoot, 'dist'),
      { recursive: true, verbatimSymlinks: true },
    );
    await copyPath(
      path.join(repoRoot, 'packages', 'plugin-core', 'schemas'),
      path.join(corePackageRoot, 'schemas'),
      { recursive: true, verbatimSymlinks: true },
    );
    await copyPath(
      path.join(repoRoot, 'packages', 'cli', 'dist'),
      path.join(cliPackageRoot, 'dist'),
      { recursive: true, verbatimSymlinks: true },
    );
    await copyPath(
      path.join(repoRoot, 'packages', 'cli', 'plugins-dist'),
      path.join(cliPackageRoot, 'plugins-dist'),
      { recursive: true, verbatimSymlinks: true },
    );
    await createDependencyLink(
      canonicalNodeModules,
      path.join(cliPackageRoot, 'node_modules'),
      (settings.__testSnapshotPlatform ?? process.platform) === 'win32' ? 'junction' : 'dir',
    );
    await createDependencyLink(
      canonicalEvalNodeModules,
      path.join(evalPackageRoot, 'node_modules'),
      (settings.__testSnapshotPlatform ?? process.platform) === 'win32' ? 'junction' : 'dir',
    );
    await createDependencyLink(
      canonicalCoreNodeModules,
      path.join(corePackageRoot, 'node_modules'),
      (settings.__testSnapshotPlatform ?? process.platform) === 'win32' ? 'junction' : 'dir',
    );
    await copyPath(
      path.join(repoRoot, 'packages', 'agent-skill-eval', 'package.json'),
      path.join(evalPackageRoot, 'package.json'),
      { verbatimSymlinks: true },
    );
    await copyPath(
      path.join(repoRoot, 'packages', 'plugin-core', 'package.json'),
      path.join(corePackageRoot, 'package.json'),
      { verbatimSymlinks: true },
    );
    const snapshotDigest = await computeBuildOutputDigest(snapshotRoot);
    if (snapshotDigest !== ensured.outputDigest) {
      throw new Error(
        `Build snapshot digest mismatch for generation ${ensured.generationId}: ` +
        `expected ${ensured.outputDigest}, found ${snapshotDigest}.`,
      );
    }
    const snapshotSymlink = await findRegisteredSymlink(
      snapshotRoot,
      ['packages/agent-skill-eval', 'packages/plugin-core', 'packages/cli'],
      (relativePath) => {
        const normalizedPath = normalizeRelativePath(relativePath);
        return normalizedPath === 'packages/cli/node_modules' ||
          normalizedPath.startsWith('packages/cli/node_modules/') ||
          normalizedPath === 'packages/agent-skill-eval/node_modules' ||
          normalizedPath.startsWith('packages/agent-skill-eval/node_modules/') ||
          normalizedPath === 'packages/plugin-core/node_modules' ||
          normalizedPath.startsWith('packages/plugin-core/node_modules/') ||
          normalizedPath === 'packages/cli/plugins-dist' ||
          normalizedPath.startsWith('packages/cli/plugins-dist/');
      },
    );
    if (snapshotSymlink) {
      throw new Error(
        `Build snapshot contains unsupported symlink ${snapshotSymlink}.`,
      );
    }
    const [currentInputDigest, currentCliPackageDigest, snapshotCliPackageDigest] =
      await Promise.all([
        computeBuildInputDigest(repoRoot),
        computeCliPackageDigest(repoRoot),
        computeCliPackageDigest(snapshotRoot),
      ]);
    if (currentCliPackageDigest !== ensured.cliPackageDigest) {
      throw new Error(
        `CLI package metadata changed while snapshot generation ` +
        `${ensured.generationId} was copying.`,
      );
    }
    if (currentInputDigest !== ensured.inputDigest) {
      throw new Error(
        `Build inputs changed while snapshot generation ${ensured.generationId} was copying.`,
      );
    }
    if (snapshotCliPackageDigest !== ensured.cliPackageDigest) {
      throw new Error(
        `Build snapshot CLI package digest mismatch for generation ${ensured.generationId}: ` +
        `expected ${ensured.cliPackageDigest}, found ${snapshotCliPackageDigest}.`,
      );
    }
  } catch (error) {
    if (!ownsSnapshotRoot) {
      throw error;
    }
    try {
      await removeSnapshot(snapshotRoot);
    } catch (cleanupError) {
      throw snapshotCleanupError(error, cleanupError, snapshotRoot);
    }
    throw error;
  }

  return {
    root: snapshotRoot,
    generationId: ensured.generationId,
    outputDigest: ensured.outputDigest,
    inputDigest: ensured.inputDigest,
    cliPackageDigest: ensured.cliPackageDigest,
    evalPackageRoot,
    corePackageRoot,
    cliPackageRoot,
    cliDistRoot: path.join(cliPackageRoot, 'dist'),
    catalogOutputRoot: path.join(cliPackageRoot, 'plugins-dist'),
    cleanup: () => removeSnapshot(snapshotRoot),
  };
}

async function runCreateBuildSnapshot(repoRoot, settings) {
  return withStableBuildLock(
    repoRoot,
    settings,
    () => createSnapshotUnderLock(repoRoot, settings),
  );
}

export function createBuildSnapshot(repoRoot, options = {}) {
  const settings = buildSettings(options);
  return startWithForceIntent(repoRoot, settings, () =>
    runCreateBuildSnapshot(repoRoot, settings)
  );
}

export async function withBuildSnapshot(repoRoot, callback, options = {}) {
  const snapshot = await createBuildSnapshot(repoRoot, options);
  let result;
  try {
    result = await callback(snapshot);
  } catch (error) {
    try {
      await snapshot.cleanup();
    } catch (cleanupError) {
      throw snapshotCleanupError(error, cleanupError, snapshot.root);
    }
    throw error;
  }
  await snapshot.cleanup();
  return result;
}

export const buildCacheContract = {
  inputPaths: INPUT_PATHS,
  outputRoots: OUTPUT_ROOTS,
  requiredOutputs: REQUIRED_OUTPUTS.map((output) => output.path),
  schemaVersion: STAMP_SCHEMA_VERSION,
};
