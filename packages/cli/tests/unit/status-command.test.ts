import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import {
  statusCommandV7,
  statusTargetActivation,
  statusTargetExtensions,
  statusTargetIntent,
  statusTargetSharedNative,
} from '../../src/commands/status-v6.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { createSharedOwnerToken, writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { setNativeCliRunnerOverrideForTests } from '../../src/utils/native-cli.js';
import { applyCodexConfigTransactionFile } from '../../src/utils/codex-config.js';
import {
  createEmptyPluginIntentState,
  resolvePluginIntentStatePath,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';
import { resolveAwHome, resolveCodexPaths } from '../../src/utils/paths.js';
import { getCodexHome } from '../../src/utils/state-paths.js';
import {
  createCatalogSnapshotFixture,
  createDependencyCatalogSnapshotFixture,
} from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function configurePathSource(
  sourceRoot: string,
  sourceId = 'local',
): Promise<{ env: NodeJS.ProcessEnv; sourceIdentity: string }> {
  const isolation = getCurrentSourceTestIsolation();
  const source = { id: sourceId, type: 'path', primary: true, path: sourceRoot } as const;
  const current = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 2, sources: [source] },
    expectedDigest: current.digest,
    env: isolation.env,
  });
  await syncCatalogSourceGeneration({
    sourceId,
    cliVersion: '1.0.0',
    env: isolation.env,
  });
  return {
    env: { ...isolation.env, PATH: '' },
    sourceIdentity: await calculateCatalogSourceIdentity(source),
  };
}

async function filesystemSnapshot(root: string): Promise<Array<{
  path: string;
  type: 'directory' | 'file';
  content?: string;
}>> {
  if (!await fs.pathExists(root)) return [];
  const output: Array<{ path: string; type: 'directory' | 'file'; content?: string }> = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.isDirectory()) {
        output.push({ path: relative, type: 'directory' });
        pending.push(entryPath);
      } else if (entry.isFile()) {
        output.push({ path: relative, type: 'file', content: await fs.readFile(entryPath, 'utf8') });
      }
    }
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeCodexNativeResidue(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  version: string;
  userEnabled: boolean;
  sourceIdentity: string;
}): Promise<void> {
  const marketplaceRoot = path.join(resolveAwHome(options.env), 'marketplaces', 'local');
  const marketplaceName = 'aw-local';
  await fs.ensureDir(marketplaceRoot);
  await Promise.all([
    fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
      schemaVersion: 2,
      sourceId: 'local',
      sourceIdentity: options.sourceIdentity,
      marketplaceName,
    }),
    fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
      name: marketplaceName, owner: {}, interface: {}, plugins: [],
    }),
  ]);
  const configPath = resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath;
  await fs.outputFile(configPath, [
    `[marketplaces.${marketplaceName}]`,
    `source = ${JSON.stringify(marketplaceRoot)}`,
    'source_type = "local"',
    `[plugins."demo@${marketplaceName}"]`,
    `enabled = ${String(options.userEnabled)}`,
    '',
  ].join('\n'));
  await fs.outputJson(path.join(
    getCodexHome(options.env),
    'plugins', 'cache', marketplaceName, 'demo', options.version, 'plugin.json',
  ), { name: 'demo', version: options.version });
}

async function writeSystemCodexPackage(options: {
  root: string;
  version: string;
  packageName?: string;
}): Promise<string> {
  const binRoot = process.platform === 'win32'
    ? options.root
    : path.join(options.root, 'bin');
  const packageRoot = process.platform === 'win32'
    ? path.join(binRoot, 'node_modules', '@openai', 'codex')
    : path.join(options.root, 'lib', 'node_modules', '@openai', 'codex');
  const launcher = path.join(packageRoot, 'bin', 'codex.js');
  await Promise.all([
    fs.outputJson(path.join(packageRoot, 'package.json'), {
      name: options.packageName ?? '@openai/codex',
      version: options.version,
      bin: { codex: 'bin/codex.js' },
    }),
    fs.outputFile(launcher, [
      '#!/usr/bin/env node',
      "require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME, 'status-executed'), 'executed');",
      '',
    ].join('\n')),
  ]);
  await fs.chmod(launcher, 0o755);
  await fs.ensureDir(binRoot);
  if (process.platform === 'win32') {
    await fs.outputFile(path.join(binRoot, 'codex.CMD'), '@echo off\r\n');
  } else {
    await fs.symlink(path.relative(binRoot, launcher), path.join(binRoot, 'codex'));
  }
  return binRoot;
}

