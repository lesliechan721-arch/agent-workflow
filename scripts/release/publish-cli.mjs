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
  cliPublication,
  options = {},
) {
  if (releaseIdentity) assertReleaseSnapshotIdentity(snapshot, releaseIdentity);
  const snapshotPackageJsonPath = path.join(snapshot.cliPackageRoot, 'package.json');
  const snapshotPackageJson = await readPackageJson(snapshotPackageJsonPath);
  const version = String(snapshotPackageJson.version);
  if (version !== expectedVersion) {
    throw new Error(
      `CLI snapshot version mismatch: expected ${expectedVersion}, found ${version} in snapshot package.json.`,
    );
  }
  assertVersionKind(version, publishMode.versionKind);

  assertBoundCliPublication(cliPublication, snapshot, expectedVersion);
  const { tarballPath, registryUrl } = cliPublication;
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
  await (options.runCommand ?? runCommand)('pnpm', publishArgs, {
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
    candidateTreeDigest: cliPublication.candidateTreeDigest,
    generationId: snapshot.generationId,
    outputDigest: snapshot.outputDigest,
    inputDigest: snapshot.inputDigest,
    cliPackageDigest: snapshot.cliPackageDigest,
    ...(releaseIdentity ? { releaseIdentity } : {}),
  };
}

function assertBoundCliPublication(publication, snapshot, expectedVersion) {
  if (
    !publication
    || (publication.status !== 'publish' && publication.status !== 'already-published')
    || publication.version !== expectedVersion
    || typeof publication.tarballPath !== 'string'
    || publication.tarballPath === ''
    || typeof publication.registryUrl !== 'string'
    || publication.registryUrl === ''
    || typeof publication.candidateTreeDigest !== 'string'
    || publication.candidateTreeDigest === ''
    || (
      publication.status === 'already-published'
      && (
        typeof publication.publishedTreeDigest !== 'string'
        || publication.publishedTreeDigest !== publication.candidateTreeDigest
      )
    )
    || publication.generationId !== snapshot.generationId
    || publication.outputDigest !== snapshot.outputDigest
    || publication.inputDigest !== snapshot.inputDigest
    || publication.cliPackageDigest !== snapshot.cliPackageDigest
  ) {
    throw new Error('Bound CLI publication candidate is invalid.');
  }
}

export async function prepareCliPublication(
  mode,
  publishMode,
  snapshot,
  expectedVersion,
  gate,
  tarballPath,
  options = {},
) {
  const packageJsonPath = path.join(snapshot.cliPackageRoot, 'package.json');
  const packageJson = await readPackageJson(packageJsonPath);
  if (packageJson.name !== '@lesliechan721/aw') {
    throw new Error('CLI snapshot package identity is invalid.');
  }
  if (String(packageJson.version) !== expectedVersion) {
    throw new Error(
      `CLI snapshot version mismatch: expected ${expectedVersion}, found ${packageJson.version}.`,
    );
  }
  assertVersionKind(expectedVersion, publishMode.versionKind);

  const exactVersionPublished = await (options.isExactPackageVersionPublished
    ?? isExactPackageVersionPublished)(
    '@lesliechan721/aw',
    expectedVersion,
    packageJsonPath,
  );
  if (exactVersionPublished) {
    const comparison = await (options.assertPublishedPackageTarballMatchesCandidate
      ?? assertPublishedPackageTarballMatchesCandidate)(
      '@lesliechan721/aw',
      expectedVersion,
      packageJsonPath,
      tarballPath,
      options.registryComparisonOptions,
    );
    if (gate.status === 'already-published') {
      return {
        status: 'already-published',
        mode,
        version: expectedVersion,
        tarballPath,
        registryUrl: comparison.registryUrl,
        candidateTreeDigest: comparison.candidateTreeDigest,
        publishedTreeDigest: comparison.publishedTreeDigest,
        generationId: snapshot.generationId,
        outputDigest: snapshot.outputDigest,
        inputDigest: snapshot.inputDigest,
        cliPackageDigest: snapshot.cliPackageDigest,
      };
    }
    throw new Error(
      `CLI @lesliechan721/aw@${expectedVersion} already exists, but the ${mode} dist-tag resolves to ` +
      `${gate.publishedVersion}. Refusing to repeat an immutable package publication.`,
    );
  }

  const [registryUrl, candidateTreeDigest] = await Promise.all([
    resolveRegistryUrl(packageJsonPath, process.env),
    (options.computePackageTarballTreeDigest ?? computePackageTarballTreeDigest)(tarballPath),
  ]);
  return {
    status: 'publish',
    mode,
    version: expectedVersion,
    tarballPath,
    registryUrl,
    candidateTreeDigest,
    generationId: snapshot.generationId,
    outputDigest: snapshot.outputDigest,
    inputDigest: snapshot.inputDigest,
    cliPackageDigest: snapshot.cliPackageDigest,
  };
}

export async function withPreparedCliPublication(
  mode,
  publishMode,
  snapshot,
  expectedVersion,
  gate,
  assertFresh,
  callback,
  options = {},
) {
  return (options.withPrivateCliTarball ?? withPrivateCliTarball)(snapshot, async (tarballPath) => {
    const publication = await (options.prepareCliPublication ?? prepareCliPublication)(
      mode,
      publishMode,
      snapshot,
      expectedVersion,
      gate,
      tarballPath,
      options,
    );
    assertBoundCliPublication(publication, snapshot, expectedVersion);
    await assertFresh();
    return callback(publication);
  });
}

async function prepareEvalPublicationCandidate(
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
    return {
      status: 'publish',
      mode,
      version: expectedVersion,
      tarballPath,
      registryUrl,
      gitCheckArgs,
      candidateTreeDigest,
      generationId: snapshot.generationId,
      outputDigest: snapshot.outputDigest,
      inputDigest: snapshot.inputDigest,
    };
  });
}

