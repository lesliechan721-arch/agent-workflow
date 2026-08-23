import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoRoot as defaultRepoRoot } from './common.mjs';
import { resolvePreparedCandidates } from './prepared-release.mjs';
import { readVersionTargets } from './release-target.mjs';

export function parseStatusArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    throw new Error('Usage: pnpm release:status [-- --json]');
  }
  return { json: args[0] === '--json' };
}

export async function releaseStatus(argv = process.argv.slice(2), options = {}) {
  const { json } = parseStatusArgs(argv);
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const targets = await (options.readTargets ?? readVersionTargets)(repoRoot);
  const [beta, stable] = await Promise.all([
    (options.resolveCandidates ?? resolvePreparedCandidates)('beta', targets, options),
    (options.resolveCandidates ?? resolvePreparedCandidates)('stable', targets, options),
  ]);
  const result = {
    schemaVersion: 1,
    targets,
    channels: {
      beta: { candidates: beta, axes: { cli: beta.cli !== null, catalog: beta.catalog !== null } },
      stable: { candidates: stable, axes: { cli: stable.cli !== null, catalog: stable.catalog !== null } },
    },
  };
  if (options.writeOutput !== false) {
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write([
      'Release status',
      `beta: CLI ${beta.cli ?? 'disabled'}; Catalog ${beta.catalog ?? 'disabled'}`,
      `stable: CLI ${stable.cli ?? 'disabled'}; Catalog ${stable.catalog ?? 'disabled'}`,
    ].join('\n') + '\n');
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    await releaseStatus(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
