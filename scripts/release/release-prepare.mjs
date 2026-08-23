import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareLocalRelease } from './prepared-release.mjs';

export function parsePrepareArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  if (args.length !== 1 || !['beta', 'stable'].includes(args[0])) {
    throw new Error('Usage: pnpm release:prepare -- beta|stable');
  }
  return { channel: args[0] };
}

export async function prepareRelease(argv = process.argv.slice(2), options = {}) {
  const { channel } = parsePrepareArgs(argv);
  return prepareLocalRelease(channel, options);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const descriptor = await prepareRelease(argv);
    process.stdout.write(
      `Prepared local ${descriptor.channel} release: CLI ${descriptor.candidates.cli ?? 'disabled'}, ` +
      `Catalog ${descriptor.candidates.catalog ?? 'disabled'}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
