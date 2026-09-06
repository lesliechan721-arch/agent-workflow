import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  packCli,
  packCore,
  packEval,
  packWindowsJobArm64,
  packWindowsJobX64,
  relativeToRepo,
  withReleaseBuildSnapshot,
} from './common.mjs';

const usage = 'node scripts/release/pack-cli.mjs [--pack-destination <directory>]';

export function parseArgs(argv) {
  const args = [...argv];
  let destination;

  while (args[0] === '--') {
    args.shift();
  }

  while (args.length > 0) {
    const token = args.shift();
    if (token === '--pack-destination' && destination === undefined) {
      destination = args.shift();
      if (!destination) {
        throw new Error(`Missing value for --pack-destination. Usage: ${usage}`);
      }
      continue;
    }
    throw new Error(`Unknown argument "${token}". Usage: ${usage}`);
  }

  return { destination };
}

export async function packCliBundle(options = {}) {
  const destination = options.destination;
  const snapshotRunner = options.withBuildSnapshot ?? withReleaseBuildSnapshot;
  const packEvalTarball = options.packEval ?? packEval;
  const packWindowsX64Tarball = options.packWindowsJobX64 ?? packWindowsJobX64;
  const packWindowsArm64Tarball = options.packWindowsJobArm64 ?? packWindowsJobArm64;
  const packCoreTarball = options.packCore ?? packCore;
  const packCliTarball = options.packCli ?? packCli;

  return snapshotRunner(async (snapshot) => {
    const windowsX64TarballPath = await packWindowsX64Tarball({ destination, snapshot });
    const windowsArm64TarballPath = await packWindowsArm64Tarball({ destination, snapshot });
    const evalTarballPath = await packEvalTarball({ destination, snapshot });
    const coreTarballPath = await packCoreTarball({ destination, snapshot });
    const cliTarballPath = await packCliTarball({ destination, snapshot });
    return {
      windowsX64TarballPath,
      windowsArm64TarballPath,
      evalTarballPath,
      coreTarballPath,
      cliTarballPath,
    };
  });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { destination } = parseArgs(argv);
    const bundle = await packCliBundle({ destination });
    console.log(`Packed Windows Job x64 tarball: ${relativeToRepo(bundle.windowsX64TarballPath)}`);
    console.log(`Packed Windows Job arm64 tarball: ${relativeToRepo(bundle.windowsArm64TarballPath)}`);
    console.log(`Packed shared Eval tarball: ${relativeToRepo(bundle.evalTarballPath)}`);
    console.log(`Packed plugin core tarball: ${relativeToRepo(bundle.coreTarballPath)}`);
    console.log(`Packed CLI tarball: ${relativeToRepo(bundle.cliTarballPath)}`);
    return bundle;
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
