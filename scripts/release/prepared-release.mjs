import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertPublicPackageVersions,
  assertReleaseWorktreeClean,
  captureCommand,
  cliPackageJsonPath,
  compareReleaseSemVer,
  computePackageTarballTreeDigest,
  loadCatalogModules,
  packCli,
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
  publishStagedCatalog,
  readCatalogChannelState,
  readCatalogChannelLedger,
  readCatalogVersions,
} from './git-catalog-publisher.mjs';
import { calculateCanonicalDigest } from './release-model.mjs';
import { readCurrentReleaseContent } from './release-observe.mjs';
import { assertVersionTargetsMatchHead, readVersionTargets } from './release-target.mjs';
import { stageCatalogRelease } from './stage-catalog.mjs';

export const preparedReleaseRoot = path.join(releaseRoot, 'prepared');
export const preparedDescriptorPath = path.join(preparedReleaseRoot, 'descriptor.json');
export const releaseAttemptPath = path.join(releaseRoot, 'attempted.json');
const CLI_PACKAGES = [
  '@lesliechan721/agent-skill-eval',
  '@lesliechan721/aw',
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

function sameCandidates(left, right) {
  return left?.cli === right?.cli && left?.catalog === right?.catalog;
}

async function assertCandidateNotAttempted(targetsDigest, candidates, options = {}) {
  const attempt = await readAttempt(options);
  if (!attempt) return;
  if (attempt.targetsDigest === targetsDigest && sameCandidates(attempt.candidates, candidates)) {
    throw new Error('This release candidate was already attempted. Bump the involved target, then prepare again.');
  }
  if (attempt.targetsDigest !== targetsDigest) await fs.rm(attemptedPath(options), { force: true });
}

async function consumePreparedCandidate(descriptor, options = {}) {
  const marker = {
    schemaVersion: 1,
    targetsDigest: descriptor.source.targetsDigest,
    candidates: descriptor.candidates,
    descriptorDigest: calculateCanonicalDigest(descriptor),
  };
  await fs.mkdir(path.dirname(attemptedPath(options)), { recursive: true });
  try {
    await fs.writeFile(attemptedPath(options), `${JSON.stringify(marker, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('This release candidate was already attempted. Bump the involved target, then prepare again.');
    }
    throw error;
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

function nextCandidate(targetVersion, channel, versionSets, currentVersion, label) {
  if (channel === 'stable') {
    const present = versionSets.map((versions) => versions.includes(targetVersion));
    if (present.some(Boolean) && !present.every(Boolean)) {
      throw new Error(`${label} ${targetVersion} is only partially published; bump the version before preparing again.`);
    }
    if (present.every(Boolean)) {
      if (currentVersion !== targetVersion) {
        throw new Error(`${label} target ${targetVersion} is already published but is not the current channel; bump the target.`);
      }
      return null;
    }
    if (currentVersion && compareReleaseSemVer(targetVersion, currentVersion) <= 0) {
      throw new Error(`${label} candidate ${targetVersion} must be higher than current channel ${currentVersion}; bump the target.`);
    }
    return targetVersion;
  }
  if (versionSets.some((versions) => versions.includes(targetVersion))) {
    throw new Error(`${label} stable target ${targetVersion} is already published; bump the target before beta prepare.`);
  }
  const pattern = new RegExp(`^${targetVersion.replaceAll('.', '\\.')}\-beta\\.([1-9]\\d*)$`, 'u');
  const normalized = versionSets.map((versions) => versions
    .map((version) => pattern.exec(version))
    .filter(Boolean)
    .map((match) => BigInt(match[1])));
  if (normalized.length > 1) {
    const left = normalized[0].map(String).sort().join(',');
    const right = normalized[1].map(String).sort().join(',');
    if (left !== right) {
      throw new Error(`${label} beta history is partial; bump the stable target before preparing again.`);
    }
  }
  const highest = normalized.flat().reduce((value, entry) => entry > value ? entry : value, 0n);
  const candidate = `${targetVersion}-beta.${highest + 1n}`;
  if (currentVersion && compareReleaseSemVer(candidate, currentVersion) <= 0) {
    throw new Error(`${label} candidate ${candidate} must be higher than current channel ${currentVersion}; bump the target.`);
  }
  return candidate;
}

export async function resolvePreparedCandidates(channel, targets, options = {}) {
  const readVersions = options.readPackageVersions ?? readPackageVersions;
  const readChannelVersion = options.readPackageChannelVersion ?? readPackageChannelVersion;
  const mode = channel === 'stable' ? 'latest' : 'beta';
  const [evalVersions, cliVersions, catalogVersions, evalCurrent, cliCurrent, catalogState] = await Promise.all([
    readVersions(CLI_PACKAGES[0], options),
    readVersions(CLI_PACKAGES[1], options),
    (options.readCatalogVersions ?? readCatalogVersions)(options),
    readChannelVersion(CLI_PACKAGES[0], channel, options),
    readChannelVersion(CLI_PACKAGES[1], channel, options),
    (options.readCatalogChannelState ?? readCatalogChannelState)(mode, options),
  ]);
  if (evalCurrent !== cliCurrent) {
    throw new Error(`Published ${mode} versions for both npm packages must match before release.`);
  }
  return {
    cli: nextCandidate(targets.cli, channel, [evalVersions, cliVersions], evalCurrent, 'CLI train'),
    catalog: nextCandidate(targets.catalog, channel, [catalogVersions], catalogState?.version ?? null, 'Catalog'),
  };
}

async function stampCandidatePackages(snapshot, candidateVersion) {
  const evalPath = path.join(snapshot.evalPackageRoot, 'package.json');
  const cliPath = path.join(snapshot.cliPackageRoot, 'package.json');
  const [evalPackage, cliPackage] = await Promise.all([
    readPackageJson(evalPath),
    readPackageJson(cliPath),
  ]);
  evalPackage.version = candidateVersion;
  cliPackage.version = candidateVersion;
  cliPackage.dependencies['@lesliechan721/agent-skill-eval'] = candidateVersion;
  delete evalPackage.awRelease;
  delete cliPackage.awRelease;
  await Promise.all([
    writePackageJson(evalPath, evalPackage),
    writePackageJson(cliPath, cliPackage),
  ]);
}

function descriptorArtifact(root, name, filePath, contentDigest) {
  return { name, path: path.relative(root, filePath), contentDigest };
}

export async function prepareLocalRelease(channel, options = {}) {
  if (channel !== 'beta' && channel !== 'stable') {
    throw new Error('Usage: pnpm release:prepare -- beta|stable');
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
    ...options, repoRoot,
  });
  const targetsDigest = calculateCanonicalDigest(targets);
  await assertCandidateNotAttempted(targetsDigest, candidates, { ...options, releaseRoot: localReleaseRoot });
  await fs.mkdir(localReleaseRoot, { recursive: true });
  const temporaryRoot = await fs.mkdtemp(path.join(localReleaseRoot, '.prepared-'));
  try {
    const artifactRoot = path.join(temporaryRoot, 'artifacts');
    await fs.mkdir(artifactRoot, { recursive: true });
    await Promise.all([fs.chmod(temporaryRoot, 0o700), fs.chmod(artifactRoot, 0o700)]);
    const descriptor = await (options.withSnapshot ?? withReleaseBuildSnapshot)(async (snapshot) => {
      const content = await (options.readContent ?? readCurrentReleaseContent)(snapshot, sourceHead, options);
      let npm = null;
      if (candidates.cli !== null) {
        await stampCandidatePackages(snapshot, candidates.cli);
        const [evalTarball, cliTarball] = await Promise.all([
          (options.packEval ?? packEval)({ snapshot, destination: artifactRoot, quiet: true }),
          (options.packCli ?? packCli)({ snapshot, destination: artifactRoot, quiet: true }),
        ]);
        npm = {
          version: candidates.cli,
          packages: [
            descriptorArtifact(temporaryRoot, CLI_PACKAGES[0], evalTarball, await fileDigest(evalTarball)),
            descriptorArtifact(temporaryRoot, CLI_PACKAGES[1], cliTarball, await fileDigest(cliTarball)),
          ],
          treeDigests: {
            [CLI_PACKAGES[0]]: await (options.computeTarballTreeDigest
              ?? computePackageTarballTreeDigest)(evalTarball, {
                normalizeReleaseMetadata: true,
                expectedPackageName: CLI_PACKAGES[0],
                expectedVersion: candidates.cli,
              }),
            [CLI_PACKAGES[1]]: await (options.computeTarballTreeDigest
              ?? computePackageTarballTreeDigest)(cliTarball, {
                normalizeReleaseMetadata: true,
                expectedPackageName: CLI_PACKAGES[1],
                expectedVersion: candidates.cli,
              }),
          },
        };
      }
      let catalog = null;
      if (candidates.catalog !== null) {
        const mode = channel === 'stable' ? 'latest' : 'beta';
        const internalOutputRoot = path.join(temporaryRoot, '.release', 'catalog-staging', 'catalog');
        const previousReleaseLedger = await (options.readCatalogChannelLedger
          ?? readCatalogChannelLedger)(mode, options);
        const staged = await (options.stageCatalog ?? stageCatalogRelease)([
          '--catalog-version', candidates.catalog,
        ], {
          snapshot,
          internalOutputRoot,
          previousReleaseLedger,
          catalogRelease: {
            state: 'published',
            targetVersion: targets.catalog,
            planId: content.catalog.contentDigest,
            sourceHead,
            contentDigest: content.catalog.contentDigest,
          },
        });
        const catalogPath = path.join(artifactRoot, 'catalog');
        await fs.cp(staged.outputRoot, catalogPath, { recursive: true, verbatimSymlinks: true });
        await fs.rm(path.join(temporaryRoot, '.release'), { recursive: true, force: true });
        catalog = {
          version: candidates.catalog,
          path: path.relative(temporaryRoot, catalogPath),
          snapshotDigest: staged.snapshotDigest,
          minCliVersion: content.catalog.minCliVersion,
          ledgerDigest: calculateCanonicalDigest(JSON.parse(await fs.readFile(
            path.join(catalogPath, 'plugin-release-ledger.json'), 'utf8',
          ))),
        };
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
    throw new Error('No valid local prepared release exists; run release:prepare first.', { cause: error });
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

async function assertPreparedArtifacts(root, descriptor, options = {}) {
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
  if (descriptor.catalog) {
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
    const ledger = JSON.parse(await fs.readFile(path.join(catalogRoot, 'plugin-release-ledger.json'), 'utf8'));
    modules.pluginStaging.validatePluginReleaseLedgerAgainstManifest(ledger, validation.manifest);
    if (validation.snapshotDigest !== descriptor.catalog.snapshotDigest) {
      throw new Error('Prepared Catalog snapshot digest changed; prepare again.');
    }
    if (calculateCanonicalDigest(ledger) !== descriptor.catalog.ledgerDigest) {
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
        throw new Error(`${packageName}@${descriptor.candidates.cli} already exists; bump both npm package versions and prepare again.`);
      }
    }
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
  if (versions.some((version) => typeof version !== 'string') || versions[0] !== versions[1]) {
    throw new Error(`Catalog-only release requires matching published ${tag} versions for both npm packages.`);
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
    options,
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
    throw new Error(
      `${packageName}@${version} publish failed or its result is uncertain. Do not retry this version; bump both npm package versions, then run target, prepare, and publish again.`,
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

export async function publishPreparedRelease(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const { root, descriptor } = await (options.readDescriptor ?? readPreparedDescriptor)(options);
  assertPreparedChannelCandidates(descriptor);
  await assertLiveSourceBinding(descriptor, repoRoot, options);
  await (options.withSnapshot ?? withReleaseBuildSnapshot)(async (snapshot) => {
    for (const field of ['generationId', 'inputDigest', 'outputDigest', 'cliPackageDigest']) {
      if (snapshot[field] !== descriptor.build[field]) {
        throw new Error(`Release build ${field} changed after prepare; prepare again.`);
      }
    }
  }, { repoRoot });
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
  if (descriptor.axes.cli || descriptor.axes.catalog) {
    await (options.consumeCandidate ?? consumePreparedCandidate)(descriptor, options);
  }

  const publicationOptions = {
    ...options,
    beforeRemoteWrite: async (target) => {
      await assertLiveSourceBinding(descriptor, repoRoot, options);
      await options.beforeRemoteWrite?.(target);
    },
  };

  if (descriptor.axes.cli) {
    const [evalArtifact, cliArtifact] = descriptor.npm.packages;
    await publishNpm(CLI_PACKAGES[0], resolvePreparedPath(root, evalArtifact.path),
      descriptor.candidates.cli, descriptor.channel, publicationOptions);
    await publishNpm(CLI_PACKAGES[1], resolvePreparedPath(root, cliArtifact.path),
      descriptor.candidates.cli, descriptor.channel, publicationOptions);
  }
  if (descriptor.axes.catalog) {
    await (options.publishCatalog ?? publishStagedCatalog)({
      mode: descriptor.channel === 'stable' ? 'latest' : 'beta',
      catalogVersion: descriptor.candidates.catalog,
      stagedRoot: resolvePreparedPath(root, descriptor.catalog.path),
    }, publicationOptions);
  }
  return descriptor;
}
