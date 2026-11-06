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

  it('aggregates profile impact and counts each consumer target once', async () => {
    const value = controller({
      ...baseEvidence,
      configBatch: { groups: [
        { scope: 'user', targetFingerprint: 'common-target', config: {
          scope: 'user', storeDigest: 'user-store', impactState: 'known',
          affectedTargets: [
            { platform: 'codex', scope: 'user' },
            { platform: 'claude', scope: 'project' },
            { pluginName: 'provider', platform: 'generic', scope: 'user' },
          ],
        } },
        { scope: 'user', platform: 'codex', targetFingerprint: 'codex-target', config: {
          scope: 'user', platform: 'codex', storeDigest: 'codex-store', impactState: 'unknown',
          affectedTargets: [
            { platform: 'claude', scope: 'project' },
            { pluginName: 'consumer', platform: 'generic', scope: 'user' },
          ],
        } },
      ] },
    });

    const review = await value.buildOperationReview({
      kind: 'configSaveBatch', pluginId: 'official/demo', apply: true,
      groups: [
        { scope: 'user', updates: { mode: 'safe' } },
        { platform: 'codex', updates: { mode: 'strict' } },
      ],
    });

    expect(review.configImpact).toEqual({ state: 'unknown', affectedTargetCount: 4 });
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

  it('shows an existing command package when no Agent output needs an update', async () => {
    const value = controller({
      ...baseEvidence,
      config: {
        scope: 'user', context: 'user', storeDigest: 'store', impactState: 'known', affectedTargets: [],
        commandPackages: [{
          producer: { sourceId: 'official', sourceIdentity: 'source', pluginName: 'demo',
            kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null },
          packageId: 'tools-package', packageKey: 'tools', refreshKeys: ['mode'], declared: true, installed: true,
        }],
      },
    });
    const review = await value.buildOperationReview({
      kind: 'configSave', pluginId: 'official/demo', context: 'user', apply: true, retryApply: true,
    });
    expect(review.configImpact).toEqual({ state: 'known', affectedTargetCount: 1 });
    expect(review.changes).toContainEqual(expect.objectContaining({ title: '刷新命令包 tools' }));
  });
});
