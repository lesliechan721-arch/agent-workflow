import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { observeRelease } from './release-observe.mjs';
import { calculateReleaseStatus } from './release-state.mjs';

export function parseStatusArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  let json = false;
  for (const token of args) {
    if (token === '--json' && !json) json = true;
    else throw new Error(`Unknown release status argument ${JSON.stringify(token)}.`);
  }
  return { json };
}

export async function releaseStatus(argv = process.argv.slice(2), options = {}) {
  const { json } = parseStatusArgs(argv);
  const observed = await (options.observe ?? observeRelease)(options);
  const result = {
    schemaVersion: 1,
    targets: observed.targets,
    channels: {
      beta: calculateReleaseStatus({ channel: 'beta', ...observed }),
      stable: calculateReleaseStatus({ channel: 'stable', ...observed }),
    },
  };
  if (options.writeOutput !== false) {
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      const lines = ['Release status'];
      for (const channel of ['beta', 'stable']) {
        const status = result.channels[channel];
        lines.push(
          `${channel}: CLI target ${status.cli.targetVersion}, latest ${status.cli.latestStable ?? '-'}, ` +
          `beta ${status.cli.latestBeta ?? '-'}, next ${status.cli.candidateVersion ?? '-'}, ` +
          `content ${status.cli.trainContentDigest}, status ${status.cli.action}; ` +
          `Catalog target ${status.catalog.targetVersion}, latest ${status.catalog.latestStable ?? '-'}, ` +
          `beta ${status.catalog.latestBeta ?? '-'}, ` +
          `next ${status.catalog.candidateVersion ?? '-'}, content ${status.catalog.contentDigest}, ` +
          `status ${status.catalog.action}`,
        );
        for (const plugin of status.plugins) {
          lines.push(
            `  ${plugin.name}: target ${plugin.targetVersion}, latest ${plugin.latestStable ?? '-'}, ` +
            `beta ${plugin.latestBeta ?? '-'}, next ${plugin.candidateVersion ?? '-'}, ` +
            `content ${plugin.contentDigest}, status ${plugin.action}`,
          );
        }
      }
      process.stdout.write(`${lines.join('\n')}\n`);
    }
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
