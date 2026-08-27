import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertPublishedPackageTarballMatchesCandidate,
  assertPublicPackageVersions,
  assertReleaseWorktreeClean,
  captureCommand,
  cliPackageJsonPath,
  compareReleaseSemVer,
  computePackageTarballTreeDigest,
  corePackageJsonPath,
  evalPackageJsonPath,
  loadCatalogModules,
  packCli,
  packCore,
  packEval,
  readPackageJson,
  releaseRoot,
  repoRoot as defaultRepoRoot,
  resolveRegistryUrl,
  resolveReleaseHead,
  withReleaseBuildSnapshot,
  writePackageJson,
} from './common.mjs';
import {
  assertCatalogTagAvailable,
  disposeCatalogRelease,
  prepareCatalogRelease,
  publishCatalogRelease,
  readCatalogChannelState,
  readCatalogVersions,
} from './catalog-publication.mjs';
import {
  assertCliTagAvailable,
  ensureCliTag,
} from './cli-git-tag.mjs';
import { calculateCanonicalDigest } from './release-model.mjs';
import { assertVersionTargetsMatchHead, readVersionTargets } from './release-target.mjs';

export const preparedReleaseRoot = path.join(releaseRoot, 'prepared');
export const preparedDescriptorPath = path.join(preparedReleaseRoot, 'descriptor.json');
export const releaseAttemptPath = path.join(releaseRoot, 'attempted.json');
const CLI_PACKAGES = [
  '@lesliechan721/agent-skill-eval',
  '@lesliechan721/aw-plugin-core',
  '@lesliechan721/aw',
];
const CLI_PACKAGE_JSON_PATHS = [
  evalPackageJsonPath,
  corePackageJsonPath,
  cliPackageJsonPath,
];

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function fileDigest(filePath) {
  return digest(await fs.readFile(filePath));
}

function attemptedPath(options = {}) {
  return options.attemptPath ?? path.join(options.releaseRoot ?? releaseRoot, 'attempted.json');
}

