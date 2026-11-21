import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { executeIntentPlan, executeTargetsPlan,
  prepareIntentPlan, prepareTargetsPlan, projectScopedRecoveryHistory } from '../../src/tui/scoped-flow.js';
import type { RecoveryDiagnostic, RecoveryReceipt } from '../../src/recovery/receipt.js';
import { OperationHistoryStore } from '../../src/tui/operation-history.js';
import { operationDiagnosticText } from '../../src/tui/operation-diagnostic-screens.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('scoped TUI plan physical target', () => {
  async function aliasFixture() {
    const isolation = getCurrentSourceTestIsolation();
    const base = path.join(isolation.layout.fixtureCwd, 'scoped-plan-alias');
    const first = path.join(base, 'first');
    const second = path.join(base, 'second');
    const alias = path.join(base, 'alias');
    await fs.ensureDir(path.join(first, 'aw'));
    await fs.ensureDir(path.join(second, 'aw'));
    await fs.symlink(first, alias, 'dir');
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, AW_HOME: path.join(alias, 'aw') } };
    const swap = async () => { await fs.remove(alias); await fs.symlink(second, alias, 'dir'); };
    return { first, second, location, swap };
  }

  it('does not save targets after the AW_HOME ancestor changes physical location', async () => {
    const { second, location, swap } = await aliasFixture();
    const plan = await prepareTargetsPlan(location, 'set', ['codex']);
    await swap();
    await expect(executeTargetsPlan(location, plan)).rejects.toThrow('operationReviewStale');
    await expect(fs.pathExists(path.join(second, 'aw', 'deployment-preferences.json')))
      .resolves.toBe(false);
  });

  it('does not remove an identical declaration at a new physical location', async () => {
    const { first, second, location, swap } = await aliasFixture();
    await writeIntentFixture(location, { roots: [{ pluginId: 'local/demo', platforms: ['codex'] }] });
    const source = path.join(first, 'aw', 'plugin-intents.json');
    const target = path.join(second, 'aw', 'plugin-intents.json');
    await fs.copyFile(source, target);
    const original = await fs.readFile(target);
    const plan = await prepareIntentPlan(location, 'remove', 'local/demo');
    await swap();
    await expect(executeIntentPlan(location, plan)).rejects.toThrow('operationReviewStale');
    await expect(fs.readFile(target)).resolves.toEqual(original);
  });
});

// Test Value Gate: a stale sibling must not erase execution facts from batch history.
it('distinguishes stale before execution from a stale target after a sibling was verified', () => {
  const stale = { code: 'operationReviewStale', message: 'Review again.' };
  const positions = (['claude', 'generic'] as const).map((agent) => ({
    pluginId: 'team/demo', agent, scope: 'user' as const, delivery: null,
  }));
  const receipt: RecoveryReceipt = {
    schemaVersion: 1, kind: 'aw-recovery', scope: 'user', command: 'install', ok: false,
    intent: { state: 'valid', roots: ['team/demo'] }, requestedRoots: ['team/demo'], requestedTargets: positions,
    selection: { agents: ['claude', 'generic'], origin: 'argument', preferences: 'valid' },
    blockers: [stale], errors: [], remainingTargets: positions, recoveryActions: [],
    declarationChanged: false, configChanged: false, preferencesChanged: false, outputsMayHaveChanged: false,
    targetResults: positions.map((position) => ({ ...position, execution: 'not-run', observation: 'unknown', blockers: [], requiredBy: [] })),
  };
  const identity = { recordId: 'batch', epoch: 0, operationId: 'sync', createdAtMs: 0 };
  // The joint receipt records a policy-excluded target as a verified no-op.
  receipt.targetResults[1] = { ...receipt.targetResults[1]!, execution: 'no-op', observation: 'verified', satisfaction: 'excluded' };
  expect(projectScopedRecoveryHistory(receipt, identity).summary.effects).toMatchObject({
    preApplyExternalEffect: 'notStarted', finalVerification: 'notStarted',
  });
  const afterSave = projectScopedRecoveryHistory({ ...receipt, declarationChanged: true, unconfirmedSavedState: 'intent',
    coverage: { scopes: ['user', 'project'] } }, identity);
  expect(afterSave.summary).toMatchObject({ state: 'partial', effects: {
    awWrite: 'notStarted', preApplyExternalEffect: 'notStarted', finalVerification: 'notStarted',
  } });
  expect(afterSave.diagnostics[0]?.detailLines).toEqual(['aw plugin status --context project --json']);

  receipt.blockers = [];
  receipt.errors = [stale];
  receipt.targetResults[0] = { ...receipt.targetResults[0]!, execution: 'applied', observation: 'verified', content: 'satisfied' };
  receipt.targetResults[1] = { ...receipt.targetResults[1]!, execution: 'not-run', observation: 'unknown',
    satisfaction: 'pending', blockers: [stale], recoveryActions: ['untrusted-backend-detail'] };
  receipt.outputsMayHaveChanged = true;
  receipt.remainingTargets = [positions[1]!];
  const history = new OperationHistoryStore();
  history.record(projectScopedRecoveryHistory(receipt, identity));
  const record = history.get(identity.recordId)!;
  expect(record.summary).toMatchObject({ state: 'partial', diagnosticCount: 1,
    effects: { awWrite: 'possible', preApplyExternalEffect: 'unknown', finalVerification: 'partial' },
  });
  const retry = 'aw plugin sync team/demo --context user --target generic';
  expect(record.diagnostics).toMatchObject([{ code: 'operationReviewStale',
    target: { pluginId: 'team/demo', platform: 'generic', scope: 'user' },
    detailLines: ['aw plugin status --context user --json', retry] }]);
  expect(record.targets[0]).toMatchObject({ state: 'completed', diagnosticIds: [] });
  expect(history.preview(identity.recordId)?.content).toContain(retry);
  expect(history.preview(identity.recordId)?.content).not.toContain('untrusted-backend-detail');
});

