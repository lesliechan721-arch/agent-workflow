import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createBuildSnapshot } from '../../../../scripts/build/build-cache.mjs';
import { packCli } from '../../../../scripts/release/common.mjs';
import { packCatalogRelease } from '../../../../scripts/release/pack-catalog.mjs';

const execFileAsync = promisify(execFile);
const [repoRoot, catalogVersion] = process.argv.slice(2);

if (!repoRoot || !catalogVersion) {
  throw new Error('Usage: node release-snapshot-force.mjs <repo-root> <catalog-version>');
}

async function waitForForceIntent() {
  const forceRoot = path.join(repoRoot, '.release', 'cache', 'build.force');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(forceRoot).catch(() => []);
    if (entries.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for force build intent.');
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-snapshot-force-fixture-'));
const cliPackRoot = path.join(tempRoot, 'cli-pack');
const cliUnpackRoot = path.join(tempRoot, 'cli-unpack');
const fullUnpackRoot = path.join(tempRoot, 'full-unpack');
await Promise.all([
  fs.mkdir(cliPackRoot, { recursive: true }),
  fs.mkdir(cliUnpackRoot, { recursive: true }),
  fs.mkdir(fullUnpackRoot, { recursive: true }),
]);

const snapshot = await createBuildSnapshot(repoRoot);
let forceBuild;
try {
  const snapshotCliIndex = await fs.readFile(path.join(snapshot.cliDistRoot, 'index.js'));
  const snapshotPluginManifest = await fs.readFile(path.join(
    snapshot.catalogOutputRoot,
    'plugins',
    'git-commit',
    '.agents-plugin',
    'plugin.json',
  ));
  const npmExecPath = process.env.npm_execpath?.trim();
  if (!npmExecPath) {
    throw new Error('release snapshot force fixture requires npm_execpath.');
  }
  forceBuild = execFileAsync(
    process.execPath,
    [npmExecPath, 'build'],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  await waitForForceIntent();

  const cliTarballPath = await packCli({ destination: cliPackRoot, snapshot });
  const catalog = await packCatalogRelease(
    ['--catalog-version', catalogVersion],
    { snapshot },
  );
  await forceBuild;

  await Promise.all([
    execFileAsync('tar', ['-xzf', cliTarballPath, '-C', cliUnpackRoot]),
    execFileAsync('tar', ['-xzf', catalog.fullTarballPath, '-C', fullUnpackRoot]),
  ]);
  const [packedCliIndex, packedPluginManifest, fullManifest] = await Promise.all([
    fs.readFile(path.join(cliUnpackRoot, 'package', 'dist', 'index.js')),
    fs.readFile(path.join(
      fullUnpackRoot,
      'package',
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    )),
    fs.readFile(path.join(fullUnpackRoot, 'package', 'catalog-manifest.json'), 'utf8')
      .then((contents) => JSON.parse(contents)),
  ]);

  await snapshot.cleanup();
  const [snapshotExists, catalogStages, forceIntents, buildLockExists] = await Promise.all([
    fs.stat(snapshot.root).then(() => true, () => false),
    fs.readdir(path.join(repoRoot, '.release', 'catalog-staging')).catch(() => []),
    fs.readdir(path.join(repoRoot, '.release', 'cache', 'build.force')).catch(() => []),
    fs.stat(path.join(repoRoot, '.release', 'cache', 'build.lock'))
      .then(() => true, () => false),
  ]);
  console.log(`SNAPSHOT_FORCE_RESULT ${JSON.stringify({
    catalogVersion: fullManifest.catalogVersion,
    channel: fullManifest.channel,
    generationMatches: catalog.generationId === snapshot.generationId,
    outputDigestMatches: catalog.outputDigest === snapshot.outputDigest,
    cliBytesMatch: packedCliIndex.equals(snapshotCliIndex),
    catalogBytesMatch: packedPluginManifest.equals(snapshotPluginManifest),
    snapshotRemoved: !snapshotExists,
    remainingCatalogStages: catalogStages.filter((entry) => entry.startsWith('catalog-')).length,
    remainingForceIntents: forceIntents.length,
    buildLockExists,
  })}`);
} finally {
  await forceBuild?.catch(() => undefined);
  await snapshot.cleanup().catch(() => undefined);
  await fs.rm(tempRoot, { recursive: true, force: true });
}
