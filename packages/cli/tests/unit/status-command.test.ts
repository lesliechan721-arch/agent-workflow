import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { statusCommandV6 } from '../../src/commands/status-v6.js';
import { refreshCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { setNativeCliRunnerOverrideForTests } from '../../src/utils/native-cli.js';
import {
  createEmptyPluginIntentState,
  resolvePluginIntentStatePath,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';
import { resolveAwHome, resolveCodexPaths } from '../../src/utils/paths.js';
import { getCodexHome } from '../../src/utils/state-paths.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
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
  await refreshCatalogSourceGeneration({
    sourceId,
    cliVersion: '1.0.0',
    env: isolation.env,
  });
  return {
    env: isolation.env,
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

describe('status v6 current behavior', () => {
  it('reports a qualified pure-native Codex project target without scoped materialization', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'capability-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);

    const result = await statusCommandV6({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env: { ...env, PATH: '' },
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.schemaVersion).toBe(6);
    expect(result.payload.targets).toEqual([
      expect.objectContaining({
        pluginId: 'local/demo',
        state: 'absent',
        desired: { enabled: false, scopes: [], relation: 'none' },
        actual: { state: 'absent' },
        sharedNative: expect.objectContaining({ state: 'missing', shared: true }),
        activation: { evidence: 'assumed' },
      }),
    ]);
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

    const result = await statusCommandV6({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    expect(result.payload.targets).toHaveLength(1);
    expect(result.payload.targets[0]).toMatchObject({
      desired: { enabled: true, scopes: ['project', 'user'], relation: 'root' },
      actual: { state: 'needsSync' },
      sharedNative: { state: 'missing', shared: true },
      activation: { evidence: 'assumed' },
      recovery: [expect.objectContaining({ command: 'sync' })],
    });
  });

  it('reports a mixed user/project intent as an extension conflict with two recovery actions', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-conflict-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
      manifest.config = { schema: { mode: { type: 'string', title: 'Mode' } } };
    });
    const { env } = await configurePathSource(sourceRoot);
    for (const scope of ['user', 'project'] as const) {
      await writePluginIntentState({ scope, cwd: isolation.layout.fixtureCwd, env }, {
        ...createEmptyPluginIntentState(),
        roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
      });
    }

    const result = await statusCommandV6({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      actual: { state: 'conflict' },
      extensions: expect.objectContaining({ state: 'conflict' }),
      errors: expect.arrayContaining([expect.objectContaining({ code: 'codexExtensionScopeConflict' })]),
      recovery: [
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
    expect(result.hasErrors, JSON.stringify(result.payload, null, 2)).toBe(false);
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

    const result = await statusCommandV6({
      plugins: ['gone/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      desired: { enabled: true, scopes: ['project'], relation: 'root' },
      actual: { state: 'unresolved' },
      errors: expect.arrayContaining([expect.objectContaining({ code: 'codexIntentSourceUnavailable' })]),
    })]);
  });

  it('reports managed Codex inventory without desired roots as orphaned', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'orphan-managed-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);
    await writePluginIntentState({ scope: 'user', cwd: isolation.layout.fixtureCwd, env }, {
      ...createEmptyPluginIntentState(),
      managed: { codexPluginIds: ['demo@aw'] },
    });

    const result = await statusCommandV6({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      desired: { enabled: false, scopes: [], relation: 'managed' },
      actual: { state: 'orphaned' },
      recovery: [expect.objectContaining({ command: 'cleanup' })],
    })]);
  });

  it('keeps desired intent structured when the Catalog has no active generation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, {
      ...createEmptyPluginIntentState(),
      roots: [{ pluginId: 'official/demo', platforms: ['codex'] }],
    });

    const result = await statusCommandV6({
      plugins: ['official/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.catalog.sources).toEqual([
      expect.objectContaining({ id: 'official', error: expect.any(String) }),
    ]);
    expect(result.payload.targets).toEqual([expect.objectContaining({
      pluginId: 'official/demo',
      desired: { enabled: true, scopes: ['project'], relation: 'root' },
      actual: { state: 'unresolved' },
      recovery: [
        expect.objectContaining({ command: 'sync' }),
        expect.objectContaining({ command: 'cleanup' }),
      ],
    })]);
  });

  it('keeps managed-only Codex inventory cleanable without an active Catalog', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, {
      ...createEmptyPluginIntentState(),
      managed: { codexPluginIds: ['demo@aw-official'] },
    });

    const result = await statusCommandV6({
      plugins: ['official/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'user', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      pluginId: 'official/demo',
      desired: { enabled: false, scopes: [], relation: 'managed' },
      actual: { state: 'orphaned' },
      sharedNative: { pluginId: 'demo@aw-official', state: 'missing', shared: true },
      recovery: [expect.objectContaining({ command: 'cleanup' })],
    })]);
  });

  it('uses stable codes for shared update and activation drift', async () => {
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

    const result = await statusCommandV6({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'user', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      actual: { state: 'needsSync' },
      sharedNative: expect.objectContaining({ state: 'outdated', version: '1.0.0' }),
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'codexSharedNativeUpdateRequired' }),
        expect.objectContaining({ code: 'codexActivationDrift' }),
      ]),
    })]);
    expect(result.hasErrors, JSON.stringify(result.payload, null, 2)).toBe(false);
  });

  it.each([
    ['foreign', 'conflict', 'codexSharedNativeForeign'],
    ['corrupt', 'drifted', 'codexSharedNativeCorrupt'],
  ] as const)('reports %s shared native state with a stable code', async (
    nativeState,
    actualState,
    errorCode,
  ) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, `native-${nativeState}-source`);
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
      cwd: isolation.layout.fixtureCwd, env, version: '2.0.0', userEnabled: true,
      sourceIdentity,
    });
    const cacheVersionRoot = path.join(
      getCodexHome(env), 'plugins', 'cache', 'aw-local', 'demo', '2.0.0',
    );
    if (nativeState === 'foreign') {
      await fs.outputJson(path.join(cacheVersionRoot, 'plugin.json'), {
        name: 'other', version: '2.0.0',
      });
    } else {
      await fs.outputFile(path.join(cacheVersionRoot, 'payload.txt'), 'tampered\n');
    }

    const result = await statusCommandV6({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'user', json: true,
    });

    expect(result.payload.targets).toEqual([expect.objectContaining({
      actual: { state: actualState },
      sharedNative: expect.objectContaining({ state: nativeState }),
      errors: expect.arrayContaining([expect.objectContaining({ code: errorCode })]),
    })]);
  });

  it('uses pluginIntentStateInvalid for an unreadable desired-state file', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'invalid-intent-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const { env } = await configurePathSource(sourceRoot);
    await fs.outputFile(resolvePluginIntentStatePath({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env,
    }), '{ invalid intent');

    const result = await statusCommandV6({
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
    await refreshCatalogSourceGeneration({
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

    const result = await statusCommandV6({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', verbose: true, json: true,
    });

    expect(result.hasErrors).toBe(true);
    expect(result.payload.catalog.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bad', error: expect.any(String) }),
    ]));
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

    const result = await statusCommandV6({
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

    const result = await statusCommandV6({
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
      result = await statusCommandV6({
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

  it('does not materialize intent or state paths while reading missing state', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const env = isolation.env;
    const nativeRunner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    setNativeCliRunnerOverrideForTests(nativeRunner);
    const before = await filesystemSnapshot(isolation.layout.rootDir);

    try {
      const result = await statusCommandV6({
        cwd: isolation.layout.fixtureCwd, env, json: true,
      });
      expect(result.payload.schemaVersion).toBe(6);
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
