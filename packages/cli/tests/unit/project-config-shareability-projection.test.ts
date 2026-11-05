import { describe, expect, it } from 'vitest';

import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';

describe('user config sharing projection in a project context', () => {
  it('shows shared native impact and hides private values in the config Review projection', () => {
    const review = buildOperationReviewProjection({
      intent: {
        kind: 'configSave',
        pluginId: 'team/demo',
        scope: 'user',
        platform: 'codex',
        context: 'project',
        apply: true,
        updates: { mode: 'safe', token: 'new-secret-token', localPath: '/private/new-config' },
        sensitiveKeys: ['token'],
        privateKeys: ['localPath'],
        changes: [
          { key: 'mode', title: 'Mode', before: 'old', after: 'safe' },
          { key: 'token', title: 'Token', before: 'old-secret-token', after: 'new-secret-token' },
          { key: 'localPath', title: 'Local path', before: '/private/old-config', after: '/private/new-config' },
        ],
      },
      evidence: {
        catalog: { configDigest: 'config', compositeDigest: 'catalog' },
        config: {
          scope: 'user',
          platform: 'codex',
          context: 'project',
          storeDigest: 'store',
          affectedTargets: [
            { platform: 'codex', scope: 'user' },
            { platform: 'codex', scope: 'project' },
          ],
          sharedNativeRenderTargets: [{ id: 'native', skillKey: 'native', refreshKeys: ['mode', 'token'] }],
        },
      },
    });

    expect(review.requiresConfirmation).toBe(true);
    expect(review.sharedImpact).toEqual({
      pluginIds: ['team/demo'],
      warning: '更新被共用的原生 Skill 会影响所有启用项目。',
    });
    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'change', title: 'Codex 平台配置 · Mode', description: 'old → safe' }),
      expect.objectContaining({ kind: 'change', title: 'Codex 平台配置 · Token', description: '已设置 → 将更新' }),
      expect.objectContaining({ kind: 'change', title: 'Codex 平台配置 · Local path', description: '已设置 → 将更新' }),
      expect.objectContaining({ kind: 'keep', title: '保留所有项目和当前项目的启用位置' }),
    ]));
    const projection = JSON.stringify(review);
    expect(projection).not.toContain('old-secret-token');
    expect(projection).not.toContain('new-secret-token');
    expect(projection).not.toContain('/private/old-config');
    expect(projection).not.toContain('/private/new-config');
  });
});
