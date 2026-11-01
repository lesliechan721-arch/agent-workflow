import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compareStrictSemVer, parseStrictSemVer } from './semver.mjs';
import {
  assertAuthoringPluginPathFence,
  resolveAuthoringPluginRoot,
} from './plugin-root.mjs';

const execFileAsync = promisify(execFile);
const EXPECTED_MANIFEST_CONTRACT_VERSION = 17;
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_GIT_BLOB_BYTES = 50 * 1024 * 1024;
const MAX_GIT_BATCH_HEADER_BYTES = 1024;
const GIT_BATCH_OPERATION_TIMEOUT_MS = 30_000;
const GIT_BATCH_TERM_GRACE_MS = 250;
const GIT_BATCH_CLOSE_TIMEOUT_MS = 2_000;
const CLI_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

export class PluginVersionCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PluginVersionCheckError';
    this.code = code;
  }
}

function codedError(code, message) {
  return new PluginVersionCheckError(code, message);
}

export function parseStablePluginVersion(version, fieldName) {
  const parsed = parseStrictSemVer(version, fieldName);
  if (parsed.prerelease.length > 0 || parsed.build.length > 0) {
    throw codedError(
      'invalidPlugin',
      `${fieldName} must be a stable SemVer without prerelease or build metadata.`,
    );
  }
  return parsed;
}