it('keeps the declared User repair ahead of its dependent Project in history', () => {
  const project = { pluginId: 'team/b', agent: 'opencode' as const, scope: 'project' as const, delivery: null };
  const issue = { code: 'userSkillProviderNotReady', pluginId: 'team/d', message: 'Repair the User dependency.',
    subject: { pluginId: 'team/a', scope: 'user' as const, target: 'opencode' as const } };
  const receipt: RecoveryReceipt = {
    schemaVersion: 1, kind: 'aw-recovery', scope: 'project', command: 'sync', ok: false,
    intent: { state: 'valid', roots: ['team/b'] }, requestedRoots: ['team/b'], requestedTargets: [project],
    selection: { agents: ['opencode'], origin: 'argument', preferences: 'valid' },
    reviewedUserRoots: ['team/a'], blockers: [], errors: [], remainingTargets: [project], recoveryActions: [],
    declarationChanged: false, configChanged: false, preferencesChanged: false, outputsMayHaveChanged: false,
    targetResults: [{ ...project, relation: 'root', execution: 'not-run', observation: 'unknown', blockers: [issue], requiredBy: ['team/b'] }],
  };
  const history = projectScopedRecoveryHistory(receipt, { recordId: 'provider', epoch: 0, operationId: 'sync', createdAtMs: 0 });
  expect(history.diagnostics[0]?.detailLines).toEqual(['aw plugin status --context project --json',
    'aw plugin sync team/a --context user --target opencode', 'aw plugin sync team/b --context project --target opencode']);
});

// A single dependency can supply the same declared root at both User and Project.
it('exports one recovery command for both unfinished scopes and keeps the successful root', () => {
  const position = (name: string, scope: 'user' | 'project') =>
    ({ pluginId: `team/${name}`, scope, agent: 'generic' as const, delivery: null });
  const kept = position('a', 'user');
  const provider = position('d', 'user');
  const roots = [position('b', 'user'), position('b', 'project')];
  const stale = { code: 'operationReviewStale', message: 'Provider changed.' };
  const receipt: RecoveryReceipt = {
    schemaVersion: 1, kind: 'aw-recovery', scope: 'user', command: 'install', ok: false,
    intent: { state: 'valid', roots: ['team/a', 'team/b'] }, requestedRoots: ['team/a', 'team/b'],
    selection: { agents: ['generic'], origin: 'argument', preferences: 'valid' }, coverage: { scopes: ['user', 'project'] },
    declarationChanged: false, configChanged: false, preferencesChanged: false, outputsMayHaveChanged: false,
    requestedTargets: [kept, ...roots], remainingTargets: [provider, ...roots], recoveryActions: [], errors: [stale], blockers: [],
    targetResults: [
      { ...kept, relation: 'root', execution: 'no-op', observation: 'verified', requiredBy: ['team/a'], blockers: [] },
      { ...provider, relation: 'dependency', requiredBy: ['team/b'], execution: 'not-run', observation: 'unknown', blockers: [stale],
        contributions: roots.map(({ pluginId, scope }) => ({ root: pluginId, scope, path: [pluginId, provider.pluginId] })) },
      ...roots.map((root) => ({ ...root, relation: 'root' as const, execution: 'not-run' as const, observation: 'unknown' as const,
        requiredBy: [root.pluginId], blockers: [stale] })),
    ],
  };
  const store = new OperationHistoryStore();
  store.record(projectScopedRecoveryHistory(receipt, { recordId: 'joint-scopes', epoch: 0, operationId: 'install', createdAtMs: 0 }));
  const record = store.get('joint-scopes')!;
  expect(record.diagnostics.find((diagnostic) => diagnostic.target?.pluginId === provider.pluginId)?.detailLines)
    .toEqual(['aw plugin status --context project --json', 'aw plugin sync team/b --context project --target generic']);
  expect(record.targets.find((target) => target.pluginId === kept.pluginId)).toMatchObject({ state: 'kept', diagnosticIds: [] });
  const status = 'aw plugin status --context project --json';
  const sync = 'aw plugin sync team/b --context project --target generic';
  expect(record.diagnostics.filter((entry) => entry.code === stale.code).map((entry) => entry.detailLines))
    .toEqual([[status, sync], [status, sync], [status, sync]]);
  for (const text of [store.preview('joint-scopes')!.content, operationDiagnosticText(record)]) {
    expect(text.match(/aw plugin sync [^\n]+/g)).toEqual([sync]);
    expect(text.split(status)).toHaveLength(2);
  }

  const ended: RecoveryReceipt = { ...receipt, errors: [{ code: 'statusUnavailable', message: 'Final inventory read failed.' }],
    remainingTargets: [], targetResults: [{ ...kept, execution: 'applied', observation: 'verified', requiredBy: [], blockers: [] }],
    outputsMayHaveChanged: true, recoveryActions: [status] };
  store.record(projectScopedRecoveryHistory(ended, { recordId: 'final-read', epoch: 0, operationId: 'install', createdAtMs: 1 }));
  expect(store.get('final-read')?.diagnostics).toMatchObject([{ code: 'statusUnavailable', detailLines: [status] }]);
  expect(store.preview('final-read')?.content).toContain(status);
  expect(store.preview('final-read')?.content).not.toContain('aw plugin sync');
});

