import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createBuildSnapshot,
  withBuildSnapshot,
} from '../build/build-cache.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*)?)?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const repoRoot = path.resolve(scriptDir, '..', '..');
export const releaseRoot = path.join(repoRoot, '.release');
export const tarballDir = path.join(releaseRoot, 'tarballs');
export const rootPackageJsonPath = path.join(repoRoot, 'package.json');
export const cliPackageJsonPath = path.join(repoRoot, 'packages', 'cli', 'package.json');
export const cliPackageRoot = path.join(repoRoot, 'packages', 'cli');
export const cliDistRoot = path.join(cliPackageRoot, 'dist');
export const defaultCatalogOutputRoot = path.join(cliPackageRoot, 'plugins-dist');
export const catalogReleaseStagingRoot = path.join(releaseRoot, 'catalog-staging');
export const sidecarCatalogPackageName = '@yiliang/aw-plugins-manifest';
export const fullCatalogPackageName = '@yiliang/aw-plugins';

const cachedCatalogModules = new Map();

export function relativeToRepo(targetPath) {
  return path.relative(repoRoot, path.resolve(repoRoot, targetPath)) || '.';
}

export function assertValidVersion(version) {
  if (!version || !semverPattern.test(version)) {
    throw new Error(
      `Invalid version "${version}". Expected a semver value such as 0.2.0 or 0.2.0-beta.1.`,
    );
  }
  return version;
}

export function isPrereleaseVersion(version) {
  assertValidVersion(version);
  return version.includes('-');
}

export function assertVersionKind(version, kind) {
  const prerelease = isPrereleaseVersion(version);
  if (kind === 'stable' && prerelease) {
    throw new Error(`Expected a stable version, received prerelease version "${version}".`);
  }
  if (kind === 'prerelease' && !prerelease) {
    throw new Error(`Expected a prerelease version, received stable version "${version}".`);
  }
}

export async function readPackageJson(packageJsonPath) {
  return JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
}

export async function writePackageJson(packageJsonPath, contents) {
  await fs.writeFile(packageJsonPath, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
}

export async function readCliPackageJson() {
  return readPackageJson(cliPackageJsonPath);
}

export async function syncCliVersion(version) {
  assertValidVersion(version);

  const [rootPackageJson, cliPackageJson] = await Promise.all([
    readPackageJson(rootPackageJsonPath),
    readPackageJson(cliPackageJsonPath),
  ]);

  rootPackageJson.version = version;
  cliPackageJson.version = version;

  await Promise.all([
    writePackageJson(rootPackageJsonPath, rootPackageJson),
    writePackageJson(cliPackageJsonPath, cliPackageJson),
  ]);

  return version;
}

export async function syncRepoVersion(version) {
  return syncCliVersion(version);
}

export async function runCommand(command, args, options = {}) {
  const inheritedPnpmExecPath = process.env.npm_execpath?.trim();
  const useInheritedPnpm = command === 'pnpm'
    && process.env.npm_config_user_agent?.startsWith('pnpm/')
    && inheritedPnpmExecPath;
  const resolvedCommand = useInheritedPnpm ? process.execPath : command;
  const resolvedArgs = useInheritedPnpm
    ? [path.resolve(inheritedPnpmExecPath), ...args]
    : args;
  await new Promise((resolve, reject) => {
    const child = spawn(resolvedCommand, resolvedArgs, {
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: options.stdio ?? 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const reason =
        signal === null
          ? `exit code ${code ?? 'unknown'}`
          : `signal ${signal}`;
      reject(new Error(`Command failed: ${command} ${args.join(' ')} (${reason})`));
    });
  });
}

async function captureCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const reason =
        signal === null
          ? `exit code ${code ?? 'unknown'}`
          : `signal ${signal}`;
      const detail = stderr.trim() || stdout.trim();
      reject(
        new Error(
          detail
            ? `${detail}\nCommand failed: ${command} ${args.join(' ')} (${reason})`
            : `Command failed: ${command} ${args.join(' ')} (${reason})`,
        ),
      );
    });
  });
}

function normalizeGitStatusPath(statusLine) {
  if (!statusLine || statusLine.length < 4) {
    return null;
  }

  const rawPath = statusLine.slice(3).trim();
  if (!rawPath) {
    return null;
  }

  const renamedPath = rawPath.includes(' -> ')
    ? rawPath.split(' -> ').at(-1)
    : rawPath;

  return renamedPath ? renamedPath.replaceAll('\\', '/') : null;
}

