import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { createRebuildIntegration, materializeReviewNativeSkills } from '../../src/commands/rebuild-integration.js';
import { createRuntimeSkillSnapshot } from '@lesliechan721/agent-skill-eval';
import { executeRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const sourceIdentity = (source: string) => `sha256:${(source === 'alpha' ? '1' : '2').repeat(64)}`;

// Test Value Gate: public installation/save/apply, source and secret boundaries, and offline recovery.
async function fixture(source: string, withSibling = false, native = false) {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, source, 'source');
  const manifest = {
    schemaVersion: 3, name: 'third-party-routing', version: '1.0.0', description: 'Unrelated runtime consumer',
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
    config: { schemaVersion: 3, fields: {
      accessToken: { type: 'string', sensitive: true },
      backendCatalog: { type: 'array', default: [], validation: { uniqueBy: 'id' }, items: {
        type: 'object', properties: { id: { type: 'string', required: true }, title: { type: 'string' } },
      } },
      selectedBackend: { type: 'string', default: 'local', valueRef: { field: 'backendCatalog', key: 'id', include: ['local'] } },
    } },
    artifacts: { targets: [{ id: 'routing-skill', platform: 'codex', scopes: ['user'], target: 'codex.skill',
      delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: ['selectedBackend', 'backendCatalog'], skillKey: 'routing-tool',
      runtimeConfig: { keys: ['selectedBackend', 'backendCatalog'] },
    }] },
  };
  if (withSibling) {
    const first = manifest.artifacts.targets[0]!;
    manifest.artifacts.targets.push({ ...first, id: 'routing-peer', skillKey: 'routing-peer',
      runtimeConfig: { ...first.runtimeConfig } });
  }
  if (native) for (const target of manifest.artifacts.targets) {
    Object.assign(target, { scopes: ['user', 'project'], delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' } });
  }
  await fs.outputJson(path.join(sourceRoot, '.agents-plugin/plugin.json'), manifest);
  const render = `import fs from 'node:fs';
const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));
const files={'SKILL.md':'---\\nname: routing-tool\\ndescription: Route a bounded task.\\n---\\n# Routing\\n',
 'README.md':'# Routing runtime\\n', 'agents/openai.yaml':'interface:\\n  display_name: Routing\\n  short_description: Route a bounded task.\\n  default_prompt: Route the current task.\\npolicy:\\n  allow_implicit_invocation: true\\n',
 'scripts/caller.mjs':${JSON.stringify("import {readRuntimeConfig} from './aw-runtime-config.mjs';\ntry { console.log(JSON.stringify(await readRuntimeConfig({from:import.meta.url,keys:process.argv.slice(2).length?process.argv.slice(2):['selectedBackend']}))); } catch(e) { console.log(JSON.stringify({code:e.code,recoveryActions:e.recoveryActions,message:e.message})); process.exitCode=1; }\n")}};
console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>({id,kind:'skill',platform:'codex',target:'codex.skill',state:'present',refreshKeys:['selectedBackend','backendCatalog'],skillKey:id==='routing-skill'?'routing-tool':'routing-peer',content:{files:{...files,'SKILL.md':files['SKILL.md'].replaceAll('routing-tool',id==='routing-skill'?'routing-tool':'routing-peer')}}}))}));
`;
  await fs.outputFile(path.join(sourceRoot, 'scripts/render.mjs'), render);
  const sourcePlugin = await readPluginManifest(sourceRoot);
  const bundleRoot = path.join(isolation.layout.fixtureCwd, source, 'bundle');
  await bundleLocalPlugin(sourcePlugin, bundleRoot);
  const plugin = await readPluginManifest(bundleRoot, { mode: 'bundle' });
  Object.assign(plugin, { sourceId: source, sourceIdentity: sourceIdentity(source), pluginId: `${source}/${manifest.name}` });
  const env = { ...isolation.env, CODEX_HOME: path.join(isolation.layout.fixtureCwd, source, 'codex-home') };
  const skillRoot = path.join(env.CODEX_HOME, 'skills/routing-tool');
  const install = async (command: 'install' | 'sync' | 'cleanup' = 'install') => {
    const integration = createRebuildIntegration({ context: createCommandExecutionContext({
      env, nativeCliRunner: async () => ({ exitCode: 0, stdout: '{"installed":[],"available":[]}', stderr: '' }),
    }) });
    const target = await integration.buildTarget({ plugin, platform: 'codex', scope: 'user',
      cwd: isolation.layout.fixtureCwd, command, catalog: { rootDir: bundleRoot, source: 'local' } });
    return executeRebuildOperation({ command, target, driver: integration.driver });
  };
  const save = (values: Record<string, unknown>) => writePluginConfigStore({ sourceId: source,
    sourceIdentity: sourceIdentity(source), pluginName: manifest.name, scope: 'user',
    cwd: isolation.layout.fixtureCwd, values, env });
  const read = (keys: string[] = ['selectedBackend']) => {
    const cleanEnv = { ...env };
    delete cleanEnv.AW_PLUGIN_CONTEXT;
    try { return JSON.parse(execFileSync(process.execPath, [path.join(skillRoot, 'scripts/caller.mjs'), ...keys], { env: cleanEnv, encoding: 'utf8' })); }
    catch (error) { return JSON.parse((error as { stdout: string }).stdout); }
  };
  return { plugin, render, install, save, read, skillRoot, env };
}

describe('installed runtime config', () => {
  it('isolates same-name source snapshots, keeps saved values inactive, and applies through the real writer', async () => {
    const alpha = await fixture('alpha');
    const beta = await fixture('beta');
    await alpha.save({ backendCatalog: [{ id: 'remote-a' }], selectedBackend: 'remote-a', accessToken: 'private-alpha-token' });
    await beta.save({ backendCatalog: [{ id: 'remote-b' }], selectedBackend: 'remote-b' });
    for (const item of [alpha, beta]) {
      const result = await item.install();
      expect(result.status, JSON.stringify(result)).toBe('succeeded');
    }
    const previous = alpha.read();
    expect(previous).toMatchObject({ installedIdentity: { pluginId: 'alpha/third-party-routing', configScope: 'user' }, effectiveValues: { selectedBackend: 'remote-a' } });
    expect(beta.read()).toMatchObject({ installedIdentity: { pluginId: 'beta/third-party-routing' }, effectiveValues: { selectedBackend: 'remote-b' } });
    expect(previous.effectiveValues).not.toHaveProperty('backendCatalog');
    expect(alpha.read(['accessToken'])).toMatchObject({ code: 'runtimeConfigKeyDenied', recoveryActions: ['sync', 'reinstall'] });
    expect(await fs.readFile(path.join(alpha.skillRoot, '.aw-runtime-config.json'), 'utf8')).not.toContain('private-alpha-token');

    const bindingPath = path.join(alpha.skillRoot, '.aw-runtime-config.json');
    const originalBinding = await fs.readJson(bindingPath);
    await fs.copy(path.join(beta.skillRoot, '.aw-runtime-config.json'), bindingPath, { overwrite: true });
    expect(alpha.read()).toMatchObject({ code: 'runtimeConfigIdentityMismatch' });
    await fs.outputJson(bindingPath, originalBinding);

    await alpha.save({ backendCatalog: [{ id: 'replacement' }], selectedBackend: 'replacement' });
    expect(alpha.read()).toEqual(previous);
    await fs.outputFile(path.join(alpha.plugin.rootDir, 'scripts/render.mjs'), "throw new Error('staging failure');\n");
    await expect(alpha.install('sync')).rejects.toThrow('staging failure');
    expect(alpha.read()).toEqual(previous);
    await fs.outputFile(path.join(alpha.plugin.rootDir, 'scripts/render.mjs'), alpha.render);
    const result = await alpha.install('sync');
    expect(result.status, JSON.stringify(result)).toBe('succeeded');
    expect(alpha.read().effectiveValues).toEqual({ selectedBackend: 'replacement' });
    expect(beta.read().effectiveValues).toEqual({ selectedBackend: 'remote-b' });
  });

  it('accepts changed Skill text and allows cleanup despite a broken binding', async () => {
    const item = await fixture('alpha');
    expect((await item.install()).status).toBe('succeeded');
    await fs.appendFile(path.join(item.skillRoot, 'SKILL.md'), '\nchanged resource\n');
    expect(item.read()).toMatchObject({ effectiveValues: { selectedBackend: 'local' } });
    await fs.outputFile(path.join(item.skillRoot, '.aw-runtime-config.json'), '{broken');
    expect(item.read()).toMatchObject({ code: 'runtimeConfigBindingInvalid' });
    const cleanup = await item.install('cleanup');
    expect(cleanup.status, JSON.stringify(cleanup)).toBe('succeeded');
    expect(await fs.pathExists(item.skillRoot)).toBe(false);
  });

  it('keeps each Skill usable when a sibling is stale, replaced or missing', async () => {
    const alpha = await fixture('alpha', true);
    const beta = await fixture('beta', true);
    expect((await alpha.install()).status).toBe('succeeded');
    expect((await beta.install()).status).toBe('succeeded');
    const peerRoot = path.join(path.dirname(alpha.skillRoot), 'routing-peer');
    const backup = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'peer-backup');
    await fs.copy(peerRoot, backup);
    await alpha.save({ selectedBackend: 'new-key', backendCatalog: [{ id: 'new-key' }] });
    expect((await alpha.install('sync')).status).toBe('succeeded');
    await fs.remove(peerRoot);
    await fs.copy(backup, peerRoot);
    expect(alpha.read()).toMatchObject({ effectiveValues: { selectedBackend: 'new-key' } });
    await fs.remove(peerRoot);
    await fs.copy(path.join(path.dirname(beta.skillRoot), 'routing-peer'), peerRoot);
    expect(alpha.read()).toMatchObject({ effectiveValues: { selectedBackend: 'new-key' } });
    await fs.remove(peerRoot);
    expect(alpha.read()).toMatchObject({ effectiveValues: { selectedBackend: 'new-key' } });
  });

  it.each([['routing-tool'], ['routing-tool', 'routing-peer']])('copies only selected native Skills with their origin receipt for final %j', async (...names) => {
    const item = await fixture('alpha', true, true);
    const isolation = getCurrentSourceTestIsolation();
    const outputRoot = path.join(isolation.layout.fixtureCwd, 'review-final');
    await materializeReviewNativeSkills({ plugin: item.plugin, platform: 'codex', scope: 'user', cwd: isolation.layout.fixtureCwd,
      env: item.env, outputRoot, skills: names.map((skill) => ({ skill, targetId: skill === 'routing-tool' ? 'routing-skill' : 'routing-peer' })),
    });
    expect((await fs.readdir(path.join(outputRoot, 'skills'))).sort()).toEqual([...names].sort());
    const target = path.join(isolation.layout.fixtureCwd, 'targets/current');
    await createRuntimeSkillSnapshot(path.join(outputRoot, 'skills/routing-tool'), target);
    await fs.remove(outputRoot);
    const restored = path.join(isolation.layout.fixtureCwd, 'engine-workspace/.agents/skills/routing-tool');
    await createRuntimeSkillSnapshot(target, restored);
    const env = { ...item.env };
    delete env.AW_PLUGIN_CONTEXT;
    const actual = JSON.parse(execFileSync(process.execPath, [path.join(restored, 'scripts/caller.mjs')], { env, encoding: 'utf8' }));
    expect(actual).toMatchObject({ effectiveValues: { selectedBackend: 'local' }, installedIdentity: { sourceId: 'alpha', scope: 'user', configScope: 'user' } });
    expect(await fs.pathExists(path.join(restored, '.aw-runtime-native-receipt.json'))).toBe(true);
    expect(await fs.pathExists(path.join(restored, '.aw-runtime-peers'))).toBe(false);
  });

  it('uses shared native user config when preparing a project runtime snapshot', async () => {
    const item = await fixture('alpha', true, true);
    const isolation = getCurrentSourceTestIsolation();
    item.plugin.catalogLogicalIdentity = 'runtime-fixture-catalog';
    await item.save({ selectedBackend: 'user-native', backendCatalog: [{ id: 'user-native' }] });
    await writePluginConfigStore({ sourceId: 'alpha', sourceIdentity: sourceIdentity('alpha'), logicalIdentity: item.plugin.catalogLogicalIdentity,
      pluginName: item.plugin.manifest.name, scope: 'project', cwd: isolation.layout.fixtureCwd,
      values: { selectedBackend: 'project-native', backendCatalog: [{ id: 'project-native' }] }, env: item.env });
    const outputRoot = path.join(isolation.layout.fixtureCwd, 'project-runtime-final');
    await materializeReviewNativeSkills({ plugin: item.plugin, platform: 'codex', scope: 'project', cwd: isolation.layout.fixtureCwd,
      env: item.env, outputRoot, skills: [{ skill: 'routing-tool', targetId: 'routing-skill' }] });
    const actual = JSON.parse(execFileSync(process.execPath, [path.join(outputRoot, 'skills/routing-tool/scripts/caller.mjs')], { env: item.env, encoding: 'utf8' }));
    expect(actual).toMatchObject({ effectiveValues: { selectedBackend: 'user-native' }, installedIdentity: { scope: 'user', configScope: 'user' } });
  });
});