// Test Value Gate: a mixed receipt can repeat a delivered provider's notice under several roots.
it('keeps one Skill notice per delivered location in partial recovery history and reports', () => {
  const position = (pluginId: string, scope: 'user' | 'project') =>
    ({ pluginId, scope, agent: 'codex' as const, delivery: null });
  const user = position('team/provider', 'user');
  const project = position('team/provider', 'project');
  const root = position('team/root', 'project');
  const failure = { code: 'nativeRecoveryFailed', message: 'Private sibling failure.' };
  const notice = (scope: 'user' | 'project'): RecoveryDiagnostic => ({
    code: 'skillInvocationPolicyNotGuaranteed',
    message: 'Private diagnostic from /private/catalog/skill.',
    subject: { pluginId: 'team/provider', target: 'codex', scope, field: 'skill.commit' },
    detail: { reasonCode: 'invocationControlUnverified', path: '/private/catalog/skill', skillInvocationControls: [
      { feature: 'skill.invocation.model', values: ['false'], reasonCode: 'invocationControlUnverified', product: 'app' },
      { feature: 'skill.visibility', values: ['hidden'], reasonCode: 'invocationControlUnsupported' },
    ] },
  });
  const receipt: RecoveryReceipt = {
    schemaVersion: 1, kind: 'aw-recovery', scope: 'project', command: 'sync', ok: false,
    coverage: { scopes: ['user', 'project'] }, intent: { state: 'valid', roots: ['team/root'] },
    requestedRoots: [root.pluginId], requestedTargets: [position(root.pluginId, 'user'), root],
    selection: { agents: ['codex'], origin: 'argument', preferences: 'valid' },
    blockers: [], errors: [], remainingTargets: [root], recoveryActions: [],
    declarationChanged: false, configChanged: false, preferencesChanged: false, outputsMayHaveChanged: true,
    targetResults: [
      { ...root, execution: 'failed', observation: 'missing', blockers: [failure], requiredBy: [], reasons: [notice('user')] },
      { ...user, execution: 'applied', observation: 'verified', blockers: [], requiredBy: [root.pluginId], reasons: [notice('user')] },
      { ...project, execution: 'applied', observation: 'verified', blockers: [], requiredBy: [root.pluginId], reasons: [notice('project')] },
    ],
  };
  const store = new OperationHistoryStore();
  store.record(projectScopedRecoveryHistory(receipt, { recordId: 'sync', epoch: 0, operationId: 'sync', createdAtMs: 0 }));

  const record = store.get('sync')!;
  expect(record.summary).toMatchObject({ state: 'partial', code: failure.code, diagnosticCount: 3 });
  const warnings = record.diagnostics.filter(({ code }) => code === 'skillInvocationPolicyNotGuaranteed');
  expect(warnings.map(({ target }) => target)).toEqual([
    { pluginId: user.pluginId, platform: user.agent, scope: user.scope },
    { pluginId: project.pluginId, platform: project.agent, scope: project.scope },
  ]);
  expect(record.targets).toMatchObject([
    { pluginId: root.pluginId, state: 'failed', diagnosticIds: [record.diagnostics[0]!.id] },
    { pluginId: user.pluginId, state: 'completed', diagnosticIds: [warnings[0]!.id] },
    { pluginId: project.pluginId, state: 'completed', diagnosticIds: [warnings[1]!.id] },
  ]);
  for (const text of [operationDiagnosticText(record), store.preview('sync')!.content]) {
    expect(text.match(/skill\.commit · invocationControlUnverified/gu)).toHaveLength(2);
    expect(text.match(/skill\.invocation\.model=false · invocationControlUnverified · product=app/gu)).toHaveLength(2);
    expect(text.match(/skill\.visibility=hidden · invocationControlUnsupported/gu)).toHaveLength(2);
    expect(text).not.toContain('Private diagnostic');
    expect(text).not.toContain('/private/catalog');
  }
});