export async function resolveCliPublishGitCheckArgs() {
  const allowedDirtyPaths = new Set([
    relativeToRepo(rootPackageJsonPath),
    relativeToRepo(cliPackageJsonPath),
  ]);
  const { stdout } = await captureCommand('git', [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  const dirtyPaths = stdout
    .split('\n')
    .map((line) => normalizeGitStatusPath(line))
    .filter((path) => Boolean(path));
  const unexpectedDirtyPaths = dirtyPaths.filter((path) => !allowedDirtyPaths.has(path));

  if (unexpectedDirtyPaths.length > 0) {
    const allowedPathsText = Array.from(allowedDirtyPaths).join(', ');
    const unexpectedChanges = unexpectedDirtyPaths.map((path) => `- ${path}`).join('\n');
    throw new Error(
      `Refusing to publish from a dirty working tree. Only ${allowedPathsText} may be modified by the version sync step.\nUnexpected changes:\n${unexpectedChanges}`,
    );
  }

  return dirtyPaths.length > 0 ? ['--no-git-checks'] : [];
}

export async function ensureDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
}

export async function cleanTarballs(directoryPath) {
  await ensureDirectory(directoryPath);
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
      .map((entry) => fs.rm(path.join(directoryPath, entry.name), { force: true })),
  );
}

export function combineReleaseErrors(primaryError, additionalError, context) {
  const primary = primaryError instanceof Error
    ? primaryError
    : new Error(String(primaryError));
  const additional = additionalError instanceof Error
    ? additionalError
    : new Error(String(additionalError));
  const errors = primary instanceof AggregateError
    ? [...primary.errors, additional]
    : [primary, additional];
  const cause = primary instanceof AggregateError && primary.cause
    ? primary.cause
    : primary;
  return new AggregateError(
    errors,
    `${cause.message}\n${context}: ${additional.message}`,
    { cause },
  );
}

async function withOwnedTemporaryDirectory(prefix, callback, cleanupContext) {
  const temporaryDirectory = await fs.mkdtemp(prefix);
  let callbackError = null;

  try {
    return await callback(temporaryDirectory);
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      await fs.rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    } catch (cleanupError) {
      if (callbackError) {
        throw combineReleaseErrors(callbackError, cleanupError, cleanupContext);
      }
      throw cleanupError;
    }
  }
}

export async function createCatalogReleaseStaging(options = {}) {
  const sourceRoot = options.sourceRoot;
  if (!sourceRoot) {
    throw new Error('Catalog release staging requires a build snapshot source root.');
  }
  await fs.access(sourceRoot).catch(() => {
    throw new Error(
      `Catalog release staging requires ${relativeToRepo(sourceRoot)}. Run \`pnpm build\` first.`,
    );
  });
  await ensureDirectory(catalogReleaseStagingRoot);
  const outputRoot = await fs.mkdtemp(path.join(catalogReleaseStagingRoot, 'catalog-'));
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    await fs.rm(outputRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
    cleaned = true;
  };

  try {
    await fs.cp(sourceRoot, outputRoot, { recursive: true });
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw combineReleaseErrors(
        error,
        cleanupError,
        'Catalog release staging cleanup also failed',
      );
    }
    throw error;
  }

  return {
    outputRoot,
    cleanup,
  };
}

export async function listTarballs(directoryPath = tarballDir) {
  await ensureDirectory(directoryPath);
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const tarballs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
      .map(async (entry) => {
        const fullPath = path.join(directoryPath, entry.name);
        const stats = await fs.stat(fullPath);
        return {
          fullPath,
          mtimeMs: stats.mtimeMs,
        };
      }),
  );

  tarballs.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return tarballs.map((entry) => entry.fullPath);
}

export async function findLatestTarball(directoryPath = tarballDir) {
  const tarballs = await listTarballs(directoryPath);
  if (tarballs.length === 0) {
    throw new Error(`No tarball found in ${relativeToRepo(directoryPath)}.`);
  }
  return tarballs[0];
}

export async function assertRepoAndCliPackageVersions() {
  const [rootPackageJson, cliPackageJson] = await Promise.all([
    readPackageJson(rootPackageJsonPath),
    readPackageJson(cliPackageJsonPath),
  ]);
  const rootVersion = assertValidVersion(rootPackageJson.version);
  const cliVersion = assertValidVersion(cliPackageJson.version);
  if (rootVersion !== cliVersion) {
    throw new Error(
      `Version mismatch: package.json version "${rootVersion}" must match packages/cli/package.json version "${cliVersion}".`,
    );
  }
  return {
    rootVersion,
    cliVersion,
  };
}

