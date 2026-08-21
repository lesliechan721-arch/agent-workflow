import { assertVersionKind, relativeToRepo, syncCliVersion } from './common.mjs';

function parseArgs(argv) {
  const args = [...argv];
  let kind = 'any';
  let target = 'cli';

  while (args[0] === '--') {
    args.shift();
  }

  if (args[0] === '--kind') {
    kind = args[1] ?? '';
    args.splice(0, 2);
  }

  if (args[0] === '--target') {
    target = args[1] ?? '';
    args.splice(0, 2);
  }

  while (args[0] === '--') {
    args.shift();
  }

  const version = args[0];
  if (!version) {
    throw new Error(
      'Missing version. Usage: node scripts/release/sync-version.mjs [--target cli|catalog] [--kind stable|prerelease] <version>',
    );
  }

  if (!['any', 'stable', 'prerelease'].includes(kind)) {
    throw new Error(`Unsupported version kind "${kind}".`);
  }
  if (!['cli', 'catalog'].includes(target)) {
    throw new Error(`Unsupported sync target "${target}".`);
  }

  return {
    kind,
    target,
    version,
  };
}

try {
  const { kind, target, version } = parseArgs(process.argv.slice(2));
  if (kind !== 'any') {
    assertVersionKind(version, kind);
  }

  if (target === 'catalog') {
    console.log(
      `Catalog version ${version} is independent from ${relativeToRepo('packages/agent-skill-eval/package.json')} and ${relativeToRepo('packages/cli/package.json')}. Pass it to catalog release commands with --catalog-version.`,
    );
  } else {
    await syncCliVersion(version);
    console.log(
      `Synced release version ${version} in ${relativeToRepo('packages/agent-skill-eval/package.json')} and ` +
      `${relativeToRepo('packages/cli/package.json')}.`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
