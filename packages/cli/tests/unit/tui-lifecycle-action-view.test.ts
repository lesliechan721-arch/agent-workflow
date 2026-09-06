import { describe, expect, it } from 'vitest';

import { projectLifecycleActionView } from '../../src/tui/lifecycle-action-view.js';

describe('lifecycle action view', () => {
  it('projects stable actions into task labels without internal lifecycle terms', () => {
    const sync = projectLifecycleActionView({
      id: 'sync',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: 'user',
      reason: 'savedSettingsNotApplied',
    });
    const cleanup = projectLifecycleActionView({
      id: 'cleanup',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: 'user',
      reason: 'orphanedManagedContent',
    });

    expect(sync).toEqual({
      label: '同步已保存使用设置',
      description: '按已保存使用设置修复当前使用位置。',
    });
    expect(cleanup).toEqual({
      label: '清理 AW 管理内容',
      description: '只清理这个插件目标的 AW 管理内容。',
    });
    expect(JSON.stringify([sync, cleanup])).not.toMatch(/desired|actual|AW-owned/u);
  });
});
