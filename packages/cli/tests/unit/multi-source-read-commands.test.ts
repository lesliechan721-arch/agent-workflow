import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { initCommand } from '../../src/commands/init.js';
import {
  listCatalogSources,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import { createDashboardController, dashboardActions } from '../../src/commands/console.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { loadConsoleItemsResult } from '../../src/commands/status.js';
import { statusCommandV4 } from '../../src/commands/status-v4.js';
import { runCli } from '../../src/index.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function fixturePath(name: string): string {
  return path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
}

async function configureTwoPaths(validRoot: string, invalidRoot: string): Promise<NodeJS.ProcessEnv> {
  const isolation = getCurrentSourceTestIsolation();
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 1,
      sources: [
        { id: 'good', type: 'path', primary: true, path: validRoot },
        { id: 'bad', type: 'path', primary: false, path: invalidRoot },
      ],
    },
    expectedDigest: snapshot.digest,
    env: isolation.env,
  });
  return isolation.env;
}

describe('multi-source read commands', () => {
  it('keeps a successful init cache when another source fails', async () => {
    const good = fixturePath('good');
    const bad = fixturePath('bad');
    await Promise.all([createCatalogSnapshotFixture(good), fs.ensureDir(bad)]);
    const env = await configureTwoPaths(good, bad);

    const result = await initCommand({ cliVersion: '1.0.0', env });

    expect(result).toMatchObject({
      ok: false,
      primarySourceId: 'good',
      sources: expect.arrayContaining([
        expect.objectContaining({ id: 'good', ok: true, freshness: 'path' }),
        expect.objectContaining({
          id: 'bad',
          ok: false,
          error: expect.any(String),
          errorCode: 'catalogSourceResolutionFailed',
        }),
      ]),
    });
    expect(result.configDigest).toMatch(/^sha256:/);
    expect(result.compositeDigest).toMatch(/^sha256:/);
  });

  it('keeps path compatibility codes in init and status JSON', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const incompatible = fixturePath('incompatible');
    await createCatalogSnapshotFixture(incompatible, 'demo', '99.0.0');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'local', type: 'path', primary: true, path: incompatible }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    const initOutput = createCapturedCliIo();
    expect(await runCli(['init', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: initOutput.io,
      interactive: false,
    })).toBe(1);
    expect(JSON.parse(initOutput.readStdout())).toMatchObject({
      sources: [expect.objectContaining({
        id: 'local',
        errorCode: 'explicitCatalogIncompatible',
      })],
    });

    const statusOutput = createCapturedCliIo();
    expect(await runCli(['status', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: statusOutput.io,
      interactive: false,
    })).toBe(1);
    expect(JSON.parse(statusOutput.readStdout())).toMatchObject({
      catalog: {
        sources: [expect.objectContaining({
          id: 'local',
          errorCode: 'explicitCatalogIncompatible',
        })],
      },
    });
  });

  it('reports status schema 4 and continues after one source failure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('good');
    const bad = fixturePath('bad');
    await Promise.all([createCatalogSnapshotFixture(good), fs.ensureDir(bad)]);
    const env = await configureTwoPaths(good, bad);

    const result = await statusCommandV4({
      cwd: isolation.layout.fixtureCwd,
      env,
      cliVersion: '1.0.0',
      json: true,
    });

    expect(result.hasErrors).toBe(true);
    expect(result.payload).toMatchObject({
      schemaVersion: 4,
      catalog: {
        primarySourceId: 'good',
        configDigest: expect.stringMatching(/^sha256:/),
        compositeDigest: expect.stringMatching(/^sha256:/),
        sources: expect.arrayContaining([
          expect.objectContaining({ id: 'good', freshness: 'path' }),
          expect.objectContaining({
            id: 'bad',
            error: expect.any(String),
            errorCode: 'catalogSourceResolutionFailed',
          }),
        ]),
      },
    });
    expect(result.payload.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginName: 'demo',
        sourceId: 'good',
        pluginId: 'good/demo',
        state: 'absent',
      }),
    ]));
  });

  it('shows safe component inspection only for verbose status', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('verbose-components');
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review fixture.\n---\n',
    );
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'skills', 'review', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'review');
    await fs.copy(path.join(sourceRoot, 'plugins', 'demo', 'skills', 'review'), skillRoot);
    await fs.remove(path.join(skillRoot, 'agents', 'openai.yaml'));
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/demo',
        plugin: 'demo',
        artifactKey: 'review',
        platform: 'codex',
        scope: 'project',
      },
    });

    const ordinary = createCapturedCliIo();
    const ordinaryExit = await runCli([
      'status', 'team/demo', '--platform', 'codex', '--scope', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: ordinary.io,
      interactive: false,
    });
    expect(JSON.parse(ordinary.readStdout())).toMatchObject({
      targets: [expect.objectContaining({ state: 'partial', components: [] })],
    });
    expect(ordinaryExit).toBe(0);

    const verbose = createCapturedCliIo();
    expect(await runCli([
      'status', 'team/demo', '--platform', 'codex', '--scope', 'project', '--verbose', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: verbose.io,
      interactive: false,
    })).toBe(0);
    const verbosePayload = JSON.parse(verbose.readStdout()) as {
      targets: Array<{ components: Array<{ error?: { message: string } }> }>;
    };
    expect(verbosePayload).toMatchObject({
      targets: [expect.objectContaining({
        state: 'partial',
        components: expect.arrayContaining([
          expect.objectContaining({ key: 'review', state: 'partial' }),
        ]),
      })],
    });
    expect(JSON.stringify(verbosePayload.targets[0]!.components)).not.toContain(isolation.layout.rootDir);

    const ordinaryHuman = createCapturedCliIo();
    await runCli([
      'status', 'team/demo', '--platform', 'codex', '--scope', 'project',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: ordinaryHuman.io,
      interactive: false,
    });
    expect(ordinaryHuman.readStdout()).not.toContain('component review');

    const human = createCapturedCliIo();
    await runCli([
      'status', 'team/demo', '--platform', 'codex', '--scope', 'project', '--verbose',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: human.io,
      interactive: false,
    });
    expect(human.readStdout()).toContain('component review: partial');
    expect(human.readStdout()).not.toContain(isolation.layout.rootDir);

    await fs.outputFile(path.join(skillRoot, '.agent-workflows-owner.json'), '{ invalid');
    const broken = createCapturedCliIo();
    expect(await runCli([
      'status', 'team/demo', '--platform', 'codex', '--scope', 'project', '--verbose', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: broken.io,
      interactive: false,
    })).toBe(1);
    const brokenPayload = JSON.parse(broken.readStdout()) as {
      targets: Array<{ components: Array<{ error?: { message: string } }> }>;
    };
    expect(brokenPayload).toMatchObject({
      targets: [expect.objectContaining({
        state: 'partial',
        components: expect.arrayContaining([expect.objectContaining({
          key: 'review',
          state: 'partial',
          error: expect.objectContaining({
            code: 'componentInspectionFailed',
            message: expect.any(String),
          }),
        })]),
      })],
    });
    expect(JSON.stringify(brokenPayload.targets[0]!.components)).not.toContain(isolation.layout.rootDir);
  });

  it('emits one init JSON object and a non-zero partial-failure exit code', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('good');
    const bad = fixturePath('bad');
    await Promise.all([createCatalogSnapshotFixture(good), fs.ensureDir(bad)]);
    const env = await configureTwoPaths(good, bad);
    const captured = createCapturedCliIo();

    const exitCode = await runCli(['init', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env,
      io: captured.io,
      interactive: false,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      receiptSchemaVersion: 4,
      command: 'init',
      ok: false,
      sources: expect.arrayContaining([
        expect.objectContaining({ id: 'good', ok: true }),
        expect.objectContaining({ id: 'bad', ok: false }),
      ]),
    });
    expect(captured.readStderr()).toContain('bad:');
  });

  it('projects config read identity and rejects a legacy bare-name store', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('good');
    await createCatalogSnapshotFixture(good);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'good', type: 'path', primary: true, path: good }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    await initCommand({ cliVersion: '1.0.0', env: isolation.env });
    const captured = createCapturedCliIo();

    expect(await runCli(['config', 'list', 'good/demo', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      configSchemaVersion: 4,
      pluginName: 'demo',
      pluginId: 'good/demo',
      sourceId: 'good',
      sourceIdentity: expect.stringMatching(/^sha256:/),
      fields: [],
    });

    await fs.outputJson(
      path.join(isolation.env.AW_HOME!, 'plugin-config', 'demo', 'config.json'),
      { version: 1, values: {} },
    );
    const blocked = createCapturedCliIo();
    expect(await runCli(['config', 'list', 'good/demo', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: blocked.io,
      interactive: false,
    })).toBe(1);
    expect(blocked.readStdout()).toBe('');
    expect(blocked.readStderr()).toContain('legacyStateUnsupported');
  });

  it.each([
    ['init', '--channel', 'latest'],
    ['status', '--catalog-version', '1.0.0'],
    ['install', 'demo', '--platform', 'codex', '--catalog-channel', 'beta'],
  ])('rejects removed public catalog selector flags: %s', async (...argv) => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli(argv, { interactive: false, io: captured.io });
    expect(exitCode).toBe(1);
    expect(captured.readStderr()).toContain('unknown option');
  });

  it('ignores removed catalog environment selectors and resolves the configured source', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('legacy-env-good');
    await createCatalogSnapshotFixture(good);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    const env = {
      ...isolation.env,
      AW_CATALOG_CHANNEL: 'beta',
      AW_CATALOG_VERSION: '99.0.0',
      AW_NPM_REGISTRY_URL: 'https://invalid.example.test/',
    };
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'good', type: 'path', primary: true, path: good }],
      },
      expectedDigest: initial.digest,
      env,
    });

    await expect(initCommand({ cliVersion: '1.0.0', env })).resolves.toMatchObject({
      ok: true,
      primarySourceId: 'good',
      sources: [expect.objectContaining({ id: 'good', freshness: 'path' })],
    });
  });

  it('uses qualified plugin IDs in the multi-source console writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('first');
    const second = fixturePath('second');
    await Promise.all([createCatalogSnapshotFixture(first), createCatalogSnapshotFixture(second)]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          { id: 'first', type: 'path', primary: true, path: first },
          { id: 'second', type: 'path', primary: false, path: second },
        ],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const loaded = await loadConsoleItemsResult({ cwd: isolation.layout.fixtureCwd }, {
      env: isolation.env,
    });

    expect(loaded.catalogUnavailable).toBe(false);
    expect(loaded.items.map((item) => item.pluginName)).toEqual(['first/demo', 'second/demo']);
    const controller = createDashboardController(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: true,
    }));
    await expect(controller.execute('install', loaded.items[0]!.targets[0]!))
      .resolves.toMatchObject({
        overallState: 'succeeded',
        rebuildResults: [expect.objectContaining({
          target: expect.objectContaining({ pluginId: 'first/demo', sourceId: 'first' }),
        })],
      });
  });

  it('applies qualified, ambiguous bare, unknown, and mixed selector semantics', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('first');
    const second = fixturePath('second');
    await Promise.all([createCatalogSnapshotFixture(first), createCatalogSnapshotFixture(second)]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          { id: 'first', type: 'path', primary: true, path: first },
          { id: 'second', type: 'path', primary: false, path: second },
        ],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    const ambiguous = await statusCommandV4({
      plugins: ['demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
    });
    expect(ambiguous.hasErrors).toBe(true);
    expect(ambiguous.payload.targets).toEqual([]);
    expect(ambiguous.payload.errors).toEqual([
      expect.objectContaining({ code: 'ambiguousPlugin' }),
    ]);

    const mixed = await statusCommandV4({
      plugins: ['missing', 'first/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      scope: 'user',
    });
    expect(mixed.hasErrors).toBe(true);
    expect(mixed.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'first/demo', sourceId: 'first' }),
    ]);
    expect(mixed.payload.errors).toEqual([
      expect.objectContaining({ code: 'pluginNotFound' }),
    ]);

    const captured = createCapturedCliIo();
    expect(await runCli(['status', 'demo', 'first/demo', 'missing', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    })).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      schemaVersion: 4,
      targets: expect.arrayContaining([
        expect.objectContaining({ pluginId: 'first/demo' }),
      ]),
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'ambiguousPlugin' }),
        expect.objectContaining({ code: 'pluginNotFound' }),
      ]),
    });
  });

  it('resolves only selector dependencies and withholds a bare match when one source fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('good');
    const bad = fixturePath('missing');
    await createCatalogSnapshotFixture(good);
    const env = await configureTwoPaths(good, bad);

    const qualified = await statusCommandV4({
      plugins: ['good/demo'],
      cwd: isolation.layout.fixtureCwd,
      env,
      cliVersion: '1.0.0',
    });
    expect(qualified.hasErrors).toBe(false);
    expect(qualified.payload.catalog.sources.map((source) => source.id)).toEqual(['good']);
    expect(qualified.payload.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'good/demo' }),
    ]));

    const bare = await statusCommandV4({
      plugins: ['demo'],
      cwd: isolation.layout.fixtureCwd,
      env,
      cliVersion: '1.0.0',
    });
    expect(bare.hasErrors).toBe(true);
    expect(bare.payload.targets).toEqual([]);
    expect(bare.payload.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'catalogSourceUnavailable' }),
    ]));

    const mixed = await statusCommandV4({
      plugins: ['good/demo', 'demo'],
      cwd: isolation.layout.fixtureCwd,
      env,
      cliVersion: '1.0.0',
    });
    expect(mixed.hasErrors).toBe(true);
    expect(mixed.payload.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'good/demo' }),
    ]));
    expect(mixed.payload.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'catalogSourceUnavailable' }),
    ]));
  });

  it('projects supported targets and reports an explicitly unsupported target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const claudeOnly = fixturePath('claude-only');
    await createCatalogSnapshotFixture(
      claudeOnly,
      'demo',
      '0.0.0',
      'demo\n',
      (manifest) => { manifest.marketplace.policy.products = ['CLAUDE']; },
    );
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'local', type: 'path', primary: true, path: claudeOnly }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    const defaultTargets = await statusCommandV4({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
    });
    expect(defaultTargets.payload.targets.map((target) => `${target.platform}/${target.scope}`).sort())
      .toEqual(['claude/project', 'claude/user']);

    const unsupported = await statusCommandV4({
      plugins: ['local/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      scope: 'user',
    });
    expect(unsupported.hasErrors).toBe(true);
    expect(unsupported.payload.targets).toEqual([
      expect.objectContaining({
        pluginId: 'local/demo',
        platform: 'codex',
        scope: 'user',
        state: 'error',
        errors: [expect.objectContaining({ code: 'unsupportedTarget' })],
      }),
    ]);

    const filtered = createCapturedCliIo();
    expect(await runCli(['status', '--platform', 'codex', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: filtered.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(filtered.readStdout())).toMatchObject({
      schemaVersion: 4,
      targets: [],
      errors: [],
    });

    const explicitlyUnsupported = createCapturedCliIo();
    expect(await runCli(['status', 'local/demo', '--platform', 'codex', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: explicitlyUnsupported.io,
      interactive: false,
    })).toBe(1);
    expect(JSON.parse(explicitlyUnsupported.readStdout())).toMatchObject({
      targets: expect.arrayContaining([expect.objectContaining({
        pluginId: 'local/demo',
        state: 'error',
        errors: [expect.objectContaining({ code: 'unsupportedTarget' })],
      })]),
    });
  });

  it('uses the Codex project managed-artifact capability for target support', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const codexOnly = fixturePath('codex-only');
    await createCatalogSnapshotFixture(
      codexOnly,
      'demo',
      '0.0.0',
      'demo\n',
      (manifest) => { manifest.marketplace.policy.products = ['CODEX']; },
    );
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'local', type: 'path', primary: true, path: codexOnly }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    const result = await statusCommandV4({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
    });
    expect(result.payload.targets.map((target) => `${target.platform}/${target.scope}`))
      .toEqual(['codex/user']);

    const unsupported = await statusCommandV4({
      plugins: ['local/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      scope: 'project',
    });
    expect(unsupported.payload.targets).toEqual([
      expect.objectContaining({ state: 'error', errors: [expect.objectContaining({ code: 'unsupportedTarget' })] }),
    ]);

    const projectCapable = fixturePath('codex-project-capable');
    await fs.outputFile(
      path.join(projectCapable, 'plugins', 'demo', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: demo\n---\n',
    );
    await createCatalogSnapshotFixture(
      projectCapable,
      'demo',
      '0.0.0',
      'demo\n',
      (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.skills = './skills';
      },
    );
    const current = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'local', type: 'path', primary: true, path: projectCapable }],
      },
      expectedDigest: current.digest,
      env: isolation.env,
    });
    const supported = await statusCommandV4({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
    });
    expect(supported.payload.targets.map((target) => `${target.platform}/${target.scope}`))
      .toEqual(['codex/user', 'codex/project']);
  });

  it('lists and reports a missing persisted path, then updates it to a valid path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const missing = fixturePath('missing');
    const valid = fixturePath('valid');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'local', type: 'path', primary: true, path: missing }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    await expect(listCatalogSources({ env: isolation.env })).resolves.toMatchObject({
      sources: [{ id: 'local', sourceIdentity: expect.stringMatching(/^sha256:/) }],
    });
    const unavailable = await statusCommandV4({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
    });
    expect(unavailable.payload.catalog.sources).toEqual([
      expect.objectContaining({ id: 'local', error: expect.any(String) }),
    ]);

    await createCatalogSnapshotFixture(valid);
    await expect(updateCatalogSourceCommand({
      sourceId: 'local',
      update: { type: 'path', path: valid },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ ok: true, sourceId: 'local' });
  });

  it('runs namespaced writes and returns v4 config failures', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('good');
    await createCatalogSnapshotFixture(good);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'good', type: 'path', primary: true, path: good }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const captured = createCapturedCliIo();

    expect(await runCli(['install', 'demo', '--platform', 'codex', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      receiptSchemaVersion: 4,
      ok: true,
      overallState: 'succeeded',
      targets: [expect.objectContaining({
        pluginName: 'demo',
        platform: 'codex',
        scope: 'user',
        status: 'succeeded',
      })],
      errors: [],
    });

    const config = createCapturedCliIo();
    expect(await runCli(['config', 'set', 'good/demo', 'key', 'value', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: config.io,
      interactive: false,
    })).toBe(1);
    expect(JSON.parse(config.readStdout())).toMatchObject({
      receiptSchemaVersion: 4,
      command: 'config:set',
      ok: false,
      overallState: 'failed',
      errors: [expect.objectContaining({ code: 'configSchemaUnavailable' })],
    });
  });

  it.each(['codex', 'claude'] as const)(
    'keeps an error target when a %s status probe config file is invalid',
    async (platform) => {
      const isolation = getCurrentSourceTestIsolation();
      const good = fixturePath('good');
      await createCatalogSnapshotFixture(good);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 1,
          sources: [{ id: 'good', type: 'path', primary: true, path: good }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const invalidPath = platform === 'codex'
        ? path.join(isolation.env.AW_CODEX_HOME!, 'config.toml')
        : path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
      await fs.outputFile(invalidPath, platform === 'codex' ? '[invalid' : '{invalid');
      const captured = createCapturedCliIo();

      expect(await runCli(['status', 'good/demo', '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
      })).toBe(1);
      expect(JSON.parse(captured.readStdout())).toMatchObject({
        schemaVersion: 4,
        targets: expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'good/demo',
            state: 'error',
            errors: expect.arrayContaining([
              expect.objectContaining({ code: expect.any(String) }),
            ]),
          }),
        ]),
      });
      expect(captured.readStdout().trim().split('\n').filter(Boolean).length).toBeGreaterThan(0);
      expect(captured.readStderr()).toBe('');
    },
  );

  it.each(['codex', 'claude'] as const)(
    'keeps qualified config list/get available when unrelated %s config is invalid',
    async (platform) => {
      const isolation = getCurrentSourceTestIsolation();
      const good = fixturePath('config-readable');
      await createCatalogSnapshotFixture(
        good,
        'demo',
        '0.0.0',
        'demo\n',
        (manifest) => {
          manifest.config = { schema: { mode: { type: 'string', default: 'fast' } } };
        },
      );
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 1,
          sources: [{ id: 'good', type: 'path', primary: true, path: good }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const invalidPath = platform === 'codex'
        ? path.join(isolation.env.AW_CODEX_HOME!, 'config.toml')
        : path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
      await fs.outputFile(invalidPath, platform === 'codex' ? '[invalid' : '{invalid');

      for (const args of [
        ['config', 'list', 'good/demo', '--json'],
        ['config', 'get', 'good/demo', 'mode', '--json'],
      ]) {
        const captured = createCapturedCliIo();
        expect(await runCli(args, {
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
          io: captured.io,
          interactive: false,
        })).toBe(0);
        expect(JSON.parse(captured.readStdout())).toMatchObject({
          ok: true,
          configSchemaVersion: 4,
          pluginId: 'good/demo',
          fields: [expect.objectContaining({ key: 'mode' })],
        });
        expect(captured.readStderr()).toBe('');
      }
    },
  );

  it('redacts invalid Git snapshot paths from init and status source errors', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const invalidRepository = fixturePath('invalid-git-catalog');
    await Promise.all([
      fs.ensureDir(path.join(invalidRepository, '.agents')),
      fs.ensureDir(path.join(invalidRepository, '.claude-plugin')),
      fs.ensureDir(path.join(invalidRepository, 'plugins')),
    ]);
    await fs.outputFile(path.join(invalidRepository, 'catalog-manifest.json'), '{invalid');
    await git(invalidRepository, ['init', '--initial-branch=main']);
    await git(invalidRepository, ['config', 'user.email', 'test@example.test']);
    await git(invalidRepository, ['config', 'user.name', 'AW Test']);
    await git(invalidRepository, ['add', '.']);
    await git(invalidRepository, ['commit', '-m', 'invalid catalog']);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{
          id: 'broken',
          type: 'git',
          primary: true,
          url: invalidRepository,
          refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
        }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    for (const args of [['init', '--json'], ['status', '--json']]) {
      const captured = createCapturedCliIo();
      expect(await runCli(args, {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
      })).toBe(1);
      const stdout = captured.readStdout();
      expect(JSON.parse(stdout)).toMatchObject(args[0] === 'init'
        ? { sources: [expect.objectContaining({ id: 'broken', errorCode: expect.any(String) })] }
        : { catalog: { sources: [expect.objectContaining({ id: 'broken', errorCode: expect.any(String) })] } });
      for (const secret of [
        isolation.env.AW_HOME!,
        invalidRepository,
        'catalog-cache',
        '.materialize-',
      ]) expect(`${stdout}${captured.readStderr()}`).not.toContain(secret);
    }
  });

  it('redacts a missing path source outside managed and temporary roots from init/status errors', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const missingSource = path.join(path.parse(isolation.repositoryCwd).root, 'aw-review5-missing-catalog');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'private-path', type: 'path', primary: true, path: missingSource }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    await expect(listCatalogSources({ env: isolation.env })).resolves.toMatchObject({
      sources: [{ id: 'private-path', path: missingSource }],
    });

    for (const args of [['init', '--json'], ['status', '--json']]) {
      const captured = createCapturedCliIo();
      expect(await runCli(args, {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
      })).toBe(1);
      const stdout = captured.readStdout();
      expect(JSON.parse(stdout)).toMatchObject(args[0] === 'init'
        ? { sources: [expect.objectContaining({ id: 'private-path', errorCode: expect.any(String) })] }
        : { catalog: { sources: [expect.objectContaining({ id: 'private-path', errorCode: expect.any(String) })] } });
      expect(`${stdout}${captured.readStderr()}`).not.toContain(missingSource);
    }
  });

  it('exposes qualified multi-source config mutations in the dashboard', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('configurable');
    await createCatalogSnapshotFixture(
      good,
      'demo',
      '0.0.0',
      'demo\n',
      (manifest) => {
        manifest.config = { schema: { mode: { type: 'string', default: 'fast' } } };
      },
    );
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'good', type: 'path', primary: true, path: good }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const loaded = await loadConsoleItemsResult({ cwd: isolation.layout.fixtureCwd }, {
      env: isolation.env,
    });
    const item = loaded.items[0]!;
    const target = item.targets[0]!;
    expect(item).toMatchObject({
      pluginName: 'good/demo',
      pluginSummary: {
        description: 'demo plugin',
        configSchema: { mode: { type: 'string', default: 'fast' } },
      },
    });
    expect(item.plugin).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain('rootDir');
    expect(dashboardActions(item, target)).toContain('config');

    const controller = createDashboardController(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: true,
    }));
    await expect(controller.readConfig(item, { scope: 'user', projectLayer: 'shared' }))
      .resolves.toMatchObject({
        model: { pluginName: 'demo' },
        read: { fields: [expect.objectContaining({ key: 'mode', effectiveValue: 'fast' })] },
      });
    await expect(controller.saveConfig(item, { scope: 'user', projectLayer: 'shared' }, {
      updates: { mode: 'slow' },
    })).resolves.toMatchObject({ configWrite: 'succeeded', updatedKeys: ['mode'] });
    await expect(controller.resetConfig(item, { scope: 'user', projectLayer: 'shared' }))
      .resolves.toMatchObject({ configWrite: 'succeeded', deleted: true });
  });
});
