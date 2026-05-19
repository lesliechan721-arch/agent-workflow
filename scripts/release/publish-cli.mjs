import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertVersionKind,
  packCli,
  readCliPackageJson,
  relativeToRepo,
  resolveCliPublishGitCheckArgs,
  runCommand,
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

export async function publishCli(argv = process.argv.slice(2)) {
  const { mode, publishMode } = parseArgs(argv);
  const cliPackageJson = await readCliPackageJson();
  const version = String(cliPackageJson.version);
  assertVersionKind(version, publishMode.versionKind);

  await runCommand('pnpm', ['run', 'release:verify:cli']);
  const gitCheckArgs = await resolveCliPublishGitCheckArgs();
  const tarballPath = await packCli();
  const publishArgs = [
    '--filter',
    '@yiliang/aw',
    'publish',
    '--tag',
    publishMode.tag,
    ...gitCheckArgs,
  ];
  await runCommand('pnpm', publishArgs);

  return {
    mode,
    version,
    tarballPath,
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { mode, version, tarballPath } = await publishCli(argv);
    console.log(
      `Published CLI @yiliang/aw@${version} with tag ${mode}. Tarball: ${relativeToRepo(tarballPath)}`,
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
