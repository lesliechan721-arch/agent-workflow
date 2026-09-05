import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzip } from 'node:zlib';

import {
  assertBuildInputPathSafety,
  buildCacheContract,
  computeBuildInputDigest,
  computeCliPackageDigest,
  withBuildSnapshot,
} from '../build/build-cache.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const RELEASE_NETWORK_TIMEOUT_MS = 2 * 60 * 1000;
const gunzipAsync = promisify(gunzip);
const MAX_PACKAGE_TREE_BYTES = 128 * 1024 * 1024;
const CLI_PACKAGE_NAME = '@lesliechan721/aw';
const EVAL_PACKAGE_NAME = '@lesliechan721/agent-skill-eval';
const CORE_PACKAGE_NAME = '@lesliechan721/aw-plugin-core';
const WINDOWS_X64_PACKAGE_NAME = '@lesliechan721/aw-windows-job-win32-x64';
const WINDOWS_ARM64_PACKAGE_NAME = '@lesliechan721/aw-windows-job-win32-arm64';
const RELEASE_VERSION_SENTINEL = '0.0.0';

export const repoRoot = path.resolve(scriptDir, '..', '..');
export const releaseRoot = path.join(repoRoot, '.release');
export const tarballDir = path.join(releaseRoot, 'tarballs');
export const evalPackageJsonPath = path.join(repoRoot, 'packages', 'agent-skill-eval', 'package.json');
export const evalPackageRoot = path.join(repoRoot, 'packages', 'agent-skill-eval');
export const windowsX64PackageJsonPath = path.join(repoRoot, 'packages', 'aw-windows-job-win32-x64', 'package.json');
export const windowsX64PackageRoot = path.join(repoRoot, 'packages', 'aw-windows-job-win32-x64');
export const windowsArm64PackageJsonPath = path.join(repoRoot, 'packages', 'aw-windows-job-win32-arm64', 'package.json');
export const windowsArm64PackageRoot = path.join(repoRoot, 'packages', 'aw-windows-job-win32-arm64');
export const corePackageJsonPath = path.join(repoRoot, 'packages', 'plugin-core', 'package.json');
export const corePackageRoot = path.join(repoRoot, 'packages', 'plugin-core');
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
  return version.split('+', 1)[0].includes('-');
}

function parseReleaseSemVer(version) {
  assertValidVersion(version);
  const match = semverPattern.exec(version);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function compareReleaseSemVer(left, right) {
  const parsedLeft = parseReleaseSemVer(left);
  const parsedRight = parseReleaseSemVer(right);
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft.core[index] !== parsedRight.core[index]) {
      return parsedLeft.core[index] < parsedRight.core[index] ? -1 : 1;
    }
  }
  if (parsedLeft.prerelease.length === 0 || parsedRight.prerelease.length === 0) {
    if (parsedLeft.prerelease.length === parsedRight.prerelease.length) return 0;
    return parsedLeft.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === rightIdentifier) continue;
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      if (leftIdentifier.length !== rightIdentifier.length) {
        return leftIdentifier.length < rightIdentifier.length ? -1 : 1;
      }
      return leftIdentifier < rightIdentifier ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function resolveCliPublicationGate({
  mode,
  candidateVersion,
  publishedVersion,
  compare = compareReleaseSemVer,
}) {
  assertVersionKind(candidateVersion, mode === 'beta' ? 'prerelease' : 'stable');
  assertVersionKind(publishedVersion, mode === 'beta' ? 'prerelease' : 'stable');
  const relation = compare(candidateVersion, publishedVersion);
  if (relation < 0) {
    throw new Error(
      `CLI candidate ${candidateVersion} must be higher than the published ${mode} CLI ${publishedVersion}.`,
    );
  }
  if (relation === 0 && candidateVersion !== publishedVersion) {
    throw new Error(
      `CLI candidate ${candidateVersion} has the same SemVer precedence but a different version string ` +
      `from the published ${mode} CLI ${publishedVersion}.`,
    );
  }
  return relation === 0
    ? { status: 'already-published', version: candidateVersion }
    : { status: 'publish', version: candidateVersion };
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

export async function runCommand(command, args, options = {}) {
  const inheritedPnpmExecPath = process.env.npm_execpath?.trim();
  const useInheritedPnpm = command === 'pnpm'
    && process.env.npm_config_user_agent?.startsWith('pnpm/')
    && inheritedPnpmExecPath;
  const resolvedCommand = useInheritedPnpm ? process.execPath : command;
  const resolvedArgs = useInheritedPnpm
    ? [path.resolve(inheritedPnpmExecPath), ...args]
    : args;
  const invocation = formatCommandInvocation(command, args);
  await new Promise((resolve, reject) => {
    const child = spawn(resolvedCommand, resolvedArgs, {
      cwd: options.cwd ?? repoRoot,
      env: options.replaceEnv
        ? (options.env ?? {})
        : {
            ...process.env,
            ...(options.env ?? {}),
          },
      stdio: options.stdio ?? ['inherit', 'inherit', 'pipe'],
      ...(options.timeoutMs
        ? { signal: AbortSignal.timeout(options.timeoutMs) }
        : {}),
    });

    if (options.stdio === undefined) forwardRedactedStderr(child);

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
      reject(new Error(`Command failed: ${invocation} (${reason})`));
    });
  });
}

