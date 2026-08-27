import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';

import {
  CATALOG_CHANNEL_REFS,
  disposeCatalogRelease,
  prepareCatalogRelease,
  publishCatalogRelease,
} from '../../../../scripts/release/catalog-publication.mjs';
import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);
let temporaryRoot: string | null = null;

afterEach(async () => {
  if (temporaryRoot) await fs.remove(temporaryRoot);
  temporaryRoot = null;
});

async function runAw(cliEntry: string, workspaceRoot: string, args: string[]): Promise<void> {
  await execFileAsync(process.execPath, [cliEntry, ...args], {
    cwd: workspaceRoot,
    env: getCurrentSourceTestIsolation().env,
    maxBuffer: 20 * 1024 * 1024,
  });
}

it('uses the built common publisher to bootstrap independent official beta and latest channels', async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-bootstrap-smoke-'));
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  const remoteUrl = path.join(temporaryRoot, 'catalog.git');
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const cliEntry = path.join(sourceRoot, 'packages', 'cli', 'dist', 'index.js');
  await Promise.all([
    fs.ensureDir(workspaceRoot),
    execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]),
  ]);
  await execFileAsync('git', ['init', '--quiet'], { cwd: workspaceRoot });
  await runAw(cliEntry, workspaceRoot, [
    'catalog', 'init', '--workspace-root', workspaceRoot,
  ]);
  await runAw(cliEntry, workspaceRoot, [
    'plugin', 'init', 'bootstrap-demo', '--description', 'Bootstrap demo.', '--no-skills',
    '--workspace-root', workspaceRoot,
  ]);
  await execFileAsync('git', ['add', '.'], { cwd: workspaceRoot });
  await execFileAsync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'source',
  ], { cwd: workspaceRoot });

  const results = [];
  for (const [mode, version] of [
    ['beta', '92.0.0-beta.1'],
    ['latest', '92.0.0'],
  ] as const) {
    const preparation = await prepareCatalogRelease(version, mode, {
      repoRoot: workspaceRoot,
      remoteUrl,
      env: getCurrentSourceTestIsolation().env,
    });
    try {
      results.push(await publishCatalogRelease({
        descriptor: preparation.descriptor,
        stagedRoot: preparation.prepared.outputRoot,
      }, {
        repoRoot: workspaceRoot,
        remoteUrl,
        env: getCurrentSourceTestIsolation().env,
      }));
    } finally {
      await disposeCatalogRelease(preparation);
    }
  }

  for (const [index, ref] of [CATALOG_CHANNEL_REFS.beta, CATALOG_CHANNEL_REFS.latest].entries()) {
    const expected = results[index]!;
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
    expect(resolved.resolvedCommit).toBe(expected.commit);
  }
});
