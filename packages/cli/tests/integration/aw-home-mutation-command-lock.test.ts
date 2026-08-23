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
  it('keeps a plugin write behind an in-flight source mutation for the same AW_HOME', async () => {
    const { isolation, candidateRoot } = await configureCatalog();
    const sourceEntered = deferred();
    const releaseSource = deferred();
    const sourceMutation = addCatalogSourceCommand({
      source: { id: 'secondary', type: 'path', primary: false, path: candidateRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runtime: {
        afterValidation: async () => {
          sourceEntered.resolve();
          await releaseSource.promise;
        },
      },
    });
    await sourceEntered.promise;

    let pluginSettled = false;
    const pluginWrite = installWriteCommand(['team/missing'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    });
    void pluginWrite.then(() => { pluginSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(pluginSettled).toBe(false);

    releaseSource.resolve();
    await expect(sourceMutation).resolves.toMatchObject({ ok: true, changed: true });
    const pluginResult = await pluginWrite;
    expect(pluginResult.overallState).toBe('failed');
    expect(pluginSettled).toBe(true);
  });

  it('does not acquire the mutation lock for a dependency-plan preview', async () => {
    const { isolation } = await configureCatalog();
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

  it('re-resolves config identity after a source update releases the mutation lock', async () => {
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
        afterValidation: async () => {
          sourceEntered.resolve();
          await releaseSource.promise;
        },
      },
    });
    await sourceEntered.promise;

    const captured = createCapturedCliIo();
    let configSettled = false;
    const configSet = runCli([
      'config', 'set', 'team/demo', 'mode', 'fast', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    });
    void configSet.then(() => { configSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(configSettled).toBe(false);

    releaseSource.resolve();
    await expect(sourceMutation).resolves.toMatchObject({ ok: true, changed: true });
    await expect(configSet).resolves.toBe(0);
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

  it('fails a source identity update closed when config already references the source', async () => {
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
    })).rejects.toMatchObject({ code: 'catalogSourceInUse' });
    expect((await listCatalogSources({ env: isolation.env })).sources[0]!.sourceIdentity).toBe(oldIdentity);
    await expect(fs.readJson(path.join(
      isolation.env.AW_HOME!,
      'plugin-config',
      'team',
      'demo',
      'config.json',
    ))).resolves.toMatchObject({ sourceIdentity: oldIdentity, values: { mode: 'safe' } });
  });
});
