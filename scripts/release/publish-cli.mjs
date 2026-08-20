import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCurrentReleaseIdentity,
  assertPublishedPackageTarballMatchesCandidate,
  assertVersionKind,
  assertReleaseSnapshotIdentity,
  createReleaseSnapshotIdentity,
  computePackageTarballTreeDigest,
  isExactPackageVersionPublished,
  readPackageJson,
  readCliPackageJson,
  RELEASE_NETWORK_TIMEOUT_MS,
  resolveCliPublicationGate,
  resolvePublishedCliVersion,
  resolveRegistryUrl,
  resolveCliPublishGitCheckArgs,
  resolveReleaseHead,
  runCommand,
  withPrivateCliTarball,
  withPrivateEvalTarball,
  withReleaseBuildSnapshot,
} from './common.mjs';
import {
  OFFICIAL_CATALOG_PUBLISH_REMOTE,
  withCatalogPublicationLease,
} from './git-catalog-publisher.mjs';

const publishModes = {
  beta: {
    tag: 'beta',
    versionKind: 'prerelease',
  },
  latest: {
    tag: 'latest',
    versionKind: 'stable',
  },
};

export function parseArgs(argv) {
  const args = [...argv];
  const mode = args.shift();
  const publishMode = publishModes[mode];
  if (!publishMode) {
    throw new Error('Missing publish mode. Use "beta" or "latest".');
  }
  while (args[0] === '--') args.shift();
  const versionFlag = args.shift();
  const cliVersion = args.shift();
  const extraArgs = args;
  if (versionFlag !== '--cli-version' || !cliVersion || extraArgs.length > 0) {
    throw new Error(
      'Unknown or extra arguments. Usage: node scripts/release/publish-cli.mjs <beta|latest> --cli-version <version>',
    );
  }
  assertVersionKind(cliVersion, publishMode.versionKind);

  return {
    mode,
    publishMode,
    cliVersion,
  };
}

async function publishCliFromSnapshot(
  mode,
  publishMode,
  snapshot,
  expectedVersion,
  gitCheckArgs,
  releaseIdentity,
  assertFresh,
) {
  if (releaseIdentity) assertReleaseSnapshotIdentity(snapshot, releaseIdentity);
  const snapshotPackageJsonPath = path.join(snapshot.cliPackageRoot, 'package.json');
  const [snapshotPackageJson, registryUrl] = await Promise.all([
    readPackageJson(snapshotPackageJsonPath),
    resolveRegistryUrl(snapshotPackageJsonPath, process.env),
  ]);
  const version = String(snapshotPackageJson.version);
  if (version !== expectedVersion) {
    throw new Error(
      `CLI snapshot version mismatch: expected ${expectedVersion}, found ${version} in snapshot package.json.`,
    );
  }
  assertVersionKind(version, publishMode.versionKind);

  return withPrivateCliTarball(snapshot, async (tarballPath) => {
    const publishArgs = [
      'publish',
      tarballPath,
      '--ignore-scripts',
      '--tag',
      publishMode.tag,
      '--registry',
      registryUrl,
      ...gitCheckArgs,
    ];
    await assertFresh();
    await runCommand('pnpm', publishArgs, {
      timeoutMs: RELEASE_NETWORK_TIMEOUT_MS,
      env: {
        ...process.env,
        AW_RELEASE_NPM_REGISTRY_URL: registryUrl,
        npm_config_registry: registryUrl,
        NPM_CONFIG_REGISTRY: registryUrl,
      },
    });

    return {
      mode,
      version,
      tarballPath,
      registryUrl,
      generationId: snapshot.generationId,
      outputDigest: snapshot.outputDigest,
      inputDigest: snapshot.inputDigest,
      cliPackageDigest: snapshot.cliPackageDigest,
      ...(releaseIdentity ? { releaseIdentity } : {}),
    };
  });
}

export async function prepareEvalPublication(
  mode,
  publishMode,
  snapshot,
  expectedVersion,
  assertFresh,
  options = {},
) {
  const packageJsonPath = path.join(snapshot.evalPackageRoot, 'package.json');
  const packageJson = await readPackageJson(packageJsonPath);
  if (packageJson.name !== '@lesliechan721/agent-skill-eval') {
    throw new Error('Shared Eval snapshot package identity is invalid.');
  }
  if (String(packageJson.version) !== expectedVersion) {
    throw new Error(
      `Shared Eval snapshot version mismatch: expected ${expectedVersion}, found ${packageJson.version}.`,
    );
  }
  assertVersionKind(expectedVersion, publishMode.versionKind);

  return (options.withPrivateEvalTarball ?? withPrivateEvalTarball)(snapshot, async (tarballPath) => {
    const evalPublished = await (options.isExactPackageVersionPublished
      ?? isExactPackageVersionPublished)(
      '@lesliechan721/agent-skill-eval',
      expectedVersion,
      packageJsonPath,
    );
    if (evalPublished) {
      const comparison = await (options.assertPublishedPackageTarballMatchesCandidate
        ?? assertPublishedPackageTarballMatchesCandidate)(
        '@lesliechan721/agent-skill-eval',
        expectedVersion,
        packageJsonPath,
        tarballPath,
        options.registryComparisonOptions,
      );
      return {
        status: 'already-published',
        version: expectedVersion,
        candidateTreeDigest: comparison.candidateTreeDigest,
        generationId: snapshot.generationId,
        outputDigest: snapshot.outputDigest,
        inputDigest: snapshot.inputDigest,
      };
    }

    const gitCheckArgs = options.gitCheckArgs
      ?? (options.beforePublish ? await options.beforePublish() : []);
    const [registryUrl, candidateTreeDigest] = await Promise.all([
      resolveRegistryUrl(packageJsonPath, process.env),
      (options.computePackageTarballTreeDigest ?? computePackageTarballTreeDigest)(tarballPath),
    ]);
    await assertFresh();
    await (options.runCommand ?? runCommand)('pnpm', [
      'publish',
      tarballPath,
      '--ignore-scripts',
      '--tag',
      publishMode.tag,
      '--registry',
      registryUrl,
      ...gitCheckArgs,
    ], {
      timeoutMs: RELEASE_NETWORK_TIMEOUT_MS,
      env: {
        ...process.env,
        AW_RELEASE_NPM_REGISTRY_URL: registryUrl,
        npm_config_registry: registryUrl,
        NPM_CONFIG_REGISTRY: registryUrl,
      },
    });
    return {
      status: 'published',
      mode,
      version: expectedVersion,
      candidateTreeDigest,
      generationId: snapshot.generationId,
      outputDigest: snapshot.outputDigest,
      inputDigest: snapshot.inputDigest,
    };
  });
}

