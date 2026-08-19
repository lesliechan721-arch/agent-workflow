import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertVersionKind,
  assertReleaseSnapshotIdentity,
  packCli,
  readPackageJson,
  readCliPackageJson,
  RELEASE_NETWORK_TIMEOUT_MS,
  relativeToRepo,
  resolveCliPublicationGate,
  resolvePublishedCliVersion,
  resolveRegistryUrl,
  resolveCliPublishGitCheckArgs,
  runCommand,
  withReleaseBuildSnapshot,
} from './common.mjs';

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
  const mode = argv[0];
  const publishMode = publishModes[mode];
  if (!publishMode) {
    throw new Error('Missing publish mode. Use "beta" or "latest".');
  }

  return {
    mode,
    publishMode,
  };
}

async function publishCliFromSnapshot(
  mode,
  publishMode,
  snapshot,
  expectedVersion,
  gitCheckArgs,
  releaseIdentity,
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

  const tarballPath = await packCli({ snapshot });
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
}

export async function publishCli(argv = process.argv.slice(2), options = {}) {
  const { mode, publishMode } = parseArgs(argv);
  const expectedVersion = options.expectedVersion
    ?? String((await readCliPackageJson()).version);
  assertVersionKind(expectedVersion, publishMode.versionKind);

  const publishedVersion = options.publishedVersion
    ?? await (options.resolvePublishedCliVersion ?? resolvePublishedCliVersion)(mode);
  const gate = resolveCliPublicationGate({
    mode,
    candidateVersion: expectedVersion,
    publishedVersion,
    ...(options.compareSemVer ? { compare: options.compareSemVer } : {}),
  });
  if (gate.status === 'already-published') return { mode, ...gate };

  if (!options.skipVerify) {
    await runCommand('pnpm', ['run', 'release:verify:cli']);
  }
  const gitCheckArgs = await resolveCliPublishGitCheckArgs();
  if (options.snapshot) {
    return publishCliFromSnapshot(
      mode,
      publishMode,
      options.snapshot,
      expectedVersion,
      gitCheckArgs,
      options.releaseIdentity,
    );
  }
  return withReleaseBuildSnapshot((snapshot) =>
    publishCliFromSnapshot(
      mode,
      publishMode,
      snapshot,
      expectedVersion,
      gitCheckArgs,
      options.releaseIdentity,
    )
  );
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
    const { mode, version, tarballPath, generationId } = result;
    console.log(
      `Published CLI @lesliechan721/aw@${version} with tag ${mode} from build generation ${generationId}. Tarball: ${relativeToRepo(tarballPath)}`,
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