export async function captureCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.replaceEnv
        ? options.env
        : {
          ...process.env,
          ...(options.env ?? {}),
        },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.timeoutMs
        ? { signal: AbortSignal.timeout(options.timeoutMs) }
        : {}),
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
      const detail = redactReleaseDiagnostic(stderr.trim() || stdout.trim());
      const invocation = formatCommandInvocation(command, args);
      reject(
        new Error(
          detail
            ? `${detail}\nCommand failed: ${invocation} (${reason})`
            : `Command failed: ${invocation} (${reason})`,
        ),
      );
    });
  });
}

const URL_USERINFO_PATTERN = /([a-z][a-z\d+.-]*:\/\/)[^/\s?#]*@/giu;

function redactReleaseDiagnostic(value) {
  return String(value).replace(
    URL_USERINFO_PATTERN,
    '$1<redacted>@',
  );
}

function formatCommandInvocation(command, args) {
  return [command, ...args].map((value) => redactReleaseDiagnostic(value)).join(' ');
}

function forwardRedactedStderr(child) {
  if (!child.stderr) return;

  let pending = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    pending += chunk;
    const boundary = pending.lastIndexOf('\n');
    if (boundary < 0) return;
    process.stderr.write(redactReleaseDiagnostic(pending.slice(0, boundary + 1)));
    pending = pending.slice(boundary + 1);
  });
  child.stderr.on('end', () => {
    if (pending) process.stderr.write(redactReleaseDiagnostic(pending));
    pending = '';
  });
}

function releaseGitEnvironment(env = process.env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (
      key === 'GIT_DIR'
      || key === 'GIT_COMMON_DIR'
      || key === 'GIT_WORK_TREE'
      || key === 'GIT_INDEX_FILE'
      || key === 'GIT_OBJECT_DIRECTORY'
      || key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
      || key === 'GIT_NAMESPACE'
      || key === 'GIT_CONFIG'
      || key === 'GIT_CONFIG_GLOBAL'
      || key === 'GIT_CONFIG_SYSTEM'
      || key === 'GIT_CONFIG_NOSYSTEM'
      || key === 'GIT_CONFIG_COUNT'
      || key === 'GIT_CONFIG_PARAMETERS'
      || key === 'GIT_CEILING_DIRECTORIES'
      || key === 'GIT_DISCOVERY_ACROSS_FILESYSTEM'
      || key === 'GIT_PREFIX'
      || key === 'GIT_SHALLOW_FILE'
      || key === 'GIT_GRAFT_FILE'
      || key === 'GIT_REPLACE_REF_BASE'
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
    ) delete next[key];
  }
  return next;
}

export async function runReleaseGit(args, options = {}) {
  const requestedRoot = path.resolve(options.cwd ?? repoRoot);
  const expectedRoot = await fs.realpath(requestedRoot);
  const capture = options.captureCommand ?? captureCommand;
  const env = releaseGitEnvironment(options.env ?? process.env);
  const invoke = (gitArgs) => capture('git', gitArgs, {
    cwd: expectedRoot,
    env,
    replaceEnv: true,
  });
  const { stdout: topLevelOutput } = await invoke(['rev-parse', '--show-toplevel']);
  let actualRoot;
  try {
    actualRoot = await fs.realpath(topLevelOutput.trim());
  } catch (error) {
    throw new Error('Release Git did not resolve a valid worktree root.', { cause: error });
  }
  if (actualRoot !== expectedRoot) {
    throw new Error(
      `Release Git worktree mismatch: expected ${expectedRoot}, found ${actualRoot}.`,
    );
  }
  return invoke(args);
}

