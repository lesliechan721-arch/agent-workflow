import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { publishPreparedRelease } from './prepared-release.mjs';

export function parsePublishArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  if (args.length !== 0) throw new Error('release:publish does not accept version arguments.');
  return {};
}

export async function publishRelease(argv = process.argv.slice(2), options = {}) {
  parsePublishArgs(argv);
  return publishPreparedRelease(options);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const descriptor = await publishRelease(argv);
    process.stdout.write(
      `Published ${descriptor.channel} release: CLI ${descriptor.candidates.cli ?? 'disabled'}, ` +
      `Catalog ${descriptor.candidates.catalog ?? 'disabled'}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
