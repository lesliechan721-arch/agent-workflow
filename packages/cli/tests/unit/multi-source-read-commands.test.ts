import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { initCommand } from '../../src/commands/init.js';
import {
  listCatalogSources,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import { loadConsoleItemsResult, statusCommandV8 } from '../../src/commands/status-v6.js';
import { runCli } from '../../src/index.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { setNativeCliRunnerOverrideForTests } from '../../src/utils/native-cli.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
} from '../../src/utils/catalog-sources.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';

function fixturePath(name: string): string {
  return path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
}

async function ensureProjectRepository(): Promise<void> {
  await git(getCurrentSourceTestIsolation().layout.fixtureCwd, ['init', '--initial-branch=main']);
}

async function declarePlugin(pluginId: string, agents: Array<'codex' | 'claude'>,
  scope: 'user' | 'project' = 'user'): Promise<void> {
  const isolation = getCurrentSourceTestIsolation();
  await writeIntentFixture({ scope, cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
    roots: [{ pluginId }], agents,
  });
}

async function replaceCatalogSourcesConfig(
  options: Parameters<typeof replaceCatalogSourcesConfigWithoutActive>[0],
) {
  const replaced = await replaceCatalogSourcesConfigWithoutActive(options);
  for (const source of options.config.sources.filter((entry) => entry.type === 'path')) {
    await syncCatalogSourceGeneration({
      sourceId: source.id,
      cliVersion: '1.0.0',
      env: options.env,
    }).catch(() => undefined);
  }
  return replaced;
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

async function withSuccessfulCodexPluginList<T>(operation: () => Promise<T>): Promise<T> {
  setNativeCliRunnerOverrideForTests(async (invocation) => ({
    exitCode: 0,
    stdout: invocation.args.includes('--version') ? 'codex-cli 0.200.0'
      : JSON.stringify({ installed: [], available: [] }),
    stderr: '',
  }));
  try {
    return await operation();
  } finally {
    setNativeCliRunnerOverrideForTests(null);
  }
}

describe('multi-source read commands', () => {
  it('reports each offline Active source when another source is unavailable', async () => {
    const good = fixturePath('good');
    const bad = fixturePath('bad');
    await Promise.all([createCatalogSnapshotFixture(good), fs.ensureDir(bad)]);
    const env = await configureTwoPaths(good, bad);

    const result = await initCommand({ env });

    expect(result).toMatchObject({
      ok: false,
      primarySourceId: 'good',
      sources: expect.arrayContaining([
        expect.objectContaining({ id: 'good', ok: true, activeReady: true }),
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

  it('reports the default unavailable source without writing config, state, or store', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    const exitCode = await runCli(['plugin', 'list', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    });
    const result = JSON.parse(captured.readStdout());

    expect(exitCode).toBe(3);
    expect(result).toMatchObject({
      schemaVersion: 1, command: 'plugin.list', status: 'blocked',
      data: { items: [], coverage: { sources: [], complete: false } },
      diagnostics: [{ code: 'sourceActiveUnavailable', subject: { sourceId: 'official' } }],
    });
    for (const relativePath of ['catalog-sources.json', 'catalog-state.json', 'catalog-store']) {
      await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, relativePath))).resolves.toBe(false);
    }
  });

  it('keeps a source loadable when one catalog entry requires a future capability', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const incompatible = fixturePath('incompatible');
    await createCatalogSnapshotFixture(incompatible, 'demo', ['aw.future-feature.v99'], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: incompatible }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    const listOutput = createCapturedCliIo();
    expect(await runCli(['plugin', 'list', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: listOutput.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(listOutput.readStdout())).toMatchObject({
      command: 'plugin.list', status: 'success', data: { items: [expect.objectContaining({ pluginId: 'local/demo' })] },
    });

    await declarePlugin('local/demo', ['codex']);

    const statusOutput = createCapturedCliIo();
    expect(await runCli(['plugin', 'status', '--context', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: statusOutput.io,
      interactive: false,
    })).toBe(3);
    expect(JSON.parse(statusOutput.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.status', status: 'blocked', data: { context: 'user',
        inventory: [expect.objectContaining({ pluginId: 'local/demo', targetResults: [expect.objectContaining({
          delivery: { kind: 'native', platform: 'codex' }, content: 'unknown',
        })] })],
      },
    });
    const backend = await statusCommandV8({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
      env: isolation.env, platform: 'codex', scope: 'user', cliVersion: '1.0.0',
    });
    expect(backend.payload.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'awCapabilityUnsupported' }),
      ]) }),
    ]));
  });

  it('reports status schema 8 and continues after one source failure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('good');
    const bad = fixturePath('bad');
    await Promise.all([createCatalogSnapshotFixture(good), fs.ensureDir(bad)]);
    const env = await configureTwoPaths(good, bad);

    const result = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd,
      env,
      cliVersion: '1.0.0',
      json: true,
    });

    expect(result.hasErrors).toBe(true);
    expect(result.payload).toMatchObject({
      schemaVersion: 8,
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
      manifest.config = { fields: { rules: { type: 'string', title: '规则', required: true } } };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'good', type: 'path', primary: true, path: root }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });

    const missing = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', json: true,
    });
    expect(missing.pluginSummaries[0]?.configIssues).toEqual([
      { platform: 'codex', scope: 'user', type: 'missing-required', key: 'rules', title: '规则', source: 'missing' },
      { platform: 'codex', scope: 'project', type: 'missing-required', key: 'rules', title: '规则', source: 'missing' },
      { platform: 'claude', scope: 'user', type: 'missing-required', key: 'rules', title: '规则', source: 'missing' },
      { platform: 'claude', scope: 'project', type: 'missing-required', key: 'rules', title: '规则', source: 'missing' },
    ]);
    expect(JSON.parse(missing.output)).not.toHaveProperty('pluginSummaries');

    await fs.outputFile(path.join(
      isolation.env.AW_HOME!, 'plugin-config', 'good', 'demo', 'config.json',
    ), '{ private invalid config');
    const unreadable = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', json: true,
    });
    expect(unreadable.pluginSummaries[0]?.configDiagnostic).toEqual({
      scope: 'user',
      code: 'configReadFailed',
      message: '插件设置当前不可读。未读取或显示设置值。',
    });
    expect(JSON.stringify(unreadable)).not.toContain('private invalid config');
  });

  it('keeps unobserved Codex output out of ready state and reports damaged legacy Project Skill markers safely', () => withSuccessfulCodexPluginList(async () => {
    // A legacy project Skill is not Native installation evidence. Keep the
    // Codex version probe explicitly unavailable while testing safe diagnostics.
    setNativeCliRunnerOverrideForTests(async (invocation) => invocation.args.includes('--version')
      ? { exitCode: 1, stdout: '', stderr: 'Fixture Codex version is unavailable.' }
      : { exitCode: 0, stdout: JSON.stringify({ installed: [], available: [] }), stderr: '' });
    const isolation = getCurrentSourceTestIsolation();
    await ensureProjectRepository();
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
      manifest.platforms = ['codex'];
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

    await declarePlugin('team/demo', ['codex'], 'project');

    const ordinary = createCapturedCliIo();
    const ordinaryExit = await runCli([
      'plugin', 'status', '--context', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: ordinary.io,
      interactive: false,
    });
    expect(JSON.parse(ordinary.readStdout()).data).toMatchObject({
      inventory: [expect.objectContaining({
        pluginId: 'team/demo',
        targetResults: [expect.objectContaining({ content: 'unknown' })],
      })],
    });
    expect(ordinaryExit).toBe(3);

    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
    const ordinaryPayload = JSON.parse(ordinary.readStdout()).data;
    expect(ordinaryPayload.coverage.currentProject).toBe(true);
    expect(JSON.stringify(ordinaryPayload.inventory)).not.toContain(isolation.layout.rootDir);

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
    expect(ordinaryConsole.items.find((item) => item.pluginName === 'team/demo')?.targets[0]?.state)
      .not.toBe('ready');
    expect(verboseConsole.items.find((item) => item.pluginName === 'team/demo')?.targets[0]?.state)
      .toBe(ordinaryConsole.items.find((item) => item.pluginName === 'team/demo')?.targets[0]?.state);
    expect(ordinaryConsole.items.find((item) => item.pluginName === 'team/demo')?.targets[0]?.components)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'review' }),
      ]));
    expect(verboseConsole.items.find((item) => item.pluginName === 'team/demo')?.targets[0]?.components)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'review' }),
      ]));
    expect(JSON.stringify(
      verboseConsole.items.flatMap((item) => item.targets.flatMap((target) => target.components)),
    )).not.toContain(isolation.layout.rootDir);

    const ordinaryHuman = createCapturedCliIo();
    await runCli([
      'plugin', 'status', '--context', 'project',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: ordinaryHuman.io,
      interactive: false,
    });
    expect(ordinaryHuman.readStdout()).not.toContain('component review');

    const markerPath = path.join(skillRoot, '.agent-workflows-owner.json');
    const skillBytes = await fs.readFile(path.join(skillRoot, 'SKILL.md'));
    await fs.outputFile(markerPath, '{ invalid');
    const broken = createCapturedCliIo();
    expect(await runCli([
      'plugin', 'status', '--context', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: broken.io,
      interactive: false,
    })).toBe(3);
    const brokenResult = JSON.parse(broken.readStdout());
    expect(brokenResult).toMatchObject({ command: 'plugin.status', status: 'blocked' });
    const brokenPayload = brokenResult.data as {
      inventory: Array<{ targetResults: Array<{ backend?: unknown }> }>;
    };
    expect(brokenPayload).toMatchObject({
      inventory: [expect.objectContaining({ targetResults: [expect.objectContaining({ content: 'unknown' })] })],
    });
    expect(JSON.stringify(brokenPayload.inventory[0]!.targetResults)).not.toContain('"key":"review"');
    const brokenNative = await statusCommandV8({
      plugins: ['team/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      json: true,
      verbose: true,
    });
    expect(brokenNative.payload.targets[0]?.components)
      .not.toContainEqual(expect.objectContaining({ key: 'review' }));
    expect(JSON.stringify(brokenNative.payload.targets[0]?.components)).not.toContain(isolation.layout.rootDir);
    expect(JSON.stringify(brokenPayload.inventory[0]!.targetResults)).not.toContain(isolation.layout.rootDir);

    const collisionHuman = createCapturedCliIo();
    await runCli([
      'plugin', 'status', '--context', 'project',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: collisionHuman.io,
      interactive: false,
    });
    expect(collisionHuman.readStdout()).not.toContain('component review');
    expect(collisionHuman.readStdout()).not.toContain('请移除或迁移冲突内容后重试');
    expect(collisionHuman.readStdout()).toContain('BLOCKED');
    expect(collisionHuman.readStdout()).not.toMatch(/[\u3400-\u9fff]/u);
    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('{ invalid');
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'))).resolves.toEqual(skillBytes);
  }));

  it('ignores marker-only and foreign static project Skill directories', () => withSuccessfulCodexPluginList(async () => {
    const isolation = getCurrentSourceTestIsolation();
    await ensureProjectRepository();
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
      manifest.platforms = ['codex'];
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

    const result = await statusCommandV8({
      plugins: ['team/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      json: true,
      verbose: true,
    });
    expect(result.payload).toMatchObject({
      schemaVersion: 8,
      targets: [expect.objectContaining({
        state: 'absent',
        reasons: [],
      })],
    });
    expect(result.payload.targets[0]!.components)
      .not.toContainEqual(expect.objectContaining({ key: expect.stringMatching(/owned|collision/u) }));
    await expect(fs.pathExists(ownedRoot)).resolves.toBe(true);
    await expect(fs.readFile(path.join(skillsRoot, 'collision', 'foreign.txt'), 'utf8'))
      .resolves.toBe('keep\n');
    expect(JSON.stringify(result.payload.targets[0]!.reasons)).not.toContain(isolation.layout.rootDir);
  }));

  it('preserves available plugin data when another source is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('good');
    const bad = fixturePath('bad');
    await Promise.all([createCatalogSnapshotFixture(good), fs.ensureDir(bad)]);
    const env = await configureTwoPaths(good, bad);
    const captured = createCapturedCliIo();

    const exitCode = await runCli(['plugin', 'list', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env,
      io: captured.io,
      interactive: false,
    });

    expect(exitCode).toBe(4);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.list', status: 'partial',
      data: { items: [expect.objectContaining({ pluginId: 'good/demo' })],
        coverage: { sources: ['good'], complete: false } },
      diagnostics: [{ code: 'sourceActiveUnavailable', subject: { sourceId: 'bad' } }],
    });
  });

  it('projects config read identity and rejects a legacy bare-name store', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('good');
    await createCatalogSnapshotFixture(good, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = { schemaVersion: 5, fields: {} };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'good', type: 'path', primary: true, path: good }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    await initCommand({ env: isolation.env });
    const captured = createCapturedCliIo();

    expect(await runCli(['plugin', 'config', 'get', 'good/demo', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    }), captured.readStdout()).toBe(0);
    expect(JSON.parse(captured.readStdout()).data).toMatchObject({
      configSchemaVersion: 5,
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
    expect(await runCli(['plugin', 'config', 'get', 'good/demo', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: blocked.io,
      interactive: false,
    })).toBe(3);
    expect(JSON.parse(blocked.readStdout())).toMatchObject({ status: 'blocked',
      diagnostics: [expect.objectContaining({ code: 'legacyStateUnsupported' })] });
  });

  it('validates stored-only config bindings against the current Catalog source', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await ensureProjectRepository();
    const sourceRoot = fixturePath('stored-only-config');
    await createCatalogSnapshotFixture(sourceRoot, 'other');
    const source = { id: 'good', type: 'path', primary: true, path: sourceRoot } as const;
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfigWithoutActive({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = String((await fs.readJson(
      path.join(sourceRoot, '.aw-generated.json'),
    ) as { workspaceIdentity: string }).workspaceIdentity);
    await writePluginConfigStore({
      sourceId: source.id,
      sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { mode: 'stored' },
    });
    const unavailable = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'get', 'good/demo', '--context', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: unavailable.io,
      interactive: false,
    })).toBe(3);
    expect(JSON.parse(unavailable.readStdout())).toMatchObject({ status: 'blocked',
      diagnostics: [expect.objectContaining({ code: 'catalogSourceUnavailable' })] });

    await syncCatalogSourceGeneration({
      sourceId: source.id,
      cliVersion: '1.0.0',
      env: isolation.env,
      impactConfirmed: true,
    });
    const captured = createCapturedCliIo();

    expect(await runCli(['plugin', 'config', 'get', 'good/demo', '--context', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(captured.readStdout()).data).toMatchObject({
      pluginId: 'good/demo',
      sourceId: 'good',
      sourceIdentity,
      fields: [expect.objectContaining({ key: 'mode', effectiveValue: '[redacted]' })],
    });

    await writePluginConfigStore({
      sourceId: source.id,
      sourceIdentity,
      logicalIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { mode: 'user-stored' },
    });
    const projectRead = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'get', 'good/demo', '--context', 'project', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: projectRead.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(projectRead.readStdout()).data).toMatchObject({
      fields: [expect.objectContaining({ key: 'mode', effectiveValue: '[redacted]' })],
    });

    // Construct mismatched bytes directly: the public writer must reject replacing a bound store.
    await fs.outputJson(resolvePluginConfigStorePath({
      sourceId: source.id, pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }), {
      schemaVersion: 6,
      sourceId: source.id,
      pluginName: 'demo',
      binding: { kind: 'source', sourceIdentity: `sha256:${'f'.repeat(64)}` },
      common: { mode: 'mismatch' }, platforms: {},
    });
    const userMismatch = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'get', 'good/demo', '--context', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: userMismatch.io,
      interactive: false,
    })).toBe(3);
    expect(JSON.parse(userMismatch.readStdout())).toMatchObject({ status: 'blocked',
      diagnostics: [expect.objectContaining({ code: 'identityMismatch' })] });

    await fs.outputJson(resolvePluginConfigStorePath({
      sourceId: source.id, pluginName: 'demo', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }), {
      schemaVersion: 6,
      sourceId: source.id,
      pluginName: 'demo',
      binding: { kind: 'source', sourceIdentity: `sha256:${'e'.repeat(64)}` },
      common: { mode: 'mismatch' }, platforms: {},
    });
    const projectMismatch = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'get', 'good/demo', '--context', 'project', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: projectMismatch.io,
      interactive: false,
    })).toBe(3);
    expect(JSON.parse(projectMismatch.readStdout())).toMatchObject({ status: 'blocked',
      diagnostics: [expect.objectContaining({ code: 'identityMismatch' })] });
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

    const ambiguous = await statusCommandV8({
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

    const mixed = await statusCommandV8({
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
    expect(await runCli(['plugin', 'install', '--only', 'requirements', 'demo', 'first/demo', 'missing', '--scope', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    })).toBe(3);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.install', status: 'blocked',
      data: { changes: { requirements: 'none' } },
      diagnostics: [expect.objectContaining({ code: 'pluginSelectorAmbiguous' })],
    });
    const textOutput = createCapturedCliIo();
    expect(await runCli(['plugin', 'install', '--only', 'requirements', 'first/demo', '--scope', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: textOutput.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(textOutput.readStdout())).toMatchObject({
      command: 'plugin.install', status: 'success', data: { changes: { requirements: 'changed' }, requirements: { roots: ['first/demo'] } },
    });
    expect(textOutput.readStderr()).toBe('');
  });

  it('resolves only selector dependencies and withholds a bare match when one source fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = fixturePath('good');
    const bad = fixturePath('missing');
    await createCatalogSnapshotFixture(good);
    const env = await configureTwoPaths(good, bad);

    const qualified = await statusCommandV8({
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

    const bare = await statusCommandV8({
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

    const mixed = await statusCommandV8({
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

    const result = await statusCommandV8({
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

    const result = await statusCommandV8({
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
      (manifest) => { manifest.platforms = ['claude']; },
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

    const defaultTargets = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
    });
    expect(defaultTargets.payload.targets.map((target) => `${target.platform}/${target.scope}`).sort())
      .toEqual(['claude/project', 'claude/user']);

    const unsupported = await statusCommandV8({
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
        state: 'blocked',
        reasons: [expect.objectContaining({ code: 'unsupportedTarget' })],
        placements: [expect.objectContaining({ scope: 'user' })],
      }),
    ]);

    const filtered = createCapturedCliIo();
    expect(await runCli(['plugin', 'status', '--context', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: filtered.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(filtered.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.status', status: 'success', data: { inventory: [] }, diagnostics: [],
    });

    await declarePlugin('local/demo', ['codex']);
    const explicitlyUnsupported = createCapturedCliIo();
    expect(await runCli(['plugin', 'status', '--context', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: explicitlyUnsupported.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(explicitlyUnsupported.readStdout()).data).toMatchObject({
      inventory: expect.arrayContaining([expect.objectContaining({
        pluginId: 'local/demo',
        targetResults: expect.arrayContaining([expect.objectContaining({
          delivery: null,
          satisfaction: 'unsupported',
          blockerCodes: [],
        })]),
      })]),
    });
  });

  it('uses the qualified Codex native surface for project target support', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await ensureProjectRepository();
    const codexOnly = fixturePath('codex-only');
    await createCatalogSnapshotFixture(
      codexOnly,
      'demo',
      [],
      'demo\n',
      (manifest) => { manifest.platforms = ['codex']; },
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

    const result = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
    });
    expect(result.payload.targets.flatMap((target) => target.platform === 'codex'
      ? target.placements.map((placement) => `${target.platform}/${placement.scope}`)
      : [`${target.platform}/${target.scope}`]))
      .toEqual(['codex/user']);

    const unsupported = await statusCommandV8({
      plugins: ['local/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      scope: 'project',
    });
    expect(unsupported.payload.targets).toEqual([
      expect.objectContaining({
        state: 'blocked',
        reasons: [expect.objectContaining({ code: 'codexProjectPluginUnsupported' })],
      }),
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
        manifest.platforms = ['codex'];
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
    await syncCatalogSourceGeneration({
      sourceId: 'local', cliVersion: '1.0.0', env: isolation.env,
    });
    const supported = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
    });
    expect(supported.payload.targets.flatMap((target) => target.platform === 'codex'
      ? target.placements.map((placement) => `${target.platform}/${placement.scope}`)
      : [`${target.platform}/${target.scope}`]))
      .toEqual(['codex/project', 'codex/user']);
    expect(supported.pluginSummaries[0]?.supportedTargets.codex)
      .toEqual(['user', 'project']);
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
    const unavailable = await statusCommandV8({
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

  it('keeps a namespaced requirement when delivery is unsupported and returns a config failure receipt', async () => {
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
    await setTargets({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, ['codex']);

    const installExit = await runCli(['plugin', 'install', 'demo', '--scope', 'user', '--context', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
    });
    expect(installExit).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.install', status: 'success', data: {
        requirements: { roots: ['good/demo'] }, changes: { requirements: 'changed', outputs: 'none' },
        targetResults: [expect.objectContaining({ pluginId: 'good/demo', target: 'codex', scope: 'user',
          delivery: null, execution: 'no-op', satisfaction: 'unsupported', blockerCodes: [] })],
      }, diagnostics: [expect.objectContaining({ code: 'deliveryUnsupported', severity: 'warning' })],
    });

    const config = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'set', 'good/demo', 'key', '--value-json', '"value"', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: config.io,
      interactive: false,
    })).toBe(3);
    expect(JSON.parse(config.readStdout())).toMatchObject({
      command: 'plugin.config.set', status: 'blocked', data: { configWrite: 'notStarted' },
      diagnostics: [expect.objectContaining({ code: 'configSchemaUnavailable' })],
    });
  });

  it.each(['codex', 'claude'] as const)(
    'keeps a structured target when a %s status probe config file is invalid',
    async (platform) => {
      const isolation = getCurrentSourceTestIsolation();
      const good = fixturePath('good');
      await createCatalogSnapshotFixture(good, 'demo', [], 'demo\n', (manifest) => {
        manifest.platforms = [platform];
        manifest.extensions = { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] };
      });
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
      await declarePlugin('good/demo', [platform === 'codex' ? 'codex' : 'claude']);
      const captured = createCapturedCliIo();

      expect(await runCli(['plugin', 'status', '--context', 'user', '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
      })).toBe(3);
      const payload = JSON.parse(captured.readStdout());
      expect(payload).toMatchObject({
        schemaVersion: 1,
        command: 'plugin.status', status: 'blocked',
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'nativeStateUnreadable' })]),
      });
      expect(payload.data.inventory).toEqual(expect.arrayContaining([
        expect.objectContaining({ pluginId: 'good/demo', targetResults: [expect.objectContaining({
          target: platform === 'codex' ? 'codex' : 'claude',
          blockerCodes: expect.arrayContaining([expect.any(String)]),
        })] }),
      ]));
      expect(captured.readStdout().trim().split('\n').filter(Boolean).length).toBeGreaterThan(0);
      expect(captured.readStdout()).not.toContain(invalidPath);
      expect(captured.readStderr()).toContain('nativeStateUnreadable');
      expect(captured.readStderr()).not.toContain(invalidPath);
    },
  );

  it('does not project an unrelated Codex user inventory failure into a Claude project query', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await ensureProjectRepository();
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

    const result = await statusCommandV8({
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
    await ensureProjectRepository();
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

    const result = await statusCommandV8({
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

    const result = await statusCommandV8({
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
      if (selectedScope === 'project') await ensureProjectRepository();
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

      const result = await statusCommandV8({
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
    'keeps the qualified config view and field read available when unrelated %s config is invalid',
    async (platform) => {
      const isolation = getCurrentSourceTestIsolation();
      const good = fixturePath('config-readable');
      await createCatalogSnapshotFixture(
        good,
        'demo',
        [],
        'demo\n',
        (manifest) => {
          manifest.config = { fields: { mode: { type: 'string', default: 'fast' } } };
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
        ['plugin', 'config', 'get', 'good/demo', '--json'],
        ['plugin', 'config', 'get', 'good/demo', 'mode', '--json'],
      ]) {
        const captured = createCapturedCliIo();
        expect(await runCli(args, {
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
          io: captured.io,
          interactive: false,
        })).toBe(0);
        expect(JSON.parse(captured.readStdout())).toMatchObject({
          command: 'plugin.config.get', status: 'success', data: {
            configSchemaVersion: 5, pluginId: 'good/demo', fields: [expect.objectContaining({ key: 'mode' })],
          },
        });
        expect(captured.readStderr()).toBe('');
      }
    },
  );

  it('redacts invalid Git snapshot paths from plugin list and status source errors', async () => {
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

    await declarePlugin('broken/demo', ['codex']);
    for (const args of [['plugin', 'list', '--json'], ['plugin', 'status', '--context', 'user', '--json']]) {
      const captured = createCapturedCliIo();
      expect(await runCli(args, {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
      })).toBe(3);
      const stdout = captured.readStdout();
      expect(JSON.parse(stdout)).toMatchObject(args[1] === 'list'
        ? { command: 'plugin.list', status: 'blocked', diagnostics: [expect.objectContaining({ code: 'sourceActiveUnavailable', subject: { sourceId: 'broken' } })] }
        : { command: 'plugin.status', status: 'blocked', data: { inventory: [expect.objectContaining({
            pluginId: 'broken/demo', blockerCodes: ['sourceActiveUnavailable'],
          })] } });
      for (const secret of [
        isolation.env.AW_HOME!,
        invalidRepository,
        '.materialize-',
      ]) expect(`${stdout}${captured.readStderr()}`).not.toContain(secret);
    }
  });

  it('redacts a missing path source outside managed and temporary roots from plugin list/status errors', async () => {
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

    await declarePlugin('private-path/demo', ['codex']);
    for (const args of [['plugin', 'list', '--json'], ['plugin', 'status', '--context', 'user', '--json']]) {
      const captured = createCapturedCliIo();
      expect(await runCli(args, {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
      })).toBe(3);
      const stdout = captured.readStdout();
      expect(JSON.parse(stdout)).toMatchObject(args[1] === 'list'
        ? { command: 'plugin.list', status: 'blocked', diagnostics: [expect.objectContaining({ code: 'sourceActiveUnavailable', subject: { sourceId: 'private-path' } })] }
        : { command: 'plugin.status', status: 'blocked', data: { inventory: [expect.objectContaining({
            pluginId: 'private-path/demo', blockerCodes: ['sourceActiveUnavailable'],
          })] } });
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
        manifest.config = { fields: { mode: { type: 'string', default: 'fast' } } };
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
