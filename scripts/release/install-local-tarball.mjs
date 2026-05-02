import path from 'node:path';

import { findLatestTarball, relativeToRepo, runCommand, tarballDir } from './common.mjs';

try {
  const tarballArg = process.argv[2];
  const tarballPath = tarballArg
    ? path.resolve(process.cwd(), tarballArg)
    : await findLatestTarball(tarballDir);

  await runCommand('npm', ['install', '-g', tarballPath]);
  console.log(`Installed tarball globally: ${relativeToRepo(tarballPath)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
