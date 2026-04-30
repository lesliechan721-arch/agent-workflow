import {
  assertVersionKind,
  packCli,
  readCliPackageJson,
  relativeToRepo,
  runCommand,
} from './common.mjs';

const publishModes = {
  beta: {
    rawScript: 'publish:cli:beta:raw',
    versionKind: 'prerelease',
  },
  latest: {
    rawScript: 'publish:cli:raw',
    versionKind: 'stable',
  },
};

try {
  const mode = process.argv[2];
  const publishMode = publishModes[mode];
  if (!publishMode) {
    throw new Error('Missing publish mode. Use "beta" or "latest".');
  }

  const cliPackageJson = await readCliPackageJson();
  const version = String(cliPackageJson.version);
  assertVersionKind(version, publishMode.versionKind);

  await runCommand('pnpm', ['run', 'release:verify']);
  const tarballPath = await packCli();
  await runCommand('pnpm', ['run', publishMode.rawScript]);

  console.log(
    `Published @yiliang/aw@${version} with tag ${mode}. Tarball: ${relativeToRepo(tarballPath)}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
