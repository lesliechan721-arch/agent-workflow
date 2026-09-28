import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { executePortableProjectRecovery, inspectPortableProjectRecovery, inspectPortableProjectResidue, preparePortableProjectRecovery, type PortableProjectRecoveryOptions } from '../../src/portable/project-recovery.js';
import { readAwSourceBinding } from '../../src/review/source-binding.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { createCatalogManifestV7, createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture() {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const sourceRoot = path.join(cwd, 'catalog');
  const pluginRoot = path.join(sourceRoot, 'plugins', 'portable');
  await createCatalogSnapshotFixture(sourceRoot, 'portable', [], 'Portable history fixture', (manifest) => {
    manifest.extensions = { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] };
    manifest.distributions = { agentSkills: { skills: './agent-skills/skills' } };
    manifest.config = { fields: { tone: { type: 'string', default: 'first' } } };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
    manifest.artifacts = { targets: [{ id: 'alpha', distribution: 'agent-skills', target: 'agent-skills.skill',
      kind: 'skill', scopes: ['project'], states: ['present'], refreshKeys: ['tone'], skillKey: 'alpha' }] };
  });
  await fs.ensureDir(path.join(pluginRoot, 'agent-skills', 'skills'));
  await fs.outputFile(path.join(pluginRoot, 'scripts/render.mjs'), [
    "import fs from 'node:fs';",
    "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
    "console.log(JSON.stringify({version:2,artifacts:[{id:'alpha',distribution:'agent-skills',target:'agent-skills.skill',kind:'skill',state:'present',skillKey:'alpha',refreshKeys:['tone'],content:{files:{'SKILL.md':'---\\nname: alpha\\ndescription: alpha\\n---\\nTone: '+context.config.values.tone,'README.md':'Alpha readme','assets/payload.txt':'original','.hidden':'retain hidden bytes'}}}]}));",
  ].join('\n'));
  const refreshCatalog = async () => {
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    await fs.writeJson(path.join(sourceRoot, 'catalog-manifest.json'), createCatalogManifestV7({
      catalogVersion: plugin.manifest.version, channel: 'latest',
      marketplace: { owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' }, interface: { displayName: 'Fixture Marketplace' } },
      requires: { aw: { capabilities: ['aw.catalog-snapshot.v7'] } }, release: { state: 'development' },
      entries: [await createCatalogManifestV7Entry(plugin, pluginRoot)],
    }));
  };
  await refreshCatalog();
  const before = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
    sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: before.digest, env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env: isolation.env });
  const bin = path.join(cwd, 'provider-bin'), log = path.join(cwd, 'provider-calls.jsonl');
  await fs.ensureDir(bin);
  await fs.writeFile(path.join(bin, 'skills'), `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.PROVIDER_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='--version'){console.log('1.5.23');process.exit(0);}
let lock={version:1,skills:{}};try{lock=JSON.parse(fs.readFileSync('skills-lock.json'));}catch{}
if(args[0]==='list'){
 const records=[];
 for(const [name,entry] of Object.entries(lock.skills)){
  const canonical=path.resolve('.agents/skills',name), claude=path.resolve('.claude/skills',name);
  const agents=[...(fs.existsSync(canonical)?['Codex','Cursor']:[]),...(fs.existsSync(claude)?['Claude Code']:[])];
  if(agents.length)records.push({name,scope:'project',path:fs.existsSync(canonical)?canonical:claude,agents,source:path.resolve(entry.source)});
 }
 console.log(JSON.stringify(records));process.exit(0);
}
if(args[0]==='add'){
 const source=args[1],skill=args[args.indexOf('--skill')+1],agents=args.slice(args.indexOf('--agent')+1,args.indexOf('--copy'));
 for(const agent of agents){const target=path.resolve(agent==='claude-code'?'.claude':'.agents','skills',skill);
 fs.rmSync(target,{force:true,recursive:true});fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(path.join(source,'skills',skill),target,{recursive:true});}
 lock.skills[skill]={source:path.relative(process.cwd(),source),sourceType:'local',computedHash:'not-aw-evidence'};
 fs.writeFileSync('skills-lock.json',JSON.stringify(lock));process.exit(0);
}
process.exit(2);
`);
  await fs.chmod(path.join(bin, 'skills'), 0o755);
  const env = { ...isolation.env, PATH: `${bin}${path.delimiter}${isolation.env.PATH}`, PROVIDER_LOG: log };
  const options: PortableProjectRecoveryOptions = { selector: 'local/portable', agents: ['cursor'], cwd, env, cliVersion: '1.0.0' };
  const intentPath = path.join(cwd, '.agent-workflows/plugin-intents.json');
  const active = (await readCatalogGenerationState(env)).sources.local!.active!;
  await fs.outputJson(intentPath, { schemaVersion: 3, kind: 'aw-plugin-intents', roots: [{ pluginId: options.selector }],
    sources: { local: { logicalIdentity: active.logicalIdentity } } });
  const changeConfig = async () => writePluginConfigStore({ sourceId: 'local', sourceIdentity: active.sourceIdentity,
    logicalIdentity: active.logicalIdentity, pluginName: 'portable', scope: 'project', cwd, env, values: { tone: 'second' } });
  const upgrade = async () => {
    for (const relative of ['.agents-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
      const filename = path.join(pluginRoot, relative);
      if (!await fs.pathExists(filename)) continue;
      const manifest = await fs.readJson(filename); manifest.version = '1.1.0'; await fs.writeJson(filename, manifest);
    }
    const renderer = path.join(pluginRoot, 'scripts/render.mjs');
    await fs.writeFile(renderer, (await fs.readFile(renderer, 'utf8')).replace("'original'", "'new-version'"));
    await refreshCatalog();
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
  };
  const addCalls = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((args) => args[0] === 'add');
  return { options, active, intentPath, changeConfig, upgrade, addCalls, installed: path.join(cwd, '.agents/skills/alpha'),
    configPath: resolvePluginConfigStorePath({ pluginName: 'portable', sourceId: 'local', scope: 'project', cwd, env }) };
}
async function apply(f: Awaited<ReturnType<typeof fixture>>, authorizeUpdate = false) {
  const prepared = await preparePortableProjectRecovery(f.options);
  expect(prepared.blockers).toEqual([]);
  const result = await withAwHomeMutationLock({ env: f.options.env, action: (token) => executePortableProjectRecovery({ prepared, token, authorizeUpdate }) });
  expect(result.execution, JSON.stringify(result)).toBe('applied');
  return prepared;
}