describe('status v7 current behavior', () => {
  it('reports a qualified pure-native Codex project target without scoped materialization', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'capability-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);

    const result = await statusCommandV7({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env: { ...env, PATH: '' },
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.schemaVersion).toBe(7);
    const target = result.payload.targets[0]!;
    expect(target).toMatchObject({ pluginId: 'local/demo', state: 'absent' });
    expect(statusTargetIntent(target)).toEqual({ enabled: false, scopes: [], relation: 'none' });
    expect(statusTargetSharedNative(target)).toMatchObject({ state: 'missing' });
    expect(statusTargetActivation(target)).toEqual({
      evidence: 'assumed',
      systemConsumer: { state: 'missing', requiredMinVersion: '0.151.0' },
    });
    for (const removed of ['desired', 'actual', 'errors', 'recovery', 'sharedNative', 'activation', 'extensions']) {
      expect(target).not.toHaveProperty(removed);
    }
  });

  it('aggregates user and project pure-native intent into one missing shared target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'pure-native-intent-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    for (const scope of ['user', 'project'] as const) {
      await writePluginIntentState({ scope, cwd: isolation.layout.fixtureCwd, env }, {
        ...createEmptyPluginIntentState(),
        roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
      });
    }

    const result = await statusCommandV7({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    expect(result.payload.targets).toHaveLength(1);
    const target = result.payload.targets[0]!;
    expect(target).toMatchObject({
      state: 'needsSync',
      recoveryActions: [expect.objectContaining({ command: 'sync' })],
    });
    expect(statusTargetIntent(target)).toEqual({
      enabled: true, scopes: ['project', 'user'], relation: 'root',
    });
    expect(statusTargetSharedNative(target)).toMatchObject({ state: 'missing' });
    expect(statusTargetActivation(target)).toEqual({
        evidence: 'assumed',
        systemConsumer: { state: 'missing', requiredMinVersion: '0.151.0' },
    });
  });

  it('reports a mixed user/project intent as an extension conflict with two recovery actions', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-conflict-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    });
    const { env } = await configurePathSource(sourceRoot);
    for (const scope of ['user', 'project'] as const) {
      await writePluginIntentState({ scope, cwd: isolation.layout.fixtureCwd, env }, {
        ...createEmptyPluginIntentState(),
        roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
      });
    }

    const result = await statusCommandV7({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked',
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'codexExtensionScopeConflict' })]),
      recoveryActions: [
        expect.objectContaining({
          command: 'uninstall',
          scope: 'user',
          description: expect.stringContaining(
            'aw uninstall local/demo --platform codex --scope user',
          ),
        }),
        expect.objectContaining({
          command: 'uninstall',
          scope: 'project',
          description: expect.stringContaining(
            'aw uninstall local/demo --platform codex --scope project',
          ),
        }),
      ],
    })]);
    expect(statusTargetExtensions(result.payload.targets[0]!)).toMatchObject({ state: 'conflict' });
    expect(result.hasErrors, JSON.stringify(result.payload, null, 2)).toBe(true);
  });

  it('recovers a dependency scope conflict through its desired roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-conflict-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'project-root', dependencies: ['leaf'] },
      { name: 'user-root', dependencies: ['leaf'] },
    ]);
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env,
    }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/user-root', platforms: ['codex'] }],
    });
    await writePluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env,
    }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/project-root', platforms: ['codex'] }],
    });

    const result = await statusCommandV7({
      plugins: ['local/leaf'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      pluginId: 'local/leaf',
      state: 'blocked',
      recoveryActions: [
        {
          command: 'uninstall',
          scope: 'user',
          description: '运行 aw uninstall local/user-root --platform codex --scope user，再运行 aw sync local/project-root --platform codex --scope project。',
        },
        {
          command: 'uninstall',
          scope: 'project',
          description: '运行 aw uninstall local/project-root --platform codex --scope project，再运行 aw sync local/user-root --platform codex --scope user。',
        },
      ],
    })]);
  });

  it('keeps the default-scope Codex dependency component aligned with its project reason', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'project-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/root', platforms: ['codex'] }],
    });
    await applyCodexConfigTransactionFile(
      resolveCodexPaths(isolation.layout.fixtureCwd, 'project', env).configTomlPath,
      {
        upsertManagedInstructionBlock: {
          pluginName: createSharedOwnerToken({
            owner: 'agent-workflows',
            sourceId: 'local',
            sourceIdentity,
            pluginId: 'local/root',
            plugin: 'root',
            artifactKey: 'developer-instructions',
            platform: 'codex',
            scope: 'project',
          }),
          value: 'Root live fixture.',
        },
      },
    );

    const result = await statusCommandV7({
      plugins: ['local/root'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    const target = result.payload.targets[0]!;
    const reason = target.reasons.find((entry) => entry.code === 'dependencyMissing');
    const component = target.components.find((entry) =>
      entry.kind === 'dependency' && entry.key === 'local/leaf');
    expect(target.scope).toBe('project');
    expect(reason).toMatchObject({
      dependencyPluginId: 'local/leaf',
      dependencyPlatform: 'codex',
      dependencyScope: 'project',
      dependencyProject: 'current',
      rootIssueId: 'dependencyMissing:local/leaf:codex:project',
      rootIssueCode: 'dependencyMissing',
    });
    expect(component).toMatchObject({
      state: 'absent',
      metadata: {
        platform: 'codex',
        scope: 'project',
        project: 'current',
        rootIssueId: reason?.rootIssueId,
        rootIssueCode: reason?.rootIssueCode,
      },
    });
  });

  it('keeps unavailable desired intent visible as unresolved', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unresolved-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'gone/demo', platforms: ['codex'] }],
    });

    const result = await statusCommandV7({
      plugins: ['gone/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked',
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'codexIntentSourceUnavailable' })]),
    })]);
    expect(statusTargetIntent(result.payload.targets[0]!)).toEqual({
      enabled: true, scopes: ['project'], relation: 'root',
    });
  });

  it('does not apply managed intent from another same-name Codex marketplace', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'source-qualified-managed-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'user', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      managed: { codexPluginIds: ['demo@aw-second'] },
    });

    const result = await statusCommandV7({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      pluginId: 'local/demo',
      state: 'absent',
    })]);
    expect(statusTargetIntent(result.payload.targets[0]!)).toEqual({
      enabled: false, scopes: [], relation: 'none',
    });
  });

  it('reports a current-target owned component without desired intent as orphaned', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'orphaned-owned-source');
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'),
      'console.log(JSON.stringify({ version: 2, artifacts: [] }));\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'orphaned-skill',
          platform: 'codex',
          scopes: ['project'],
          target: 'codex.skill',
          projectManagedKind: 'skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'orphaned-skill',
        }],
      };
    });
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'orphaned-skill');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), [
      '---', 'name: orphaned-skill', 'description: Orphaned fixture.', '---', '',
    ].join('\n'));
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows', sourceId: 'local', sourceIdentity,
        pluginId: 'local/demo', plugin: 'demo', artifactKey: 'orphaned-skill',
        platform: 'codex', scope: 'project',
      },
    });

    const result = await statusCommandV7({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.targets[0]).toMatchObject({ state: 'orphaned' });
    expect(statusTargetIntent(result.payload.targets[0]!)).toEqual({
      enabled: false, scopes: [], relation: 'none',
    });
    expect(result.payload.targets[0]!.recoveryActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'cleanup' }),
    ]));
  });

  it('keeps desired intent structured when the Catalog has no active generation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'official/demo', platforms: ['codex'] }],
    });

    const result = await statusCommandV7({
      plugins: ['official/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.catalog.sources).toEqual([
      expect.objectContaining({ id: 'official', error: expect.any(String) }),
    ]);
    expect(result.payload.catalog.sources[0]).not.toHaveProperty('freshness');
    expect(result.payload.targets).toEqual([expect.objectContaining({
      pluginId: 'official/demo',
      state: 'blocked',
      recoveryActions: [
        expect.objectContaining({ command: 'sync' }),
        expect.objectContaining({ command: 'cleanup' }),
      ],
    })]);
    expect(statusTargetIntent(result.payload.targets[0]!)).toEqual({
      enabled: true, scopes: ['project'], relation: 'root',
    });
  });

  it('reports cache-only Codex residue as a non-blocking stale-cache diagnostic', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-drift-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
      manifest.version = '2.0.0';
    });
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'user', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
      managed: { codexPluginIds: ['demo@aw-local'] },
    });
    await writeCodexNativeResidue({
      cwd: isolation.layout.fixtureCwd, env, version: '1.0.0', userEnabled: false,
      sourceIdentity,
    });

    const result = await statusCommandV7({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'user', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'needsSync',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'staleCacheObserved', severity: 'warning' }),
      ]),
    })]);
    expect(statusTargetSharedNative(result.payload.targets[0]!)).toMatchObject({
      state: 'missing', staleCacheObserved: true,
    });
    expect(result.payload.targets[0]!.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'codexSharedNativeUpdateRequired' }),
      expect.objectContaining({ code: 'codexSharedNativeForeign' }),
      expect.objectContaining({ severity: 'blocking' }),
    ]));
    expect(result.hasErrors, JSON.stringify(result.payload, null, 2)).toBe(false);
  });

  it('does not project cache-only Codex residue as orphaned', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cache-only-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    await fs.outputJson(path.join(
      getCodexHome(env), 'plugins', 'cache', 'aw', 'demo', '1.0.0', 'plugin.json',
    ), { name: 'demo', version: '1.0.0' });

    const result = await statusCommandV7({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'user', json: true,
    });

    expect(
      result.payload.targets,
      JSON.stringify(result.payload.targets, null, 2),
    ).toEqual([expect.objectContaining({ state: 'absent' })]);
    expect(statusTargetIntent(result.payload.targets[0]!)).toEqual({
      enabled: false, scopes: [], relation: 'none',
    });
    expect(statusTargetSharedNative(result.payload.targets[0]!)).toMatchObject({
      state: 'missing', staleCacheObserved: true,
    });
  });

  it('uses pluginIntentStateInvalid for an unreadable desired-state file', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'invalid-intent-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const { env } = await configurePathSource(sourceRoot);
    await fs.outputFile(resolvePluginIntentStatePath({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env,
    }), '{ invalid intent');

    const result = await statusCommandV7({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env, json: true,
    });

    expect(result.hasErrors).toBe(true);
    expect(result.payload.errors).toContainEqual({
      code: 'pluginIntentStateInvalid',
      message: 'pluginIntentStateInvalid: user plugin intent state is invalid.',
    });
  });

  it('ignores a legacy project Skill marker when another Catalog source fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = path.join(isolation.layout.fixtureCwd, 'partial-good');
    const bad = path.join(isolation.layout.fixtureCwd, 'partial-bad');
    await fs.outputFile(
      path.join(good, 'plugins', 'demo', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review fixture.\n---\n',
    );
    await fs.outputFile(
      path.join(good, 'plugins', 'demo', 'skills', 'review', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );
    await createCatalogSnapshotFixture(good, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
    });
    await fs.ensureDir(bad);
    const goodSource = { id: 'good', type: 'path', primary: true, path: good } as const;
    const current = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [goodSource, { id: 'bad', type: 'path', primary: false, path: bad }],
      },
      expectedDigest: current.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'good',
      cliVersion: '1.0.0',
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'review');
    await fs.copy(path.join(good, 'plugins', 'demo', 'skills', 'review'), skillRoot);
    await fs.remove(path.join(skillRoot, 'agents', 'openai.yaml'));
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'good',
        sourceIdentity: await calculateCatalogSourceIdentity(goodSource),
        pluginId: 'good/demo',
        plugin: 'demo',
        artifactKey: 'review',
        platform: 'codex',
        scope: 'project',
      },
    });

    setNativeCliRunnerOverrideForTests(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ installed: [], available: [] }),
      stderr: '',
    }));
    let result;
    try {
      result = await statusCommandV7({
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
        platform: 'codex', scope: 'project', verbose: true, json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(result.hasErrors).toBe(true);
    expect(result.payload.catalog.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bad', error: expect.any(String) }),
      expect.objectContaining({ id: 'good', freshness: 'active' }),
    ]));
    expect(result.payload.catalog.sources.find((source) => source.id === 'bad'))
      .not.toHaveProperty('freshness');
    expect(result.payload.targets).toEqual([
      expect.objectContaining({
        pluginId: 'good/demo',
        state: 'absent',
      }),
    ]);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
  });

  it('treats a disabled-capable dynamic component as optional without running its renderer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'optional-dynamic-source');
    const sentinel = path.join(isolation.layout.fixtureCwd, 'renderer-ran');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.AW_RENDER_SENTINEL, "renderer ran\\n");',
      'console.log(JSON.stringify({ version: 2, artifacts: [] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-skill',
          platform: 'codex',
          scopes: ['project'],
          target: 'codex.skill',
          projectManagedKind: 'skill',
          states: ['present', 'disabled'],
          refreshKeys: [],
          skillKey: 'dynamic-skill',
        }],
      };
    });
    const { env } = await configurePathSource(sourceRoot);

    const result = await statusCommandV7({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
      env: { ...env, AW_RENDER_SENTINEL: sentinel },
      platform: 'codex', scope: 'project', verbose: true,
    });

    expect(result.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'local/demo', state: 'absent' }),
    ]);
    expect(await fs.pathExists(sentinel)).toBe(false);
  });

  it('does not report marker-only legacy project Skill residue', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'residue-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'removed-skill');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), [
      '---', 'name: removed-skill', 'description: Removed fixture.', '---', '',
    ].join('\n'));
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows', sourceId: 'local', sourceIdentity,
        pluginId: 'local/removed', plugin: 'removed', artifactKey: 'removed-skill',
        platform: 'codex', scope: 'project',
      },
    });

    const result = await statusCommandV7({
      cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.targets).toEqual([]);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
  });

  it('does not create or change files during a real status inspection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'read-only-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const { env } = await configurePathSource(sourceRoot);
    const nativeRunner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    setNativeCliRunnerOverrideForTests(nativeRunner);
    const before = await filesystemSnapshot(isolation.layout.rootDir);

    let result;
    try {
      result = await statusCommandV7({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
        platform: 'claude', scope: 'project', json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(result.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'local/demo', state: 'absent' }),
    ]);
    expect(await filesystemSnapshot(isolation.layout.rootDir)).toEqual(before);
    expect(nativeRunner).not.toHaveBeenCalled();
  });

  it('uses the official system Codex list without changing isolation state', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'read-only-codex-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'system-prefix'),
      version: '0.151.0',
    });
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'sentinel'), 'unchanged\n');
    const nativeRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ installed: [], available: [] }),
      stderr: '',
    }));
    setNativeCliRunnerOverrideForTests(nativeRunner);
    const before = await filesystemSnapshot(isolation.layout.rootDir);
    const codexHomeBefore = await filesystemSnapshot(isolation.layout.codexHomeDir);

    let result;
    try {
      result = await statusCommandV7({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'project', json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(statusTargetActivation(result.payload.targets[0]!)).toMatchObject({
      evidence: 'observed',
      systemConsumer: {
        state: 'compatible', detectedVersion: '0.151.0', requiredMinVersion: '0.151.0',
      },
    });
    expect(await filesystemSnapshot(isolation.layout.rootDir)).toEqual(before);
    expect(await filesystemSnapshot(isolation.layout.codexHomeDir)).toEqual(codexHomeBefore);
    expect(nativeRunner).toHaveBeenCalledTimes(2);
    expect(nativeRunner.mock.calls.every(([invocation]) =>
      invocation.command === 'codex'
      && invocation.args.join(' ') === 'plugin list --json')).toBe(true);
  });

  it('uses shallow system registration evidence without recursively hashing the payload', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'registered-codex-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'user', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
    });
    await writeCodexNativeResidue({
      cwd: isolation.layout.fixtureCwd,
      env,
      version: '1.0.0',
      userEnabled: true,
      sourceIdentity,
    });
    const cacheRoot = path.join(
      getCodexHome(env), 'plugins', 'cache', 'aw-local', 'demo', '1.0.0',
    );
    await fs.remove(cacheRoot);
    await fs.copy(path.join(sourceRoot, 'plugins', 'demo'), cacheRoot);
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'registered-system-prefix'),
      version: '0.151.0',
    });
    let listedVersion = '1.0.0';
    const nativeRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        installed: [{
          pluginId: 'demo@aw-local',
          installed: true,
          enabled: true,
          version: listedVersion,
        }],
        available: [],
      }),
      stderr: '',
    }));
    setNativeCliRunnerOverrideForTests(nativeRunner);

    try {
      await fs.remove(cacheRoot);
      const damaged = await statusCommandV7({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'user', json: true,
      });
      expect(damaged.payload.targets[0]).toMatchObject({ state: 'needsSync' });
      expect(statusTargetSharedNative(damaged.payload.targets[0]!)).toMatchObject({
        state: 'replaceable', reason: 'damaged', diagnostic: 'manifestMissing',
      });

      await fs.copy(path.join(sourceRoot, 'plugins', 'demo'), cacheRoot);
      if (process.platform !== 'win32') {
        await fs.symlink(
          path.join(isolation.layout.fixtureCwd, 'outside-payload'),
          path.join(cacheRoot, 'nested-payload-link'),
        );
      }
      const present = await statusCommandV7({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'user', json: true,
      });
      expect(present.payload.targets[0]).toMatchObject({ state: 'ready' });
      expect(statusTargetSharedNative(present.payload.targets[0]!)).toEqual({
        pluginId: 'demo@aw-local', state: 'usable', version: '1.0.0',
      });
      expect(present.payload.targets[0]!.components.find((component) =>
        component.kind === 'sharedNative')).toEqual({
        kind: 'sharedNative',
        key: 'demo@aw-local',
        state: 'usable',
        metadata: { shared: true, version: '1.0.0' },
      });
      expect(statusTargetActivation(present.payload.targets[0]!)).toMatchObject({
        user: true, evidence: 'observed',
      });

      listedVersion = '0.9.0';
      const outdated = await statusCommandV7({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'user', json: true,
      });
      expect(outdated.payload.targets[0]).toMatchObject({ state: 'needsSync' });
      expect(statusTargetSharedNative(outdated.payload.targets[0]!)).toMatchObject({
        state: 'replaceable', reason: 'outdated', version: '0.9.0',
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(nativeRunner.mock.calls.every(([invocation]) =>
      invocation.command === 'codex'
      && invocation.args.join(' ') === 'plugin list --json')).toBe(true);
  });

  it('reports a filesystem-validated Codex 0.150 consumer as unresolved', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'low-codex-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
    });
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'low-system-prefix'),
      version: '0.150.0',
    });
    const nativeRunner = vi.fn(async () => {
      throw new Error('status must not execute Codex');
    });
    setNativeCliRunnerOverrideForTests(nativeRunner);

    let result;
    try {
      result = await statusCommandV7({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'project', json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'codexProjectPluginVersionTooLow' }),
      ]),
      recoveryActions: [{
        command: 'manual',
        description: '升级或修复官方 system Codex CLI 后重试原操作。',
      }],
    })]);
    expect(statusTargetActivation(result.payload.targets[0]!)).toMatchObject({
      evidence: 'unobserved',
      systemConsumer: {
        state: 'incompatible', code: 'codexProjectPluginVersionTooLow',
        detectedVersion: '0.150.0',
      },
    });
    expect(nativeRunner).not.toHaveBeenCalled();
  });

  it('uses the user requirement for default-scope status with only user desired intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-low-codex-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'user', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
    });
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'user-low-system-prefix'),
      version: '0.150.0',
    });
    const nativeRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ installed: [], available: [] }),
      stderr: '',
    }));
    setNativeCliRunnerOverrideForTests(nativeRunner);

    let result;
    try {
      result = await statusCommandV7({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(result.payload.targets[0]).toMatchObject({ state: 'needsSync' });
    expect(statusTargetIntent(result.payload.targets[0]!)).toEqual({
      enabled: true, scopes: ['user'], relation: 'root',
    });
    expect(statusTargetActivation(result.payload.targets[0]!)).toMatchObject({
      evidence: 'observed',
      systemConsumer: {
        state: 'compatible', detectedVersion: '0.150.0', requiredMinVersion: '0.145.0',
      },
    });
    expect(nativeRunner).toHaveBeenCalledTimes(2);
  });

  it.runIf(process.platform !== 'win32')(
    'keeps an ordinary POSIX shim unobserved and non-blocking without executing it',
    async () => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unobserved-codex-source');
      await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.apps = './.app.json';
      });
      const { env } = await configurePathSource(sourceRoot);
      await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
        ...createEmptyPluginIntentState(),
        roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
      });
      const binRoot = path.join(isolation.layout.fixtureCwd, 'unobserved-system-bin');
      const launcher = path.join(binRoot, 'codex');
      await fs.outputFile(launcher, '#!/bin/sh\nexit 0\n');
      await fs.chmod(launcher, 0o755);
      const nativeRunner = vi.fn(async () => {
        throw new Error('status must not execute Codex');
      });
      setNativeCliRunnerOverrideForTests(nativeRunner);

      let result;
      try {
        result = await statusCommandV7({
          plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
          env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'project', json: true,
        });
      } finally {
        setNativeCliRunnerOverrideForTests(null);
      }

      expect(result.payload.targets[0]).toMatchObject({ state: 'needsSync' });
      expect(statusTargetActivation(result.payload.targets[0]!)).toMatchObject({
        evidence: 'unobserved',
        systemConsumer: { state: 'unobserved', requiredMinVersion: '0.151.0' },
      });
      expect(result.payload.targets[0]?.reasons).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'codexProjectPluginUnsupported' }),
      ]));
      expect(nativeRunner).not.toHaveBeenCalled();
    },
  );

  it('reports an invalid npm package identity as typed unresolved evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'invalid-codex-source-identity');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'project', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
    });
    const binRoot = await writeSystemCodexPackage({
      root: path.join(isolation.layout.fixtureCwd, 'invalid-system-prefix'),
      version: '0.151.0',
      packageName: 'foreign/codex',
    });
    const nativeRunner = vi.fn(async () => {
      throw new Error('status must not execute Codex');
    });
    setNativeCliRunnerOverrideForTests(nativeRunner);

    let result;
    try {
      result = await statusCommandV7({
        plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...env, PATH: binRoot }, platform: 'codex', scope: 'project', json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(result.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'codexProjectPluginUnsupported' }),
      ]),
      recoveryActions: [{
        command: 'manual',
        description: '升级或修复官方 system Codex CLI 后重试原操作。',
      }],
    })]);
    expect(statusTargetActivation(result.payload.targets[0]!)).toMatchObject({
      evidence: 'unobserved',
      systemConsumer: expect.objectContaining({
        state: 'unresolved', code: 'codexProjectPluginUnsupported',
      }),
    });
    expect(nativeRunner).not.toHaveBeenCalled();
  });

  it('does not materialize intent or state paths while reading missing state', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const env = isolation.env;
    const nativeRunner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    setNativeCliRunnerOverrideForTests(nativeRunner);
    const before = await filesystemSnapshot(isolation.layout.rootDir);

    try {
      const result = await statusCommandV7({
        cwd: isolation.layout.fixtureCwd, env, json: true,
      });
      expect(result.payload.schemaVersion).toBe(7);
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(await filesystemSnapshot(isolation.layout.rootDir)).toEqual(before);
    expect(await fs.pathExists(path.join(isolation.layout.fixtureCwd, '.agent-workflows'))).toBe(false);
    expect(await fs.pathExists(isolation.layout.awHomeDir)).toBe(false);
    expect(await fs.pathExists(isolation.layout.codexHomeDir)).toBe(false);
    expect(await fs.pathExists(isolation.layout.claudeHomeDir)).toBe(false);
    expect(nativeRunner).not.toHaveBeenCalled();
  });
});
