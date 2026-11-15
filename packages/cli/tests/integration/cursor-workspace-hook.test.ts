import path from 'node:path';
import { Readable } from 'node:stream';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/index.js';
import { cursorWorkspaceOpen } from '../../src/platforms/cursor-workspace-hook.js';
import { resolveDeployments, getDeploymentLayout } from '../../src/platforms/layout.js';
import { deploymentPackageComponent } from '../../src/platforms/inspection.js';
import { createSkillOwnerMarkerContent, SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { writeIntent } from '../../src/intent/intent-store.js';
import { createEmptyPreferences, writePreferences } from '../../src/intent/deployment-preferences.js';
import { readDemand } from '../../src/recovery/demand.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture() {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'cursor-project'); await fs.ensureDir(cwd); await git(cwd, ['init', '--quiet']);
  const source = path.join(isolation.layout.fixtureCwd, 'cursor-source');
  for (const name of ['personal', 'project', 'dependency']) {
    await fs.outputFile(path.join(source, 'plugins', name, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Test ${name}\n---\nUse ${name}.\n`);
    await fs.outputFile(path.join(source, 'plugins', name, 'skills', name, 'README.md'), `Use ${name}.\n`);
  }
  await createDependencyCatalogSnapshotFixture(source, ['personal', 'project', 'dependency'].map((name) => ({ name,
    ...(name === 'personal' ? { dependencies: ['dependency'] } : {}),
    configureManifest: (manifest) => { manifest.schemaVersion = 4; manifest.platforms = ['cursor']; manifest.skills = './skills'; delete manifest.extensions; },
  })));
  const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ env: isolation.env, expectedDigest: initial.digest,
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: source }] } });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  const generated = await fs.readJson(path.join(source, '.aw-generated.json')) as { workspaceIdentity: string };
  const context = { cwd, env: isolation.env };
  for (const [scope, name] of [['user', 'personal'], ['project', 'project']] as const) {
    await writeIntent({ ...context, scope }, { schemaVersion: 3, kind: 'aw-plugin-intents',
      sources: { team: { logicalIdentity: generated.workspaceIdentity } }, roots: [{ pluginId: `team/${name}` }] });
  }
  await writePreferences({ ...context, scope: 'user' }, { ...createEmptyPreferences(), targets: ['cursor'] });
  const paths = new Map<string, string>();
  for (const scope of ['user', 'project'] as const) {
    const demand = await readDemand({ ...context, scope });
    for (const plugin of demand.plugins.filter((plugin) => plugin.manifest.name !== (scope === 'user' ? 'project' : 'personal') && (scope === 'user' || plugin.manifest.name !== 'dependency'))) {
      const resolved = await resolveDeployments(context, { plugin: { sourceId: plugin.sourceId!, sourceIdentity: plugin.sourceIdentity!,
        pluginId: plugin.pluginId!, version: plugin.manifest.version },
        scope: scope === 'user' ? { kind: 'user' } : { kind: 'project', projectRoot: cwd }, operation: 'ensure', recoveryCandidates: [],
        discovery: { platform: 'cursor', availability: 'available', diagnostics: [], installations: [{ id: 'controlled-app', product: 'app', version: '3.29',
          availability: 'available', reasonCodes: [], entry: { kind: 'directory', configRoot: resolvePlatformConfigRoot('cursor', context) } }] } });
      const binding = resolved.bindings[0]!; const layout = await getDeploymentLayout(context, binding);
      const component = deploymentPackageComponent(binding, layout);
      await fs.outputFile(path.join(layout.packageRoot, SKILL_OWNER_MARKER), createSkillOwnerMarkerContent(component.identity));
      await fs.outputJson(path.join(layout.packageRoot, '.cursor-plugin', 'plugin.json'), { name: plugin.manifest.name, version: plugin.manifest.version });
      paths.set(`${scope}/${plugin.manifest.name}`, layout.packageRoot);
    }
  }
  return { ...context, paths };
}

// Test Value Gate: host loading must respect current demand, dependency closure, exact scope, source identity, and owned package presence.
describe('Cursor workspaceOpen production loader', () => {
  it('loads current scope packages and dependencies while preserving foreign or missing evidence', async () => {
    const value = await fixture();
    const input = { workspace_roots: [value.cwd] };
    expect((await cursorWorkspaceOpen(input, { ...value, scope: 'user' })).pluginPaths.sort()).toEqual([
      value.paths.get('user/personal')!, value.paths.get('user/dependency')!,
    ].sort());
    expect(await cursorWorkspaceOpen(input, { ...value, scope: 'project', projectRoot: value.cwd })).toEqual({ pluginPaths: [value.paths.get('project/project')!] });
    expect(await cursorWorkspaceOpen({ workspace_roots: [] }, { ...value, scope: 'user' })).toEqual({ pluginPaths: [] });
    const other = path.join(value.cwd, 'other'); await fs.ensureDir(other);
    expect(await cursorWorkspaceOpen({ workspace_roots: [other] }, { ...value, scope: 'project', projectRoot: value.cwd })).toEqual({ pluginPaths: [] });
    const markerPath = path.join(value.paths.get('user/personal')!, SKILL_OWNER_MARKER);
    const original = await fs.readJson(markerPath);
    await fs.writeJson(markerPath, { ...original, sourceIdentity: 'foreign-source' });
    expect((await cursorWorkspaceOpen(input, { ...value, scope: 'user' })).pluginPaths).not.toContain(value.paths.get('user/personal'));
    expect((await fs.readJson(markerPath)).sourceIdentity).toBe('foreign-source');
    await fs.writeJson(markerPath, { ...original, sourceIdentity: undefined, physicalKey: undefined });
    expect((await cursorWorkspaceOpen(input, { ...value, scope: 'user' })).pluginPaths).not.toContain(value.paths.get('user/personal'));
    await writePreferences({ ...value, scope: 'user' }, createEmptyPreferences());
    expect(await cursorWorkspaceOpen(input, { ...value, scope: 'user' })).toEqual({ pluginPaths: [] });
  });

  // Test Value Gate: the installed AW entry must emit exactly the official Hook JSON, and reject malformed or excessive input safely.
  it('exposes the fixed CLI host protocol without an AW result envelope', async () => {
    const value = await fixture();
    const execute = async (args: string[], input: string) => {
      let stdout = '', stderr = '';
      const code = await runCli(['internal', 'cursor-workspace-open', ...args], { ...value, stdin: Readable.from([input]),
        io: { stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; } } });
      return { code, result: JSON.parse(stdout), stderr };
    };
    const loaded = await execute(['--scope', 'project', '--project-root', value.cwd], JSON.stringify({ workspace_roots: [value.cwd] }));
    expect(loaded).toEqual({ code: 0, result: { pluginPaths: [value.paths.get('project/project')!] }, stderr: '' });
    expect((await execute(['--scope', 'user', '--plugin-id', 'team/dependency'], JSON.stringify({ workspace_roots: [value.cwd] }))).result)
      .toEqual({ pluginPaths: [value.paths.get('user/dependency')!] });
    expect((await execute(['--scope', 'user', '--plugin-id', 'team/project'], JSON.stringify({ workspace_roots: [value.cwd] }))).result)
      .toEqual({ pluginPaths: [] });
    expect((await execute(['--scope', 'project'], '{}')).code).toBe(2);
    expect((await execute(['--scope', 'user'], '{bad')).result).toEqual({ pluginPaths: [] });
    expect((await execute(['--scope', 'user'], ' '.repeat(65537))).code).toBe(1);
  });
});