async function readAttempt(options = {}) {
  try {
    return JSON.parse(await fs.readFile(attemptedPath(options), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('The local release attempt marker is invalid; bump the target before release.', { cause: error });
  }
}

function attemptedCandidates(candidates) {
  return Object.fromEntries(['cli'].flatMap((axis) =>
    typeof candidates?.[axis] === 'string' && candidates[axis] !== ''
      ? [[axis, candidates[axis]]]
      : []));
}

function sameCandidates(left, right) {
  return left?.cli === right?.cli && left?.catalog === right?.catalog;
}

function reusesAttemptedCandidate(attempt, candidates) {
  const previous = attemptedCandidates(attempt?.candidates);
  const next = attemptedCandidates(candidates);
  return previous.cli !== undefined && previous.cli === next.cli;
}

async function assertCandidateNotAttempted(targetsDigest, candidates, options = {}) {
  if (typeof candidates?.cli !== 'string' || candidates.cli === '') return;
  const attempt = await readAttempt(options);
  if (!attempt) return;
  if (reusesAttemptedCandidate(attempt, candidates)) {
    throw new Error('This release candidate was already attempted. Run pnpm release again with the involved target bump.');
  }
}

export async function assertPreparedCliAttempt(descriptor, options = {}) {
  const attempt = await (options.readAttempt ?? readAttempt)(options);
  if (
    attempt?.schemaVersion !== 1
    || attempt.targetsDigest !== descriptor.source.targetsDigest
    || attempt.candidates?.cli !== descriptor.candidates.cli
    || attempt.descriptorDigest !== calculateCanonicalDigest(descriptor)
  ) {
    throw new Error(
      'Cannot repair the CLI tag: the local attempt marker does not match the prepared release.',
    );
  }
}

async function consumePreparedCandidate(descriptor, axis, options = {}) {
  const attempt = await readAttempt(options);
  const marker = {
    schemaVersion: 1,
    targetsDigest: descriptor.source.targetsDigest,
    candidates: {
      ...attemptedCandidates(attempt?.candidates),
      [axis]: descriptor.candidates[axis],
    },
    descriptorDigest: calculateCanonicalDigest(descriptor),
  };
  const destination = attemptedPath(options);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function assertTrackedHeadClean(repoRoot = defaultRepoRoot, options = {}) {
  return (options.assertReleaseWorktreeClean ?? assertReleaseWorktreeClean)({
    ...options,
    cwd: repoRoot,
  });
}

async function readPackageVersions(packageName, options = {}) {
  const registryUrl = options.registryUrl ?? await resolveRegistryUrl(
    options.packageJsonPath ?? cliPackageJsonPath,
    options.env ?? process.env,
  );
  try {
    const result = await (options.captureCommand ?? captureCommand)('pnpm', [
      'view', packageName, 'versions', '--json', '--registry', registryUrl,
    ], { cwd: options.repoRoot ?? defaultRepoRoot, env: options.env });
    const versions = JSON.parse(result.stdout);
    if (!Array.isArray(versions) || versions.some((entry) => typeof entry !== 'string')) {
      throw new Error(`Registry returned invalid versions for ${packageName}.`);
    }
    return versions;
  } catch (error) {
    if (/E404|404 Not Found|is not in this registry/iu.test(String(error?.message))) return [];
    throw error;
  }
}

async function readPackageChannelVersion(packageName, channel, options = {}) {
  const registryUrl = options.registryUrl ?? await resolveRegistryUrl(
    options.packageJsonPath ?? cliPackageJsonPath,
    options.env ?? process.env,
  );
  const tag = channel === 'stable' ? 'latest' : 'beta';
  try {
    const result = await (options.captureCommand ?? captureCommand)('pnpm', [
      'view', `${packageName}@${tag}`, 'version', '--json', '--registry', registryUrl,
    ], { cwd: options.repoRoot ?? defaultRepoRoot, env: options.env });
    const version = JSON.parse(result.stdout);
    if (typeof version !== 'string') throw new Error(`Registry returned invalid ${tag} version for ${packageName}.`);
    return version;
  } catch (error) {
    if (/E404|404 Not Found|is not in this registry|No match found/iu.test(String(error?.message))) return null;
    throw error;
  }
}

function assertCandidateAbovePublished(candidate, versionSets, currentVersions, label) {
  const published = [...versionSets.flat(), ...currentVersions.filter(Boolean)];
  const blocking = published.find((version) => compareReleaseSemVer(candidate, version) <= 0);
  if (blocking) {
    throw new Error(`${label} candidate ${candidate} must be higher than published version ${blocking}; bump the target.`);
  }
}

function nextCandidate(
  targetVersion,
  channel,
  versionSets,
  currentVersions,
  label,
  attemptedVersion = null,
) {
  if (channel === 'stable') {
    const present = versionSets.map((versions) => versions.includes(targetVersion));
    if (present.some(Boolean) && !present.every(Boolean)) {
      throw new Error(`${label} ${targetVersion} is only partially published; bump the version before preparing again.`);
    }
    if (present.every(Boolean)) {
      return null;
    }
    assertCandidateAbovePublished(targetVersion, versionSets, currentVersions, label);
    return targetVersion;
  }
  const stablePresent = versionSets.map((versions) => versions.includes(targetVersion));
  if (stablePresent.some(Boolean) && !stablePresent.every(Boolean)) {
    throw new Error(`${label} stable target ${targetVersion} is only partially published; bump the target before beta prepare.`);
  }
  if (stablePresent.every(Boolean)) return null;
  const pattern = new RegExp(`^${targetVersion.replaceAll('.', '\\.')}\-beta\\.([1-9]\\d*)$`, 'u');
  const normalized = versionSets.map((versions) => versions
    .map((version) => pattern.exec(version))
    .filter(Boolean)
    .map((match) => BigInt(match[1])));
  const attemptedMatch = pattern.exec(attemptedVersion ?? '');
  const attempted = attemptedMatch ? BigInt(attemptedMatch[1]) : 0n;
  const highest = normalized.flat().reduce(
    (value, entry) => entry > value ? entry : value,
    attempted,
  );
  const candidate = `${targetVersion}-beta.${highest + 1n}`;
  assertCandidateAbovePublished(candidate, versionSets, currentVersions, label);
  return candidate;
}

export async function resolvePreparedCandidates(channel, targets, options = {}) {
  const readVersions = options.readPackageVersions ?? readPackageVersions;
  const readChannelVersion = options.readPackageChannelVersion ?? readPackageChannelVersion;
  const mode = channel === 'stable' ? 'latest' : 'beta';
  const axes = options.axes ?? { cli: true, catalog: true };
  const cliState = axes.cli
    ? {
        versions: await Promise.all(CLI_PACKAGES.map((name) => readVersions(name, options))),
        channels: await Promise.all(CLI_PACKAGES.map((name) =>
          readChannelVersion(name, channel, options))),
      }
    : null;
  const catalogState = axes.catalog
    ? await Promise.all([
        (options.readCatalogVersions ?? readCatalogVersions)(options),
        (options.readCatalogChannelState ?? readCatalogChannelState)(mode, options),
      ])
    : null;
  const attempt = channel === 'beta' && axes.cli
    ? await (options.readAttempt ?? readAttempt)(options)
    : null;
  return {
    cli: cliState
      ? nextCandidate(
          targets.cli,
          channel,
          cliState.versions,
          cliState.channels,
          'CLI train',
          attempt?.candidates?.cli ?? null,
        )
      : null,
    catalog: catalogState
      ? nextCandidate(
          targets.catalog,
          channel,
          [catalogState[0]],
          [catalogState[1]?.version ?? null],
          'Catalog',
        )
      : null,
  };
}

export function assertSelectedCandidates(axes, candidates) {
  for (const axis of ['cli', 'catalog']) {
    if (axes[axis] && candidates[axis] === null) {
      throw new Error(
        `Selected ${axis === 'cli' ? 'CLI' : 'Catalog'} axis has no release candidate; ` +
        'select another axis or bump its stable target.',
      );
    }
  }
}

async function stampCandidatePackages(snapshot, candidateVersion) {
  const evalPath = path.join(snapshot.evalPackageRoot, 'package.json');
  const corePath = path.join(snapshot.corePackageRoot, 'package.json');
  const cliPath = path.join(snapshot.cliPackageRoot, 'package.json');
  const [evalPackage, corePackage, cliPackage] = await Promise.all([
    readPackageJson(evalPath),
    readPackageJson(corePath),
    readPackageJson(cliPath),
  ]);
  evalPackage.version = candidateVersion;
  corePackage.version = candidateVersion;
  cliPackage.version = candidateVersion;
  cliPackage.dependencies['@lesliechan721/agent-skill-eval'] = candidateVersion;
  cliPackage.dependencies['@lesliechan721/aw-plugin-core'] = candidateVersion;
  delete evalPackage.awRelease;
  delete corePackage.awRelease;
  delete cliPackage.awRelease;
  await Promise.all([
    writePackageJson(evalPath, evalPackage),
    writePackageJson(corePath, corePackage),
    writePackageJson(cliPath, cliPackage),
  ]);
}

function descriptorArtifact(root, name, filePath, contentDigest) {
  return { name, path: path.relative(root, filePath), contentDigest };
}

export async function prepareLocalRelease(channel, options = {}) {
  if (channel !== 'beta' && channel !== 'stable') {
    throw new Error('Prepared release channel must be beta or stable.');
  }
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const localReleaseRoot = options.releaseRoot ?? releaseRoot;
  const localPreparedRoot = options.preparedRoot ?? path.join(localReleaseRoot, 'prepared');
  await (options.assertClean ?? assertTrackedHeadClean)(repoRoot, options);
  await (options.assertTargetsMatchHead ?? assertVersionTargetsMatchHead)(repoRoot, options);
  const [targets, versions, sourceHead] = await Promise.all([
    (options.readTargets ?? readVersionTargets)(repoRoot),
    (options.assertPackageVersions ?? assertPublicPackageVersions)(repoRoot),
    (options.resolveHead ?? resolveReleaseHead)({ cwd: repoRoot }),
  ]);
  if (versions.targetVersion !== targets.cli) throw new Error('CLI package versions do not match release targets.');
  const candidates = await (options.resolveCandidates ?? resolvePreparedCandidates)(channel, targets, {
    ...options, repoRoot, axes: options.axes ?? { cli: true, catalog: true },
  });
  assertSelectedCandidates(options.axes ?? { cli: true, catalog: true }, candidates);
  const targetsDigest = calculateCanonicalDigest(targets);
  await assertCandidateNotAttempted(targetsDigest, candidates, { ...options, releaseRoot: localReleaseRoot });
  await fs.mkdir(localReleaseRoot, { recursive: true });
  const temporaryRoot = await fs.mkdtemp(path.join(localReleaseRoot, '.prepared-'));
  try {
    const artifactRoot = path.join(temporaryRoot, 'artifacts');
    await fs.mkdir(artifactRoot, { recursive: true });
    await Promise.all([fs.chmod(temporaryRoot, 0o700), fs.chmod(artifactRoot, 0o700)]);
    const descriptor = await (options.withSnapshot ?? withReleaseBuildSnapshot)(async (snapshot) => {
      let npm = null;
      if (candidates.cli !== null) {
        await stampCandidatePackages(snapshot, candidates.cli);
        const [evalTarball, coreTarball, cliTarball] = await Promise.all([
          (options.packEval ?? packEval)({ snapshot, destination: artifactRoot, quiet: true }),
          (options.packCore ?? packCore)({ snapshot, destination: artifactRoot, quiet: true }),
          (options.packCli ?? packCli)({ snapshot, destination: artifactRoot, quiet: true }),
        ]);
        npm = {
          version: candidates.cli,
          packages: [
            descriptorArtifact(temporaryRoot, CLI_PACKAGES[0], evalTarball, await fileDigest(evalTarball)),
            descriptorArtifact(temporaryRoot, CLI_PACKAGES[1], coreTarball, await fileDigest(coreTarball)),
            descriptorArtifact(temporaryRoot, CLI_PACKAGES[2], cliTarball, await fileDigest(cliTarball)),
          ],
          treeDigests: {
            [CLI_PACKAGES[0]]: await (options.computeTarballTreeDigest
              ?? computePackageTarballTreeDigest)(evalTarball, {
                normalizeReleaseMetadata: true,
                expectedPackageName: CLI_PACKAGES[0],
                expectedVersion: candidates.cli,
              }),
            [CLI_PACKAGES[1]]: await (options.computeTarballTreeDigest
              ?? computePackageTarballTreeDigest)(coreTarball, {
                normalizeReleaseMetadata: true,
                expectedPackageName: CLI_PACKAGES[1],
                expectedVersion: candidates.cli,
              }),
            [CLI_PACKAGES[2]]: await (options.computeTarballTreeDigest
              ?? computePackageTarballTreeDigest)(cliTarball, {
                normalizeReleaseMetadata: true,
                expectedPackageName: CLI_PACKAGES[2],
                expectedVersion: candidates.cli,
              }),
          },
        };
      }
      let catalog = null;
      if (candidates.catalog !== null) {
        const mode = channel === 'stable' ? 'latest' : 'beta';
        const preparation = await (options.prepareCatalog ?? prepareCatalogRelease)(
          candidates.catalog,
          mode,
          { ...options, repoRoot },
        );
        const catalogPath = path.join(artifactRoot, 'catalog');
        try {
          await fs.cp(preparation.prepared.outputRoot, catalogPath, {
            recursive: true,
            verbatimSymlinks: true,
          });
          catalog = {
            version: candidates.catalog,
            path: path.relative(temporaryRoot, catalogPath),
            snapshotDigest: preparation.descriptor.snapshotDigest,
            minCliVersion: preparation.descriptor.minCliVersion,
            ledgerDigest: preparation.descriptor.ledgerDigest,
            publication: preparation.descriptor,
          };
        } finally {
          await (options.disposeCatalog ?? disposeCatalogRelease)(preparation, options);
        }
      }
      return {
        schemaVersion: 1,
        source: { head: sourceHead, targetsDigest },
        channel,
        axes: { cli: candidates.cli !== null, catalog: candidates.catalog !== null },
        candidates,
        build: {
          generationId: snapshot.generationId,
          inputDigest: snapshot.inputDigest,
          outputDigest: snapshot.outputDigest,
          cliPackageDigest: snapshot.cliPackageDigest,
        },
        npm,
        catalog,
      };
    }, { repoRoot });
    await fs.writeFile(path.join(temporaryRoot, 'descriptor.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
    await (options.assertClean ?? assertTrackedHeadClean)(repoRoot, options);
    await fs.rm(localPreparedRoot, { recursive: true, force: true });
    await fs.rename(temporaryRoot, localPreparedRoot);
    return descriptor;
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function readPreparedDescriptor(options = {}) {
  const root = options.preparedRoot ?? preparedReleaseRoot;
  let descriptor;
  try {
    const [rootStats, descriptorStats] = await Promise.all([
      fs.lstat(root),
      fs.lstat(path.join(root, 'descriptor.json')),
    ]);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()
      || !descriptorStats.isFile() || descriptorStats.isSymbolicLink()) {
      throw new Error('Prepared release paths must be regular local paths.');
    }
    descriptor = JSON.parse(await fs.readFile(path.join(root, 'descriptor.json'), 'utf8'));
  } catch (error) {
    throw new Error('No valid local prepared release exists; run pnpm release first.', { cause: error });
  }
  if (descriptor?.schemaVersion !== 1 || !descriptor.axes || !descriptor.source || !descriptor.build) {
    throw new Error('The local prepared release descriptor is invalid; prepare again.');
  }
  if (
    !['beta', 'stable'].includes(descriptor.channel)
    || typeof descriptor.axes.cli !== 'boolean'
    || typeof descriptor.axes.catalog !== 'boolean'
    || (descriptor.axes.cli !== (typeof descriptor.candidates?.cli === 'string'))
    || (descriptor.axes.catalog !== (typeof descriptor.candidates?.catalog === 'string'))
    || (descriptor.axes.cli && (
      descriptor.npm?.version !== descriptor.candidates.cli
      || descriptor.npm.packages?.map((entry) => entry.name).join('\n') !== CLI_PACKAGES.join('\n')
    ))
    || (!descriptor.axes.cli && descriptor.npm !== null)
    || (descriptor.axes.catalog && (
      descriptor.catalog?.version !== descriptor.candidates.catalog
      || typeof descriptor.catalog?.ledgerDigest !== 'string'
      || descriptor.catalog?.publication?.catalogVersion !== descriptor.candidates.catalog
      || descriptor.catalog?.publication?.snapshotDigest !== descriptor.catalog?.snapshotDigest
      || descriptor.catalog?.publication?.ledgerDigest !== descriptor.catalog?.ledgerDigest
      || descriptor.catalog?.publication?.minCliVersion !== descriptor.catalog?.minCliVersion
    ))
    || (!descriptor.axes.catalog && descriptor.catalog !== null)
  ) {
    throw new Error('The local prepared release axes or candidates are invalid; prepare again.');
  }
  assertPreparedChannelCandidates(descriptor);
  return { root, descriptor };
}

function assertPreparedChannelCandidates(descriptor) {
  const matches = (candidate) => descriptor.channel === 'beta'
    ? /-beta\.[1-9]\d*$/u.test(candidate)
    : /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(candidate);
  for (const candidate of [descriptor.candidates?.cli, descriptor.candidates?.catalog]) {
    if (candidate !== null && candidate !== undefined && !matches(candidate)) {
      throw new Error('Prepared candidate versions do not match the selected channel; prepare again.');
    }
  }
}

function resolvePreparedPath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '' || path.isAbsolute(relativePath)) {
    throw new Error('Prepared artifact path is invalid; prepare again.');
  }
  const resolved = path.resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error('Prepared artifact path escapes the local prepared root; prepare again.');
  }
  return resolved;
}

export async function assertPreparedCliArtifacts(root, descriptor, options = {}) {
  if (descriptor.npm) {
    for (const artifact of descriptor.npm.packages) {
      const artifactPath = resolvePreparedPath(root, artifact.path);
      const [stats, realPath, realRoot] = await Promise.all([
        fs.lstat(artifactPath), fs.realpath(artifactPath), fs.realpath(root),
      ]);
      if (
        !stats.isFile()
        || stats.isSymbolicLink()
        || realPath !== path.resolve(realRoot, artifact.path)
      ) {
        throw new Error('Prepared npm artifact path is not a regular local file; prepare again.');
      }
      const actual = await fileDigest(artifactPath);
      if (actual !== artifact.contentDigest) throw new Error('Prepared npm artifact digest changed; prepare again.');
      const treeDigest = await (options.computeTarballTreeDigest
        ?? computePackageTarballTreeDigest)(artifactPath, {
          normalizeReleaseMetadata: true,
          expectedPackageName: artifact.name,
          expectedVersion: descriptor.npm.version,
        });
      if (treeDigest !== descriptor.npm.treeDigests[artifact.name]) {
        throw new Error(`Prepared ${artifact.name} content digest changed; prepare again.`);
      }
    }
  }
}

async function assertPreparedArtifacts(root, descriptor, options = {}) {
  await assertPreparedCliArtifacts(root, descriptor, options);
  if (descriptor.catalog) {
    if (descriptor.catalog.publication?.minCliVersion !== descriptor.catalog.minCliVersion) {
      throw new Error('Prepared Catalog compatibility binding changed; prepare again.');
    }
    const modules = options.catalogModules ?? await loadCatalogModules(options.cliDistRoot);
    const catalogRoot = resolvePreparedPath(root, descriptor.catalog.path);
    const [stats, realPath, realRoot] = await Promise.all([
      fs.lstat(catalogRoot), fs.realpath(catalogRoot), fs.realpath(root),
    ]);
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || realPath !== path.resolve(realRoot, descriptor.catalog.path)
    ) {
      throw new Error('Prepared Catalog path is not a regular local directory; prepare again.');
    }
    const validation = await modules.catalogSnapshot.validateCatalogSnapshot(catalogRoot);
    const ledgerPath = path.join(catalogRoot, 'plugin-release-ledger.json');
    const ledgerBytes = await fs.readFile(ledgerPath);
    const ledger = JSON.parse(ledgerBytes);
    modules.pluginStaging.validatePluginReleaseLedgerAgainstManifest(ledger, validation.manifest);
    if (validation.snapshotDigest !== descriptor.catalog.snapshotDigest) {
      throw new Error('Prepared Catalog snapshot digest changed; prepare again.');
    }
    if (
      digest(ledgerBytes) !== descriptor.catalog.ledgerDigest
      || descriptor.catalog.publication.ledgerDigest !== descriptor.catalog.ledgerDigest
    ) {
      throw new Error('Prepared Catalog ledger digest changed; prepare again.');
    }
  }
}

async function assertCandidatesUnavailable(descriptor, options = {}) {
  if (descriptor.axes.cli) {
    const readVersions = options.readPackageVersions ?? readPackageVersions;
    for (const packageName of CLI_PACKAGES) {
      const versions = await readVersions(packageName, options);
      if (versions.includes(descriptor.candidates.cli)) {
        throw new Error(`${packageName}@${descriptor.candidates.cli} already exists; bump all npm package versions and prepare again.`);
      }
    }
    await (options.assertCliTagAvailable ?? assertCliTagAvailable)(
      descriptor.candidates.cli,
      { ...options, repoRoot: options.repoRoot ?? defaultRepoRoot },
    );
  }
  if (descriptor.axes.catalog) {
    await (options.assertCatalogTagAvailable ?? assertCatalogTagAvailable)(
      descriptor.candidates.catalog, options,
    );
  }
}

async function readPublishedCliVersion(channel, options = {}) {
  const registryUrl = options.registryUrl ?? await resolveRegistryUrl(
    options.packageJsonPath ?? cliPackageJsonPath,
    options.env ?? process.env,
  );
  const tag = channel === 'stable' ? 'latest' : 'beta';
  const versions = [];
  for (const packageName of CLI_PACKAGES) {
    const result = await (options.captureCommand ?? captureCommand)('pnpm', [
      'view', `${packageName}@${tag}`, 'version', '--json', '--registry', registryUrl,
    ], { cwd: options.repoRoot ?? defaultRepoRoot, env: options.env });
    versions.push(JSON.parse(result.stdout));
  }
  if (versions.some((version) => typeof version !== 'string') || new Set(versions).size !== 1) {
    throw new Error(`Catalog-only release requires matching published ${tag} versions for all npm packages.`);
  }
  const prerelease = versions[0].includes('-');
  if ((channel === 'stable' && prerelease) || (channel === 'beta' && !prerelease)) {
    throw new Error(`Catalog-only release requires a ${tag === 'latest' ? 'stable' : 'prerelease'} npm channel version.`);
  }
  return versions[0];
}

async function assertRemoteCandidateGate(descriptor, targets, options = {}) {
  const live = await (options.resolveCandidates ?? resolvePreparedCandidates)(
    descriptor.channel,
    targets,
    { ...options, axes: descriptor.axes },
  );
  if (!sameCandidates(live, descriptor.candidates)) {
    throw new Error('Published channel state changed after prepare; bump the involved target and prepare again.');
  }
}

async function assertCatalogCliCompatibility(descriptor, options = {}) {
  if (!descriptor.axes.catalog) return;
  const cliVersion = descriptor.axes.cli
    ? descriptor.candidates.cli
    : await (options.readPublishedCliVersion ?? readPublishedCliVersion)(descriptor.channel, options);
  const prerelease = cliVersion.includes('-');
  if ((descriptor.channel === 'stable' && prerelease) || (descriptor.channel === 'beta' && !prerelease)) {
    throw new Error('Catalog-only release selected an npm channel version with the wrong stable/beta type.');
  }
  if (compareReleaseSemVer(cliVersion, descriptor.catalog.minCliVersion) < 0) {
    throw new Error(
      `Catalog ${descriptor.candidates.catalog} requires aw >= ${descriptor.catalog.minCliVersion}, ` +
      `but the selected CLI is ${cliVersion}.`,
    );
  }
}

async function publishNpm(packageName, tarballPath, version, channel, options = {}) {
  await options.beforeRemoteWrite?.(packageName);
  const registryUrl = options.registryUrl ?? await resolveRegistryUrl(
    options.packageJsonPath ?? cliPackageJsonPath,
    options.env ?? process.env,
  );
  try {
    await (options.runNpmCommand ?? options.runCommand ?? (await import('./common.mjs')).runCommand)('pnpm', [
      'publish', tarballPath, '--ignore-scripts', '--access', 'public',
      '--tag', channel === 'stable' ? 'latest' : 'beta',
      '--registry', registryUrl,
    ], {
      env: {
        ...(options.env ?? process.env),
        AW_RELEASE_NPM_REGISTRY_URL: registryUrl,
        npm_config_registry: registryUrl,
        NPM_CONFIG_REGISTRY: registryUrl,
      },
    });
  } catch (error) {
    const recovery = channel === 'beta'
      ? 'Run pnpm release -- --repair-cli with the unchanged prepared release, or run pnpm release again '
        + 'with the intended CLI axis to publish the next beta version.'
      : 'Run pnpm release -- --repair-cli with the unchanged prepared release, or run pnpm release again '
        + 'with --cli-bump and the intended CLI axis.';
    throw new Error(
      `${packageName}@${version} publish failed or its result is uncertain. ` +
      `Do not retry this package directly. ${recovery}`,
      { cause: error },
    );
  }
}

async function assertLiveSourceBinding(descriptor, repoRoot, options = {}) {
  await (options.assertClean ?? assertTrackedHeadClean)(repoRoot, options);
  const [head, targets, versions] = await Promise.all([
    (options.resolveHead ?? resolveReleaseHead)({ cwd: repoRoot }),
    (options.readTargets ?? readVersionTargets)(repoRoot),
    (options.assertPackageVersions ?? assertPublicPackageVersions)(repoRoot),
  ]);
  if (head !== descriptor.source.head) throw new Error('Release HEAD changed after prepare; prepare again.');
  if (calculateCanonicalDigest(targets) !== descriptor.source.targetsDigest) {
    throw new Error('Release version targets changed after prepare; prepare again.');
  }
  if (versions.targetVersion !== targets.cli) throw new Error('CLI package versions changed after prepare; prepare again.');
}

async function assertPreparedBuildBinding(descriptor, repoRoot, options = {}) {
  await (options.withSnapshot ?? withReleaseBuildSnapshot)(async (snapshot) => {
    for (const field of ['generationId', 'inputDigest', 'outputDigest', 'cliPackageDigest']) {
      if (snapshot[field] !== descriptor.build[field]) {
        throw new Error(`Release build ${field} changed after prepare; prepare again.`);
      }
    }
  }, { repoRoot });
}

async function assertPublishedCliArtifact(root, descriptor, artifact, index, options = {}) {
  await (options.assertPublishedPackageMatches
    ?? assertPublishedPackageTarballMatchesCandidate)(
    artifact.name,
    descriptor.candidates.cli,
    CLI_PACKAGE_JSON_PATHS[index],
    resolvePreparedPath(root, artifact.path),
    options,
  );
}

export async function repairPreparedCliRelease(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const { root, descriptor } = await (options.readDescriptor ?? readPreparedDescriptor)(options);
  assertPreparedChannelCandidates(descriptor);
  if (!descriptor.axes.cli || !descriptor.npm) {
    throw new Error('The prepared release does not contain a CLI candidate to repair.');
  }
  await (options.assertPreparedCliAttempt ?? assertPreparedCliAttempt)(descriptor, options);
  await assertLiveSourceBinding(descriptor, repoRoot, options);
  await assertPreparedBuildBinding(descriptor, repoRoot, options);
  await assertPreparedCliArtifacts(root, descriptor, options);

  const publicationOptions = {
    ...options,
    beforeRemoteWrite: async (target) => {
      await assertLiveSourceBinding(descriptor, repoRoot, options);
      await options.beforeRemoteWrite?.(target);
    },
  };
  const readVersions = options.readPackageVersions ?? readPackageVersions;
  for (const [index, artifact] of descriptor.npm.packages.entries()) {
    const versions = await readVersions(artifact.name, options);
    if (!versions.includes(descriptor.candidates.cli)) {
      try {
        await publishNpm(
          artifact.name,
          resolvePreparedPath(root, artifact.path),
          descriptor.candidates.cli,
          descriptor.channel,
          publicationOptions,
        );
      } catch (error) {
        try {
          await assertPublishedCliArtifact(root, descriptor, artifact, index, options);
        } catch {
          throw new Error(
            `${artifact.name}@${descriptor.candidates.cli} repair publish failed or remains uncertain. ` +
            'Run pnpm release -- --repair-cli again with the unchanged prepared release, ' +
            'or publish a new version.',
            { cause: error },
          );
        }
        continue;
      }
    }
    await assertPublishedCliArtifact(root, descriptor, artifact, index, options);
  }

  await assertLiveSourceBinding(descriptor, repoRoot, options);
  return (options.publishCliTag ?? ensureCliTag)(
    descriptor.candidates.cli,
    descriptor.source.head,
    { ...publicationOptions, repoRoot },
  );
}

export async function publishPreparedRelease(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const { root, descriptor } = await (options.readDescriptor ?? readPreparedDescriptor)(options);
  assertPreparedChannelCandidates(descriptor);
  await assertLiveSourceBinding(descriptor, repoRoot, options);
  await assertPreparedBuildBinding(descriptor, repoRoot, options);
  await assertPreparedArtifacts(root, descriptor, options);
  const targets = await (options.readTargets ?? readVersionTargets)(repoRoot);
  await assertRemoteCandidateGate(descriptor, targets, { ...options, repoRoot });
  await assertCandidatesUnavailable(descriptor, { ...options, repoRoot });
  await assertCatalogCliCompatibility(descriptor, { ...options, repoRoot });
  await assertLiveSourceBinding(descriptor, repoRoot, options);

  await assertCandidateNotAttempted(
    descriptor.source.targetsDigest,
    descriptor.candidates,
    options,
  );
  const publicationOptions = {
    ...options,
    beforeRemoteWrite: async (target) => {
      await assertLiveSourceBinding(descriptor, repoRoot, options);
      await options.beforeRemoteWrite?.(target);
    },
  };

  if (descriptor.axes.cli) {
    const [evalArtifact, coreArtifact, cliArtifact] = descriptor.npm.packages;
    await (options.consumeCandidate ?? consumePreparedCandidate)(descriptor, 'cli', options);
    await publishNpm(CLI_PACKAGES[0], resolvePreparedPath(root, evalArtifact.path),
      descriptor.candidates.cli, descriptor.channel, publicationOptions);
    await publishNpm(CLI_PACKAGES[1], resolvePreparedPath(root, coreArtifact.path),
      descriptor.candidates.cli, descriptor.channel, publicationOptions);
    await publishNpm(CLI_PACKAGES[2], resolvePreparedPath(root, cliArtifact.path),
      descriptor.candidates.cli, descriptor.channel, publicationOptions);
    await (options.publishCliTag ?? ensureCliTag)(
      descriptor.candidates.cli,
      descriptor.source.head,
      { ...publicationOptions, repoRoot },
    );
  }
  if (descriptor.axes.catalog) {
    await (options.publishCatalog ?? publishCatalogRelease)({
      descriptor: descriptor.catalog.publication,
      stagedRoot: resolvePreparedPath(root, descriptor.catalog.path),
    }, { ...publicationOptions, repoRoot });
  }
  return descriptor;
}
