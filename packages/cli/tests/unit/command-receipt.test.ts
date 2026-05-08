import { describe, expect, it } from 'vitest';

import {
  buildCommandReceiptJson,
  renderCommandReceipt,
} from '../../src/output/command-receipt.js';

describe('command receipt output', () => {
  it('dedupes install dependency targets, keeps warnings, and lists all affected plugins in JSON', () => {
    const dependencyWarning =
      '[codex/workflow-child/user] 依赖插件 workflow-child 缺少必填配置 token。运行 `aw config set workflow-child token <value> -s user` 完成配置。';
    const receipt = {
      result: {
        platforms: ['codex'],
        plugins: ['workflow-parent-a', 'workflow-parent-b'],
        warnings: [dependencyWarning, dependencyWarning],
        receiptTargets: [
          {
            plugin: 'workflow-parent-a',
            platform: 'codex',
            scope: 'user' as const,
            requested: true,
          },
          {
            plugin: 'workflow-parent-b',
            platform: 'codex',
            scope: 'user' as const,
            requested: true,
          },
          {
            plugin: 'workflow-child',
            platform: 'codex',
            scope: 'user' as const,
            requested: false,
            dependencyOf: [{
              plugin: 'workflow-parent-a',
              platform: 'codex',
              scope: 'user' as const,
            }],
          },
          {
            plugin: 'workflow-child',
            platform: 'codex',
            scope: 'user' as const,
            requested: false,
            dependencyOf: [{
              plugin: 'workflow-parent-b',
              platform: 'codex',
              scope: 'user' as const,
            }],
          },
        ],
        receiptActions: [{
          type: 'installDependency' as const,
          plugin: 'workflow-child',
          platform: 'codex',
          scope: 'user' as const,
        }],
      },
      groups: [{
        scope: 'user' as const,
        platforms: ['codex'],
        plugins: ['workflow-parent-a', 'workflow-parent-b'],
      }],
    };

    expect(buildCommandReceiptJson('install', receipt)).toMatchObject({
      command: 'install',
      plugins: ['workflow-parent-a', 'workflow-parent-b', 'workflow-child'],
      warnings: [dependencyWarning],
      targets: [
        {
          plugin: 'workflow-parent-a',
          platform: 'codex',
          scope: 'user',
          requested: true,
        },
        {
          plugin: 'workflow-parent-b',
          platform: 'codex',
          scope: 'user',
          requested: true,
        },
        {
          plugin: 'workflow-child',
          platform: 'codex',
          scope: 'user',
          requested: false,
          dependencyOf: [
            {
              plugin: 'workflow-parent-a',
              platform: 'codex',
              scope: 'user',
            },
            {
              plugin: 'workflow-parent-b',
              platform: 'codex',
              scope: 'user',
            },
          ],
        },
      ],
      actions: expect.arrayContaining([
        {
          type: 'install',
          plugin: 'workflow-parent-a',
          platform: 'codex',
          scope: 'user',
          requested: true,
          status: 'succeeded',
        },
        {
          type: 'install',
          plugin: 'workflow-parent-b',
          platform: 'codex',
          scope: 'user',
          requested: true,
          status: 'succeeded',
        },
        {
          type: 'installDependency',
          plugin: 'workflow-child',
          platform: 'codex',
          scope: 'user',
          status: 'succeeded',
        },
      ]),
    });

    const output = renderCommandReceipt('install', receipt).join('\n');
    expect(output).toContain('已安装 workflow-parent-a、workflow-parent-b。');
    expect(output).toContain('已自动安装依赖：workflow-child。');
    expect(output).not.toMatch(/ledger|ref-count|dependencyEdges/i);
  });

  it('preserves dependency action types during upgrade receipts', () => {
    const receipt = {
      result: {
        platforms: ['codex'],
        plugins: ['upgrade-root'],
        warnings: [],
        receiptTargets: [
          {
            plugin: 'upgrade-root',
            platform: 'codex',
            scope: 'user' as const,
            requested: true,
          },
          {
            plugin: 'upgrade-child',
            platform: 'codex',
            scope: 'user' as const,
            requested: false,
            dependencyOf: [{
              plugin: 'upgrade-root',
              platform: 'codex',
              scope: 'user' as const,
            }],
          },
        ],
        receiptActions: [
          {
            type: 'upgradeDependency' as const,
            plugin: 'upgrade-child',
            platform: 'codex',
            scope: 'user' as const,
            requested: false,
            dependencyOf: [{
              plugin: 'upgrade-root',
              platform: 'codex',
              scope: 'user' as const,
            }],
          },
          {
            type: 'installDependency' as const,
            plugin: 'new-upgrade-child',
            platform: 'codex',
            scope: 'user' as const,
            requested: false,
            dependencyOf: [{
              plugin: 'upgrade-root',
              platform: 'codex',
              scope: 'user' as const,
            }],
          },
        ],
      },
      groups: [{
        scope: 'user' as const,
        platforms: ['codex'],
        plugins: ['upgrade-root'],
      }],
    };

    expect(buildCommandReceiptJson('upgrade', receipt)).toMatchObject({
      command: 'upgrade',
      upgraded: expect.arrayContaining([
        {
          plugin: 'upgrade-root',
          platform: 'codex',
          scope: 'user',
          requested: true,
        },
        {
          plugin: 'upgrade-child',
          platform: 'codex',
          scope: 'user',
          requested: false,
          dependencyOf: [{
            plugin: 'upgrade-root',
            platform: 'codex',
            scope: 'user',
          }],
        },
        {
          plugin: 'new-upgrade-child',
          platform: 'codex',
          scope: 'user',
          requested: false,
          dependencyOf: [{
            plugin: 'upgrade-root',
            platform: 'codex',
            scope: 'user',
          }],
        },
      ]),
      actions: expect.arrayContaining([
        {
          type: 'upgrade',
          plugin: 'upgrade-root',
          platform: 'codex',
          scope: 'user',
          requested: true,
          status: 'succeeded',
        },
        {
          type: 'upgradeDependency',
          plugin: 'upgrade-child',
          platform: 'codex',
          scope: 'user',
          requested: false,
          dependencyOf: [{
            plugin: 'upgrade-root',
            platform: 'codex',
            scope: 'user',
          }],
          status: 'succeeded',
        },
        {
          type: 'installDependency',
          plugin: 'new-upgrade-child',
          platform: 'codex',
          scope: 'user',
          requested: false,
          dependencyOf: [{
            plugin: 'upgrade-root',
            platform: 'codex',
            scope: 'user',
          }],
          status: 'succeeded',
        },
      ]),
    });
  });

  it('keeps auto-cleaned dependencies in uninstall JSON while leaving the human summary concise', () => {
    const receipt = {
      result: {
        platforms: ['codex'],
        plugins: ['cleanup-parent'],
        warnings: [],
        receiptActions: [
          {
            type: 'uninstallAutoDependency' as const,
            plugin: 'cleanup-child',
            platform: 'codex',
            scope: 'user' as const,
          },
          {
            type: 'uninstallAutoDependency' as const,
            plugin: 'cleanup-grandchild',
            platform: 'codex',
            scope: 'user' as const,
          },
        ],
      },
      groups: [{
        scope: 'user' as const,
        platforms: ['codex'],
        plugins: ['cleanup-parent'],
      }],
    };

    expect(buildCommandReceiptJson('uninstall', receipt)).toMatchObject({
      command: 'uninstall',
      plugins: ['cleanup-parent', 'cleanup-child', 'cleanup-grandchild'],
      actions: expect.arrayContaining([
        {
          type: 'uninstall',
          plugin: 'cleanup-parent',
          platform: 'codex',
          scope: 'user',
          status: 'succeeded',
        },
        {
          type: 'uninstallAutoDependency',
          plugin: 'cleanup-child',
          platform: 'codex',
          scope: 'user',
          status: 'succeeded',
        },
        {
          type: 'uninstallAutoDependency',
          plugin: 'cleanup-grandchild',
          platform: 'codex',
          scope: 'user',
          status: 'succeeded',
        },
      ]),
    });

    const output = renderCommandReceipt('uninstall', receipt).join('\n');
    expect(output).toContain('已卸载 cleanup-parent。');
    expect(output).toContain('已清理相关文件和已安装项。');
    expect(output).not.toContain('已自动清理不再需要的依赖');
  });
});
