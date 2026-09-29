import path from 'node:path';

import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createScopeContext } from '../../src/intent/scope-context.js';
import { removeRoot } from '../../src/intent/intent-store.js';
import { writeAwSourceBinding } from '../../src/review/source-binding.js';
import { portableJsonDigest, portableSkillTreeDigest } from '../../src/portable/historical-materialization.js';
import { executePortableRecovery, inspectPortableExtraInstalled, inspectPortableRecovery, inspectPortableResidue, preparePortableRecovery } from '../../src/portable/recovery.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const state = vi.hoisted(() => ({ content: 'first', extraFile: '', builds: 0, scope: 'project' as 'project' | 'user' }));
vi.mock('../../src/portable/materializer.js', () => ({
  resolvePortableCatalogBindingInput: async () => ({ source: {
    kind: 'catalog-snapshot', sourceId: 'team', catalogSourceIdentity: portableJsonDigest('catalog'),
    logicalIdentity: 'team-catalog', snapshotDigest: portableJsonDigest('snapshot'), workspaceIdentity: 'workspace',
    workspaceSourceIdentity: portableJsonDigest('workspace'),
  }, subject: { plugin: 'root' }, profile: { kind: 'portable', id: `agent-skills-${state.scope}`, scope: state.scope, inputDigest: portableJsonDigest(state.content) } }),
}));
vi.mock('../../src/portable/commands.js', () => ({
  materializePortableSkillsToDirectory: async (options: { out: string }) => {
    state.builds += 1;
    const skill = path.join(options.out, 'skills', 'alpha');
    await fs.outputFile(path.join(skill, 'SKILL.md'), `---\nname: alpha\ndescription: alpha\n---\n${state.content}`);
    if (state.extraFile) await fs.outputFile(path.join(skill, state.extraFile), 'extra');
    const { resolvePortableCatalogBindingInput } = await import('../../src/portable/materializer.js');
    const binding = await resolvePortableCatalogBindingInput({} as never);
    await writeAwSourceBinding({ rootDir: options.out, ...binding, artifacts: [
      { kind: 'portable-skill', plugin: 'root', skill: 'alpha', path: 'skills/alpha' },
    ] });
    const selectedSkills = [{ name: 'alpha', providerPluginId: 'team/root', filesDigest: await portableSkillTreeDigest(skill) }];
    const outputDigest = portableJsonDigest(selectedSkills.map((entry) => [entry.name, entry.filesDigest]));
    await fs.writeJson(path.join(options.out, '.aw-materialization.json'), {
      schemaVersion: 1, receiptSchemaVersion: 5, command: 'skill:materialize', scope: state.scope,
      plugin: { id: 'team/root', sourceId: 'team', sourceIdentity: binding.source.catalogSourceIdentity },
      config: { pluginConfigDigest: binding.profile.inputDigest }, selectedSkills, outputDigest, materializationDigest: outputDigest,
    });
  },
}));