export async function runGit(repoRoot, args, options = {}) {
  try {
    const result = await execFileAsync('git', args, {
      cwd: repoRoot,
      encoding: options.buffer ? null : 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const detail = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString('utf8').trim()
      : String(error.stderr ?? error.message).trim();
    throw codedError(
      options.code ?? 'gitFailed',
      `${options.label ?? `git ${args.join(' ')}`} failed${detail ? `: ${detail}` : '.'}`,
    );
  }
}

export async function resolveBaseCommit(repoRoot, base) {
  await runGit(repoRoot, ['rev-parse', '--show-toplevel'], {
    code: 'gitUnavailable',
    label: 'Git repository discovery',
  });
  const output = await runGit(repoRoot, ['rev-parse', '--verify', `${base}^{commit}`], {
    code: 'invalidBase',
    label: `Git base ${JSON.stringify(base)}`,
  });
  return output.trim();
}

async function loadProductionBundler(cliPackageRoot) {
  const manifestModulePath = path.join(
    cliPackageRoot,
    'dist',
    'src',
    'utils',
    'manifest.js',
  );
  const generatorModulePath = path.join(
    cliPackageRoot,
    'dist',
    'src',
    'generators',
    'local-plugin.js',
  );
  const digestModulePath = path.join(
    cliPackageRoot,
    'dist',
    'src',
    'utils',
    'catalog-digests.js',
  );
  const runtimeProjectionModulePath = path.join(
    cliPackageRoot,
    'dist',
    'src',
    'utils',
    'catalog-runtime-projection.js',
  );
  const requiredPaths = [
    manifestModulePath,
    generatorModulePath,
    digestModulePath,
    runtimeProjectionModulePath,
  ];
  const exists = await Promise.all(requiredPaths.map((filePath) => fs.stat(filePath).then(
    (stat) => stat.isFile(),
    () => false,
  )));
  if (exists.some((value) => !value)) {
    throw codedError(
      'bundlerUnavailable',
      'Plugin version checking requires a built CLI; run `pnpm build` first.',
    );
  }

  let manifestModule;
  let generatorModule;
  let digestModule;
  let runtimeProjectionModule;
  try {
    [manifestModule, generatorModule, digestModule, runtimeProjectionModule] = await Promise.all([
      import(pathToFileURL(manifestModulePath).href),
      import(pathToFileURL(generatorModulePath).href),
      import(pathToFileURL(digestModulePath).href),
      import(pathToFileURL(runtimeProjectionModulePath).href),
    ]);
  } catch (error) {
    throw codedError('bundlerUnavailable', `Failed to load built CLI bundler: ${error.message}`);
  }
  if (
    manifestModule.SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION
      !== EXPECTED_MANIFEST_CONTRACT_VERSION
    || typeof manifestModule.readPluginManifest !== 'function'
    || typeof manifestModule.discoverPlugins !== 'function'
    || typeof generatorModule.bundleLocalPlugin !== 'function'
    || typeof digestModule.calculateCatalogEntryArtifactDigest !== 'function'
    || typeof runtimeProjectionModule.createCatalogRuntimeImportResolver !== 'function'
  ) {
    throw codedError(
      'bundlerUnavailable',
      'Built CLI authoring contract is incompatible; run `pnpm build` and retry.',
    );
  }
  return {
    readPluginManifest: manifestModule.readPluginManifest,
    discoverPlugins: manifestModule.discoverPlugins,
    bundleLocalPlugin: generatorModule.bundleLocalPlugin,
    calculateArtifactDigest: digestModule.calculateCatalogEntryArtifactDigest,
    createRuntimeResolver: runtimeProjectionModule.createCatalogRuntimeImportResolver,
  };
}

function parseTreeRecord(record) {
  const tabIndex = record.indexOf('\t');
  if (tabIndex < 0) {
    throw codedError('gitFailed', 'Git authoring source tree returned a malformed record.');
  }
  const metadata = record.slice(0, tabIndex).split(' ');
  if (
    metadata.length !== 3
    || !metadata[0]
    || !metadata[1]
    || !GIT_OBJECT_ID_PATTERN.test(metadata[2] ?? '')
  ) {
    throw codedError('gitFailed', 'Git authoring source tree returned malformed metadata.');
  }
  return {
    mode: metadata[0],
    type: metadata[1],
    objectId: metadata[2],
    filePath: record.slice(tabIndex + 1),
  };
}

function createBatchReader(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  let chunk = Buffer.alloc(0);
  let offset = 0;
  let ended = false;

  async function nextChunk() {
    if (offset < chunk.length) return true;
    const next = await iterator.next();
    if (next.done) {
      ended = true;
      chunk = Buffer.alloc(0);
      offset = 0;
      return false;
    }
    chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    offset = 0;
    return true;
  }

  return {
    async readLine() {
      const parts = [];
      let size = 0;
      while (await nextChunk()) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        parts.push(part);
        size += part.length;
        if (size > MAX_GIT_BATCH_HEADER_BYTES) {
          throw codedError('gitFailed', 'Git cat-file batch returned an oversized header.');
        }
        offset = newline < 0 ? chunk.length : newline + 1;
        if (newline >= 0) return Buffer.concat(parts, size).toString('ascii');
      }
      if (size === 0 && ended) return null;
      throw codedError('gitFailed', 'Git cat-file batch stdout ended during a header.');
    },
    async readExact(size) {
      const output = Buffer.allocUnsafe(size);
      let written = 0;
      while (written < size && await nextChunk()) {
        const available = Math.min(size - written, chunk.length - offset);
        chunk.copy(output, written, offset, offset + available);
        offset += available;
        written += available;
      }
      if (written !== size) {
        throw codedError('gitFailed', 'Git cat-file batch stdout ended during a blob.');
      }
      return output;
    },
  };
}

export async function readGitBlobsBatch(repoRoot, objectIds, options = {}) {
  const uniqueObjectIds = [...new Set(objectIds)];
  for (const objectId of uniqueObjectIds) {
    if (!GIT_OBJECT_ID_PATTERN.test(objectId)) {
      throw codedError('gitFailed', `Git authoring source tree returned an invalid object ID.`);
    }
  }
  if (uniqueObjectIds.length === 0) return new Map();

  const child = spawn(options.command ?? 'git', [...(options.argsPrefix ?? []), 'cat-file', '--batch'], {
    cwd: repoRoot,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let cleanupStarted = false;
  let operationTimedOut = false;
  let operationTimeoutTimer;
  let forceKillTimer;
  let closeTimeoutTimer;
  let settleExit;
  let onStderrData;
  const exitTask = new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      if (!settleExit) return;
      settleExit = null;
      clearTimeout(operationTimeoutTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(closeTimeoutTimer);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      if (onStderrData) child.stderr.removeListener('data', onStderrData);
      settle(value);
    };
    const onError = (error) => finish(reject, error);
    const onClose = (code, signal) => finish(resolve, { code, signal });
    settleExit = (error) => finish(reject, error);
    child.once('error', onError);
    child.once('close', onClose);
  });
  function requestCleanup() {
    if (cleanupStarted || !settleExit) return;
    cleanupStarted = true;
    child.stdin.destroy();
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => child.kill('SIGKILL'), GIT_BATCH_TERM_GRACE_MS);
    closeTimeoutTimer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      settleExit(codedError(
        'gitFailed',
        'Git cat-file batch did not exit after forced termination.',
      ));
    }, GIT_BATCH_CLOSE_TIMEOUT_MS);
  }
  operationTimeoutTimer = setTimeout(() => {
    operationTimedOut = true;
    requestCleanup();
  }, options.operationTimeoutMs ?? GIT_BATCH_OPERATION_TIMEOUT_MS);
  const stderrChunks = [];
  let stderrBytes = 0;
  onStderrData = (value) => {
    const valueBuffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    stderrBytes += valueBuffer.length;
    if (stderrBytes <= MAX_GIT_BLOB_BYTES) stderrChunks.push(valueBuffer);
    requestCleanup();
  };
  child.stderr.on('data', onStderrData);

  const readTask = (async () => {
    const reader = createBatchReader(child.stdout);
    const contents = new Map();
    for (const expectedObjectId of uniqueObjectIds) {
      const header = await reader.readLine();
      if (header === null) {
        throw codedError('gitFailed', 'Git cat-file batch stdout ended before all blobs were returned.');
      }
      if (header === `${expectedObjectId} missing`) {
        throw codedError('gitFailed', `Git blob ${expectedObjectId} is missing.`);
      }
      const match = /^(\S+) (\S+) (\S+)$/u.exec(header);
      if (!match || match[1] !== expectedObjectId) {
        throw codedError('gitFailed', 'Git cat-file batch returned a malformed header.');
      }
      if (match[2] !== 'blob') {
        throw codedError('gitFailed', `Git object ${expectedObjectId} is not a blob.`);
      }
      if (!/^(?:0|[1-9][0-9]*)$/u.test(match[3])) {
        throw codedError('gitFailed', `Git blob ${expectedObjectId} has an invalid size.`);
      }
      const size = Number(match[3]);
      if (!Number.isSafeInteger(size) || size > MAX_GIT_BLOB_BYTES) {
        throw codedError('gitFailed', `Git blob ${expectedObjectId} exceeds the size limit.`);
      }
      const content = await reader.readExact(size);
      const separator = await reader.readExact(1);
      if (separator[0] !== 0x0a) {
        throw codedError('gitFailed', `Git blob ${expectedObjectId} has an invalid separator.`);
      }
      contents.set(expectedObjectId, content);
    }
    if (await reader.readLine() !== null) {
      throw codedError('gitFailed', 'Git cat-file batch returned unexpected output.');
    }
    return contents;
  })();
  const writeTask = pipeline(
    Readable.from(uniqueObjectIds.map((objectId) => `${objectId}\n`)),
    child.stdin,
  );
  for (const task of [readTask, writeTask]) {
    task.catch(requestCleanup);
  }
  const [readResult, writeResult, exitResult] = await Promise.allSettled([
    readTask,
    writeTask,
    exitTask,
  ]);
  if (operationTimedOut) {
    throw codedError('gitFailed', 'Git cat-file batch timed out.');
  }
  if (
    exitResult.status === 'rejected'
    && exitResult.reason instanceof PluginVersionCheckError
  ) {
    throw exitResult.reason;
  }
  if (readResult.status === 'rejected') throw readResult.reason;
  if (writeResult.status === 'rejected') {
    throw codedError('gitFailed', `Git cat-file batch input failed: ${writeResult.reason.message}`);
  }
  if (exitResult.status === 'rejected') {
    throw codedError('gitFailed', `Git cat-file batch failed: ${exitResult.reason.message}`);
  }
  const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
  if (stderrBytes > MAX_GIT_BLOB_BYTES) {
    throw codedError('gitFailed', 'Git cat-file batch stderr exceeded the size limit.');
  }
  if (exitResult.value.signal) {
    throw codedError('gitFailed', `Git cat-file batch ended from signal ${exitResult.value.signal}${stderr ? `: ${stderr}` : '.'}`);
  }
  if (exitResult.value.code !== 0 || stderr) {
    throw codedError('gitFailed', `Git cat-file batch failed with exit code ${exitResult.value.code}${stderr ? `: ${stderr}` : '.'}`);
  }
  return readResult.value;
}

