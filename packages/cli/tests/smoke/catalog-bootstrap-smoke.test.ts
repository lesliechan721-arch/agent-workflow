import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';

import { bootstrapCatalog } from '../../../../scripts/release/bootstrap-catalog.mjs';
import { stageCatalogRelease } from '../../../../scripts/release/stage-catalog.mjs';
import * as pluginStaging from '../../scripts/plugin-staging.js';
import * as catalogSnapshot from '../../src/utils/catalog-snapshot.js';
import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);
let temporaryRoot: string | null = null;

afterEach(async () => {
  if (temporaryRoot) await fs.remove(temporaryRoot);
  temporaryRoot = null;
});

it('bootstraps both orphan channels, confirms idempotency, and fetches each through the Git provider', async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-bootstrap-smoke-'));
  const remoteUrl = path.join(temporaryRoot, 'catalog.git');
  await execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]);
  const catalogModules = { pluginStaging, catalogSnapshot };
  const run = (mode: 'beta' | 'latest', version: string) => bootstrapCatalog(
    [mode, '--catalog-version', version],
    {
      testRemoteUrl: remoteUrl,
      catalogModules,
      assertReleaseWorktreeClean: async () => undefined,
      assertCurrentReleaseIdentity: async () => undefined,
      runCommand: async () => undefined,
      stageCatalogRelease: async (argv: string[], options: {
        internalOutputRoot: string;
        previousReleaseLedger: pluginStaging.PluginReleaseLedger;
        releaseIdentity: object;
        snapshot: object;
        legacyPublishedIdentity: boolean;
      }) => {
        return stageCatalogRelease(argv, {
          internalOutputRoot: options.internalOutputRoot,
          previousReleaseLedger: options.previousReleaseLedger,
          releaseIdentity: options.releaseIdentity,
          snapshot: options.snapshot,
          legacyPublishedIdentity: options.legacyPublishedIdentity,
        });
      },
    },
  );

  const beta = await run('beta', '92.0.0-beta.1');
  const retry = await run('beta', '92.0.0-beta.1');
  const latest = await run('latest', '92.0.0');
  const retryAfterLatest = await run('beta', '92.0.0-beta.1');
  expect(retry).toMatchObject({ idempotent: true, commit: beta.commit });
  expect(retryAfterLatest).toMatchObject({ idempotent: true, commit: beta.commit });

  for (const [ref, expected] of [
    ['refs/heads/catalog/beta', beta.commit],
    ['refs/heads/catalog/latest', latest.commit],
  ] as const) {
    const resolved = await catalogGitProviderInternal.resolve({
      id: ref.endsWith('beta') ? 'beta-smoke' : 'latest-smoke',
      type: 'git',
      primary: true,
      url: remoteUrl,
      refPolicy: { type: 'explicit', ref },
    }, {
      cliVersion: '99.0.0',
      freshnessPolicy: 'forceRemote',
      env: getCurrentSourceTestIsolation().env,
    });
    expect(resolved.resolvedCommit).toBe(expected);
  }

  for (const version of ['92.0.0-beta.1', '92.0.0']) {
    const result = await execFileAsync('git', [
      '--git-dir', remoteUrl, 'cat-file', '-t', `refs/tags/catalog-v${version}`,
    ]);
    expect(String(result.stdout).trim()).toBe('tag');
  }
});