export async function publishPreparedEvalPublication(publication, assertFresh, options = {}) {
  if (publication.status === 'already-published') return publication;
  if (publication.status !== 'publish') throw new Error('Bound shared Eval publication candidate is invalid.');
  await assertFresh();
  await options.beforeNpmWrite?.('@lesliechan721/agent-skill-eval');
  await (options.runCommand ?? runCommand)('pnpm', [
    'publish', publication.tarballPath, '--ignore-scripts', '--tag', publication.mode,
    '--registry', publication.registryUrl, ...publication.gitCheckArgs,
  ], {
    timeoutMs: RELEASE_NETWORK_TIMEOUT_MS,
    env: {
      ...process.env,
      AW_RELEASE_NPM_REGISTRY_URL: publication.registryUrl,
      npm_config_registry: publication.registryUrl,
      NPM_CONFIG_REGISTRY: publication.registryUrl,
    },
  });
  return { ...publication, status: 'published' };
}

export async function withPreparedEvalPublication(
  mode, publishMode, snapshot, expectedVersion, assertFresh, callback, options = {},
) {
  return (options.withPrivateEvalTarball ?? withPrivateEvalTarball)(snapshot, async (tarballPath) => {
    const publication = await prepareEvalPublicationCandidate(
      mode, publishMode, snapshot, expectedVersion, assertFresh,
      { ...options, withPrivateEvalTarball: async (_snapshot, consume) => consume(tarballPath) },
    );
    return callback(publication);
  });
}

export async function prepareEvalPublication(
  mode, publishMode, snapshot, expectedVersion, assertFresh, options = {},
) {
  return withPreparedEvalPublication(
    mode, publishMode, snapshot, expectedVersion, assertFresh,
    (publication) => publishPreparedEvalPublication(publication, assertFresh, options),
    options,
  );
}

export async function publishCli(argv = process.argv.slice(2), options = {}) {
  const { mode, publishMode, cliVersion } = parseArgs(argv);
  if (options.expectedVersion !== undefined && options.expectedVersion !== cliVersion) {
    throw new Error(
      `CLI version mismatch: expected ${options.expectedVersion}, received ${cliVersion} from --cli-version.`,
    );
  }
  const currentVersion = String((await (options.readCliPackageJson ?? readCliPackageJson)()).version);
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
      {},
    );
    const publishUnderLease = async (publicationLease) => {
      const publishedVersion = publicationLease && options.publishedVersion !== undefined
        ? options.publishedVersion
        : await (options.resolvePublishedCliVersion ?? resolvePublishedCliVersion)(mode);
      if (publishedVersion === null && mode !== 'latest') {
        throw new Error('An empty published CLI baseline is valid only for the committed first stable release.');
      }
      const gate = publishedVersion === null
        ? { status: 'publish', version: expectedVersion, publishedVersion }
        : {
            ...resolveCliPublicationGate({
              mode,
              candidateVersion: expectedVersion,
              publishedVersion,
              ...(options.compareSemVer ? { compare: options.compareSemVer } : {}),
            }),
            publishedVersion,
          };
      let gitCheckArgs;
      const prepareToPublish = async () => {
        if (gitCheckArgs) return gitCheckArgs;
        if (!options.skipVerify) {
          await (options.runCommand ?? runCommand)('pnpm', ['run', 'release:verify:cli']);
        }
        gitCheckArgs = await (options.resolveCliPublishGitCheckArgs
          ?? resolveCliPublishGitCheckArgs)();
        return gitCheckArgs;
      };
      const publishPreparedCandidate = async (cliPublication) => {
        assertBoundCliPublication(cliPublication, snapshot, expectedVersion);
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
            ...(options.beforeNpmWrite ? { beforeNpmWrite: options.beforeNpmWrite } : {}),
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
        if (cliPublication.status === 'already-published') {
          return {
            mode,
            status: 'already-published',
            version: expectedVersion,
            cliPublication,
            evalPackage,
          };
        }
        await prepareToPublish();
        await options.beforeNpmWrite?.('@lesliechan721/aw');
        const cli = await publishCliFromSnapshot(
          mode,
          publishMode,
          snapshot,
          expectedVersion,
          gitCheckArgs,
          releaseIdentity,
          assertFresh,
          cliPublication,
          options,
        );
        return { ...cli, cliPublication, evalPackage };
      };

      if (options.cliPublication) return publishPreparedCandidate(options.cliPublication);
      return (options.withPreparedCliPublication ?? withPreparedCliPublication)(
        mode,
        publishMode,
        snapshot,
        expectedVersion,
        gate,
        assertFresh,
        publishPreparedCandidate,
        {
          ...(options.isExactPackageVersionPublished
            ? { isExactPackageVersionPublished: options.isExactPackageVersionPublished }
            : {}),
          ...(options.assertPublishedPackageTarballMatchesCandidate
            ? { assertPublishedPackageTarballMatchesCandidate: options.assertPublishedPackageTarballMatchesCandidate }
            : {}),
        },
      );
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

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === currentEntryPath) {
  process.stderr.write(
    'Direct release helper execution is disabled. Use `pnpm release:publish` or `pnpm release:recover`.\n',
  );
  process.exitCode = 1;
}