export async function resolvePublishedCliVersion(mode, options = {}) {
  if (mode !== 'beta' && mode !== 'latest') {
    throw new Error('Published CLI lookup mode must be "beta" or "latest".');
  }
  const packageJsonPath = options.packageJsonPath ?? cliPackageJsonPath;
  const registryUrl = await resolveRegistryUrl(packageJsonPath, options.env ?? process.env);
  const capture = options.captureCommand ?? captureCommand;
  const { stdout } = await capture('pnpm', [
    'view',
    '@lesliechan721/aw',
    `dist-tags.${mode}`,
    '--json',
    '--registry',
    registryUrl,
  ], {
    timeoutMs: options.timeoutMs ?? RELEASE_NETWORK_TIMEOUT_MS,
    env: {
      ...(options.env ?? process.env),
      AW_RELEASE_NPM_REGISTRY_URL: registryUrl,
      npm_config_registry: registryUrl,
      NPM_CONFIG_REGISTRY: registryUrl,
    },
  });
  let version;
  try {
    version = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Registry returned invalid JSON for the published ${mode} CLI version.`, {
      cause: error,
    });
  }
  if (typeof version !== 'string') {
    throw new Error(`Registry did not return a published ${mode} CLI version.`);
  }
  assertValidVersion(version);
  assertVersionKind(version, mode === 'beta' ? 'prerelease' : 'stable');
  return version;
}

export async function isExactPackageVersionPublished(
  packageName,
  version,
  packageJsonPath,
  options = {},
) {
  assertValidVersion(version);
  const registryUrl = await resolveRegistryUrl(packageJsonPath, options.env ?? process.env);
  const capture = options.captureCommand ?? captureCommand;
  try {
    const { stdout } = await capture('pnpm', [
      'view',
      `${packageName}@${version}`,
      'version',
      '--json',
      '--registry',
      registryUrl,
    ], {
      timeoutMs: options.timeoutMs ?? RELEASE_NETWORK_TIMEOUT_MS,
      env: {
        ...(options.env ?? process.env),
        AW_RELEASE_NPM_REGISTRY_URL: registryUrl,
        npm_config_registry: registryUrl,
        NPM_CONFIG_REGISTRY: registryUrl,
      },
    });
    return JSON.parse(stdout) === version;
  } catch (error) {
    if (/E404|404 Not Found|is not in this registry/iu.test(String(error?.message))) return false;
    throw error;
  }
}

function readTarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  return buffer.subarray(offset, end >= offset && end < offset + length ? end : offset + length)
    .toString('utf8');
}

function readTarOctal(buffer, offset, length, field) {
  const value = readTarString(buffer, offset, length).trim();
  if (!/^[0-7]*$/.test(value)) {
    throw new Error(`Package tarball has an unsupported ${field} value.`);
  }
  return value === '' ? 0 : Number.parseInt(value, 8);
}

function parsePaxFields(contents) {
  const fields = {};
  let offset = 0;
  while (offset < contents.length) {
    const separator = contents.indexOf(0x20, offset);
    if (separator < 0) throw new Error('Package tarball has malformed PAX metadata.');
    const length = Number(contents.subarray(offset, separator).toString('ascii'));
    if (!Number.isSafeInteger(length) || length <= separator - offset + 1 || offset + length > contents.length) {
      throw new Error('Package tarball has malformed PAX metadata.');
    }
    const record = contents.subarray(separator + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error('Package tarball has malformed PAX metadata.');
    fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return fields;
}

function normalizePackageTarPath(value) {
  const normalized = value.replace(/^\.\//u, '');
  if (!normalized.startsWith('package/')) {
    throw new Error('Package tarball contains an entry outside the package root.');
  }
  const relativePath = normalized.slice('package/'.length);
  if (
    relativePath === ''
    || relativePath.includes('\\')
    || path.posix.isAbsolute(relativePath)
    || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Package tarball contains an unsafe package path.');
  }
  return relativePath;
}

function updateDigestField(hash, value) {
  const contents = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(contents.length));
  hash.update(length);
  hash.update(contents);
}

export async function computePackageTarballTreeDigest(tarballPath, options = {}) {
  const compressed = await fs.readFile(tarballPath);
  const archive = await gunzipAsync(compressed, { maxOutputLength: MAX_PACKAGE_TREE_BYTES });
  const entries = new Map();
  let offset = 0;
  let localPax = {};
  let globalPax = {};
  let longPath;
  let longLink;
  let normalizedReleasePackage = false;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const size = readTarOctal(header, 124, 12, 'size');
    const paddedSize = Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || offset + paddedSize > archive.length) {
      throw new Error('Package tarball is truncated or too large.');
    }
    const contents = archive.subarray(offset, offset + size);
    offset += paddedSize;
    const type = String.fromCharCode(header[156] || 0x30);

    if (type === 'x' || type === 'g') {
      const fields = parsePaxFields(contents);
      if (type === 'x') localPax = fields;
      else globalPax = { ...globalPax, ...fields };
      continue;
    }
    if (type === 'L' || type === 'K') {
      const value = contents.toString('utf8').replace(/[\0\n]+$/u, '');
      if (type === 'L') longPath = value;
      else longLink = value;
      continue;
    }

    const prefix = readTarString(header, 345, 155);
    const headerPath = `${prefix ? `${prefix}/` : ''}${readTarString(header, 0, 100)}`;
    const fields = { ...globalPax, ...localPax };
    const entryPath = fields.path ?? longPath ?? headerPath;
    const linkPath = fields.linkpath ?? longLink ?? readTarString(header, 157, 100);
    localPax = {};
    longPath = undefined;
    longLink = undefined;

    if (type === '5') continue;
    if (type !== '0' && type !== '2') {
      throw new Error(`Package tarball contains unsupported entry type ${JSON.stringify(type)}.`);
    }
    const relativePath = normalizePackageTarPath(entryPath);
    if (entries.has(relativePath)) {
      throw new Error(`Package tarball contains duplicate path ${JSON.stringify(relativePath)}.`);
    }
    const mode = readTarOctal(header, 100, 8, 'mode') & 0o777;
    let normalizedContents = type === '2' ? Buffer.from(linkPath) : Buffer.from(contents);
    if (relativePath === 'package.json' && options.normalizeReleaseMetadata) {
      let packageJson;
      try {
        packageJson = JSON.parse(normalizedContents.toString('utf8'));
      } catch (error) {
        throw new Error('Package tarball package.json is invalid JSON.', { cause: error });
      }
      if (![CLI_PACKAGE_NAME, EVAL_PACKAGE_NAME, CORE_PACKAGE_NAME].includes(packageJson.name)) {
        throw new Error(`Unsupported release package ${JSON.stringify(packageJson.name)}.`);
      }
      assertValidVersion(packageJson.version);
      if (options.expectedPackageName && packageJson.name !== options.expectedPackageName) {
        throw new Error(`Packed release package must be ${options.expectedPackageName}.`);
      }
      if (options.expectedVersion && packageJson.version !== options.expectedVersion) {
        throw new Error(
          `Packed ${packageJson.name} version must be ${options.expectedVersion}.`,
        );
      }
      const trainDependency = packageJson.dependencies?.[EVAL_PACKAGE_NAME];
      const coreDependency = packageJson.dependencies?.[CORE_PACKAGE_NAME];
      if (packageJson.name === CLI_PACKAGE_NAME) {
        if (trainDependency !== packageJson.version) {
          throw new Error(
            `Packed ${CLI_PACKAGE_NAME} must depend on ${EVAL_PACKAGE_NAME}@${packageJson.version}.`,
          );
        }
        packageJson.dependencies[EVAL_PACKAGE_NAME] = RELEASE_VERSION_SENTINEL;
        if (coreDependency !== packageJson.version) {
          throw new Error(
            `Packed ${CLI_PACKAGE_NAME} must depend on ${CORE_PACKAGE_NAME}@${packageJson.version}.`,
          );
        }
        packageJson.dependencies[CORE_PACKAGE_NAME] = RELEASE_VERSION_SENTINEL;
      } else if (trainDependency !== undefined) {
        throw new Error(`Packed ${packageJson.name} must not depend on ${EVAL_PACKAGE_NAME}.`);
      } else if (coreDependency !== undefined) {
        throw new Error(`Packed ${packageJson.name} must not depend on ${CORE_PACKAGE_NAME}.`);
      }
      packageJson.version = RELEASE_VERSION_SENTINEL;
      delete packageJson.awRelease;
      normalizedContents = Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`);
      normalizedReleasePackage = true;
    }
    entries.set(relativePath, {
      type: type === '2' ? 'symlink' : 'file',
      mode,
      contents: normalizedContents,
    });
  }

  if (entries.size === 0) throw new Error('Package tarball contains no production files.');
  if (options.normalizeReleaseMetadata && !normalizedReleasePackage) {
    throw new Error('Release package tarball is missing package.json.');
  }
  const hash = crypto.createHash('sha256');
  for (const [relativePath, entry] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    updateDigestField(hash, relativePath);
    updateDigestField(hash, entry.type);
    updateDigestField(hash, entry.mode);
    updateDigestField(hash, entry.contents);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function computeReleasePackageContentDigest(tarballPath) {
  return computePackageTarballTreeDigest(tarballPath, { normalizeReleaseMetadata: true });
}

export async function downloadExactPackageTarball(
  packageName,
  version,
  packageJsonPath,
  destination,
  options = {},
) {
  assertValidVersion(version);
  const registryUrl = options.registryUrl
    ? normalizeRegistryUrl(options.registryUrl)
    : await resolveRegistryUrl(packageJsonPath, options.env ?? process.env);
  const capture = options.captureCommand ?? captureCommand;
  await capture('npm', [
    'pack',
    `${packageName}@${version}`,
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    destination,
    '--registry',
    registryUrl,
  ], {
    timeoutMs: options.timeoutMs ?? RELEASE_NETWORK_TIMEOUT_MS,
    env: {
      ...(options.env ?? process.env),
      AW_RELEASE_NPM_REGISTRY_URL: registryUrl,
      npm_config_registry: registryUrl,
      NPM_CONFIG_REGISTRY: registryUrl,
      npm_config_ignore_scripts: 'true',
      NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    },
  });
  const tarballs = await listTarballs(destination);
  if (tarballs.length !== 1) {
    throw new Error(`Expected registry download to produce exactly one tarball, found ${tarballs.length}.`);
  }
  return { tarballPath: tarballs[0], registryUrl };
}

export async function assertPublishedPackageTarballMatchesCandidate(
  packageName,
  version,
  packageJsonPath,
  candidateTarballPath,
  options = {},
) {
  const computeDigest = options.computePackageTarballTreeDigest ?? computePackageTarballTreeDigest;
  const candidateTreeDigest = await computeDigest(candidateTarballPath);
  return withOwnedTemporaryDirectory(
    path.join(os.tmpdir(), 'aw-registry-package-'),
    async (temporaryRoot) => {
      await fs.chmod(temporaryRoot, 0o700);
      const download = options.downloadExactPackageTarball ?? downloadExactPackageTarball;
      const { tarballPath, registryUrl } = await download(
        packageName,
        version,
        packageJsonPath,
        temporaryRoot,
        options,
      );
      const publishedTreeDigest = await computeDigest(tarballPath);
      if (candidateTreeDigest !== publishedTreeDigest) {
        throw new Error(
          `Published ${packageName}@${version} has different package files from the release candidate.`,
        );
      }
      return { candidateTreeDigest, publishedTreeDigest, registryUrl };
    },
    'Registry package comparison cleanup also failed',
  );
}

async function resolveReleaseDirtyEntries(options = {}) {
  const { stdout } = await runReleaseGit([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ], options);
  const records = stdout.split('\0');
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('Git returned malformed worktree status data.');
    }
    const status = record.slice(0, 2);
    const relativePath = record.slice(3).replaceAll('\\', '/');
    if (!relativePath) {
      throw new Error('Git returned a dirty worktree entry without a path.');
    }
    const indexStatus = status[0];
    if (indexStatus === 'R' || indexStatus === 'C') {
      index += 1;
      if (!records[index]) {
        throw new Error('Git returned malformed rename or copy status data.');
      }
    }
    entries.push({ status, path: relativePath });
  }
  return entries;
}

