import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { executeIntentPlan, executeTargetsPlan,
  prepareIntentPlan, prepareTargetsPlan, projectScopedRecoveryHistory } from '../../src/tui/scoped-flow.js';
import type { RecoveryReceipt } from '../../src/recovery/receipt.js';
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
