import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  addCatalogSourceCommand,
  listCatalogSources,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import { installWriteCommand } from '../../src/commands/write-commands.js';
import { runCli } from '../../src/index.js';
import type { PluginMeta } from '../../src/types.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import {
  readPluginConfigStore,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { refreshCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function configureCatalog(): Promise<{
  isolation: ReturnType<typeof getCurrentSourceTestIsolation>;
  candidateRoot: string;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const currentRoot = path.join(isolation.layout.fixtureCwd, 'current');
  const candidateRoot = path.join(isolation.layout.fixtureCwd, 'candidate');
  await Promise.all([
    createCatalogSnapshotFixture(currentRoot, 'demo', '0.0.0', 'demo\n', configureDemoManifest),
    createCatalogSnapshotFixture(candidateRoot, 'demo', '0.0.0', 'demo v2\n', configureDemoManifest),
  ]);
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 1,
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
  it('releases the mutation lock before a committed source begins refresh', async () => {
    const { isolation, candidateRoot } = await configureCatalog();
    const sourceEntered = deferred();
    const releaseSource = deferred();
    const sourceMutation = addCatalogSourceCommand({
      source: { id: 'secondary', type: 'path', primary: false, path: candidateRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: {
        beforeRefresh: async () => {
          sourceEntered.resolve();
          await releaseSource.promise;
        },
      },
    });
    await sourceEntered.promise;

    let lockAcquired = false;
    await withAwHomeMutationLock({
      env: isolation.env,
      action: async () => {
        lockAcquired = true;
      },
    });
    expect(lockAcquired).toBe(true);

    releaseSource.resolve();
    await expect(sourceMutation).resolves.toMatchObject({ ok: true, changed: true });
  });

  it('does not acquire the mutation lock for a dependency-plan preview', async () => {
    const { isolation } = await configureCatalog();
    await refreshCatalogSourceGeneration({
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
          previewDependencyPlanOnly: true,
          nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
        }),
    });

    expect(result).toMatchObject({ overallState: 'succeeded' });
    expect(result.dependencyPlan?.requestedPluginIds).toEqual(['team/demo']);
  });

  it('re-resolves config identity while a committed source refresh is still pending', async () => {
    const { isolation, candidateRoot } = await configureCatalog();
    const oldIdentity = (await listCatalogSources({ env: isolation.env })).sources[0]!.sourceIdentity;
    const sourceEntered = deferred();
    const releaseSource = deferred();
    const sourceMutation = updateCatalogSourceCommand({
      sourceId: 'team',
      update: { type: 'path', path: candidateRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: {
        beforeRefresh: async () => {
          sourceEntered.resolve();
          await releaseSource.promise;
        },
      },
    });
    await sourceEntered.promise;

    const captured = createCapturedCliIo();
    const configSet = runCli([
      'config', 'set', 'team/demo', 'mode', 'fast', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    });
    await expect(configSet).resolves.toBe(0);

    releaseSource.resolve();
    await expect(sourceMutation).resolves.toMatchObject({ ok: true, changed: true });
    const payload = JSON.parse(captured.readStdout());
    const newIdentity = (await listCatalogSources({ env: isolation.env })).sources[0]!.sourceIdentity;
    expect(newIdentity).not.toBe(oldIdentity);
    expect(payload).toMatchObject({
      command: 'config:set',
      ok: true,
      sourceId: 'team',
      sourceIdentity: newIdentity,
    });
    await expect(readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity: newIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ exists: true, values: { mode: 'fast' } });
    await expect(fs.readJson(path.join(
      isolation.env.AW_HOME!,
      'plugin-config',
      'team',
      'demo',
      'config.json',
    ))).resolves.toMatchObject({ sourceIdentity: newIdentity, values: { mode: 'fast' } });
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
    ))).resolves.toMatchObject({ sourceIdentity: oldIdentity, values: { mode: 'safe' } });
  });
});