const RELEASE_INPUT_PATHS = [
  'release/version-targets.json',
  'scripts/release',
  ...buildCacheContract.inputPaths,
];

function isAllowedIgnoredReleaseInput(relativePath) {
  if (relativePath.split('/').at(-1) === '.DS_Store') return true;
  if (relativePath.split('/').includes('node_modules')) return true;
  return (
    /^packages\/cli\/(?:dist|plugins-dist)(?:\/|$)/.test(relativePath)
    || /^packages\/agent-skill-eval\/dist(?:\/|$)/.test(relativePath)
    || /^packages\/plugin-core\/dist(?:\/|$)/.test(relativePath)
    || /^plugins\/[^/]+\/(?:evals|reports)(?:\/|$)/.test(relativePath)
    || /^plugins\/[^/]+\/skills\/[^/]+\/(?:[^/]+\/)*(?:evals|reports)(?:\/|$)/.test(
      relativePath,
    )
  );
}

async function resolveIgnoredReleaseInputs(options = {}) {
  const { stdout } = await runReleaseGit([
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
    '--',
    ...RELEASE_INPUT_PATHS,
  ], options);
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.replaceAll('\\', '/'))
    .filter((entry) => !isAllowedIgnoredReleaseInput(entry));
}

function parseTaggedReleaseInputs(stdout, flagName) {
  const entries = [];
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    if (record.length < 3 || record[1] !== ' ') {
      throw new Error(`Git returned malformed ${flagName} index data.`);
    }
    entries.push({ tag: record[0], path: record.slice(2).replaceAll('\\', '/') });
  }
  return entries;
}