export async function publishCli(argv = process.argv.slice(2), options = {}) {
  const { mode, publishMode, cliVersion } = parseArgs(argv);
  if (options.expectedVersion !== undefined && options.expectedVersion !== cliVersion) {
    throw new Error(
      `CLI version mismatch: expected ${options.expectedVersion}, received ${cliVersion} from --cli-version.`,
    );
  }
  const currentVersion = String((await readCliPackageJson()).version);
  if (currentVersion !== cliVersion) {
    throw new Error(
      `CLI version mismatch: expected ${cliVersion}, found ${currentVersion} in packages/cli/package.json.`,
    );
  }
  const expectedVersion = cliVersion;
  const snapshotRunner = options.snapshot
    ? (callback) => callback(options.snapshot)
    : (options.withReleaseBuildSnapshot ?? withReleaseBuildSnapshot);
  return snapshotRunner(async (snapshot) => {
    const releaseIdentity = options.releaseIdentity ?? createReleaseSnapshotIdentity(
      snapshot,
      await (options.resolveReleaseHead ?? resolveReleaseHead)(),
    );
    const assertFresh = () => (options.assertCurrentReleaseIdentity
      ?? assertCurrentReleaseIdentity)(
      snapshot,
      releaseIdentity,
      { allowVersionSync: true },
    );
    const publishUnderLease = async (publicationLease) => {
      const publishedVersion = publicationLease && options.publishedVersion !== undefined
        ? options.publishedVersion
        : await (options.resolvePublishedCliVersion ?? resolvePublishedCliVersion)(mode);
      const gate = resolveCliPublicationGate({
        mode,
        candidateVersion: expectedVersion,
        publishedVersion,
        ...(options.compareSemVer ? { compare: options.compareSemVer } : {}),
      });
      let gitCheckArgs;
      const prepareToPublish = async () => {
        if (gitCheckArgs) return gitCheckArgs;
        if (!options.skipVerify) {
          await runCommand('pnpm', ['run', 'release:verify:cli']);
        }
        gitCheckArgs = await resolveCliPublishGitCheckArgs();
        return gitCheckArgs;
      };
      const evalPackage = options.evalPublication ?? await prepareEvalPublication(
        mode,
        publishMode,
        snapshot,
        expectedVersion,
        assertFresh,
        {
          beforePublish: prepareToPublish,
          ...(options.isExactPackageVersionPublished
            ? { isExactPackageVersionPublished: options.isExactPackageVersionPublished }
            : {}),
          ...(options.assertPublishedPackageTarballMatchesCandidate
            ? { assertPublishedPackageTarballMatchesCandidate: options.assertPublishedPackageTarballMatchesCandidate }
            : {}),
        },
      );
      if (
        evalPackage.version !== expectedVersion
        || typeof evalPackage.candidateTreeDigest !== 'string'
        || evalPackage.candidateTreeDigest === ''
        || evalPackage.generationId !== snapshot.generationId
        || evalPackage.outputDigest !== snapshot.outputDigest
        || evalPackage.inputDigest !== snapshot.inputDigest
      ) {
        throw new Error('Bound shared Eval publication result is invalid.');
      }
      if (gate.status === 'already-published') return { mode, ...gate, evalPackage };
      await prepareToPublish();
      const cli = await publishCliFromSnapshot(
        mode,
        publishMode,
        snapshot,
        expectedVersion,
        gitCheckArgs,
        releaseIdentity,
        assertFresh,
      );
      return { ...cli, evalPackage };
    };

    if (options.publicationLease) return publishUnderLease(options.publicationLease);
    await assertFresh();
    return (options.withCatalogPublicationLease ?? withCatalogPublicationLease)(
      options.remoteUrl ?? OFFICIAL_CATALOG_PUBLISH_REMOTE,
      publishUnderLease,
      { ...options.publisherOptions, beforeAcquire: assertFresh },
    );
  }, options.snapshotOptions);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await publishCli(argv);
    if (result.status === 'already-published') {
      console.log(
        `CLI @lesliechan721/aw@${result.version} is already published with tag ${result.mode}; publication was skipped.`,
      );
      return;
    }
    const { mode, version, generationId } = result;
    console.log(
      `Published CLI @lesliechan721/aw@${version} with tag ${mode} from build generation ${generationId}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedPath === currentEntryPath) {
  await main();
}
