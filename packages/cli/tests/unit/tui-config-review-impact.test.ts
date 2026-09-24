import { describe, expect, it, vi } from 'vitest';

import {
  TuiController,
  TuiOperationBlockedError,
  type OperationEvidence,
} from '../../src/tui/controller.js';

const baseEvidence: OperationEvidence = {
  catalog: { configDigest: 'config', compositeDigest: 'catalog' },
  source: { sourceId: 'official', sourceIdentity: 'official-source' },
  targetFingerprint: 'target',
};

function controller(evidence: OperationEvidence | Error): TuiController {
  return new TuiController({
    loadStatus: vi.fn(),
    captureEvidence: evidence instanceof Error
      ? vi.fn().mockRejectedValue(evidence) : vi.fn().mockResolvedValue(evidence),
    executeIntent: vi.fn(),
  });
}

describe('config Review impact', () => {
  it('marks a known zero-target save separately from an unknown impact', async () => {
    const intent = {
      kind: 'configSave' as const,
      pluginId: 'official/demo',
      scope: 'user' as const,
      apply: true,
      updates: { mode: 'safe' },
      changes: [{ key: 'mode', title: '模式', before: 'old', after: 'safe' }],
    };
    const known = controller({
      ...baseEvidence,
      config: {
        scope: 'user', storeDigest: 'store', impactState: 'known',
        noEffectiveChange: true, affectedTargets: [],
      },
    });
    const unknown = controller({
      ...baseEvidence,
      config: {
        scope: 'user', storeDigest: 'store', impactState: 'unknown',
        affectedTargets: [],
      },
    });

    expect((await known.buildOperationReview(intent)).configImpact).toEqual({
      state: 'known', affectedTargetCount: 0,
    });
    expect((await unknown.buildOperationReview(intent)).configImpact).toEqual({
      state: 'unknown', affectedTargetCount: 0,
    });
  });

  it('aggregates batch impact across scopes and counts each target once', async () => {
    const value = controller({
      ...baseEvidence,
      configBatch: { groups: [
        { scope: 'user', targetFingerprint: 'user-target', config: {
          scope: 'user', storeDigest: 'user-store', impactState: 'known',
          affectedTargets: [
            { platform: 'codex', scope: 'user' },
            { platform: 'claude', scope: 'project' },
          ],
        } },
        { scope: 'project', targetFingerprint: 'project-target', config: {
          scope: 'project', storeDigest: 'project-store', impactState: 'unknown',
          affectedTargets: [
            { platform: 'claude', scope: 'project' },
          ],
        } },
      ] },
    });

    const review = await value.buildOperationReview({
      kind: 'configSaveBatch', pluginId: 'official/demo', apply: true,
      groups: [
        { scope: 'user', updates: { mode: 'safe' } },
        { scope: 'project', updates: { mode: 'strict' } },
      ],
    });

    expect(review.configImpact).toEqual({ state: 'unknown', affectedTargetCount: 2 });
    expect(value.snapshot.activeReview?.configImpact).toEqual(review.configImpact);
  });

  it('keeps an impact-read failure out of Review', async () => {
    const value = controller(new TuiOperationBlockedError(
      'sourceIdentityChanged', '来源身份已变化。',
    ));

    await expect(value.buildOperationReview({
      kind: 'configSave', pluginId: 'official/demo', scope: 'user',
      apply: true, updates: { mode: 'safe' },
    })).rejects.toMatchObject({ code: 'sourceIdentityChanged' });
    expect(value.snapshot.activeReview).toBeUndefined();
  });
});