async function assertReleaseInputIndexFlagsSafe(options = {}) {
  const [skipWorktreeResult, assumeUnchangedResult] = await Promise.all([
    runReleaseGit([
      'ls-files', '-t', '-z', '--', ...RELEASE_INPUT_PATHS,
    ], options),
    runReleaseGit([
      'ls-files', '-v', '-z', '--', ...RELEASE_INPUT_PATHS,
    ], options),
  ]);
  const assumeUnchanged = parseTaggedReleaseInputs(
    assumeUnchangedResult.stdout,
    'assume-unchanged',
  ).find((entry) =>
    entry.tag !== entry.tag.toUpperCase()
    && !isAllowedIgnoredReleaseInput(entry.path)
  );
  if (assumeUnchanged) {
    throw new Error(
      'Refusing release snapshot: registered release input uses Git index flag ' +
      `assume-unchanged: ${assumeUnchanged.path}.`,
    );
  }
  const skipWorktree = parseTaggedReleaseInputs(
    skipWorktreeResult.stdout,
    'skip-worktree',
  ).find((entry) => entry.tag === 'S' && !isAllowedIgnoredReleaseInput(entry.path));
  if (skipWorktree) {
    throw new Error(
      'Refusing release snapshot: registered release input uses Git index flag ' +
      `skip-worktree: ${skipWorktree.path}.`,
    );
  }
}

export async function assertReleaseWorktreeClean(options = {}) {
  await assertBuildInputPathSafety(options.cwd ?? repoRoot);
  await assertReleaseInputIndexFlagsSafe(options);
  const dirtyEntries = await resolveReleaseDirtyEntries(options);
  const dirtyPaths = dirtyEntries.map((entry) => entry.path);
  const ignoredInputs = await resolveIgnoredReleaseInputs(options);
  const unexpectedDirtyPaths = [...dirtyPaths, ...ignoredInputs];

  if (unexpectedDirtyPaths.length > 0) {
    const unexpectedChanges = unexpectedDirtyPaths.map((path) => `- ${path}`).join('\n');
    throw new Error(
      `Refusing to publish from a dirty working tree.\nUnexpected changes:\n${unexpectedChanges}`,
    );
  }

  return dirtyPaths;
}