async function packCliFromSnapshot(snapshot, destination) {
  const targetDir = path.resolve(repoRoot, destination);
  await ensureDirectory(targetDir);

  return withOwnedTemporaryDirectory(
    path.join(os.tmpdir(), 'aw-cli-pack-'),
    async (packDirectory) => {
      await runCommand('pnpm', [
        '--config.ignore-scripts=true',
        'pack',
        '--pack-destination',
        packDirectory,
      ], {
        cwd: snapshot.cliPackageRoot,
      });

      const tarballs = await listTarballs(packDirectory);
      if (tarballs.length !== 1) {
        throw new Error(
          `Expected pnpm pack to produce exactly one tarball, found ${tarballs.length}.`,
        );
      }

      const sourcePath = tarballs[0];
      const fileName = path.basename(sourcePath);
      const targetPath = path.join(targetDir, fileName);
      return withOwnedTemporaryDirectory(
        path.join(targetDir, '.aw-cli-pack-'),
        async (publishDirectory) => {
          const stagedPath = path.join(publishDirectory, fileName);
          try {
            await fs.rename(sourcePath, stagedPath);
          } catch (error) {
            if (error?.code !== 'EXDEV') {
              throw error;
            }
            await fs.copyFile(sourcePath, stagedPath);
          }
          await fs.rename(stagedPath, targetPath);
          return targetPath;
        },
        'CLI tarball publish staging cleanup also failed',
      );
    },
    'CLI tarball pack staging cleanup also failed',
  );
}

export async function packCli({ destination = tarballDir, snapshot } = {}) {
  await assertRepoAndCliPackageVersions();
  if (snapshot) {
    return packCliFromSnapshot(snapshot, destination);
  }
  return withBuildSnapshot(repoRoot, (ownedSnapshot) =>
    packCliFromSnapshot(ownedSnapshot, destination)
  );
}

export function createReleaseBuildSnapshot(options = {}) {
  return createBuildSnapshot(repoRoot, options);
}

export function withReleaseBuildSnapshot(callback, options = {}) {
  return withBuildSnapshot(repoRoot, callback, options);
}

export async function loadCatalogModules(compiledCliDistRoot = cliDistRoot) {
  const resolvedCliDistRoot = path.resolve(compiledCliDistRoot);
  const cached = cachedCatalogModules.get(resolvedCliDistRoot);
  if (cached) {
    return cached;
  }

  const pluginStagingPath = path.join(resolvedCliDistRoot, 'scripts', 'plugin-staging.js');
  const bundleLayoutPath = path.join(resolvedCliDistRoot, 'src', 'utils', 'bundle-layout.js');
  const manifestPath = path.join(resolvedCliDistRoot, 'src', 'utils', 'manifest.js');
  const marketplacePath = path.join(resolvedCliDistRoot, 'src', 'utils', 'marketplace.js');
  await Promise.all([
    fs.access(pluginStagingPath),
    fs.access(bundleLayoutPath),
    fs.access(manifestPath),
    fs.access(marketplacePath),
  ]).catch(() => {
    throw new Error('Catalog release helpers require compiled CLI artifacts. Run `pnpm build` first.');
  });

  const catalogModules = await Promise.all([
    import(pathToFileURL(pluginStagingPath).href),
    import(pathToFileURL(bundleLayoutPath).href),
    import(pathToFileURL(manifestPath).href),
    import(pathToFileURL(marketplacePath).href),
  ]).then(([pluginStaging, bundleLayout, manifest, marketplace]) => ({
    pluginStaging,
    bundleLayout,
    manifest,
    marketplace,
  }));

  cachedCatalogModules.set(resolvedCliDistRoot, catalogModules);
  return catalogModules;
}

async function resolveCatalogModules(catalogModules = null, compiledCliDistRoot = cliDistRoot) {
  return catalogModules ?? loadCatalogModules(compiledCliDistRoot);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeChannel(channel, version) {
  if (channel !== undefined && channel !== 'latest' && channel !== 'beta') {
    throw new Error(`Unsupported catalog channel "${channel}".`);
  }
  const derived = isPrereleaseVersion(version) ? 'beta' : 'latest';
  return channel ?? derived;
}

export function isMissingRegistryPackageError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('HTTP 404')
    || message.includes('missing dist-tag')
    || /Registry dist-tag .+ is missing for /.test(message)
  );
}

function isMissingRegistryPackageVersionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Registry version .+ is missing for /.test(message);
}

async function listFilesRecursively(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRecursively(entryPath);
      files.push(...nested.map((filePath) => path.join(entry.name, filePath).split(path.sep).join('/')));
      continue;
    }
    files.push(entry.name);
  }
  return files.sort();
}

