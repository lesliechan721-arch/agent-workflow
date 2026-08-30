import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { initCommand } from '../../src/commands/init.js';
import {
  listCatalogSources,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import { loadConsoleItemsResult, statusCommandV5 } from '../../src/commands/status-v5.js';
import { runCli } from '../../src/index.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { refreshCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
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
      schemaVersion: 2,
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
  it('keeps init --force usable when old cache cleanup reports a failure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('force-cleanup-warning');
    await createCatalogSnapshotFixture(root);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: root }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    await expect(initCommand({
      force: true,
      cliVersion: '1.0.0',
      env: isolation.env,
      runtime: { cleanupLegacyCache: async () => ['旧 Catalog cache 布局清理失败：selectors'] },
    })).resolves.toMatchObject({
      ok: true,
      warnings: ['旧 Catalog cache 布局清理失败：selectors'],
      sources: [expect.objectContaining({ id: 'local', ok: true })],
    });
  });

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
        expect.objectContaining({ id: 'good', ok: true, freshness: 'active' }),
        expect.objectContaining({
          id: 'bad',
          ok: false,
          error: expect.any(String),
          errorCode: 'catalogGenerationUnavailable',
        }),
      ]),
    });
    expect(result.configDigest).toMatch(/^sha256:/);
    expect(result.compositeDigest).toMatch(/^sha256:/);
  });

  it('keeps a source loadable when one catalog entry requires a future capability', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const incompatible = fixturePath('incompatible');
    await createCatalogSnapshotFixture(incompatible, 'demo', ['aw.future-feature.v99']);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
    })).toBe(0);
    expect(JSON.parse(initOutput.readStdout())).toMatchObject({
      sources: [expect.objectContaining({
        id: 'local',
        ok: true,
      })],
    });

    const statusOutput = createCapturedCliIo();
    expect(await runCli(['status', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: statusOutput.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(statusOutput.readStdout())).toMatchObject({
      catalog: {
        sources: [expect.objectContaining({
          id: 'local',
          freshness: 'active',
        })],
      },
      targets: expect.arrayContaining([expect.objectContaining({
        state: 'error',
        errors: [expect.objectContaining({
          code: 'awCapabilityUnsupported',
          severity: 'warning',
        })],
      })]),
    });
  });

  it('reports status schema 5 and continues after one source failure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('good');
    const bad = fixturePath('bad');
    await Promise.all([createCatalogSnapshotFixture(good), fs.ensureDir(bad)]);
    const env = await configureTwoPaths(good, bad);

    const result = await statusCommandV5({
      cwd: isolation.layout.fixtureCwd,
      env,
      cliVersion: '1.0.0',
      json: true,
    });

    expect(result.hasErrors).toBe(true);
    expect(result.payload).toMatchObject({
      schemaVersion: 5,
      catalog: {
        primarySourceId: 'good',
        configDigest: expect.stringMatching(/^sha256:/),
        compositeDigest: expect.stringMatching(/^sha256:/),
        sources: expect.arrayContaining([
          expect.objectContaining({ id: 'good', freshness: 'active' }),
          expect.objectContaining({
            id: 'bad',
            error: expect.any(String),
            errorCode: 'catalogGenerationUnavailable',
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
    expect(result.targetRevisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'good/demo',
        revision: expect.objectContaining({ state: 'unknown', availableVersion: '1.0.0' }),
      }),
    ]));
    expect(JSON.parse(result.output)).not.toHaveProperty('targetRevisions');
  });

  it('keeps typed config preflight details internal and isolates a safe read diagnostic', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = fixturePath('status-config-preflight');
    await createCatalogSnapshotFixture(root, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = { schema: { rules: { type: 'string', title: '规则', required: true } } };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'good', type: 'path', primary: true, path: root }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    const missing = await statusCommandV5({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', json: true,
    });
    expect(missing.pluginSummaries[0]?.configIssues).toEqual([
      { type: 'missing-required', key: 'rules', title: '规则', source: 'missing' },
    ]);
    expect(JSON.parse(missing.output)).not.toHaveProperty('pluginSummaries');

    await fs.outputFile(path.join(
      isolation.env.AW_HOME!, 'plugin-config', 'good', 'demo', 'config.json',
    ), '{ private invalid config');
    const unreadable = await statusCommandV5({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', json: true,
    });
    expect(unreadable.pluginSummaries[0]?.configDiagnostic).toEqual({
      code: 'configReadFailed',
      message: '插件设置当前不可读。未读取或显示设置值。',
    });
    expect(JSON.stringify(unreadable)).not.toContain('private invalid config');
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
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
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

    const ordinaryConsole = await loadConsoleItemsResult({
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env });
    const verboseConsole = await loadConsoleItemsResult({
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      verbose: true,
    }, { env: isolation.env });
    expect(ordinaryConsole.items.find((item) => item.pluginName === 'team/demo')?.targets[0]?.components)
      .toEqual([]);
    expect(verboseConsole.items.find((item) => item.pluginName === 'team/demo')?.targets[0]?.components)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'review', state: 'partial' }),
      ]));
    expect(JSON.stringify(
      verboseConsole.items.flatMap((item) => item.targets.flatMap((target) => target.components)),
    )).not.toContain(isolation.layout.rootDir);

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
      targets: [expect.objectContaining({ state: 'absent', errors: [] })],
    });
    expect(brokenPayload.targets[0]!.components)
      .not.toContainEqual(expect.objectContaining({ key: 'review' }));
    expect(await statusCommandV5({
      plugins: ['team/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      json: true,
      verbose: true,
    })).toMatchObject({ hasErrors: true });
    expect(JSON.stringify(brokenPayload.targets[0]!.components)).not.toContain(isolation.layout.rootDir);

    const collisionHuman = createCapturedCliIo();
    await runCli([
      'status', 'team/demo', '--platform', 'codex', '--scope', 'project', '--verbose',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: collisionHuman.io,
      interactive: false,
    });
    expect(collisionHuman.readStdout()).not.toContain('component review');
    expect(collisionHuman.readStdout()).not.toContain('请移除或迁移冲突内容后重试');
    expect(collisionHuman.readStdout()).not.toContain(isolation.layout.rootDir);
  });

  it('keeps owned incomplete evidence partial when another required artifact collides', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('partial-collision');
    for (const skillName of ['owned', 'collision']) {
      await fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'skills', skillName, 'SKILL.md'),
        `---\nname: ${skillName}\ndescription: ${skillName} fixture.\n---\n`,
      );
      await fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'skills', skillName, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      );
    }
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const ownedRoot = path.join(skillsRoot, 'owned');
    await fs.copy(path.join(sourceRoot, 'plugins', 'demo', 'skills', 'owned'), ownedRoot);
    await fs.remove(path.join(ownedRoot, 'SKILL.md'));
    await writeSkillOwnerMarker({
      skillRoot: ownedRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity, pluginId: 'team/demo', plugin: 'demo',
        artifactKey: 'owned', platform: 'codex', scope: 'project',
      },
    });
    await fs.outputFile(path.join(skillsRoot, 'collision', 'foreign.txt'), 'keep\n');

    const result = await statusCommandV5({
      plugins: ['team/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      json: true,
      verbose: true,
    });
    expect(result.payload).toMatchObject({
      schemaVersion: 5,
      targets: [expect.objectContaining({
        state: 'partial',
        errors: [],
        components: expect.arrayContaining([
          expect.objectContaining({ key: 'owned', state: 'partial' }),
        ]),
      })],
    });
    expect(result.payload.targets[0]!.components)
      .not.toContainEqual(expect.objectContaining({ key: 'collision' }));
    expect(JSON.stringify(result.payload.targets[0]!.errors)).not.toContain(isolation.layout.rootDir);
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
        schemaVersion: 2,
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

  it('uses qualified plugin IDs in the multi-source console writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('first');
    const second = fixturePath('second');
    await Promise.all([createCatalogSnapshotFixture(first), createCatalogSnapshotFixture(second)]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
  });

  it('applies qualified, ambiguous bare, unknown, and mixed selector semantics', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = fixturePath('first');
    const second = fixturePath('second');
    await Promise.all([createCatalogSnapshotFixture(first), createCatalogSnapshotFixture(second)]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'first', type: 'path', primary: true, path: first },
          { id: 'second', type: 'path', primary: false, path: second },
        ],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    const ambiguous = await statusCommandV5({
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

    const mixed = await statusCommandV5({
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
      schemaVersion: 5,
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

    const qualified = await statusCommandV5({
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

    const bare = await statusCommandV5({
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

    const mixed = await statusCommandV5({
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

  it('does not let another source inventory error hide a qualified missing selector', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('inventory-unrelated-good');
    await createCatalogSnapshotFixture(good, 'foo');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'good', type: 'path', primary: true, path: good }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    await fs.outputFile(path.join(
      isolation.env.AW_HOME!,
      'plugin-config',
      'other',
      'demo',
      'config.json',
    ), '{');

    const result = await statusCommandV5({
      plugins: ['missing/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
    });

    expect(result.hasErrors).toBe(true);
    expect(result.payload.targets).toEqual([]);
    expect(result.payload.errors).toContainEqual(expect.objectContaining({ code: 'pluginNotFound' }));
    expect(result.payload.errors).not.toContainEqual(expect.objectContaining({ code: 'stateInventoryFailed' }));
  });

  it('keeps each parsed selector relevant without suppressing another selector failure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('inventory-own-error-good');
    await createCatalogSnapshotFixture(good, 'foo');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'good', type: 'path', primary: true, path: good }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    await fs.outputFile(path.join(
      isolation.env.AW_HOME!,
      'plugin-config',
      'missing',
      'demo',
      'config.json',
    ), '{');

    const result = await statusCommandV5({
      plugins: ['good/foo', 'missing/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
    });

    expect(result.hasErrors).toBe(true);
    expect(result.payload.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'good/foo' }),
    ]));
    expect(result.payload.errors).toContainEqual(expect.objectContaining({ code: 'stateInventoryFailed' }));
    expect(result.payload.errors).not.toContainEqual(expect.objectContaining({ code: 'pluginNotFound' }));
  });

  it('projects supported targets and reports an explicitly unsupported target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const claudeOnly = fixturePath('claude-only');
    await createCatalogSnapshotFixture(
      claudeOnly,
      'demo',
      [],
      'demo\n',
      (manifest) => { manifest.marketplace.policy.products = ['CLAUDE']; },
    );
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: claudeOnly }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    const defaultTargets = await statusCommandV5({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
    });
    expect(defaultTargets.payload.targets.map((target) => `${target.platform}/${target.scope}`).sort())
      .toEqual(['claude/project', 'claude/user']);

    const unsupported = await statusCommandV5({
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
      schemaVersion: 5,
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
      [],
      'demo\n',
      (manifest) => { manifest.marketplace.policy.products = ['CODEX']; },
    );
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: codexOnly }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    const result = await statusCommandV5({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
    });
    expect(result.payload.targets.map((target) => `${target.platform}/${target.scope}`))
      .toEqual(['codex/user']);

    const unsupported = await statusCommandV5({
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
      [],
      'demo\n',
      (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.skills = './skills';
      },
    );
    const current = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: projectCapable }],
      },
      expectedDigest: current.digest,
      env: isolation.env,
    });
    await refreshCatalogSourceGeneration({
      sourceId: 'local', cliVersion: '1.0.0', env: isolation.env,
    });
    const supported = await statusCommandV5({
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
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: missing }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    await expect(listCatalogSources({ env: isolation.env })).resolves.toMatchObject({
      sources: [{ id: 'local', sourceIdentity: expect.stringMatching(/^sha256:/) }],
    });
    const unavailable = await statusCommandV5({
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
        schemaVersion: 2,
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
          schemaVersion: 2,
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
      const payload = JSON.parse(captured.readStdout());
      expect(payload).toMatchObject({ schemaVersion: 5 });
      expect(payload.targets).toEqual(expect.arrayContaining([
        platform === 'codex'
          ? expect.objectContaining({
              pluginId: 'good/demo', platform: 'codex', state: 'absent', errors: [],
            })
          : expect.objectContaining({
              pluginId: 'good/demo',
              state: 'error',
              errors: expect.arrayContaining([
                expect.objectContaining({ code: expect.any(String) }),
              ]),
            }),
      ]));
      expect(captured.readStdout().trim().split('\n').filter(Boolean).length).toBeGreaterThan(0);
      expect(captured.readStderr()).toBe('');
    },
  );

  it('does not project an unrelated Codex user inventory failure into a Claude project query', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('filtered-status-inventory');
    await createCatalogSnapshotFixture(good);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'good', type: 'path', primary: true, path: good }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const unrelatedPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    await fs.outputFile(unrelatedPath, '[invalid');

    const result = await statusCommandV5({
      plugins: ['good/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'claude',
      scope: 'project',
      json: true,
    });

    expect(result.hasErrors).toBe(false);
    expect(result.payload.errors).toEqual([]);
    expect(result.payload.targets).toEqual([
      expect.objectContaining({
        pluginId: 'good/demo',
        platform: 'claude',
        scope: 'project',
        state: 'absent',
      }),
    ]);
    expect(result.output).not.toContain('config.toml');
    expect(result.output).not.toContain(unrelatedPath);
  });

  it('does not project another plugin Codex residue failure into a Claude project query', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = fixturePath('filtered-codex-residue');
    await createCatalogSnapshotFixture(sourceRoot);
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await Promise.all([
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity,
        marketplaceName: 'aw-team',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
        name: 'aw-team', owner: {}, interface: {}, plugins: [],
      }),
      fs.outputJson(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), {
        name: 'aw-team', owner: {}, interface: {}, plugins: [],
      }),
      fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
        '[marketplaces.aw-team]',
        `source = ${JSON.stringify(marketplaceRoot)}`,
        'source_type = "local"',
        '',
      ].join('\n')),
      fs.outputFile(path.join(
        isolation.env.AW_CODEX_HOME!,
        'plugins',
        'other@aw-team',
        'manifest.json',
      ), '{'),
    ]);

    const result = await statusCommandV5({
      plugins: ['team/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'claude',
      scope: 'project',
      json: true,
    });

    expect(result.hasErrors).toBe(false);
    expect(result.payload.errors).toEqual([]);
    expect(result.payload.targets).toEqual([
      expect.objectContaining({
        pluginId: 'team/demo',
        platform: 'claude',
        scope: 'project',
      }),
    ]);
  });

  it('does not project an invalid project config store into an explicit user status query', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('user-status-project-config-error');
    await createCatalogSnapshotFixture(good);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'good', type: 'path', primary: true, path: good }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    await fs.outputFile(path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-config.local',
      'good',
      'demo',
      'config.json',
    ), '{');

    const result = await statusCommandV5({
      plugins: ['good/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      scope: 'user',
    });

    expect(result.payload.errors).not.toContainEqual(expect.objectContaining({
      code: 'stateInventoryFailed',
    }));
  });

  it.each([
    ['user', 'project', (isolation: ReturnType<typeof getCurrentSourceTestIsolation>) =>
      path.join(isolation.env.AW_HOME!, 'plugin-config')],
    ['project', 'user', (isolation: ReturnType<typeof getCurrentSourceTestIsolation>) =>
      path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-config')],
  ] as const)(
    'does not project an invalid %s config root into an explicit %s status query',
    async (_invalidScope, selectedScope, configRoot) => {
      const isolation = getCurrentSourceTestIsolation();
      const good = fixturePath(`status-${_invalidScope}-config-root-error`);
      await createCatalogSnapshotFixture(good);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'good', type: 'path', primary: true, path: good }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      await fs.outputFile(configRoot(isolation), 'not a directory\n');

      const result = await statusCommandV5({
        plugins: ['good/demo'],
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        cliVersion: '1.0.0',
        platform: 'codex',
        scope: selectedScope,
      });

      expect(result.payload.errors).not.toContainEqual(expect.objectContaining({
        code: 'stateInventoryFailed',
      }));
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
        [],
        'demo\n',
        (manifest) => {
          manifest.config = { schema: { mode: { type: 'string', default: 'fast' } } };
        },
      );
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
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
        schemaVersion: 2,
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
        schemaVersion: 2,
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
      [],
      'demo\n',
      (manifest) => {
        manifest.config = { schema: { mode: { type: 'string', default: 'fast' } } };
      },
    );
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'good', type: 'path', primary: true, path: good }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const loaded = await loadConsoleItemsResult({ cwd: isolation.layout.fixtureCwd }, {
      env: isolation.env,
    });
    const item = loaded.items[0]!;
    expect(item).toMatchObject({
      pluginName: 'good/demo',
      pluginSummary: {
        description: 'demo plugin',
        configSchema: { mode: { type: 'string', default: 'fast' } },
      },
    });
    expect(JSON.stringify(item)).not.toContain('rootDir');
  });
});