export async function resolveCliPublishGitCheckArgs() {
  await assertReleaseWorktreeClean();
  return [];
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

export async function withPrivateCatalogStageRoot(callback) {
  return withOwnedTemporaryDirectory(
    path.join(os.tmpdir(), 'aw-catalog-release-'),
    (temporaryRoot) => callback(path.join(
      temporaryRoot,
      '.release',
      'catalog-staging',
      'catalog',
    )),
    'Private catalog release staging cleanup also failed',
  );
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

export async function assertPublicPackageVersions(repoRootPath = repoRoot) {
  const [
    rootPackageJson,
    targets,
    windowsX64PackageJson,
    windowsArm64PackageJson,
    evalPackageJson,
    corePackageJson,
    cliPackageJson,
  ] = await Promise.all([
    readPackageJson(path.join(repoRootPath, 'package.json')),
    readPackageJson(path.join(repoRootPath, 'release', 'version-targets.json')),
    readPackageJson(path.join(repoRootPath, 'packages', 'aw-windows-job-win32-x64', 'package.json')),
    readPackageJson(path.join(repoRootPath, 'packages', 'aw-windows-job-win32-arm64', 'package.json')),
    readPackageJson(path.join(repoRootPath, 'packages', 'agent-skill-eval', 'package.json')),
    readPackageJson(path.join(repoRootPath, 'packages', 'plugin-core', 'package.json')),
    readPackageJson(path.join(repoRootPath, 'packages', 'cli', 'package.json')),
  ]);
  if (Object.hasOwn(rootPackageJson, 'version')) {
    throw new Error('package.json must not declare a version; release/version-targets.json is the release target source.');
  }
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
    throw new Error('release/version-targets.json must contain an object.');
  }
  if (
    targets.schemaVersion !== 2
    || Object.keys(targets).sort().join('\n') !== ['cli', 'schemaVersion'].join('\n')
  ) {
    throw new Error('release/version-targets.json must use schemaVersion 2 with only the CLI target.');
  }
  const targetVersion = assertValidVersion(targets.cli);
  assertVersionKind(targetVersion, 'stable');
  const windowsX64Version = assertValidVersion(windowsX64PackageJson.version);
  const windowsArm64Version = assertValidVersion(windowsArm64PackageJson.version);
  const evalVersion = assertValidVersion(evalPackageJson.version);
  const coreVersion = assertValidVersion(corePackageJson.version);
  const cliVersion = assertValidVersion(cliPackageJson.version);
  if (
    targetVersion !== cliVersion
    || targetVersion !== evalVersion
    || targetVersion !== coreVersion
    || targetVersion !== windowsX64Version
    || targetVersion !== windowsArm64Version
  ) {
    throw new Error(
      `Version mismatch: release/version-targets.json cli "${targetVersion}" must match ` +
      `packages/aw-windows-job-win32-x64/package.json version "${windowsX64Version}", ` +
      `packages/aw-windows-job-win32-arm64/package.json version "${windowsArm64Version}", ` +
      `packages/agent-skill-eval/package.json version "${evalVersion}", ` +
      `packages/plugin-core/package.json version "${coreVersion}", and ` +
      `packages/cli/package.json version "${cliVersion}".`,
    );
  }
  if (evalPackageJson.optionalDependencies?.[WINDOWS_X64_PACKAGE_NAME] !== `workspace:${targetVersion}`) {
    throw new Error(
      `${EVAL_PACKAGE_NAME} must exactly optionally depend on ${WINDOWS_X64_PACKAGE_NAME}@workspace:${targetVersion}.`,
    );
  }
  if (evalPackageJson.optionalDependencies?.[WINDOWS_ARM64_PACKAGE_NAME] !== `workspace:${targetVersion}`) {
    throw new Error(
      `${EVAL_PACKAGE_NAME} must exactly optionally depend on ${WINDOWS_ARM64_PACKAGE_NAME}@workspace:${targetVersion}.`,
    );
  }
  if (cliPackageJson.dependencies?.[EVAL_PACKAGE_NAME] !== `workspace:${targetVersion}`) {
    throw new Error(
      `${CLI_PACKAGE_NAME} must exactly depend on ${EVAL_PACKAGE_NAME}@workspace:${targetVersion}.`,
    );
  }
  if (cliPackageJson.dependencies?.[CORE_PACKAGE_NAME] !== `workspace:${targetVersion}`) {
    throw new Error(
      `${CLI_PACKAGE_NAME} must exactly depend on ${CORE_PACKAGE_NAME}@workspace:${targetVersion}.`,
    );
  }
  return {
    targetVersion,
    windowsX64Version,
    windowsArm64Version,
    evalVersion,
    coreVersion,
    cliVersion,
  };
}

async function packWindowsJobFromSnapshot(snapshot, arch, destination, options = {}) {
  const targetDir = path.resolve(repoRoot, destination);
  await ensureDirectory(targetDir);
  const packageRoot = arch === 'x64'
    ? snapshot.windowsX64PackageRoot
    : snapshot.windowsArm64PackageRoot;
  return withOwnedTemporaryDirectory(
    path.join(os.tmpdir(), `aw-windows-job-${arch}-pack-`),
    async (packDirectory) => {
      await (options.runPackCommand ?? runCommand)('pnpm', [
        '--config.ignore-scripts=true',
        'pack',
        '--pack-destination',
        packDirectory,
      ], {
        cwd: packageRoot,
        ...(options.quiet ? { stdio: 'ignore' } : {}),
      });
      const tarballs = await listTarballs(packDirectory);
      if (tarballs.length !== 1) {
        throw new Error(`Expected Windows Job ${arch} pack to produce exactly one tarball, found ${tarballs.length}.`);
      }
      const targetPath = path.join(targetDir, path.basename(tarballs[0]));
      await fs.rename(tarballs[0], targetPath).catch(async (error) => {
        if (error?.code !== 'EXDEV') throw error;
        await fs.copyFile(tarballs[0], targetPath);
      });
      return targetPath;
    },
    `Windows Job ${arch} tarball pack staging cleanup also failed`,
  );
}

export async function packWindowsJobX64({
  destination = tarballDir,
  snapshot,
  quiet = false,
  runPackCommand,
} = {}) {
  if (snapshot) return packWindowsJobFromSnapshot(snapshot, 'x64', destination, { quiet, runPackCommand });
  await assertPublicPackageVersions();
  return withBuildSnapshot(repoRoot, (ownedSnapshot) =>
    packWindowsJobFromSnapshot(ownedSnapshot, 'x64', destination, { quiet, runPackCommand })
  );
}

export async function packWindowsJobArm64({
  destination = tarballDir,
  snapshot,
  quiet = false,
  runPackCommand,
} = {}) {
  if (snapshot) return packWindowsJobFromSnapshot(snapshot, 'arm64', destination, { quiet, runPackCommand });
  await assertPublicPackageVersions();
  return withBuildSnapshot(repoRoot, (ownedSnapshot) =>
    packWindowsJobFromSnapshot(ownedSnapshot, 'arm64', destination, { quiet, runPackCommand })
  );
}

async function packCliFromSnapshot(snapshot, destination, options = {}) {
  const targetDir = path.resolve(repoRoot, destination);
  await ensureDirectory(targetDir);

  return withOwnedTemporaryDirectory(
    path.join(os.tmpdir(), 'aw-cli-pack-'),
    async (packDirectory) => {
      await (options.runPackCommand ?? runCommand)('pnpm', [
        '--config.ignore-scripts=true',
        'pack',
        '--pack-destination',
        packDirectory,
      ], {
        cwd: snapshot.cliPackageRoot,
        ...(options.quiet ? { stdio: 'ignore' } : {}),
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

export async function packCli({
  destination = tarballDir,
  snapshot,
  quiet = false,
  runPackCommand,
} = {}) {
  if (snapshot) {
    return packCliFromSnapshot(snapshot, destination, { quiet, runPackCommand });
  }
  await assertPublicPackageVersions();
  return withBuildSnapshot(repoRoot, (ownedSnapshot) =>
    packCliFromSnapshot(ownedSnapshot, destination, { quiet, runPackCommand })
  );
}

export async function withPrivateCliTarball(snapshot, callback, options = {}) {
  return withOwnedTemporaryDirectory(
    path.join(os.tmpdir(), 'aw-cli-publish-'),
    async (privateRoot) => {
      await fs.chmod(privateRoot, 0o700);
      const tarballPath = await packCli({
        destination: privateRoot,
        snapshot,
        quiet: options.quiet ?? false,
        runPackCommand: options.runPackCommand,
      });
      return callback(tarballPath);
    },
    'Private CLI tarball cleanup also failed',
  );
}

async function packEvalFromSnapshot(snapshot, destination, options = {}) {
  const targetDir = path.resolve(repoRoot, destination);
  await ensureDirectory(targetDir);
  return withOwnedTemporaryDirectory(
    path.join(os.tmpdir(), 'aw-skill-eval-pack-'),
    async (packDirectory) => {
      await (options.runPackCommand ?? runCommand)('pnpm', [
        '--config.ignore-scripts=true',
        'pack',
        '--pack-destination',
        packDirectory,
      ], {
        cwd: snapshot.evalPackageRoot,
        ...(options.quiet ? { stdio: 'ignore' } : {}),
      });
      const tarballs = await listTarballs(packDirectory);
      if (tarballs.length !== 1) {
        throw new Error(`Expected shared Eval pack to produce exactly one tarball, found ${tarballs.length}.`);
      }
      const targetPath = path.join(targetDir, path.basename(tarballs[0]));
      await fs.rename(tarballs[0], targetPath).catch(async (error) => {
        if (error?.code !== 'EXDEV') throw error;
        await fs.copyFile(tarballs[0], targetPath);
      });
      return targetPath;
    },
    'Shared Eval tarball pack staging cleanup also failed',
  );
}

export async function packEval({
  destination = tarballDir,
  snapshot,
  quiet = false,
  runPackCommand,
} = {}) {
  if (snapshot) return packEvalFromSnapshot(snapshot, destination, { quiet, runPackCommand });
  await assertPublicPackageVersions();
  return withBuildSnapshot(repoRoot, (ownedSnapshot) =>
    packEvalFromSnapshot(ownedSnapshot, destination, { quiet, runPackCommand })
  );
}

async function packCoreFromSnapshot(snapshot, destination, options = {}) {
  const targetDir = path.resolve(repoRoot, destination);
  await ensureDirectory(targetDir);
  return withOwnedTemporaryDirectory(
    path.join(os.tmpdir(), 'aw-plugin-core-pack-'),
    async (packDirectory) => {
      await (options.runPackCommand ?? runCommand)('pnpm', [
        '--config.ignore-scripts=true',
        'pack',
        '--pack-destination',
        packDirectory,
      ], {
        cwd: snapshot.corePackageRoot,
        ...(options.quiet ? { stdio: 'ignore' } : {}),
      });
      const tarballs = await listTarballs(packDirectory);
      if (tarballs.length !== 1) {
        throw new Error(`Expected plugin core pack to produce exactly one tarball, found ${tarballs.length}.`);
      }
      const targetPath = path.join(targetDir, path.basename(tarballs[0]));
      await fs.rename(tarballs[0], targetPath).catch(async (error) => {
        if (error?.code !== 'EXDEV') throw error;
        await fs.copyFile(tarballs[0], targetPath);
      });
      return targetPath;
    },
    'Plugin core tarball pack staging cleanup also failed',
  );
}

export async function packCore({
  destination = tarballDir,
  snapshot,
  quiet = false,
  runPackCommand,
} = {}) {
  if (snapshot) return packCoreFromSnapshot(snapshot, destination, { quiet, runPackCommand });
  await assertPublicPackageVersions();
  return withBuildSnapshot(repoRoot, (ownedSnapshot) =>
    packCoreFromSnapshot(ownedSnapshot, destination, { quiet, runPackCommand })
  );
}

export async function withPrivateCoreTarball(snapshot, callback, options = {}) {
  return withOwnedTemporaryDirectory(
    path.join(os.tmpdir(), 'aw-plugin-core-publish-'),
    async (privateRoot) => {
      await fs.chmod(privateRoot, 0o700);
      const tarballPath = await packCore({
        destination: privateRoot,
        snapshot,
        quiet: options.quiet ?? false,
        runPackCommand: options.runPackCommand,
      });
      return callback(tarballPath);
    },
    'Private plugin core tarball cleanup also failed',
  );
}

export async function withPrivateEvalTarball(snapshot, callback, options = {}) {
  return withOwnedTemporaryDirectory(
    path.join(os.tmpdir(), 'aw-skill-eval-publish-'),
    async (privateRoot) => {
      await fs.chmod(privateRoot, 0o700);
      const tarballPath = await packEval({
        destination: privateRoot,
        snapshot,
        quiet: options.quiet ?? false,
        runPackCommand: options.runPackCommand,
      });
      return callback(tarballPath);
    },
    'Private shared Eval tarball cleanup also failed',
  );
}

export async function withReleaseBuildSnapshot(callback, options = {}) {
  const liveRoot = options.repoRoot ?? repoRoot;
  await assertBuildInputPathSafety(liveRoot);
  const snapshotRunner = options.withBuildSnapshot ?? withBuildSnapshot;
  return snapshotRunner(liveRoot, callback, options);
}

export async function resolveReleaseHead(options = {}) {
  const { stdout } = await runReleaseGit(['rev-parse', '--verify', 'HEAD'], options);
  const headCommit = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(headCommit)) {
    throw new Error('Release HEAD did not resolve to a commit object ID.');
  }
  return headCommit;
}

export function createReleaseSnapshotIdentity(snapshot, headCommit) {
  const required = ['generationId', 'outputDigest', 'inputDigest', 'cliPackageDigest'];
  for (const field of required) {
    if (typeof snapshot[field] !== 'string' || snapshot[field] === '') {
      throw new Error(`Release build snapshot is missing ${field}.`);
    }
  }
  if (typeof headCommit !== 'string' || !/^[0-9a-f]{40,64}$/.test(headCommit)) {
    throw new Error('Release snapshot identity requires a Git HEAD commit object ID.');
  }
  return Object.freeze({
    generationId: snapshot.generationId,
    outputDigest: snapshot.outputDigest,
    inputDigest: snapshot.inputDigest,
    cliPackageDigest: snapshot.cliPackageDigest,
    headCommit,
  });
}

export function assertReleaseSnapshotIdentity(snapshot, identity) {
  for (const field of ['generationId', 'outputDigest', 'inputDigest', 'cliPackageDigest']) {
    if (snapshot[field] !== identity[field]) {
      throw new Error(`Release snapshot ${field} changed within one combined generation.`);
    }
  }
}

export function assertStagedCatalogReleaseIdentity(staged, expectedOutputRoot, identity) {
  if (
    typeof staged?.outputRoot !== 'string'
    || path.resolve(staged.outputRoot) !== path.resolve(expectedOutputRoot)
  ) {
    throw new Error('Catalog release staging did not use its private publication root.');
  }
  for (const field of ['generationId', 'outputDigest', 'inputDigest', 'cliPackageDigest']) {
    if (staged[field] !== identity[field]) {
      throw new Error(`Staged catalog ${field} does not match the bound release generation.`);
    }
  }
  if (!staged.releaseIdentity) {
    throw new Error('Staged catalog is missing its bound release identity.');
  }
  for (const field of [
    'generationId',
    'outputDigest',
    'inputDigest',
    'cliPackageDigest',
    'headCommit',
  ]) {
    if (staged.releaseIdentity[field] !== identity[field]) {
      throw new Error(`Staged catalog release identity ${field} changed before publication.`);
    }
  }
}

export async function assertCurrentReleaseHead(identity, options = {}) {
  const current = await resolveReleaseHead(options);
  if (current !== identity.headCommit) {
    throw new Error(
      `Release HEAD changed from ${identity.headCommit} to ${current} during publication.`,
    );
  }
}

export async function assertCurrentReleaseIdentity(snapshot, identity, options = {}) {
  assertReleaseSnapshotIdentity(snapshot, identity);
  const liveRoot = options.repoRoot ?? repoRoot;
  const cleanOptions = { cwd: liveRoot };
  const assertClean = options.assertReleaseWorktreeClean ?? assertReleaseWorktreeClean;
  await assertClean(cleanOptions);
  const [headCommit, inputDigest, cliPackageDigest] = await Promise.all([
    (options.resolveReleaseHead ?? resolveReleaseHead)({ cwd: liveRoot }),
    (options.computeBuildInputDigest ?? computeBuildInputDigest)(liveRoot),
    (options.computeCliPackageDigest ?? computeCliPackageDigest)(liveRoot),
  ]);
  await assertClean(cleanOptions);
  if (headCommit !== identity.headCommit) {
    throw new Error(
      `Release HEAD changed from ${identity.headCommit} to ${headCommit} during publication.`,
    );
  }
  if (inputDigest !== identity.inputDigest) {
    throw new Error('Release live inputDigest no longer matches the bound release identity.');
  }
  if (cliPackageDigest !== identity.cliPackageDigest) {
    throw new Error('Release live cliPackageDigest no longer matches the bound release identity.');
  }
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

  const pluginStaging = await import(pathToFileURL(pluginStagingPath).href);
  const catalogSnapshot = await import(pathToFileURL(catalogSnapshotPath).href);
  const catalogModules = { pluginStaging, catalogSnapshot };

  cachedCatalogModules.set(resolvedCliDistRoot, catalogModules);
  return catalogModules;
}

function normalizeRegistryUrl(registryUrl) {
  const normalized = registryUrl.trim();
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Registry URL must be a valid HTTP(S) URL.');
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      'Registry URL must not contain embedded credentials (username or password); configure authentication in npm config.',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Registry URL must use HTTP(S); received protocol ${JSON.stringify(parsed.protocol)}.`,
    );
  }
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

export async function resolveRegistryUrl(
  packageJsonPath = cliPackageJsonPath,
  env = process.env,
) {
  const fromEnv = [
    env.AW_RELEASE_NPM_REGISTRY_URL,
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