async function materializeBaseAuthoringSourceSet(repoRoot, baseCommit, outputRoot, pluginRootPath) {
  const sourcePaths = [
    'plugins',
  ];
  if (pluginRootPath && !sourcePaths.includes(pluginRootPath)) sourcePaths.push(pluginRootPath);
  const output = await runGit(
    repoRoot,
    ['ls-tree', '-r', '-z', baseCommit, '--', ...sourcePaths],
    { buffer: true, label: 'Git authoring source tree' },
  );
  const records = output.toString('utf8').split('\0').filter(Boolean).map(parseTreeRecord);

  for (const record of records) {
    if (record.type !== 'blob') {
      throw codedError('gitFailed', `Git authoring source object ${record.objectId} is not a blob.`);
    }
  }
  const contentsByObjectId = await readGitBlobsBatch(
    repoRoot,
    records.map((record) => record.objectId),
  );

  for (const record of records) {
    const normalizedPath = path.posix.normalize(record.filePath);
    if (
      normalizedPath !== record.filePath
      || normalizedPath === '..'
      || normalizedPath.startsWith('../')
      || path.posix.isAbsolute(normalizedPath)
    ) {
      throw codedError('gitFailed', `Unsafe Git authoring path: ${JSON.stringify(record.filePath)}.`);
    }
    const targetPath = path.join(outputRoot, ...normalizedPath.split('/'));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const content = contentsByObjectId.get(record.objectId);
    if (!content) {
      throw codedError('gitFailed', `Git blob ${record.objectId} was not returned.`);
    }
    if (record.mode === '120000') {
      await fs.symlink(content.toString('utf8'), targetPath);
    } else {
      await fs.writeFile(targetPath, content);
      if (record.mode === '100755') await fs.chmod(targetPath, 0o755);
    }
  }
  return outputRoot;
}

