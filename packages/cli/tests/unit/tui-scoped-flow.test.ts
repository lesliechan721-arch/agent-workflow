import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { executeIntentPlan, executeTargetsPlan,
  prepareIntentPlan, prepareTargetsPlan, projectScopedRecoveryHistory } from '../../src/tui/scoped-flow.js';
import type { RecoveryReceipt } from '../../src/recovery/receipt.js';
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

  receipt.blockers = [];
  receipt.errors = [stale];
  receipt.targetResults[0] = { ...receipt.targetResults[0]!, execution: 'applied', observation: 'verified', content: 'satisfied' };
  receipt.targetResults[1] = { ...receipt.targetResults[1]!, execution: 'not-run', observation: 'unknown', satisfaction: 'pending', blockers: [stale] };
  receipt.outputsMayHaveChanged = true;
  receipt.remainingTargets = [positions[1]!];
  expect(projectScopedRecoveryHistory(receipt, identity).summary).toMatchObject({ state: 'partial',
    effects: { awWrite: 'possible', preApplyExternalEffect: 'unknown', finalVerification: 'partial' },
  });
});
