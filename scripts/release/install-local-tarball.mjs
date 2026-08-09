import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packCli, relativeToRepo, runCommand } from './common.mjs';

export async function installLocalTarball(tarballArg, options = {}) {
  const tarballPath = tarballArg
    ? path.resolve(options.cwd ?? process.cwd(), tarballArg)
    : await (options.packCli ?? packCli)();

  await (options.runCommand ?? runCommand)('npm', ['install', '-g', tarballPath]);
  return tarballPath;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const tarballPath = await installLocalTarball(argv[0]);
    console.log(`Installed tarball globally: ${relativeToRepo(tarballPath)}`);
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
