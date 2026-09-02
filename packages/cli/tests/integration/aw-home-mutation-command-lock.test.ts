import { spawn } from 'node:child_process';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  addCatalogSourceCommand,
  listCatalogSources,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import { installWriteCommand } from '../../src/commands/write-commands.js';
import type { PluginMeta } from '../../src/types.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import {
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import {
  getCurrentSourceTestIsolation,
  getSourceTestRepositoryCwd,
} from '../setup/test-isolation.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';

interface MutationChildRun {
  completion: Promise<{ code: number | null; output: string }>;
}

function startMutationChild(env: NodeJS.ProcessEnv): MutationChildRun {
  const packageRoot = getSourceTestRepositoryCwd();
  const child = spawn(process.execPath, [
    path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config',
    'vitest.process-lock-child.config.ts',
    '--reporter=dot',
  ], {
    cwd: packageRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  return {
    completion: new Promise((resolve) => {
      child.on('error', (error) => resolve({ code: null, output: `${output}${error.stack ?? error.message}` }));
      child.on('close', (code) => resolve({ code, output }));
    }),
  };
}

async function waitForChildMarker(run: MutationChildRun, markerPath: string): Promise<void> {
  const marker = (async () => {
    const deadline = Date.now() + 10_000;
    while (!await fs.pathExists(markerPath)) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for child marker: ${markerPath}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  const outcome = await Promise.race([
    marker.then(() => null),
    run.completion,
  ]);
  if (outcome) throw new Error(`Mutation child exited before its marker (${outcome.code}):\n${outcome.output}`);
}

async function configureCatalog(): Promise<{
  isolation: ReturnType<typeof getCurrentSourceTestIsolation>;
  candidateRoot: string;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const currentRoot = path.join(isolation.layout.fixtureCwd, 'current');
  const candidateRoot = path.join(isolation.layout.fixtureCwd, 'candidate');
  await Promise.all([
    createCatalogSnapshotFixture(currentRoot, 'demo', [], 'demo\n', configureDemoManifest),
    createCatalogSnapshotFixture(candidateRoot, 'demo', [], 'demo v2\n', configureDemoManifest),
  ]);
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: currentRoot }],
    },
    expectedDigest: snapshot.digest,
    env: isolation.env,
  });
  return { isolation, candidateRoot };
}

function configureDemoManifest(manifest: PluginMeta['manifest']): void {
  manifest.extensions = {
    instructions: [{ name: 'demo', title: 'Demo', content: 'Demo.' }],
  };
  manifest.config = {
    schema: { mode: { type: 'enum', values: ['safe', 'fast'] } },
  };
}

describe('public AW_HOME mutation command lock', () => {
  it('serializes canonical AW_HOME aliases across real public writer processes without lost updates', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const physicalParent = path.join(isolation.layout.fixtureCwd, 'cross-process-parent');
    const physicalHome = path.join(physicalParent, 'cross-process-aw-home');
    const aliasParent = path.join(isolation.layout.fixtureCwd, 'cross-process-parent-alias');
    const aliasHome = path.join(aliasParent, 'cross-process-aw-home');
    const firstSourceRoot = path.join(isolation.layout.fixtureCwd, 'cross-process-first-source');
    const secondSourceRoot = path.join(isolation.layout.fixtureCwd, 'cross-process-second-source');
    await Promise.all([
      fs.ensureDir(physicalHome),
      createCatalogSnapshotFixture(firstSourceRoot, 'first-plugin', [], 'first\n'),
      createCatalogSnapshotFixture(secondSourceRoot, 'second-plugin', [], 'second\n'),
    ]);
    await fs.symlink(physicalParent, aliasParent);
    const firstStarted = path.join(isolation.layout.fixtureCwd, 'first-started');
    const firstEntered = path.join(isolation.layout.fixtureCwd, 'first-entered');
    const releaseFirst = path.join(isolation.layout.fixtureCwd, 'release-first');
    const secondStarted = path.join(isolation.layout.fixtureCwd, 'second-started');
    const secondEntered = path.join(isolation.layout.fixtureCwd, 'second-entered');
    const common = {
      ...isolation.env,
      AW_LOCK_CHILD_CWD: isolation.layout.fixtureCwd,
    };
    const first = startMutationChild({
      ...common,
      AW_HOME: physicalHome,
      AW_LOCK_CHILD_SOURCE_ID: 'first',
      AW_LOCK_CHILD_SOURCE_ROOT: firstSourceRoot,
      AW_LOCK_CHILD_STARTED: firstStarted,
      AW_LOCK_CHILD_ENTERED: firstEntered,
      AW_LOCK_CHILD_RELEASE: releaseFirst,
    });
    await waitForChildMarker(first, firstEntered);

    const second = startMutationChild({
      ...common,
      AW_HOME: aliasHome,
      AW_LOCK_CHILD_SOURCE_ID: 'second',
      AW_LOCK_CHILD_SOURCE_ROOT: secondSourceRoot,
      AW_LOCK_CHILD_STARTED: secondStarted,
      AW_LOCK_CHILD_ENTERED: secondEntered,
    });
    await waitForChildMarker(second, secondStarted);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(fs.pathExists(secondEntered)).resolves.toBe(false);
    expect((await readCatalogSourcesConfigSnapshot({ ...isolation.env, AW_HOME: physicalHome }))
      .config.sources.map((source) => source.id)).toEqual(['official']);

    await fs.outputFile(releaseFirst, 'release\n');
    const [firstOutcome, secondOutcome] = await Promise.all([
      first.completion,
      second.completion,
    ]);
    expect(firstOutcome.code, firstOutcome.output).toBe(0);
    expect(secondOutcome.code, secondOutcome.output).toBe(0);
    await expect(fs.pathExists(secondEntered)).resolves.toBe(true);
    expect((await readCatalogSourcesConfigSnapshot({ ...isolation.env, AW_HOME: aliasHome }))
      .config.sources.map((source) => source.id).sort()).toEqual(['first', 'official', 'second']);
  });

  it('does not acquire the mutation lock for a dependency-plan preview', async () => {
    const { isolation } = await configureCatalog();
    await syncCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: isolation.env,
    });
    const result = await withAwHomeMutationLock({
      env: isolation.env,
      action: () => installWriteCommand(['team/demo'], {
          cwd: isolation.layout.fixtureCwd,
          platform: 'codex',
          scope: 'project',
        }, {
          env: isolation.env,
          previewOperationPlan: true,
          nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
        }),
    });

    expect(result).toMatchObject({ overallState: 'succeeded' });
    expect(result.dependencyPlan?.requestedPluginIds).toEqual(['team/demo']);
  });

  it('commits a source identity update without migrating an existing config store', async () => {
    const { isolation, candidateRoot } = await configureCatalog();
    const oldIdentity = (await listCatalogSources({ env: isolation.env })).sources[0]!.sourceIdentity;
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity: oldIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { mode: 'safe' },
    });

    await expect(updateCatalogSourceCommand({
      sourceId: 'team',
      update: { type: 'path', path: candidateRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ ok: true, changed: true, references: [] });
    expect((await listCatalogSources({ env: isolation.env })).sources[0]!.sourceIdentity).not.toBe(oldIdentity);
    await expect(fs.readJson(path.join(
      isolation.env.AW_HOME!,
      'plugin-config',
      'team',
      'demo',
      'config.json',
    ))).resolves.toEqual({
      schemaVersion: 3,
      pluginId: 'team/demo',
      values: { mode: 'safe' },
    });
  });
});
