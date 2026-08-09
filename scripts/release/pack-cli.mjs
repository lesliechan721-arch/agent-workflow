import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packCli, relativeToRepo } from './common.mjs';

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

export async function main(argv = process.argv.slice(2)) {
  try {
    const { destination } = parseArgs(argv);
    const tarballPath = await packCli({ destination });
    console.log(`Packed tarball: ${relativeToRepo(tarballPath)}`);
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
