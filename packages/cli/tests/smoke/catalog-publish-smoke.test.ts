import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';

import {
  buildCacheContract,
  createBuildSnapshot,
} from '../../../../scripts/build/build-cache.mjs';
import {
  publishStagedCatalog,
} from '../../../../scripts/release/git-catalog-publisher.mjs';
import { stageCatalogRelease } from '../../../../scripts/release/stage-catalog.mjs';
import { calculateCatalogContentDigest } from '../../../../scripts/release/release-model.mjs';
import * as pluginStaging from '../../scripts/plugin-staging.js';
import * as catalogSnapshot from '../../src/utils/catalog-snapshot.js';
import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);
let temporaryRoot: string | null = null;

afterEach(async () => {
  if (temporaryRoot) await fs.remove(temporaryRoot);
  temporaryRoot = null;
});

async function writeSyntheticEvalBuildOutputs(sourceRoot: string): Promise<void> {
  const evalOutputs = buildCacheContract.requiredOutputs.filter((relativePath: string) =>
    relativePath.startsWith('packages/agent-skill-eval/dist/')
  );
  await Promise.all(evalOutputs.map(async (relativePath: string) => {
    const outputPath = path.join(sourceRoot, relativePath);
    if (await fs.pathExists(outputPath)) return;
    await fs.outputFile(
      outputPath,
      relativePath.endsWith('.json') ? '{}\n' : 'export {};\n',
    );
  }));
}

it('stages, publishes, fetches, and validates a release catalog through the Git provider', async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-publish-smoke-'));
  const remoteUrl = path.join(temporaryRoot, 'catalog.git');
  await execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]);
  const globalConfigPath = path.join(temporaryRoot, 'global.gitconfig');
  const systemConfigPath = path.join(temporaryRoot, 'system.gitconfig');
  await Promise.all([
    fs.outputFile(globalConfigPath, '[core]\n\tsymlinks = false\n'),
    fs.outputFile(systemConfigPath, '[core]\n\tsymlinks = false\n'),
  ]);
  const publisherEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_CONFIG_SYSTEM: systemConfigPath,
  };
  const publicationRoot = path.join(temporaryRoot, 'publication');
  await fs.ensureDir(publicationRoot);
  const outputRoot = path.join(publicationRoot, '.release', 'catalog-staging', 'catalog');
  const catalogModules = { pluginStaging, catalogSnapshot };
  const sourceRoot = path.join(temporaryRoot, 'source');
  const sourceCatalogRoot = path.join(sourceRoot, 'packages', 'cli', 'plugins-dist');
  const linkTarget = 'targets/runtime.js';
  await Promise.all([
    fs.outputJson(path.join(sourceRoot, 'package.json'), {
      version: '1.0.0',
      packageManager: 'pnpm@10.33.0',
    }),
    fs.outputJson(path.join(sourceRoot, 'packages', 'cli', 'package.json'), {
      name: '@lesliechan721/aw',
      version: '1.0.0',
      type: 'module',
      files: ['dist/'],
    }),
    fs.outputJson(path.join(sourceRoot, 'packages', 'agent-skill-eval', 'package.json'), {
      name: '@lesliechan721/agent-skill-eval',
      version: '1.0.0',
      type: 'module',
      files: ['dist/'],
      exports: './dist/index.js',
      bin: {
        'aw-skill-eval': './dist/bin.js',
      },
    }),
    fs.ensureDir(path.join(sourceRoot, 'packages', 'cli', 'node_modules')),
    fs.ensureDir(path.join(sourceRoot, 'packages', 'agent-skill-eval', 'node_modules')),
  ]);
  const build = async () => {
    await fs.remove(path.join(sourceRoot, 'packages', 'cli', 'dist'));
    await fs.remove(sourceCatalogRoot);
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'packages', 'cli', 'dist', 'index.js'),
        'export {};\n',
      ),
      fs.outputFile(
        path.join(sourceRoot, 'packages', 'cli', 'dist', 'scripts', 'bundle-plugins.js'),
        'export {};\n',
      ),
      createCatalogSnapshotFixture(sourceCatalogRoot),
    ]);
    const pluginRuntimeRoot = path.join(sourceCatalogRoot, 'plugins', 'demo', 'runtime');
    await fs.outputFile(path.join(pluginRuntimeRoot, linkTarget), 'export {};\n');
    await fs.symlink(linkTarget, path.join(pluginRuntimeRoot, 'current.js'));
    await pluginStaging.stageCatalogArtifacts({
      repoRoot: sourceRoot,
      outputRoot: sourceCatalogRoot,
      phase: 'development',
      catalogVersion: '1.0.0',
    });
    await writeSyntheticEvalBuildOutputs(sourceRoot);
  };
  const snapshot = await createBuildSnapshot(sourceRoot, { build });
  const sourceValidation = await catalogSnapshot.validateCatalogSnapshot(snapshot.catalogOutputRoot);
  const marketplace = await fs.readJson(path.join(
    snapshot.catalogOutputRoot, '.agents', 'plugins', 'marketplace.json',
  ));
  const catalogContentDigest = calculateCatalogContentDigest({
    schemaIdentity: { schemaVersion: 4 },
    marketplaceMetadata: {
      name: marketplace.name,
      owner: marketplace.owner,
      interface: marketplace.interface,
    },
    compatibility: sourceValidation.manifest.compatibility,
    plugins: sourceValidation.manifest.entries.map((entry) => ({
      name: entry.name,
      targetVersion: entry.version.replace(/-beta\.[1-9]\d*$/u, ''),
      contentDigest: entry.contentDigest,
    })),
  });
  const staged = await stageCatalogRelease(
    ['--catalog-version', '91.0.0'],
    {
      internalOutputRoot: outputRoot,
      snapshot,
      catalogModules,
      catalogRelease: {
        state: 'published',
        targetVersion: '91.0.0',
        planId: `sha256:${'1'.repeat(64)}`,
        sourceHead: '2'.repeat(40),
        contentDigest: catalogContentDigest,
      },
    },
  );
  await snapshot.cleanup();
  const published = await publishStagedCatalog({
    mode: 'latest',
    catalogVersion: '91.0.0',
    stagedRoot: staged.outputRoot,
  }, {
    remoteUrl,
    catalogModules,
    env: publisherEnv,
  });

  const resolved = await catalogGitProviderInternal.resolve({
    id: 'smoke',
    type: 'git',
    primary: true,
    url: remoteUrl,
    refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
  }, {
    cliVersion: '99.0.0',
    freshnessPolicy: 'forceRemote',
    env: getCurrentSourceTestIsolation().env,
  });

  expect(resolved.resolvedCommit).toBe(published.commit);
  expect(resolved.manifest.catalogVersion).toBe('91.0.0');
  expect(resolved.manifest.channel).toBe('latest');
  const resolvedLinkPath = path.join(
    resolved.rootDir,
    'plugins',
    'demo',
    'runtime',
    'current.js',
  );
  expect((await fs.lstat(resolvedLinkPath)).isSymbolicLink()).toBe(true);
  expect(await fs.readlink(resolvedLinkPath)).toBe(linkTarget);
  await expect(catalogSnapshot.validateCatalogSnapshot(resolved.rootDir))
    .resolves.toMatchObject({ manifest: { catalogVersion: '91.0.0' } });
});
