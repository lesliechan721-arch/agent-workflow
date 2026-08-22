import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  computeBuildOutputDigest,
} from '../../../../scripts/build/build-cache.mjs';
import { bootstrapCatalog } from '../../../../scripts/release/bootstrap-catalog.mjs';
import { stageCatalogRelease } from '../../../../scripts/release/stage-catalog.mjs';

const execFileAsync = promisify(execFile);

async function ensureBuild(repoRoot, npmExecPath) {
  await execFileAsync(process.execPath, [npmExecPath, 'build:ensure'], {
    cwd: repoRoot,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function loadCatalogModules(repoRoot) {
  const cliDistRoot = path.join(repoRoot, 'packages', 'cli', 'dist');
  const [pluginStaging, catalogSnapshot] = await Promise.all([
    import(pathToFileURL(path.join(cliDistRoot, 'scripts', 'plugin-staging.js')).href),
    import(pathToFileURL(path.join(
      cliDistRoot,
      'src',
      'utils',
      'catalog-snapshot.js',
    )).href),
  ]);
  return { pluginStaging, catalogSnapshot };
}

async function runStage(config) {
  await ensureBuild(config.repoRoot, config.npmExecPath);
  const buildCatalogRoot = path.join(config.repoRoot, 'packages', 'cli', 'plugins-dist');
  const buildDigestBefore = await computeBuildOutputDigest(config.repoRoot);
  const buildManifestBefore = await fs.readFile(path.join(
    buildCatalogRoot,
    'catalog-manifest.json',
  ));
  const staged = await stageCatalogRelease(
    ['--catalog-version', config.catalogVersion],
    {
      internalOutputRoot: config.stageRoot,
      snapshotOptions: { snapshotRunToken: config.snapshotTokens[0] },
    },
  );
  const [buildDigestAfter, buildManifestAfter] = await Promise.all([
    computeBuildOutputDigest(config.repoRoot),
    fs.readFile(path.join(buildCatalogRoot, 'catalog-manifest.json')),
  ]);
  if (
    buildDigestAfter !== buildDigestBefore
    || !buildManifestAfter.equals(buildManifestBefore)
  ) {
    throw new Error('Catalog stage smoke changed the canonical build output.');
  }
  return {
    manifest: staged.manifest,
    releaseLedger: staged.releaseLedger,
    buildDigest: buildDigestAfter,
  };
}

async function runBootstrap(config) {
  await ensureBuild(config.repoRoot, config.npmExecPath);
  await execFileAsync('git', ['init', '--bare', '--quiet', config.remoteUrl]);
  const catalogModules = await loadCatalogModules(config.repoRoot);
  let snapshotIndex = 0;
  const run = (mode, version) => bootstrapCatalog(
    [mode, '--catalog-version', version],
    {
      testRemoteUrl: config.remoteUrl,
      catalogModules,
      assertReleaseWorktreeClean: async () => undefined,
      assertCurrentReleaseIdentity: async () => undefined,
      runCommand: async () => undefined,
      withPrivateCatalogStageRoot: async (callback) => callback(config.stageRoot),
      snapshotOptions: {
        snapshotRunToken: config.snapshotTokens[snapshotIndex++],
      },
    },
  );
  const beta = await run('beta', '92.0.0-beta.1');
  const retry = await run('beta', '92.0.0-beta.1');
  const latest = await run('latest', '92.0.0');
  const retryAfterLatest = await run('beta', '92.0.0-beta.1');
  return { beta, retry, latest, retryAfterLatest };
}

async function main() {
  const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const result = config.mode === 'stage'
    ? await runStage(config)
    : await runBootstrap(config);
  process.stdout.write(JSON.stringify(result));
}

await main();
