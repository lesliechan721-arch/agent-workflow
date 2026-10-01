import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { executePortableRecovery, inspectPortableRecovery, inspectPortableResidue, preparePortableRecovery, type PortablePreparation, type PortableRecoveryOptions } from '../../src/portable/recovery.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import { readAwSourceBinding } from '../../src/review/source-binding.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { createCatalogManifestV7, createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(scope: 'user' | 'project' = 'project', sharedRoots = false) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  await fs.ensureDir(path.join(cwd, '.git'));
  const sourceRoot = path.join(cwd, 'catalog');
  const pluginRoot = path.join(sourceRoot, 'plugins', 'portable');
  const configurePortable = (manifest: Parameters<NonNullable<Parameters<typeof createCatalogSnapshotFixture>[4]>>[0]): void => {
    manifest.extensions = { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] };
    manifest.distributions = { agentSkills: { skills: './agent-skills/skills' } };
    manifest.config = { fields: { tone: { type: 'string', default: 'first' } } };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
    manifest.artifacts = { targets: [{ id: 'alpha', distribution: 'agent-skills', target: 'agent-skills.skill',
      kind: 'skill', scopes: ['project', 'user'], states: ['present'], refreshKeys: ['tone'], skillKey: 'alpha' }] };
  };
  if (sharedRoots) {
    const configureConsumer = (manifest: Parameters<NonNullable<Parameters<typeof createCatalogSnapshotFixture>[4]>>[0]): void => {
      manifest.distributions = { agentSkills: { skills: './agent-skills/skills' } };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'portable', configureManifest: configurePortable },
      { name: 'root-a', dependencies: ['portable'], configureManifest: configureConsumer },
      { name: 'root-b', dependencies: ['portable'], configureManifest: configureConsumer },
    ]);
    await Promise.all(['root-a', 'root-b'].map((name) =>
      fs.ensureDir(path.join(sourceRoot, 'plugins', name, 'agent-skills', 'skills'))));
  } else {
    await createCatalogSnapshotFixture(sourceRoot, 'portable', [], 'Portable history fixture', configurePortable);
  }
  await fs.ensureDir(path.join(pluginRoot, 'agent-skills', 'skills'));
  await fs.outputFile(path.join(pluginRoot, 'scripts/render.mjs'), [
    "import fs from 'node:fs';",
    "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
    "console.log(JSON.stringify({version:2,artifacts:[{id:'alpha',distribution:'agent-skills',target:'agent-skills.skill',kind:'skill',state:'present',skillKey:'alpha',refreshKeys:['tone'],content:{files:{'SKILL.md':'---\\nname: alpha\\ndescription: alpha\\n---\\nTone: '+context.config.values.tone,'README.md':'Alpha readme','assets/payload.txt':'original','.hidden':'retain hidden bytes'}}}]}));",
  ].join('\n'));
  const refreshCatalog = async () => {
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    const names = sharedRoots ? ['portable', 'root-a', 'root-b'] : ['portable'];
    const entries = await Promise.all(names.map(async (name) => {
      const root = path.join(sourceRoot, 'plugins', name);
      return createCatalogManifestV7Entry(await readPluginManifest(root, { mode: 'bundle' }), root);
    }));
    await fs.writeJson(path.join(sourceRoot, 'catalog-manifest.json'), createCatalogManifestV7({
      catalogVersion: plugin.manifest.version, channel: 'latest',
      marketplace: { owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' }, interface: { displayName: 'Fixture Marketplace' } },
      requires: { aw: { capabilities: ['aw.catalog-snapshot.v7'] } }, release: { state: 'development' },
      entries,
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
const globalMode=args.includes('--global');
const home=process.env.HOME;
const lockPath=path.resolve('skills-lock.json');
let lock={version:1,skills:{}};try{lock=JSON.parse(fs.readFileSync(lockPath));}catch{}
const canonicalRoot=globalMode?path.join(home,'.agents'):path.resolve('.agents');
const claudeRoot=globalMode?(process.env.CLAUDE_CONFIG_DIR||path.join(home,'.claude')):path.resolve('.claude');
if(args[0]==='list'){
 const records=[];
 for(const [name,entry] of Object.entries(lock.skills)){
  const canonical=path.join(canonicalRoot,'skills',name), claude=path.join(claudeRoot,'skills',name);
  const agents=[...(fs.existsSync(canonical)?['Codex','Cursor']:[]),...(fs.existsSync(claude)?['Claude Code']:[])];
  if(agents.length)records.push({name,scope:'project',path:fs.existsSync(canonical)?canonical:claude,agents,source:path.resolve(entry.source)});
 }
 if(globalMode){const names=new Set([...fs.existsSync(path.join(canonicalRoot,'skills'))?fs.readdirSync(path.join(canonicalRoot,'skills')):[],...fs.existsSync(path.join(claudeRoot,'skills'))?fs.readdirSync(path.join(claudeRoot,'skills')):[]]);for(const name of names){const canonical=path.join(canonicalRoot,'skills',name),claude=path.join(claudeRoot,'skills',name);const agents=[...(fs.existsSync(canonical)?['Codex','Cursor']:[]),...(fs.existsSync(claude)?['Claude Code']:[])];records.push({name,scope:'global',path:fs.existsSync(canonical)?canonical:claude,agents,source:null});}}
 if(globalMode&&process.env.FORCE_LIST_PATH)records.splice(0,records.length,{name:'alpha',scope:'global',path:process.env.FORCE_LIST_PATH,agents:['Cursor'],source:null});
 console.log(JSON.stringify(records));process.exit(0);
}
if(args[0]==='add'){
 const source=args[1],skill=args[args.indexOf('--skill')+1],agents=args.slice(args.indexOf('--agent')+1,args.indexOf('--copy'));
 for(const agent of agents){const target=path.join(agent==='claude-code'?claudeRoot:canonicalRoot,'skills',skill);
 fs.rmSync(target,{force:true,recursive:true});fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(path.join(source,'skills',skill),target,{recursive:true});}
 if(!globalMode){lock.skills[skill]={source:path.relative(process.cwd(),source),sourceType:'local',computedHash:'not-aw-evidence'};
 fs.writeFileSync(lockPath,JSON.stringify(lock));}process.exit(0);
}
process.exit(2);
`);
  await fs.chmod(path.join(bin, 'skills'), 0o755);
  const env = { ...isolation.env, PATH: `${bin}${path.delimiter}${isolation.env.PATH}`, PROVIDER_LOG: log };
  const context = await createScopeContext({ scope, cwd, env });
  const options: PortableRecoveryOptions & { cwd: string } = { scope, context, selector: 'local/portable', agents: ['cursor'], cwd, env, cliVersion: '1.0.0' };
  const intentPath = path.join(cwd, '.agent-workflows/plugin-intents.json');
  const active = (await readCatalogGenerationState(env)).sources.local!.active!;
  await fs.outputJson(intentPath, { schemaVersion: 3, kind: 'aw-plugin-intents', roots: [{ pluginId: options.selector }],
    sources: { local: { logicalIdentity: active.logicalIdentity } } });
  const changeConfig = async () => writePluginConfigStore({ sourceId: 'local', sourceIdentity: active.sourceIdentity,
    logicalIdentity: active.logicalIdentity, pluginName: 'portable', scope, cwd: context.executionCwd,
    env, values: { tone: 'second' } });
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
  const addCalls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n')
    .filter(Boolean).map((line) => JSON.parse(line)).filter((args) => args[0] === 'add');
  return { options, active, intentPath, changeConfig, upgrade, addCalls, installed: path.join(cwd, '.agents/skills/alpha'),
    configPath: resolvePluginConfigStorePath({ pluginName: 'portable', sourceId: 'local', scope: 'project', cwd, env }) };
}
async function apply(f: Awaited<ReturnType<typeof fixture>>, authorizeUpdate = false) {
  const prepared = await preparePortableRecovery(f.options);
  expect(prepared.blockers).toEqual([]);
  const result = await withAwHomeMutationLock({ env: f.options.env, action: (token) => executePortableRecovery({ prepared, token, authorizeUpdate }) });
  expect(result.execution, JSON.stringify(result)).toBe('applied');
  return prepared;
}

describe('Portable historical recovery through real catalog materialization', () => {
  it('keeps User dynamic content and digest independent of two project configs and a plain caller', async () => {
    const f = await fixture('user');
    const projectA = f.options.cwd;
    const projectB = path.join(projectA, 'second-project');
    const plain = path.join(f.options.env.HOME!, 'plain-caller');
    await fs.ensureDir(path.join(projectB, '.git'));
    await fs.ensureDir(plain);
    const config = { sourceId: 'local', sourceIdentity: f.active.sourceIdentity,
      logicalIdentity: f.active.logicalIdentity, pluginName: 'portable', env: f.options.env };
    await writePluginConfigStore({ ...config, scope: 'user', cwd: projectA, values: { tone: 'USER-ONLY-6241' } });
    await writePluginConfigStore({ ...config, scope: 'project', cwd: projectA,
      values: { tone: 'PROJECT-A-ONLY-9713' } });
    const badProjectPath = resolvePluginConfigStorePath({ sourceId: 'local', pluginName: 'portable',
      scope: 'project', cwd: projectB, env: f.options.env });
    await fs.outputFile(badProjectPath, '{PROJECT-B-BAD-4827');
    const contexts = await Promise.all([projectA, projectB, plain].map((cwd) =>
      createScopeContext({ scope: 'user', cwd, env: f.options.env })));
    try {
      expect(new Set(contexts.map((context) => context.executionCwd)).size).toBe(1);
      expect(contexts.every((context) => context.executionCwd !== context.callerCwd)).toBe(true);
      const plans: PortablePreparation[] = [];
      for (const context of contexts) plans.push(await preparePortableRecovery({ ...f.options, context }));
      expect(plans.every((plan) => plan.blockers.length === 0)).toBe(true);
      expect(new Set(plans.map((plan) => plan.generation)).size).toBe(1);
      expect(new Set(plans.map((plan) => plan.bindingDigest)).size).toBe(1);
      expect(new Set(plans.map((plan) => plan.targets[0]?.expectedDigest)).size).toBe(1);
      const content = await fs.readFile(path.join(plans[0]!.generation, 'skills/alpha/SKILL.md'), 'utf8');
      expect(content).toContain('USER-ONLY-6241');
      expect(content).not.toContain('PROJECT-A-ONLY-9713');
      expect(content).not.toContain('PROJECT-B-BAD-4827');
      const applied = await withAwHomeMutationLock({ env: f.options.env, action: (token) =>
        executePortableRecovery({ prepared: plans[0]!, token }) });
      expect(applied.execution).toBe('applied');
      expect(JSON.stringify(applied)).not.toMatch(/PROJECT-A-ONLY-9713|PROJECT-B-BAD-4827/u);
      for (const context of contexts.slice(1)) {
        const prepared = await preparePortableRecovery({ ...f.options, context });
        const result = await withAwHomeMutationLock({ env: f.options.env, action: (token) =>
          executePortableRecovery({ prepared, token }) });
        expect(result.execution).toBe('no-op');
        expect(JSON.stringify({ prepared: { generation: prepared.generation, targets: prepared.targets }, result }))
          .not.toMatch(/PROJECT-A-ONLY-9713|PROJECT-B-BAD-4827/u);
      }
      const log = await fs.readFile(path.join(projectA, 'provider-calls.jsonl'), 'utf8');
      expect(log).not.toMatch(/PROJECT-A-ONLY-9713|PROJECT-B-BAD-4827/u);
      expect(await f.addCalls()).toHaveLength(1);
    } finally {
      await Promise.all(contexts.map((context) => context.dispose()));
    }
  });

  it('keeps user and project copies and generations separate, then skips a satisfied global copy', async () => {
    const f = await fixture('user');
    f.options.agents = ['codex', 'cursor', 'claude-code'];
    const userPlan = await apply(f);
    const userPath = path.join(f.options.context.targetHomes.home, '.agents/skills/alpha');
    const claudePath = path.join(f.options.context.targetHomes.claude, 'skills/alpha');
    expect(userPlan.generation).toContain('/portable/user/');
    expect(await fs.pathExists(userPath)).toBe(true);
    expect(await fs.pathExists(claudePath)).toBe(true);
    expect(userPlan.targets.map((target) => target.physicalPath)).toEqual([userPath, userPath, claudePath]);
    expect(await fs.pathExists(f.installed)).toBe(false);
    const noOp = await withAwHomeMutationLock({ env: f.options.env, action: async (token) =>
      executePortableRecovery({ prepared: await preparePortableRecovery(f.options), token }) });
    expect(noOp.execution).toBe('no-op');
    expect((await f.addCalls()).length).toBe(1);
    const projectContext = await createScopeContext({ scope: 'project', cwd: f.options.cwd, env: f.options.env });
    const projectOptions = { ...f.options, scope: 'project' as const, context: projectContext };
    expect((await inspectPortableRecovery(projectOptions)).globalBlockers).toContain('needs-preparation');
    const projectPlan = await preparePortableRecovery(projectOptions);
    expect(projectPlan.targets[0]?.observation).toBe('absent');
    const projectResult = await withAwHomeMutationLock({ env: f.options.env, action: (token) =>
      executePortableRecovery({ prepared: projectPlan, token }) });
    expect(projectResult.execution).toBe('applied');
    expect(await fs.pathExists(f.installed)).toBe(true);
    expect((await inspectPortableRecovery(f.options)).targets[0]?.observation).toBe('satisfied');
  });

  it('blocks a malformed global lock before touching foreign output', async () => {
    const f = await fixture('user');
    const lock = path.join(f.options.env.XDG_STATE_HOME!, 'skills/.skill-lock.json');
    const foreign = path.join(f.options.env.HOME!, '.agents/skills/alpha/SKILL.md');
    await fs.outputFile(lock, '{bad json\n');
    await fs.outputFile(foreign, 'foreign content');
    const prepared = await preparePortableRecovery(f.options);
    expect(prepared.globalBlockers).toContain('portableProviderLockInvalid');
    expect(await fs.readFile(lock, 'utf8')).toBe('{bad json\n');
    expect(await fs.readFile(foreign, 'utf8')).toBe('foreign content');
    expect((await f.addCalls()).length).toBe(0);
  });

  it('keeps valid global lock metadata and non-AW entries unchanged', async () => {
    const f = await fixture('user');
    const lock = path.join(f.options.env.XDG_STATE_HOME!, 'skills/.skill-lock.json');
    const value = { version: 3, skills: { foreign: { source: 'foreign/repo', sourceType: 'github',
      sourceUrl: 'https://example.invalid/foreign', pluginName: 'foreign',
      sourceBaseUrl: 'https://example.invalid', skillFolderHash: 'abc',
      installedAt: '2024-01-01', updatedAt: '2024-01-02' } },
    dismissed: { findSkillsPrompt: true }, lastSelectedAgents: ['cursor'] };
    await fs.outputJson(lock, value);
    await apply(f);
    expect(await fs.readJson(lock)).toEqual(value);
  });

  it('uses provider CLAUDE_CONFIG_DIR even when AW_CLAUDE_HOME differs', async () => {
    const f = await fixture('user');
    const claudeProviderHome = path.join(f.options.env.HOME!, 'provider-claude');
    const env = { ...f.options.env, CLAUDE_CONFIG_DIR: claudeProviderHome };
    f.options.context = await createScopeContext({ scope: 'user', cwd: f.options.cwd, env });
    f.options.env = env;
    f.options.agents = ['claude-code'];
    const prepared = await apply(f);
    expect(prepared.targets[0]?.physicalPath).toBe(path.join(f.options.context.targetHomes.home, 'provider-claude/skills/alpha'));
    expect(await fs.pathExists(path.join(claudeProviderHome, 'skills/alpha/SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(env.AW_CLAUDE_HOME!, 'skills/alpha'))).toBe(false);
  });

  it('keeps unknown global output and rejects a provider path outside its qualified root', async () => {
    const f = await fixture('user');
    const foreign = path.join(f.options.env.HOME!, '.agents/skills/alpha/SKILL.md');
    await fs.outputFile(foreign, 'foreign content');
    const unknown = await preparePortableRecovery(f.options);
    expect(unknown.targets[0]?.blocker).toBe('portableOutputConflict');
    const result = await withAwHomeMutationLock({ env: f.options.env, action: (token) =>
      executePortableRecovery({ prepared: unknown, token }) });
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await fs.readFile(foreign, 'utf8')).toBe('foreign content');
    await fs.remove(path.dirname(foreign));
    const escapedEnv = { ...f.options.env, FORCE_LIST_PATH: path.join(f.options.cwd, 'outside/alpha') };
    const escapedContext = await createScopeContext({ scope: 'user', cwd: f.options.cwd, env: escapedEnv });
    const escaped = await preparePortableRecovery({ ...f.options, context: escapedContext, env: escapedEnv });
    expect(escaped.targets[0]?.blocker).toBe('portableTargetAssociationUnknown');
    expect((await f.addCalls()).length).toBe(0);
  });

  it('does not turn matching external global content into AW ownership through a generation', async () => {
    const f = await fixture('user');
    const first = await preparePortableRecovery(f.options);
    const target = first.targets[0]!.physicalPath;
    await fs.copy(path.join(first.generation, 'skills/alpha'), target);
    const matching = await inspectPortableRecovery(f.options);
    expect(matching.targets[0]).toMatchObject({ observation: 'satisfied', ownership: 'external' });
    await f.changeConfig();
    const changed = await preparePortableRecovery(f.options);
    expect(changed.targets[0]).toMatchObject({ observation: 'unknown', ownership: 'unknown' });
    const result = await withAwHomeMutationLock({ env: f.options.env, action: (token) =>
      executePortableRecovery({ prepared: changed, token, authorizeUpdate: true }) });
    expect(result.outputsMayHaveChanged).toBe(false);
    expect((await f.addCalls()).length).toBe(0);
  });

  it('rejects a foreign provider symlink even when it resolves to the expected global tree', async () => {
    const f = await fixture('user');
    await apply(f);
    const alias = path.join(f.options.cwd, 'foreign-link');
    await fs.symlink(path.join(f.options.context.targetHomes.home, '.agents/skills/alpha'), alias);
    const env = { ...f.options.env, FORCE_LIST_PATH: alias };
    const context = await createScopeContext({ scope: 'user', cwd: f.options.cwd, env });
    const inspected = await inspectPortableRecovery({ ...f.options, context, env });
    expect(inspected.targets[0]?.blocker).toBe('portableTargetAssociationUnknown');
  });

  it('blocks automatic global update after a real copy when provider gives no source', async () => {
    const f = await fixture('user');
    await apply(f);
    const installed = path.join(f.options.context.targetHomes.home, '.agents/skills/alpha/SKILL.md');
    const oldBytes = await fs.readFile(installed);
    expect((await inspectPortableResidue(f.options)).state).toBe('unknown');
    await f.changeConfig();
    const changed = await preparePortableRecovery(f.options);
    expect(changed.targets[0]).toMatchObject({ observation: 'unknown', ownership: 'unknown' });
    const result = await withAwHomeMutationLock({ env: f.options.env, action: (token) =>
      executePortableRecovery({ prepared: changed, token, authorizeUpdate: true }) });
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await fs.readFile(installed)).toEqual(oldBytes);
    expect((await f.addCalls()).length).toBe(1);
  });

  it('reuses a verified global dependency copy across two roots in one operation', async () => {
    const f = await fixture('user', true);
    const rootA = { ...f.options, selector: 'local/root-a' };
    const rootB = { ...f.options, selector: 'local/root-b' };
    const firstPlan = await preparePortableRecovery(rootA);
    const secondPlan = await preparePortableRecovery(rootB);
    expect(firstPlan.targets[0]).toMatchObject({ providerPluginId: 'local/portable', observation: 'absent' });
    expect(secondPlan.targets[0]).toMatchObject({ providerPluginId: 'local/portable', observation: 'absent' });
    expect(firstPlan.targets[0]?.physicalPath).toBe(secondPlan.targets[0]?.physicalPath);
    await withAwHomeMutationLock({ env: f.options.env, action: async (token) => {
      const first = await executePortableRecovery({ prepared: firstPlan, token });
      expect(first.execution).toBe('applied');
      const completedFootprints = first.targets.filter((target) => target.execution === 'applied')
        .map(({ physicalPath, expectedDigest, providerPluginId }) => ({
          physicalPath, expectedDigest, providerPluginId, logicalIdentity: firstPlan.logicalIdentity,
        }));
      const unrelated = await executePortableRecovery({ prepared: secondPlan, token,
        completedFootprints: completedFootprints.map((entry) => ({ ...entry, logicalIdentity: 'other-source' })) });
      expect(unrelated.blockers).toContain('operationReviewStale');
      expect(unrelated.outputsMayHaveChanged).toBe(false);
      const second = await executePortableRecovery({ prepared: secondPlan, token, completedFootprints });
      expect(second.execution).toBe('no-op');
      expect(second.outputsMayHaveChanged).toBe(false);
    } });
    expect((await f.addCalls()).length).toBe(1);
    expect((await inspectPortableRecovery(rootB)).targets[0])
      .toMatchObject({ observation: 'satisfied', ownership: 'external' });
    const laterPlan = await preparePortableRecovery(rootB);
    const later = await withAwHomeMutationLock({ env: f.options.env, action: (token) =>
      executePortableRecovery({ prepared: laterPlan, token, action: 'reinstall' }) });
    expect(later.outputsMayHaveChanged).toBe(false);
    expect(later.blockers).toContain('portableOutputConflict');
    expect((await f.addCalls()).length).toBe(1);
  }, 30_000);

  it('keeps a Cursor content conflict while applying the independent Claude copy with exact per-Agent results', async () => {
    const f = await fixture(); await apply(f);
    await fs.writeFile(path.join(f.installed, 'SKILL.md'), 'foreign content must survive');
    f.options.agents = ['cursor', 'claude-code'];
    const prepared = await preparePortableRecovery(f.options);
    expect(prepared.globalBlockers).toEqual([]);
    expect(prepared.targets.map((target) => [target.agent, target.observation])).toEqual([
      ['cursor', 'conflict'], ['claude-code', 'absent'],
    ]);
    const result = await withAwHomeMutationLock({ env: f.options.env, action: (token) =>
      executePortableRecovery({ prepared, token }) });
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
    expect((await inspectPortableRecovery(f.options)).targets.map((target) => target.observation))
      .toEqual(['satisfied', 'satisfied', 'satisfied']);
    expect(await f.addCalls()).toHaveLength(1);
  });
  it.each(['catalog', 'config'] as const)('updates verified old output after %s changes without rewriting shared inputs', async (change) => {
    const f = await fixture(); const original = await apply(f);
    const oldBinding = await fs.readFile(path.join(original.generation, 'aw-source-binding.json'));
    if (change === 'catalog') await f.upgrade(); else await f.changeConfig();
    const intent = await fs.readFile(f.intentPath), config = await fs.readFile(f.configPath).catch(() => undefined);
    const next = await preparePortableRecovery(f.options);
    expect(next.targets.map((target) => target.observation)).toEqual(['drifted']);
    expect(next.targets[0]?.oldGenerationDigest).toBeDefined();
    expect(next.generation).not.toBe(original.generation);
    await apply(f, true);
    expect(await fs.readFile(f.intentPath)).toEqual(intent);
    expect(await fs.readFile(f.configPath).catch(() => undefined)).toEqual(config);
    expect(await fs.readFile(path.join(original.generation, 'aw-source-binding.json'))).toEqual(oldBinding);
    expect((await inspectPortableRecovery(f.options)).targets[0]?.observation).toBe('satisfied');
    expect(await fs.readFile(path.join(f.installed, change === 'catalog' ? 'assets/payload.txt' : 'SKILL.md'), 'utf8'))
      .toContain(change === 'catalog' ? 'new-version' : 'second');
  });
  it('updates with a pruned historical snapshot using complete old generation evidence', async () => {
    const f = await fixture(); const original = await apply(f); await f.upgrade();
    const oldStore = resolveCatalogStoreLocation({ logicalIdentity: f.active.logicalIdentity, snapshotDigest: f.active.snapshotDigest, env: f.options.env });
    await fs.remove(oldStore.entryDir);
    expect(await fs.pathExists(oldStore.snapshotRoot)).toBe(false);
    expect(await fs.pathExists(original.generation)).toBe(true);
    expect((await preparePortableRecovery(f.options)).targets[0]?.observation).toBe('drifted');
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
      const prepared = await preparePortableRecovery(f.options);
      expect(['unknown', 'conflict']).toContain(prepared.targets[0]?.observation);
      const result = await withAwHomeMutationLock({ env: f.options.env, action: (token) => executePortableRecovery({ prepared, token, authorizeUpdate: true }) });
      expect(result.outputsMayHaveChanged).toBe(false);
      expect(await f.addCalls()).toHaveLength(1);
      expect(await fs.readFile(bindingPath)).toEqual(binding);
      expect(await fs.readFile(path.join(f.installed, '.hidden'))).toEqual(installed);
    });
  it('rebuilds missing current evidence without add but preserves different output when old generation is lost', async () => {
    const f = await fixture(); const original = await apply(f);
    await fs.remove(original.generation);
    expect((await preparePortableRecovery(f.options)).targets[0]?.observation).toBe('satisfied');
    await fs.remove(original.generation); await f.changeConfig();
    expect((await preparePortableRecovery(f.options)).targets[0]?.observation).toBe('unknown');
    expect(await f.addCalls()).toHaveLength(1);
  });
  it('inspection without a generation preserves requested root and agents without creating local output', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.options.cwd, 'catalog/plugins/portable/scripts/render.mjs'), 'throw new Error("status must not render");');
    await f.upgrade();
    const result = await inspectPortableRecovery(f.options);
    expect(result.options.agents).toEqual(['cursor']); expect(result.root).toBe('local/portable');
    expect(result.blockers).toEqual(['needs-preparation']);
    expect(await fs.pathExists(path.join(f.options.cwd, '.agent-workflows/.local'))).toBe(false);
  });
  it('finds current owned Portable residue without any current Catalog and reports missing provider evidence conservatively', async () => {
    const f = await fixture(); await apply(f);
    await fs.remove(path.join(f.options.cwd, 'catalog'));
    const before = await fs.readFile(path.join(f.installed, 'SKILL.md'));
    const residue = await inspectPortableResidue(f.options);
    expect(residue.state).toBe('present');
    expect(residue.targets).toEqual([{ skill: 'alpha', agent: 'cursor', physicalPath: await fs.realpath(f.installed) }]);
    const missingProviderEnv = { ...f.options.env, PATH: '' };
    const context = await createScopeContext({ scope: 'project', cwd: f.options.cwd, env: missingProviderEnv });
    expect((await inspectPortableResidue({ ...f.options, context, env: missingProviderEnv })).state).toBe('unknown');
    expect((await inspectPortableResidue({ ...f.options, context, selector: 'local/unrelated', env: missingProviderEnv })).state).toBe('absent');
    expect(await fs.readFile(path.join(f.installed, 'SKILL.md'))).toEqual(before);
    expect(await f.addCalls()).toHaveLength(1);
  });
  it('keeps a verified residue visible beside a damaged historical generation', async () => {
    const f = await fixture();
    const prepared = await apply(f);
    await fs.ensureDir(path.join(path.dirname(prepared.generation), 'bad'));
    const residue = await inspectPortableResidue(f.options);
    expect(residue.state).toBe('present');
    expect(residue.targets).toEqual([{ skill: 'alpha', agent: 'cursor', physicalPath: await fs.realpath(f.installed) }]);
    expect(residue.unknownAgents).toEqual(['cursor']);
  });
  it.each(['project', 'user'] as const)('finds dependency Portable residue materialized by another %s root', async (scope) => {
    const f = await fixture(scope, true);
    const root = { ...f.options, selector: 'local/root-a' };
    const prepared = await preparePortableRecovery(root);
    await withAwHomeMutationLock({ env: f.options.env, action: (token) =>
      executePortableRecovery({ prepared, token }) });
    const residue = await inspectPortableResidue({ ...f.options, selector: 'local/portable' });
    if (scope === 'project') {
      expect(residue.targets).toEqual([expect.objectContaining({ skill: 'alpha', agent: 'cursor' })]);
    } else {
      expect(residue.targets).toEqual([]);
      expect(residue.unknownAgents).toEqual(['cursor']);
    }
    expect(residue.state).not.toBe('absent');
    const env = { ...f.options.env, PATH: '' };
    const context = await createScopeContext({ scope, cwd: f.options.cwd, env });
    expect(await inspectPortableResidue({ ...f.options, context, env, selector: 'local/portable' }))
      .toMatchObject({ state: 'unknown', unknownAgents: ['cursor'] });
  });
});