async function lstatOrNull(filePath) {
  return fs.lstat(filePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
}



export async function readManifestDocument(pluginRoot) {
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw codedError('invalidPlugin', `Cannot read ${manifestPath}: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw codedError('invalidPlugin', `${manifestPath} must contain a JSON object.`);
  }
  return { manifestPath, manifest };
}

async function hashBundleEntries(rootDir) {
  const entries = new Map();
  async function visit(currentDir, prefix = '') {
    const children = await fs.readdir(currentDir, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const absolutePath = path.join(currentDir, child.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (stat.isSymbolicLink()) {
        entries.set(relativePath, `symlink:${await fs.readlink(absolutePath)}`);
      } else {
        const digest = crypto.createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex');
        entries.set(relativePath, `sha256:${digest}`);
      }
    }
  }
  await visit(rootDir);
  return entries;
}

function compareBundleEntries(baseEntries, currentEntries) {
  const paths = new Set([...baseEntries.keys(), ...currentEntries.keys()]);
  return [...paths]
    .filter((filePath) => baseEntries.get(filePath) !== currentEntries.get(filePath))
    .sort();
}

async function bundlePlugin(
  bundler,
  sourceSetRoot,
  pluginRoot,
  outputRoot,
  runtimeSkillClosureValidation = 'current',
) {
  const sourceSetPlugins = await bundler.discoverPlugins(sourceSetRoot);
  const plugin = await bundler.readPluginManifest(pluginRoot);
  if (!sourceSetPlugins.some((candidate) => candidate.manifest.name === plugin.manifest.name)) {
    sourceSetPlugins.push(plugin);
  }
  const runtimeResolver = bundler.createRuntimeResolver(sourceSetPlugins);
  await bundler.bundleLocalPlugin(plugin, outputRoot, {
    buildMode: 'staging',
    runtimeResolver,
    runtimeSkillClosureValidation,
  });
  return {
    digest: await bundler.calculateArtifactDigest(outputRoot),
    entries: await hashBundleEntries(outputRoot),
  };
}

function createCheckResult(pluginName, values = {}) {
  return {
    plugin: pluginName,
    ok: values.ok ?? true,
    status: values.status ?? 'unchanged',
    baseVersion: values.baseVersion ?? null,
    currentVersion: values.currentVersion ?? null,
    baseTarget: values.baseTarget ?? values.baseVersion ?? null,
    currentTarget: values.currentTarget ?? values.currentVersion ?? null,
    productionChanged: values.productionChanged ?? null,
    baseDigest: values.baseDigest ?? null,
    currentDigest: values.currentDigest ?? null,
    changedPaths: values.changedPaths ?? [],
    warnings: values.warnings ?? [],
    errors: values.errors ?? [],
  };
}

async function checkOnePlugin(options) {
  const {
    repoRoot,
    pluginName,
    bundler,
    tempRoot,
    baseSourceRoot,
    currentRoot,
    baseRoot,
  } = options;
  if (!PLUGIN_NAME_PATTERN.test(pluginName)) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      errors: [`Invalid plugin name ${JSON.stringify(pluginName)}.`],
    });
  }
  const currentExists = await fs.stat(currentRoot).then((stat) => stat.isDirectory(), () => false);
  if (!currentExists && !baseRoot) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      errors: [`Plugin ${JSON.stringify(pluginName)} does not exist in the base or working tree.`],
    });
  }
  if (!currentExists) {
    return createCheckResult(pluginName, { status: 'deleted' });
  }

  let currentDocument;
  try {
    currentDocument = await readManifestDocument(currentRoot);
    if (currentDocument.manifest.name !== pluginName) {
      throw codedError(
        'invalidPlugin',
        `Current manifest name ${JSON.stringify(currentDocument.manifest.name)} does not match ${JSON.stringify(pluginName)}.`,
      );
    }
    parseStablePluginVersion(currentDocument.manifest.version, 'current plugin version');
  } catch (error) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      errors: [error.message],
    });
  }
  if (!baseRoot) {
    let currentBundle;
    try {
      currentBundle = await bundlePlugin(
        bundler,
        repoRoot,
        currentRoot,
        path.join(tempRoot, 'bundles', pluginName, 'current'),
      );
    } catch (error) {
      return createCheckResult(pluginName, {
        ok: false,
        status: 'error',
        currentVersion: currentDocument.manifest.version,
        errors: [`Production bundle failed: current: ${error.message}`],
      });
    }
    return createCheckResult(pluginName, {
      status: 'new',
      currentVersion: currentDocument.manifest.version,
      productionChanged: true,
      currentDigest: currentBundle.digest,
      changedPaths: [...currentBundle.entries.keys()].sort(),
    });
  }

  let baseDocument;
  try {
    baseDocument = await readManifestDocument(baseRoot);
    if (baseDocument.manifest.name !== pluginName) {
      throw codedError(
        'invalidPlugin',
        `Base manifest name ${JSON.stringify(baseDocument.manifest.name)} does not match ${JSON.stringify(pluginName)}.`,
      );
    }
    parseStablePluginVersion(baseDocument.manifest.version, 'base plugin version');
  } catch (error) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      currentVersion: currentDocument.manifest.version,
      errors: [error.message],
    });
  }

  const baseVersion = baseDocument.manifest.version;
  const currentVersion = currentDocument.manifest.version;
  const precedence = compareStrictSemVer(currentVersion, baseVersion);
  baseDocument.manifest.version = currentVersion;
  await fs.writeFile(
    baseDocument.manifestPath,
    `${JSON.stringify(baseDocument.manifest, null, 2)}\n`,
    'utf8',
  );

  let baseBundle;
  let currentBundle;
  let bundleResults;
  try {
    bundleResults = await Promise.allSettled([
      bundlePlugin(
        bundler,
        baseSourceRoot,
        baseRoot,
        path.join(tempRoot, 'bundles', pluginName, 'base'),
        'historical',
      ),
      bundlePlugin(
        bundler,
        repoRoot,
        currentRoot,
        path.join(tempRoot, 'bundles', pluginName, 'current'),
      ),
    ]);
  } finally {
    baseDocument.manifest.version = baseVersion;
    await fs.writeFile(
      baseDocument.manifestPath,
      `${JSON.stringify(baseDocument.manifest, null, 2)}\n`,
      'utf8',
    );
  }
  const bundleFailures = bundleResults
    .map((result, index) => result.status === 'rejected'
      ? `${index === 0 ? 'base' : 'current'}: ${result.reason?.message ?? String(result.reason)}`
      : null)
    .filter(Boolean);
  if (bundleFailures.length > 0) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      baseVersion,
      currentVersion,
      errors: [
        `Production bundle failed: ${bundleFailures[0]}`,
        ...bundleFailures.slice(1).map((failure) => `Secondary bundle failure: ${failure}`),
      ],
    });
  }
  [baseBundle, currentBundle] = bundleResults.map((result) => result.value);
  const changedPaths = compareBundleEntries(baseBundle.entries, currentBundle.entries);
  const productionChanged = baseBundle.digest !== currentBundle.digest;
  const common = {
    baseVersion,
    currentVersion,
    productionChanged,
    baseDigest: baseBundle.digest,
    currentDigest: currentBundle.digest,
    changedPaths,
  };

  if (precedence < 0) {
    return createCheckResult(pluginName, {
      ...common,
      ok: false,
      status: 'versionDowngrade',
      errors: [`Plugin version decreased from ${baseVersion} to ${currentVersion}.`],
    });
  }
  if (precedence === 0 && currentVersion !== baseVersion) {
    return createCheckResult(pluginName, {
      ...common,
      ok: false,
      status: 'nonIncreasingVersion',
      errors: [
        `Plugin version changed from ${baseVersion} to ${currentVersion} without higher SemVer precedence.`,
      ],
    });
  }
  if (productionChanged && precedence === 0) {
    return createCheckResult(pluginName, {
      ...common,
      status: 'unreleasedChanges',
      warnings: [
        `Production bundle changed while the current stable target remains ${currentVersion}; the release target may need adjustment before publishing.`,
      ],
    });
  }
  if (!productionChanged && precedence > 0) {
    return createCheckResult(pluginName, {
      ...common,
      status: 'versionOnly',
      warnings: [`Plugin version increased from ${baseVersion} to ${currentVersion}, but the production bundle is unchanged.`],
    });
  }
  return createCheckResult(pluginName, {
    ...common,
    status: productionChanged ? 'versionBumped' : 'unchanged',
  });
}

async function listPluginNames(sourceSetRoot) {
  const entries = await fs.readdir(path.join(sourceSetRoot, 'plugins'), {
    withFileTypes: true,
  }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
}

export async function checkPluginVersions(options = {}) {
  const requestedRepoRoot = path.resolve(options.repoRoot ?? '.');
  const cliPackageRoot = path.resolve(options.cliPackageRoot ?? CLI_PACKAGE_ROOT);
  const requestedBase = options.base;
  assertAuthoringPluginPathFence({
    repoRoot: requestedRepoRoot,
    pluginRoot: requestedRepoRoot,
  });
  const explicitRoot = options.pluginRoot === undefined
    ? null
    : resolveAuthoringPluginRoot({
        repoRoot: requestedRepoRoot,
        pluginRoot: options.pluginRoot,
        pluginName: options.pluginNames?.[0],
      });
  const repoRoot = explicitRoot?.repoRoot ?? requestedRepoRoot;
  if (requestedBase === undefined) {
    let pluginNames = options.all
      ? (await listPluginNames(repoRoot)).sort()
      : [...new Set(options.pluginNames ?? [])].sort();
    if (explicitRoot) pluginNames = [...new Set(options.pluginNames ?? [])].sort();
    if (pluginNames.length === 0 && !options.all) {
      throw codedError('usage', 'Provide a plugin name or use --all.');
    }
    const checks = [];
    for (const pluginName of pluginNames) {
      const currentRoot = explicitRoot?.pluginRoot ?? path.join(repoRoot, 'plugins', pluginName);
      assertAuthoringPluginPathFence({
        repoRoot,
        pluginRoot: currentRoot,
        requireManifest: true,
      });
      try {
        const document = await readManifestDocument(currentRoot);
        if (document.manifest.name !== pluginName) {
          throw codedError(
            'invalidPlugin',
            `Current manifest name ${JSON.stringify(document.manifest.name)} does not match ${JSON.stringify(pluginName)}.`,
          );
        }
        parseStablePluginVersion(document.manifest.version, 'current plugin version');
        checks.push(createCheckResult(pluginName, {
          status: 'current',
          currentVersion: document.manifest.version,
        }));
      } catch (error) {
        checks.push(createCheckResult(pluginName, {
          ok: false,
          status: 'error',
          errors: [error.message],
        }));
      }
    }
    return {
      schemaVersion: 3,
      policy: 'development',
      ok: checks.every((check) => check.ok),
      base: null,
      requestedBase: null,
      baseCommit: null,
      checkedPlugins: pluginNames.length,
      checks,
    };
  }
  const baseCommit = await resolveBaseCommit(repoRoot, requestedBase);
  const bundler = await loadProductionBundler(cliPackageRoot);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-version-check-'));
  try {
    const baseSourceRoot = path.join(tempRoot, 'base-source');
    await materializeBaseAuthoringSourceSet(
      repoRoot,
      baseCommit,
      baseSourceRoot,
      explicitRoot?.relativePluginRoot,
    );
    let pluginNames;
    if (options.all) {
      const [basePluginNames, currentPluginNames] = await Promise.all([
        listPluginNames(baseSourceRoot),
        listPluginNames(repoRoot),
      ]);
      pluginNames = [...new Set([...basePluginNames, ...currentPluginNames])].sort();
    } else {
      pluginNames = [...new Set(options.pluginNames ?? [])].sort();
    }
    if (pluginNames.length === 0 && !options.all) {
      throw codedError('usage', 'Provide a plugin name or use --all.');
    }
    const currentRoots = new Map();
    for (const pluginName of pluginNames) {
      const currentRoot = explicitRoot?.pluginRoot ?? path.join(repoRoot, 'plugins', pluginName);
      if (await lstatOrNull(currentRoot)) {
        assertAuthoringPluginPathFence({
          repoRoot,
          pluginRoot: currentRoot,
          requireManifest: true,
        });
      }
      currentRoots.set(pluginName, currentRoot);
    }
    const checks = [];
    for (const pluginName of pluginNames) {
      const currentRoot = currentRoots.get(pluginName);
      const candidateBaseRoot = explicitRoot
        ? path.join(baseSourceRoot, ...explicitRoot.relativePluginRoot.split('/'))
        : path.join(baseSourceRoot, 'plugins', pluginName);
      const baseNode = await lstatOrNull(candidateBaseRoot);
      const baseRoot = baseNode ? candidateBaseRoot : null;
      if (baseRoot) {
        assertAuthoringPluginPathFence({
          repoRoot: baseSourceRoot,
          pluginRoot: baseRoot,
          requirePluginRoot: true,
          requireManifest: true,
        });
      }
      checks.push(await checkOnePlugin({
        repoRoot,
        pluginName,
        bundler,
        tempRoot,
        baseSourceRoot,
        currentRoot,
        baseRoot,
      }));
    }
    return {
      schemaVersion: 3,
      policy: 'development',
      ok: checks.every((check) => check.ok),
      base: {
        requested: requestedBase,
        commit: baseCommit,
      },
      requestedBase,
      baseCommit,
      checkedPlugins: pluginNames.length,
      checks,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export function formatPluginVersionCheck(result) {
  if (result.checkedPlugins === 0) {
    return result.requestedBase
      ? `[PASS] No plugin source changes relative to ${result.requestedBase}.`
      : '[PASS] No current workspace plugins.';
  }
  const lines = [];
  for (const check of result.checks) {
    lines.push(`${check.ok ? '[PASS]' : '[FAIL]'} ${check.plugin}: ${check.status}`);
    if (check.baseVersion || check.currentVersion) {
      lines.push(`  stable target: ${check.baseTarget ?? '(new)'} -> ${check.currentTarget ?? '(deleted)'}`);
    }
    for (const changedPath of check.changedPaths) lines.push(`  changed: ${changedPath}`);
    for (const warning of check.warnings) lines.push(`  warning: ${warning}`);
    for (const error of check.errors) lines.push(`  error: ${error}`);
  }
  return lines.join('\n');
}
