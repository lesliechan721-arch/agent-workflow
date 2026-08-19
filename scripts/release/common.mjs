import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withBuildSnapshot } from '../build/build-cache.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const repoRoot = path.resolve(scriptDir, '..', '..');
export const releaseRoot = path.join(repoRoot, '.release');
export const tarballDir = path.join(releaseRoot, 'tarballs');
export const rootPackageJsonPath = path.join(repoRoot, 'package.json');
export const cliPackageJsonPath = path.join(repoRoot, 'packages', 'cli', 'package.json');
export const cliPackageRoot = path.join(repoRoot, 'packages', 'cli');
export const cliDistRoot = path.join(cliPackageRoot, 'dist');
export const catalogReleaseStagingRoot = path.join(releaseRoot, 'catalog-staging');

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

async function lstatCatalogPublicationPath(fileSystem, targetPath) {
  try {
    return await fileSystem.lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function assertRegularCatalogPublicationDirectory(stats, fieldName) {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${fieldName} must be a regular directory.`);
  }
}

export async function ensureCatalogStagePublicationBoundary(
  resolvedRepoRoot = repoRoot,
  fileSystem = fs,
) {
  const publicationRepoRoot = path.resolve(resolvedRepoRoot);
  const publicationParentRoot = path.join(
    publicationRepoRoot,
    '.release',
    'catalog-staging',
  );
  const publicationTargetRoot = path.join(publicationParentRoot, 'catalog');
  const rootStats = await lstatCatalogPublicationPath(fileSystem, publicationRepoRoot);
  if (!rootStats) {
    throw new Error('Catalog staging repository root does not exist.');
  }
  assertRegularCatalogPublicationDirectory(
    rootStats,
    'Catalog staging repository root',
  );

  let currentPath = publicationRepoRoot;
  for (const segment of ['.release', 'catalog-staging']) {
    currentPath = path.join(currentPath, segment);
    let stats = await lstatCatalogPublicationPath(fileSystem, currentPath);
    if (!stats) {
      try {
        await fileSystem.mkdir(currentPath);
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }
      }
      stats = await lstatCatalogPublicationPath(fileSystem, currentPath);
      if (!stats) {
        throw new Error('Catalog staging publication parent was not created.');
      }
    }
    assertRegularCatalogPublicationDirectory(
      stats,
      'Catalog staging publication path',
    );
  }

  const [canonicalRepoRoot, canonicalParentRoot] = await Promise.all([
    fileSystem.realpath(publicationRepoRoot),
    fileSystem.realpath(publicationParentRoot),
  ]);
  if (
    canonicalParentRoot
    !== path.join(canonicalRepoRoot, '.release', 'catalog-staging')
  ) {
    throw new Error('Catalog staging publication parent escapes the repository boundary.');
  }

  const targetStats = await lstatCatalogPublicationPath(
    fileSystem,
    publicationTargetRoot,
  );
  if (targetStats) {
    assertRegularCatalogPublicationDirectory(
      targetStats,
      'Catalog staging publication target',
    );
    const canonicalTargetRoot = await fileSystem.realpath(publicationTargetRoot);
    if (canonicalTargetRoot !== path.join(canonicalParentRoot, 'catalog')) {
      throw new Error('Catalog staging publication target escapes the repository boundary.');
    }
  }

  return {
    publicationParentRoot,
    publicationTargetRoot,
    targetExists: Boolean(targetStats),
  };
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
  const catalogSnapshotPath = path.join(resolvedCliDistRoot, 'src', 'utils', 'catalog-snapshot.js');
  await Promise.all([
    fs.access(pluginStagingPath),
    fs.access(catalogSnapshotPath),
  ]).catch(() => {
    throw new Error('Catalog release helpers require compiled CLI artifacts. Run `pnpm build` first.');
  });

  const catalogModules = await Promise.all([
    import(pathToFileURL(pluginStagingPath).href),
    import(pathToFileURL(catalogSnapshotPath).href),
  ]).then(([pluginStaging, catalogSnapshot]) => ({
    pluginStaging,
    catalogSnapshot,
  }));

  cachedCatalogModules.set(resolvedCliDistRoot, catalogModules);
  return catalogModules;
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