async function comparePackageDirectories(expectedRoot, actualRoot) {
  const [expectedFiles, actualFiles] = await Promise.all([
    listFilesRecursively(expectedRoot),
    listFilesRecursively(actualRoot),
  ]);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    return {
      ok: false,
      reason: `File list mismatch.\nexpected=${expectedFiles.join(', ')}\nactual=${actualFiles.join(', ')}`,
    };
  }

  for (const relativePath of expectedFiles) {
    const [expectedBuffer, actualBuffer] = await Promise.all([
      fs.readFile(path.join(expectedRoot, relativePath)),
      fs.readFile(path.join(actualRoot, relativePath)),
    ]);
    if (!expectedBuffer.equals(actualBuffer)) {
      return {
        ok: false,
        reason: `File content mismatch at ${relativePath}.`,
      };
    }
  }

  return {
    ok: true,
  };
}

function packageNameForKind(kind) {
  if (kind === 'full') {
    return fullCatalogPackageName;
  }
  return sidecarCatalogPackageName;
}

function normalizeRegistryUrl(registryUrl) {
  const normalized = registryUrl.trim();
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export async function resolveRegistryUrl(
  packageJsonPath = cliPackageJsonPath,
  env = process.env,
) {
  const fromEnv = [
    env.AW_NPM_REGISTRY_URL,
    env.npm_config_registry,
    env.NPM_CONFIG_REGISTRY,
  ].find((value) => typeof value === 'string' && value.trim() !== '');
  if (fromEnv !== undefined) {
    return normalizeRegistryUrl(fromEnv);
  }

  const cliPackageJson = await readPackageJson(packageJsonPath);
  if (typeof cliPackageJson.publishConfig?.registry === 'string' && cliPackageJson.publishConfig.registry.trim() !== '') {
    return normalizeRegistryUrl(cliPackageJson.publishConfig.registry);
  }

  return 'https://registry.npmjs.org/';
}

function assertHistorySourceReady(result, channel, purpose) {
  if (!result || result.status === 'missing') {
    return null;
  }
  if (result.status !== 'ready' || !result.manifest) {
    const detail = result?.error ? ` ${result.error}` : '';
    throw new Error(`Unable to read ${purpose} ${channel} catalog history.${detail}`.trim());
  }
  return result.manifest;
}

function createHistoryPluginMap(releases) {
  const entries = new Map();
  for (const release of releases) {
    for (const plugin of release.plugins) {
      const key = `${plugin.name}@${plugin.version}`;
      const previous = entries.get(key);
      if (!previous) {
        entries.set(key, {
          artifactDigest: plugin.artifactDigest,
          manifestDigest: plugin.manifestDigest,
          minAwVersion: plugin.minAwVersion,
        });
        continue;
      }
      if (
        previous.artifactDigest !== plugin.artifactDigest ||
        previous.manifestDigest !== plugin.manifestDigest ||
        previous.minAwVersion !== plugin.minAwVersion
      ) {
        throw new Error(`Published plugin identity drift detected for ${key}.`);
      }
    }
  }
  return entries;
}

function assertBuildMetadataPriorityUniqueness(compareStrictSemVer, releases, currentEntries) {
  const byPlugin = new Map();
  const seen = [];
  for (const release of releases) {
    seen.push(...release.plugins);
  }
  seen.push(...currentEntries.map((entry) => ({
    name: entry.name,
    version: entry.version,
  })));

  for (const plugin of seen) {
    const versions = byPlugin.get(plugin.name) ?? [];
    for (const existingVersion of versions) {
      if (
        existingVersion !== plugin.version &&
        compareStrictSemVer(existingVersion, plugin.version) === 0
      ) {
        throw new Error(
          `Plugin "${plugin.name}" cannot reuse SemVer precedence with build metadata variants (${existingVersion} vs ${plugin.version}).`,
        );
      }
    }
    versions.push(plugin.version);
    byPlugin.set(plugin.name, versions);
  }
}

function findHighestVersion(compareStrictSemVer, releases, pluginName) {
  let highest = null;
  for (const release of releases) {
    for (const plugin of release.plugins) {
      if (plugin.name !== pluginName) {
        continue;
      }
      if (!highest || compareStrictSemVer(plugin.version, highest) > 0) {
        highest = plugin.version;
      }
    }
  }
  return highest;
}

export async function readCatalogStage(options = {}) {
  const outputRoot = options.outputRoot ?? defaultCatalogOutputRoot;
  const { pluginStaging, bundleLayout } = await resolveCatalogModules(
    options.catalogModules,
    options.cliDistRoot,
  );
  await bundleLayout.validateBundleLayout(outputRoot);
  return {
    outputRoot,
    manifest: await pluginStaging.readStagedCatalogManifest(outputRoot),
    sidecarPackageRoot: pluginStaging.getCatalogSidecarPackageRoot(outputRoot),
    fullPackageRoot: pluginStaging.getCatalogFullPackageRoot(outputRoot),
    canonicalManifestPath: pluginStaging.getCanonicalCatalogManifestPath(outputRoot),
  };
}

export async function validateCatalogReleaseCandidate(options = {}) {
  const {
    stagedManifest,
    targetChannel,
    targetHistoryManifest = null,
    officialHistoryManifests = {},
  } = options;
  const { manifest } = await resolveCatalogModules(options.catalogModules, options.cliDistRoot);
  const { validateCatalogManifest, compareStrictSemVer } = manifest;
  const candidateManifest = validateCatalogManifest(deepClone(stagedManifest));
  const channel = normalizeChannel(
    targetChannel,
    candidateManifest.catalogVersion,
  );
  if (candidateManifest.channel !== channel) {
    throw new Error(
      `Catalog staging channel mismatch: staged manifest is "${candidateManifest.channel}" but target channel is "${channel}".`,
    );
  }

  const targetHistory = targetHistoryManifest
    ? validateCatalogManifest(deepClone(targetHistoryManifest))
    : null;
  if (targetHistory && targetHistory.channel !== channel) {
    throw new Error(`Target history channel mismatch: expected "${channel}", received "${targetHistory.channel}".`);
  }

  const globalHistoryManifests = [];
  for (const source of [officialHistoryManifests.latest, officialHistoryManifests.beta]) {
    if (!source) {
      continue;
    }
    globalHistoryManifests.push(validateCatalogManifest(deepClone(source)));
  }

  const currentRelease = candidateManifest.history.releases[candidateManifest.history.releases.length - 1];
  if (!currentRelease) {
    throw new Error('Catalog staging manifest is missing the current release entry.');
  }
  const requiredCatalogMinVersion = candidateManifest.entries.reduce((highest, entry) => {
    if (!highest) {
      return entry.compatibility.aw.minVersion;
    }
    return compareStrictSemVer(entry.compatibility.aw.minVersion, highest) > 0
      ? entry.compatibility.aw.minVersion
      : highest;
  }, null);
  if (
    requiredCatalogMinVersion &&
    compareStrictSemVer(candidateManifest.compatibility.aw.minVersion, requiredCatalogMinVersion) < 0
  ) {
    throw new Error(
      `Catalog minAwVersion ${candidateManifest.compatibility.aw.minVersion} does not cover current snapshot requirement ${requiredCatalogMinVersion}.`,
    );
  }

  for (const historyManifest of globalHistoryManifests) {
    if (historyManifest.channel !== channel) {
      const conflict = historyManifest.history.releases.find(
        (release) => release.catalogVersion === candidateManifest.catalogVersion,
      );
      if (conflict) {
        throw new Error(
          `Catalog version ${candidateManifest.catalogVersion} cannot be reused across channels (${channel} vs ${historyManifest.channel}).`,
        );
      }
    }
  }

  const globalReleases = globalHistoryManifests.flatMap((entry) => entry.history.releases);
  const publishedPluginIdentities = createHistoryPluginMap(globalReleases);
  assertBuildMetadataPriorityUniqueness(
    compareStrictSemVer,
    globalReleases,
    candidateManifest.entries,
  );

  for (const entry of candidateManifest.entries) {
    const exactKey = `${entry.name}@${entry.version}`;
    const publishedIdentity = publishedPluginIdentities.get(exactKey);
    if (
      publishedIdentity &&
      (
        publishedIdentity.artifactDigest !== entry.artifactDigest ||
        publishedIdentity.manifestDigest !== entry.manifestDigest ||
        publishedIdentity.minAwVersion !== entry.compatibility.aw.minVersion
      )
    ) {
      throw new Error(`Published plugin "${exactKey}" is immutable; digest or minAwVersion changed.`);
    }
  }

  const targetReleases = targetHistory?.history.releases ?? [];
  const targetLatest = targetReleases[targetReleases.length - 1] ?? null;
  let nextReleases;
  if (!targetLatest) {
    nextReleases = [currentRelease];
  } else {
    const catalogComparison = compareStrictSemVer(
      candidateManifest.catalogVersion,
      targetLatest.catalogVersion,
    );
    if (catalogComparison < 0) {
      throw new Error(
        `Catalog version ${candidateManifest.catalogVersion} must be higher than existing ${targetLatest.catalogVersion} on ${channel}.`,
      );
    }
    if (catalogComparison === 0) {
      const targetReleaseJson = JSON.stringify(targetLatest);
      const currentReleaseJson = JSON.stringify(currentRelease);
      if (targetReleaseJson !== currentReleaseJson) {
        throw new Error(
          `Catalog version ${candidateManifest.catalogVersion} already exists on ${channel} with different contents.`,
        );
      }
      nextReleases = targetReleases;
    } else {
      nextReleases = [...targetReleases, currentRelease];
    }
  }

  for (const entry of candidateManifest.entries) {
    const exactTargetRelease = targetReleases
      .flatMap((release) => release.plugins)
      .find((plugin) => plugin.name === entry.name && plugin.version === entry.version);
    if (
      exactTargetRelease &&
      exactTargetRelease.artifactDigest === entry.artifactDigest &&
      exactTargetRelease.manifestDigest === entry.manifestDigest &&
      exactTargetRelease.minAwVersion === entry.compatibility.aw.minVersion
    ) {
      continue;
    }

    const highestTargetVersion = findHighestVersion(
      compareStrictSemVer,
      targetReleases,
      entry.name,
    );
    if (highestTargetVersion && compareStrictSemVer(entry.version, highestTargetVersion) <= 0) {
      throw new Error(
        `Plugin "${entry.name}" changed artifact identity but version ${entry.version} is not higher than ${highestTargetVersion} on ${channel}.`,
      );
    }
  }

  return {
    channel,
    currentRelease,
    nextHistory: {
      schemaVersion: 1,
      channel,
      releases: nextReleases,
    },
  };
}

export async function prepareCatalogRelease(options = {}) {
  const {
    outputRoot = defaultCatalogOutputRoot,
    catalogVersion,
    channel,
    targetHistoryManifest = null,
    officialHistoryManifests = {},
  } = options;
  const sourceRepoRoot = options.sourceRepoRoot ?? repoRoot;
  const [{ pluginStaging, bundleLayout }, stagedCandidate] = await Promise.all([
    resolveCatalogModules(options.catalogModules, options.cliDistRoot),
    resolveCatalogModules(options.catalogModules, options.cliDistRoot).then(({ pluginStaging }) =>
      pluginStaging.stageCatalogArtifacts({
        repoRoot: sourceRepoRoot,
        outputRoot,
        ...(catalogVersion ? { catalogVersion } : {}),
        ...(channel ? { channel } : {}),
      })),
  ]);
  const validation = await validateCatalogReleaseCandidate({
    stagedManifest: stagedCandidate.manifest,
    targetChannel: channel,
    targetHistoryManifest,
    officialHistoryManifests,
    catalogModules: options.catalogModules,
    cliDistRoot: options.cliDistRoot,
  });

  const staged = await pluginStaging.stageCatalogArtifacts({
    repoRoot: sourceRepoRoot,
    outputRoot,
    catalogVersion: stagedCandidate.manifest.catalogVersion,
    channel: validation.channel,
    history: validation.nextHistory,
  });
  await bundleLayout.validateBundleLayout(outputRoot);
  return staged;
}

export async function packCatalogPackage(options = {}) {
  const {
    kind,
    outputRoot = defaultCatalogOutputRoot,
    destination = tarballDir,
  } = options;
  if (kind !== 'sidecar' && kind !== 'full') {
    throw new Error('Catalog package kind must be "sidecar" or "full".');
  }

  const { pluginStaging } = await resolveCatalogModules(
    options.catalogModules,
    options.cliDistRoot,
  );
  const packageRoot = kind === 'sidecar'
    ? pluginStaging.getCatalogSidecarPackageRoot(outputRoot)
    : pluginStaging.getCatalogFullPackageRoot(outputRoot);
  const targetDir = path.resolve(repoRoot, destination);
  await ensureDirectory(targetDir);
  await runCommand('pnpm', ['pack', '--pack-destination', targetDir], {
    cwd: packageRoot,
  });
  return findLatestTarball(targetDir);
}

export async function createCatalogRegistryAdapter(options = {}) {
  const registryUrl = options.registryUrl === undefined || options.registryUrl === null
    ? await resolveRegistryUrl(options.cliPackageJsonPath)
    : normalizeRegistryUrl(options.registryUrl);
  const registryEnv = {
    ...process.env,
    AW_NPM_REGISTRY_URL: registryUrl,
    npm_config_registry: registryUrl,
    NPM_CONFIG_REGISTRY: registryUrl,
  };
  const marketplace = options.marketplace
    ?? (await loadCatalogModules(options.cliDistRoot)).marketplace;
  const commandRunner = options.runCommand ?? runCommand;

  return {
    registryUrl,
    async readChannelManifest(channel) {
      try {
        const archive = await marketplace.resolveCatalogPackageByDistTag(
          sidecarCatalogPackageName,
          channel,
          registryEnv,
        );
        try {
          return {
            status: 'ready',
            manifest: archive.rawManifest,
          };
        } finally {
          await archive.dispose();
        }
      } catch (error) {
        if (isMissingRegistryPackageError(error)) {
          return {
            status: 'missing',
          };
        }
        return {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async verifyExistingPackage(kind, context) {
      const packageName = packageNameForKind(kind);
      try {
        const identity = await marketplace.resolveCatalogPackageIdentityByVersion(
          packageName,
          context.version,
          registryEnv,
        );
        const archive = await marketplace.downloadCatalogPackageArchive(identity, registryEnv);
        try {
          const comparison = await comparePackageDirectories(context.packageRoot, archive.packageRoot);
          return comparison.ok
            ? { exists: true, verified: true }
            : { exists: true, verified: false, reason: comparison.reason };
        } finally {
          await archive.dispose();
        }
      } catch (error) {
        if (isMissingRegistryPackageError(error) || isMissingRegistryPackageVersionError(error)) {
          return { exists: false, verified: false };
        }
        throw error;
      }
    },
    async publishPackage(_kind, context) {
      await commandRunner('pnpm', [
        'publish',
        '--tag',
        context.channel,
        '--registry',
        registryUrl,
      ], {
        cwd: context.packageRoot,
        env: registryEnv,
      });
    },
    async ensureDistTag(kind, context) {
      await commandRunner('npm', [
        'dist-tag',
        'add',
        `${packageNameForKind(kind)}@${context.version}`,
        context.channel,
        '--registry',
        registryUrl,
      ], {
        env: registryEnv,
      });
    },
  };
}

async function resolveChannelHistoryManifests(options) {
  const requestedChannel = options.channel;
  const registry = options.registry ?? {};
  const providedOfficial = options.officialHistoryManifests ?? {};
  const providedTarget = options.targetHistoryManifest;

  const readChannelManifest = registry.readChannelManifest;
  const latestResult = providedOfficial.latest !== undefined
    ? { status: providedOfficial.latest ? 'ready' : 'missing', manifest: providedOfficial.latest }
    : await readChannelManifest?.('latest');
  const betaResult = providedOfficial.beta !== undefined
    ? { status: providedOfficial.beta ? 'ready' : 'missing', manifest: providedOfficial.beta }
    : await readChannelManifest?.('beta');

  const officialHistoryManifests = {
    latest: assertHistorySourceReady(latestResult, 'latest', 'official'),
    beta: assertHistorySourceReady(betaResult, 'beta', 'official'),
  };

  if (providedTarget !== undefined) {
    return {
      targetHistoryManifest: providedTarget,
      officialHistoryManifests,
    };
  }

  if (typeof readChannelManifest !== 'function') {
    return {
      targetHistoryManifest: officialHistoryManifests[requestedChannel] ?? null,
      officialHistoryManifests,
    };
  }

  const targetResult = requestedChannel === 'latest' ? latestResult : betaResult;
  return {
    targetHistoryManifest: assertHistorySourceReady(
      targetResult,
      requestedChannel,
      'target',
    ),
    officialHistoryManifests,
  };
}

async function verifyOrPublishCatalogPackage(kind, publishContext) {
  const registry = publishContext.registry ?? {};
  const verifyExistingPackage = registry.verifyExistingPackage;
  const publishPackage = registry.publishPackage;
  const packageRoot = kind === 'full'
    ? publishContext.fullPackageRoot
    : publishContext.sidecarPackageRoot;

  const verified = typeof verifyExistingPackage === 'function'
    ? await verifyExistingPackage(kind, {
      packageRoot,
      channel: publishContext.channel,
      version: publishContext.manifest.catalogVersion,
      manifest: publishContext.manifest,
    })
    : { exists: false };
  if (!verified || typeof verified !== 'object') {
    throw new Error(`Registry verifyExistingPackage returned an invalid result for ${kind}.`);
  }
  if (verified.exists) {
    if (!verified.verified) {
      const detail = verified.reason ? ` ${verified.reason}` : '';
      throw new Error(`Existing ${kind} catalog package does not match staged contents.${detail}`.trim());
    }
  } else {
    if (typeof publishPackage !== 'function') {
      throw new Error(`Missing registry publishPackage handler for ${kind}.`);
    }
    await publishPackage(kind, {
      packageRoot,
      channel: publishContext.channel,
      version: publishContext.manifest.catalogVersion,
      manifest: publishContext.manifest,
    });
  }

}

async function ensureCatalogPackageDistTag(kind, publishContext) {
  const registry = publishContext.registry ?? {};
  if (typeof registry.ensureDistTag !== 'function') {
    return;
  }

  await registry.ensureDistTag(kind, {
    channel: publishContext.channel,
    version: publishContext.manifest.catalogVersion,
  });
}

async function stageCatalogReleasePreflight(options = {}) {
  const snapshot = options.snapshot;
  if (!snapshot) {
    throw new Error('Catalog release preflight requires a build snapshot.');
  }
  const catalogModules = options.catalogModules
    ?? await loadCatalogModules(snapshot.cliDistRoot);
  const registry = options.registry ?? await createCatalogRegistryAdapter({
    cliDistRoot: snapshot.cliDistRoot,
    cliPackageJsonPath: path.join(snapshot.cliPackageRoot, 'package.json'),
    marketplace: catalogModules.marketplace,
  });
  await assertRepoAndCliPackageVersions();
  const releaseStaging = await createCatalogReleaseStaging({
    sourceRoot: snapshot.catalogOutputRoot,
  });
  const outputRoot = releaseStaging.outputRoot;
  try {
    const stagedCatalogVersion = options.catalogVersion
      ?? (await readCatalogStage({
        outputRoot,
        catalogModules,
        cliDistRoot: snapshot.cliDistRoot,
      })).manifest.catalogVersion;
    const channel = normalizeChannel(options.channel, stagedCatalogVersion);
    assertVersionKind(stagedCatalogVersion, channel === 'beta' ? 'prerelease' : 'stable');
    const historyInputs = await resolveChannelHistoryManifests({
      channel,
      registry,
      targetHistoryManifest: options.targetHistoryManifest,
      officialHistoryManifests: options.officialHistoryManifests,
    });
    const staged = await prepareCatalogRelease({
      outputRoot,
      catalogVersion: stagedCatalogVersion,
      channel,
      targetHistoryManifest: historyInputs.targetHistoryManifest,
      officialHistoryManifests: historyInputs.officialHistoryManifests,
      catalogModules,
      cliDistRoot: snapshot.cliDistRoot,
      sourceRepoRoot: snapshot.root,
    });

    return {
      channel,
      registry,
      snapshot,
      staged,
      cleanup: releaseStaging.cleanup,
    };
  } catch (error) {
    try {
      await releaseStaging.cleanup();
    } catch (cleanupError) {
      throw combineReleaseErrors(
        error,
        cleanupError,
        'Catalog release preflight cleanup also failed',
      );
    }
    throw error;
  }
}

function createCatalogReleaseMetadata(preflight) {
  const catalogVersion = preflight.staged.manifest.catalogVersion;
  return {
    channel: preflight.channel,
    catalogVersion,
    generationId: preflight.snapshot.generationId,
    outputDigest: preflight.snapshot.outputDigest,
    manifest: preflight.staged.manifest,
    packages: {
      sidecar: {
        name: sidecarCatalogPackageName,
        version: catalogVersion,
      },
      full: {
        name: fullCatalogPackageName,
        version: catalogVersion,
      },
    },
    staged: {
      manifest: preflight.staged.manifest,
    },
  };
}

async function preflightCatalogReleaseFromSnapshot(options, snapshot) {
  const preflight = await stageCatalogReleasePreflight({ ...options, snapshot });
  await preflight.cleanup();
  return {
    ...createCatalogReleaseMetadata(preflight),
    registry: preflight.registry,
  };
}

export async function preflightCatalogRelease(options = {}) {
  if (options.snapshot) {
    return preflightCatalogReleaseFromSnapshot(options, options.snapshot);
  }
  return withBuildSnapshot(
    repoRoot,
    (snapshot) => preflightCatalogReleaseFromSnapshot(options, snapshot),
    options.snapshotOptions,
  );
}

async function publishCatalogReleaseFromSnapshot(options, snapshot) {
  const preflight = await stageCatalogReleasePreflight({ ...options, snapshot });

  const publishContext = {
    channel: preflight.channel,
    manifest: preflight.staged.manifest,
    sidecarPackageRoot: preflight.staged.sidecarPackageRoot,
    fullPackageRoot: preflight.staged.fullPackageRoot,
    registry: preflight.registry,
  };

  let result;
  let publishError;
  try {
    try {
      await verifyOrPublishCatalogPackage('full', publishContext);
      await ensureCatalogPackageDistTag('full', publishContext);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Catalog full package phase failed: ${detail}`);
    }

    try {
      await verifyOrPublishCatalogPackage('sidecar', publishContext);
      await ensureCatalogPackageDistTag('sidecar', publishContext);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Catalog sidecar package phase failed: ${detail}`);
    }

    result = createCatalogReleaseMetadata(preflight);
  } catch (error) {
    publishError = error;
  }

  try {
    await preflight.cleanup();
  } catch (cleanupError) {
    if (publishError) {
      throw combineReleaseErrors(
        publishError,
        cleanupError,
        'Catalog publish staging cleanup also failed',
      );
    }
    throw cleanupError;
  }

  if (publishError) {
    throw publishError;
  }
  return result;
}

export async function publishCatalogRelease(options = {}) {
  if (options.snapshot) {
    return publishCatalogReleaseFromSnapshot(options, options.snapshot);
  }
  return withBuildSnapshot(
    repoRoot,
    (snapshot) => publishCatalogReleaseFromSnapshot(options, snapshot),
    options.snapshotOptions,
  );
}