async function fixture() {
  const isolated = getCurrentSourceTestIsolation();
  const cwd = path.join(isolated.env.AW_HOME!, 'project');
  const bin = path.join(isolated.env.AW_HOME!, 'bin');
  await fs.ensureDir(path.join(cwd, '.git'));
  await fs.ensureDir(bin);
  const log = path.join(cwd, 'calls.jsonl');
  await fs.writeFile(path.join(bin, 'skills'), `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const cwd = process.cwd();
fs.appendFileSync(process.env.PROVIDER_LOG, JSON.stringify(args) + '\\n');
if(args[0] === '--version') { console.log('1.5.23'); process.exit(0); }
let lock = {version:1, skills:{}}; try { lock=JSON.parse(fs.readFileSync('skills-lock.json')); } catch {}
if(args[0] === 'list') {
 if(process.env.FAIL_LIST) process.exit(2);
 if(args.includes('--global')) {
  const other=path.join(process.env.HOME,'.agents/skills/beta');
  console.log(JSON.stringify(fs.existsSync(other) ? [{name:'beta',path:other,scope:'global',agents:['Codex'],source:null}] : []));
  process.exit(0);
 }
 const root = path.join(cwd,'.agents/skills/alpha');
 const claude = path.join(cwd,'.claude/skills/alpha');
 console.log(JSON.stringify(fs.existsSync(root)||fs.existsSync(claude) ? [{name:'alpha',path:fs.existsSync(root)?root:claude,
 scope:process.env.WRONG_SCOPE?'global':'project', agents:process.env.PROVIDER_AGENTS?JSON.parse(process.env.PROVIDER_AGENTS):[...(fs.existsSync(root)?['Codex','Cursor']:[]),...(fs.existsSync(claude)?['Claude Code']:[])],
 source:lock.skills.alpha?.source}] : [])); process.exit(0);
}
if(args[0] === 'add') {
 const source=args[1]; const agent=args[args.indexOf('--agent')+1];
 const target=path.join(cwd, agent==='claude-code'?'.claude':'.agents','skills','alpha');
 fs.rmSync(target,{force:true,recursive:true}); fs.mkdirSync(path.dirname(target),{recursive:true});
 fs.cpSync(path.join(source,'skills','alpha'),target,{recursive:true});
 lock.skills.alpha={source,sourceType:'local',computedHash:'provider-hash'};
 fs.writeFileSync('skills-lock.json',JSON.stringify(lock)); process.exit(0);
}
process.exit(2);
`);
  await fs.chmod(path.join(bin, 'skills'), 0o755);
  const env = { ...isolated.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PROVIDER_LOG: log };
  const context = await createScopeContext({ scope: 'project', cwd, env });
  return { scope: 'project' as const, context, selector: 'team/root', cwd, cliVersion: '1.0.0',
    agents: ['codex', 'cursor'] as const, env, log };
}
async function addCalls(log: string) {
  return (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((args) => args[0] === 'add');
}
beforeEach(() => { state.content = 'first'; state.extraFile = ''; state.builds = 0; state.scope = 'project'; });

describe('project Portable recovery', () => {
  it('reports Project Portable extras from verified provider source evidence', async () => {
    const fixtureValue = await fixture();
    const options = { ...fixtureValue, agents: [...fixtureValue.agents] };
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      expect((await executePortableRecovery({ prepared: await preparePortableRecovery(options), token })).execution)
        .toBe('applied');
    } });
    const observed = await inspectPortableExtraInstalled({
      scope: 'project', context: options.context, env: options.env,
    });
    expect(observed.complete).toBe(true);
    expect(observed.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/root', skill: 'alpha', agent: 'codex',
        observation: 'verified', content: 'satisfied' }),
      expect.objectContaining({ pluginId: 'team/root', skill: 'alpha', agent: 'cursor',
        observation: 'verified', content: 'satisfied' }),
    ]));
    const intentLocation = { scope: 'project' as const, cwd: options.cwd, env: options.env };
    await writeIntentFixture(intentLocation, { roots: [{ pluginId: 'team/root' }], agents: ['cursor'] });
    await removeRoot(intentLocation, 'team/root');
    const status = await readRecoveryStatus({ ...intentLocation, nativeObservations: [] });
    expect(status.inventory).toEqual([]);
    expect(status.coverage).toEqual({ native: true, portable: true });
    expect(status.extraObserved).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/root', agent: 'cursor', scope: 'project',
        delivery: { kind: 'agent-skills', provider: 'skills-cli', agentId: 'cursor' },
        observation: 'verified', content: 'satisfied' }),
    ]));
    const missingProviderEnv = { ...options.env, PATH: '' };
    const missingProviderContext = await createScopeContext({
      scope: 'project', cwd: options.cwd, env: missingProviderEnv,
    });
    expect(await inspectPortableExtraInstalled({
      scope: 'project', context: missingProviderContext, env: missingProviderEnv,
    })).toEqual({ targets: [], complete: false });
    expect((await readRecoveryStatus({
      scope: 'project', cwd: options.cwd, env: missingProviderEnv, nativeObservations: [],
    })).coverage).toEqual({ native: true, portable: false });
  });

  it('does not turn unsupported User Portable observation into residue without AW evidence', async () => {
    const fixtureValue = await fixture();
    const userContext = await createScopeContext({ scope: 'user', cwd: fixtureValue.cwd, env: fixtureValue.env });
    try {
      const unsupported = { ...userContext,
        env: { ...userContext.env, HOME: path.join(fixtureValue.cwd, 'different-home') } };
      const options = { scope: 'user' as const, context: unsupported, selector: 'team/root',
        env: unsupported.env, agents: ['codex' as const] };
      expect(await inspectPortableResidue(options)).toEqual({ state: 'absent', targets: [], blockers: [] });
      await fs.ensureDir(path.join(userContext.generationRoot, portableJsonDigest('team/root').slice(7)));
      expect(await inspectPortableResidue(options)).toEqual({
        state: 'unknown', targets: [], blockers: ['portableObservationFailed'], unknownAgents: ['codex'],
      });
    } finally { await userContext.dispose(); }
  });
  it('ignores an unrelated global Skill after the selected User Portable output was removed', async () => {
    const fixtureValue = await fixture();
    state.scope = 'user';
    const context = await createScopeContext({ scope: 'user', cwd: fixtureValue.cwd, env: fixtureValue.env });
    try {
      const options = { scope: 'user' as const, context, selector: 'team/root',
        env: context.env, cliVersion: '1.0.0', agents: ['codex' as const] };
      await preparePortableRecovery(options);
      await fs.outputFile(path.join(context.env.HOME!, '.agents/skills/beta/SKILL.md'), 'unrelated');
      expect(await inspectPortableResidue(options)).toEqual({ state: 'absent', targets: [], blockers: [] });
    } finally { await context.dispose(); }
  });

  it('ignores a verified Claude-only residue for Codex selection but retains unknown associations', async () => {
    const fixtureValue = await fixture();
    const options = { ...fixtureValue, agents: ['claude-code' as const] };
    const prepared = await preparePortableRecovery(options);
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      expect((await executePortableRecovery({ prepared, token })).execution).toBe('applied');
    } });
    expect((await inspectPortableResidue({ ...options, agents: ['claude-code'] })).state).toBe('present');
    expect(await inspectPortableResidue({ ...options, agents: ['codex'] })).toEqual({ state: 'absent', targets: [], blockers: [] });
    for (const agents of [[], ['Unrecognized Agent']]) {
      const env = { ...options.env, PROVIDER_AGENTS: JSON.stringify(agents) };
      const context = await createScopeContext({ scope: 'project', cwd: options.cwd, env });
      expect(await inspectPortableResidue({ ...options, context, agents: ['codex'], env }))
        .toEqual({ state: 'unknown', targets: [], blockers: ['portableObservationFailed'], unknownAgents: ['codex'] });
    }
    expect(await addCalls(options.log)).toHaveLength(1);
    expect(await fs.pathExists(path.join(options.cwd, '.claude/skills/alpha/SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(options.cwd, '.agents/skills/alpha'))).toBe(false);
  });
  it('retains an uncertain Claude residue beside a verified Codex residue', async () => {
    const fixtureValue = await fixture();
    const options = { ...fixtureValue, agents: ['codex' as const] };
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      expect((await executePortableRecovery({ prepared: await preparePortableRecovery(options), token })).execution)
        .toBe('applied');
    } });
    await fs.copy(path.join(options.cwd, '.agents/skills/alpha'), path.join(options.cwd, '.claude/skills/alpha'));
    await fs.appendFile(path.join(options.cwd, '.claude/skills/alpha/SKILL.md'), '\nmodified');
    const residue = await inspectPortableResidue({ ...options, agents: ['codex', 'claude-code'] });
    expect(residue.state).toBe('present');
    expect(residue.targets.map((target) => target.agent)).toEqual(['codex']);
    expect(residue.unknownAgents).toEqual(['claude-code']);
  });
  it('static inspection never materializes; shared paths install once and subsequent recovery is a file no-op', async () => {
    const fixtureValue = await fixture();
    const options = { ...fixtureValue, agents: [...fixtureValue.agents] };
    expect((await inspectPortableRecovery(options)).blockers).toEqual(['needs-preparation']);
    expect(state.builds).toBe(0);
    const prepared = await preparePortableRecovery(options);
    expect(prepared.targets.map((target) => target.observation)).toEqual(['absent', 'absent']);
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      expect((await executePortableRecovery({ prepared, token })).execution).toBe('applied');
      const before = await fs.stat(path.join(options.cwd, '.agents/skills/alpha/SKILL.md'));
      const again = await preparePortableRecovery(options);
      expect((await executePortableRecovery({ prepared: again, token })).execution).toBe('no-op');
      expect((await fs.stat(path.join(options.cwd, '.agents/skills/alpha/SKILL.md'))).mtimeMs).toBe(before.mtimeMs);
    } });
    expect(await addCalls(options.log)).toHaveLength(1);
  });
  it('updates only a fully verified historical generation and keeps unrelated lock entries', async () => {
    const fixtureValue = await fixture(); const options = { ...fixtureValue, agents: [...fixtureValue.agents] };
    await fs.writeJson(path.join(options.cwd, 'skills-lock.json'), {version:1,skills:{foreign:{source:'foreign',sourceType:'local',computedHash:'keep'}}});
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      await executePortableRecovery({ prepared: await preparePortableRecovery(options), token });
      state.content = 'second';
      const prepared = await preparePortableRecovery(options);
      expect(prepared.targets.map((target) => target.observation)).toEqual(['drifted', 'drifted']);
      expect((await executePortableRecovery({ prepared, token })).blockers).toEqual(['portableUpdateAuthorizationRequired']);
      expect((await executePortableRecovery({ prepared, token, authorizeUpdate: true })).execution).toBe('applied');
    } });
    expect((await fs.readJson(path.join(options.cwd,'skills-lock.json'))).skills.foreign.computedHash).toBe('keep');
  });
  it('reinstalls once and reuses only verified matching batch footprints for later consumers', async () => {
    const fixtureValue = await fixture(); const options = { ...fixtureValue, agents: [...fixtureValue.agents] };
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      await executePortableRecovery({ prepared: await preparePortableRecovery(options), token });
      const prepared = await preparePortableRecovery(options);
      const first = await executePortableRecovery({ prepared, token, action: 'reinstall' });
      expect(first.execution).toBe('applied');
      expect(await addCalls(options.log)).toHaveLength(2);
      const completedFootprints = first.targets.map(({ physicalPath, expectedDigest, providerPluginId }) => ({
        physicalPath, expectedDigest, providerPluginId, logicalIdentity: prepared.logicalIdentity,
      }));
      const before = await fs.stat(path.join(options.cwd, '.agents/skills/alpha/SKILL.md'));
      const reused = await executePortableRecovery({ prepared: await preparePortableRecovery(options),
        token, action: 'reinstall', completedFootprints });
      expect(reused.execution).toBe('no-op');
      expect(reused.targets.map((target) => target.execution)).toEqual(['no-op', 'no-op']);
      expect(await addCalls(options.log)).toHaveLength(2);
      expect((await fs.stat(path.join(options.cwd, '.agents/skills/alpha/SKILL.md'))).mtimeMs).toBe(before.mtimeMs);
      const mismatched = await executePortableRecovery({ prepared: await preparePortableRecovery(options),
        token, action: 'reinstall', completedFootprints: completedFootprints.map((entry) => ({ ...entry, logicalIdentity: 'other-source' })) });
      expect(mismatched.execution).toBe('applied');
      expect(await addCalls(options.log)).toHaveLength(3);
    } });
  });
  it.each(['bad-lock', 'failed-list', 'filtered-file'])('blocks %s before add', async (kind) => {
    const fixtureValue = await fixture(); const options = { ...fixtureValue, agents: [...fixtureValue.agents] };
    if(kind==='bad-lock') await fs.writeFile(path.join(options.cwd,'skills-lock.json'), '{broken');
    if(kind==='failed-list') { Object.assign(options.env,{FAIL_LIST:'1'});
      options.context = await createScopeContext({ scope: 'project', cwd: options.cwd, env: options.env }); }
    if(kind==='filtered-file') state.extraFile='metadata.json';
    const prepared = await preparePortableRecovery(options);
    expect(prepared.blockers.length).toBeGreaterThan(0);
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      expect((await executePortableRecovery({ prepared, token })).outputsMayHaveChanged).toBe(false);
    } });
    if(await fs.pathExists(options.log)) expect(await addCalls(options.log)).toHaveLength(0);
  });
  it('rejects Review drift before writing and never removes unsupported backend outputs', async () => {
    const fixtureValue = await fixture(); const options = { ...fixtureValue, agents: [...fixtureValue.agents] };
    const prepared = await preparePortableRecovery(options);
    await fs.outputFile(path.join(options.cwd, '.agents/skills/alpha/SKILL.md'), 'foreign');
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      expect((await executePortableRecovery({ prepared, token })).blockers).toEqual(['operationReviewStale']);
      expect((await executePortableRecovery({ prepared, token, action:'cleanup' })).blockers).toEqual(['backend-action-unsupported']);
    } });
    expect(await addCalls(options.log)).toHaveLength(0);
  });
  it.each(['scope', 'tampered', 'missing-generation'])('preserves %s installed evidence instead of overwriting it', async (kind) => {
    const fixtureValue = await fixture(); const options = { ...fixtureValue, agents: [...fixtureValue.agents] };
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      const original = await preparePortableRecovery(options);
      await executePortableRecovery({ prepared: original, token });
      if (kind === 'scope') { Object.assign(options.env, { WRONG_SCOPE: '1' });
        options.context = await createScopeContext({ scope: 'project', cwd: options.cwd, env: options.env }); }
      if (kind === 'tampered') await fs.appendFile(path.join(options.cwd, '.agents/skills/alpha/SKILL.md'), '\nUser change');
      if (kind === 'missing-generation') await fs.remove(original.generation);
      state.content = 'new-content';
      const next = await preparePortableRecovery(options);
      expect(next.targets.every((target) => ['unknown', 'conflict'].includes(target.observation))).toBe(true);
      expect((await executePortableRecovery({ prepared: next, token, authorizeUpdate: true })).outputsMayHaveChanged).toBe(false);
    } });
    expect(await addCalls(options.log)).toHaveLength(1);
  });
});
