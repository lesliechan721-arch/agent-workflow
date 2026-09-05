import { describe, expect, it } from 'vitest';

import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';

describe('project config shareability projection', () => {
  it('shows unverified Git evidence in the safe config Review projection', () => {
    const review = buildOperationReviewProjection({
      intent: {
        kind: 'configSave',
        pluginId: 'team/demo',
        scope: 'project',
        projectLayer: 'shared',
        apply: false,
        updates: { mode: 'safe' },
        changes: [{ key: 'mode', title: 'Mode', before: 'old', after: 'safe' }],
      },
      evidence: {
        catalog: { configDigest: 'config', compositeDigest: 'catalog' },
        config: {
          scope: 'project',
          storeDigest: 'store',
          affectedTargets: [],
          shareability: 'unverified',
        },
      },
    });

    expect(review.changes).toContainEqual(expect.objectContaining({
      kind: 'warning',
      title: 'Git 无法验证 project config 可共享',
    }));
  });
});
