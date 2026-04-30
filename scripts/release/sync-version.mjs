import { assertVersionKind, relativeToRepo, syncRepoVersion } from './common.mjs';

function parseArgs(argv) {
  const args = [...argv];
  let kind = 'any';

  if (args[0] === '--kind') {
    kind = args[1] ?? '';
    args.splice(0, 2);
  }

  const version = args[0];
  if (!version) {
    throw new Error(
      'Missing version. Usage: node scripts/release/sync-version.mjs [--kind stable|prerelease] <version>',
    );
  }

  if (!['any', 'stable', 'prerelease'].includes(kind)) {
    throw new Error(`Unsupported version kind "${kind}".`);
  }

  return {
    kind,
    version,
  };
}

try {
  const { kind, version } = parseArgs(process.argv.slice(2));
  if (kind !== 'any') {
    assertVersionKind(version, kind);
  }

  await syncRepoVersion(version);
  console.log(
    `Synced version ${version} in ${relativeToRepo('package.json')} and ${relativeToRepo('packages/cli/package.json')}.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