describe('Portable historical recovery through real catalog materialization', () => {
  it('keeps a Cursor content conflict while applying the independent Claude copy with exact per-Agent results', async () => {
    const f = await fixture(); await apply(f);
    await fs.writeFile(path.join(f.installed, 'SKILL.md'), 'foreign content must survive');
    f.options.agents = ['cursor', 'claude-code'];
    const prepared = await preparePortableProjectRecovery(f.options);
    expect(prepared.globalBlockers).toEqual([]);
    expect(prepared.targets.map((target) => [target.agent, target.observation])).toEqual([
      ['cursor', 'conflict'], ['claude-code', 'absent'],
    ]);
    const result = await withAwHomeMutationLock({ env: f.options.env, action: (token) =>
      executePortableProjectRecovery({ prepared, token }) });
    expect(result.execution).toBe('partial');
    expect(result.globalBlockers).toEqual([]);
    expect(result.targets.map((target) => [target.agent, target.execution, target.observation])).toEqual([
      ['cursor', 'not-run', 'conflict'], ['claude-code', 'applied', 'satisfied'],
    ]);
    expect(result.targets.find((target) => target.agent === 'claude-code')?.blockers).toEqual([]);
    expect(result.targets.filter((target) => target.execution !== 'applied' && target.execution !== 'no-op')
      .map((target) => target.agent)).toEqual(['cursor']);
    expect(await fs.readFile(path.join(f.installed, 'SKILL.md'), 'utf8')).toBe('foreign content must survive');
    expect(await fs.readFile(path.join(f.options.cwd, '.claude/skills/alpha/SKILL.md'), 'utf8')).toContain('Tone: first');
    expect(await f.addCalls()).toHaveLength(2);
  });
  it('installs one shared canonical tree and the separate Claude copy in the same exact skill group', async () => {
    const f = await fixture(); f.options.agents = ['codex', 'cursor', 'claude-code'];
    await apply(f);
    expect((await inspectPortableProjectRecovery(f.options)).targets.map((target) => target.observation))
      .toEqual(['satisfied', 'satisfied', 'satisfied']);
    expect(await f.addCalls()).toHaveLength(1);
  });
  it.each(['catalog', 'config'] as const)('updates verified old output after %s changes without rewriting shared inputs', async (change) => {
    const f = await fixture(); const original = await apply(f);
    const oldBinding = await fs.readFile(path.join(original.generation, 'aw-source-binding.json'));
    if (change === 'catalog') await f.upgrade(); else await f.changeConfig();
    const intent = await fs.readFile(f.intentPath), config = await fs.readFile(f.configPath).catch(() => undefined);
    const next = await preparePortableProjectRecovery(f.options);
    expect(next.targets.map((target) => target.observation)).toEqual(['drifted']);
    expect(next.targets[0]?.oldGenerationDigest).toBeDefined();
    expect(next.generation).not.toBe(original.generation);
    await apply(f, true);
    expect(await fs.readFile(f.intentPath)).toEqual(intent);
    expect(await fs.readFile(f.configPath).catch(() => undefined)).toEqual(config);
    expect(await fs.readFile(path.join(original.generation, 'aw-source-binding.json'))).toEqual(oldBinding);
    expect((await inspectPortableProjectRecovery(f.options)).targets[0]?.observation).toBe('satisfied');
    expect(await fs.readFile(path.join(f.installed, change === 'catalog' ? 'assets/payload.txt' : 'SKILL.md'), 'utf8'))
      .toContain(change === 'catalog' ? 'new-version' : 'second');
  });
  it('updates with a pruned historical snapshot using complete old generation evidence', async () => {
    const f = await fixture(); const original = await apply(f); await f.upgrade();
    const oldStore = resolveCatalogStoreLocation({ logicalIdentity: f.active.logicalIdentity, snapshotDigest: f.active.snapshotDigest, env: f.options.env });
    await fs.remove(oldStore.entryDir);
    expect(await fs.pathExists(oldStore.snapshotRoot)).toBe(false);
    expect(await fs.pathExists(original.generation)).toBe(true);
    expect((await preparePortableProjectRecovery(f.options)).targets[0]?.observation).toBe('drifted');
    await apply(f, true);
    expect(await f.addCalls()).toHaveLength(2);
  });
  it.each(['old-tree', 'installed-tree', 'marker-owner', 'extra-artifact', 'missing-artifact'] as const)(
    'does not update or re-sign %s damage even when old binding self digest is valid', async (damage) => {
      const f = await fixture(); const original = await apply(f);
      const bindingPath = path.join(original.generation, 'aw-source-binding.json'), binding = await fs.readFile(bindingPath);
      if (damage === 'old-tree') await fs.writeFile(path.join(original.generation, 'skills/alpha/.hidden'), 'tampered');
      if (damage === 'installed-tree') await fs.writeFile(path.join(f.installed, '.hidden'), 'tampered');
      if (damage === 'marker-owner') {
        const filename = path.join(original.generation, '.aw-materialization.json');
        const marker = await fs.readJson(filename); marker.selectedSkills[0].providerPluginId = 'local/foreign'; await fs.writeJson(filename, marker);
      }
      if (damage === 'extra-artifact') await fs.outputFile(path.join(original.generation, 'skills/extra/SKILL.md'), 'extra');
      if (damage === 'missing-artifact') await fs.remove(path.join(original.generation, 'skills/alpha'));
      expect((await readAwSourceBinding(bindingPath)).finalDigest).toBe(original.bindingDigest);
      const installed = await fs.readFile(path.join(f.installed, '.hidden'));
      await f.changeConfig();
      const prepared = await preparePortableProjectRecovery(f.options);
      expect(['unknown', 'conflict']).toContain(prepared.targets[0]?.observation);
      const result = await withAwHomeMutationLock({ env: f.options.env, action: (token) => executePortableProjectRecovery({ prepared, token, authorizeUpdate: true }) });
      expect(result.outputsMayHaveChanged).toBe(false);
      expect(await f.addCalls()).toHaveLength(1);
      expect(await fs.readFile(bindingPath)).toEqual(binding);
      expect(await fs.readFile(path.join(f.installed, '.hidden'))).toEqual(installed);
    });
  it('rebuilds missing current evidence without add but preserves different output when old generation is lost', async () => {
    const f = await fixture(); const original = await apply(f);
    await fs.remove(original.generation);
    expect((await preparePortableProjectRecovery(f.options)).targets[0]?.observation).toBe('satisfied');
    await fs.remove(original.generation); await f.changeConfig();
    expect((await preparePortableProjectRecovery(f.options)).targets[0]?.observation).toBe('unknown');
    expect(await f.addCalls()).toHaveLength(1);
  });
  it('inspection without a generation preserves requested root and agents without creating local output', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.options.cwd, 'catalog/plugins/portable/scripts/render.mjs'), 'throw new Error("status must not render");');
    await f.upgrade();
    const result = await inspectPortableProjectRecovery(f.options);
    expect(result.options.agents).toEqual(['cursor']); expect(result.root).toBe('local/portable');
    expect(result.blockers).toEqual(['needs-preparation']);
    expect(await fs.pathExists(path.join(f.options.cwd, '.agent-workflows/.local'))).toBe(false);
  });
  it('finds current owned Portable residue without any current Catalog and reports missing provider evidence conservatively', async () => {
    const f = await fixture(); await apply(f);
    await fs.remove(path.join(f.options.cwd, 'catalog'));
    const before = await fs.readFile(path.join(f.installed, 'SKILL.md'));
    const residue = await inspectPortableProjectResidue(f.options);
    expect(residue.state).toBe('present');
    expect(residue.targets).toEqual([{ skill: 'alpha', agent: 'cursor', physicalPath: await fs.realpath(f.installed) }]);
    expect((await inspectPortableProjectResidue({ ...f.options, env: { ...f.options.env, PATH: '' } })).state).toBe('unknown');
    expect((await inspectPortableProjectResidue({ ...f.options, selector: 'local/unrelated', env: { ...f.options.env, PATH: '' } })).state).toBe('absent');
    expect(await fs.readFile(path.join(f.installed, 'SKILL.md'))).toEqual(before);
    expect(await f.addCalls()).toHaveLength(1);
  });
});
