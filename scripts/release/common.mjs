import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

let cachedCatalogModules = null;

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
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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

export async function packCli({ destination = tarballDir } = {}) {
  await assertRepoAndCliPackageVersions();
  const targetDir = path.resolve(repoRoot, destination);
  await cleanTarballs(targetDir);
  await runCommand('pnpm', ['pack:cli', '--pack-destination', targetDir]);
  return findLatestTarball(targetDir);
}

export async function loadCatalogModules() {
  if (cachedCatalogModules) {
    return cachedCatalogModules;
  }

  const pluginStagingPath = path.join(cliDistRoot, 'scripts', 'plugin-staging.js');
  const bundleLayoutPath = path.join(cliDistRoot, 'src', 'utils', 'bundle-layout.js');
  const manifestPath = path.join(cliDistRoot, 'src', 'utils', 'manifest.js');
  const marketplacePath = path.join(cliDistRoot, 'src', 'utils', 'marketplace.js');
  await Promise.all([
    fs.access(pluginStagingPath),
    fs.access(bundleLayoutPath),
    fs.access(manifestPath),
    fs.access(marketplacePath),
  ]).catch(() => {
    throw new Error('Catalog release helpers require compiled CLI artifacts. Run `pnpm build` first.');
  });

  cachedCatalogModules = await Promise.all([
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

  return cachedCatalogModules;
}

async function resolveCatalogModules(catalogModules = null) {
  return catalogModules ?? loadCatalogModules();
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
  const { pluginStaging, bundleLayout } = await resolveCatalogModules(options.catalogModules);
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
  const { manifest } = await resolveCatalogModules(options.catalogModules);
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
  const [{ pluginStaging, bundleLayout }, stagedCandidate] = await Promise.all([
    resolveCatalogModules(options.catalogModules),
    resolveCatalogModules(options.catalogModules).then(({ pluginStaging }) =>
      pluginStaging.stageCatalogArtifacts({
        repoRoot,
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
  });

  const staged = await pluginStaging.stageCatalogArtifacts({
    repoRoot,
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

  const { pluginStaging } = await resolveCatalogModules(options.catalogModules);
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

export async function publishCatalogRelease(options = {}) {
  const { outputRoot = defaultCatalogOutputRoot, registry = {} } = options;
  await assertRepoAndCliPackageVersions();
  const stagedCatalogVersion = options.catalogVersion
    ?? (await readCatalogStage({ outputRoot, catalogModules: options.catalogModules })).manifest.catalogVersion;
  const channel = normalizeChannel(options.channel, stagedCatalogVersion);
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
    catalogModules: options.catalogModules,
  });

  const publishContext = {
    channel,
    manifest: staged.manifest,
    sidecarPackageRoot: staged.sidecarPackageRoot,
    fullPackageRoot: staged.fullPackageRoot,
    registry,
  };

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

  return staged;
}
