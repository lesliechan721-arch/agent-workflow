import { describe, expect, it } from 'vitest';

import {
  buildInitReceiptJson,
  buildCommandReceiptJson,
  buildCleanupReceiptJson,
  renderCommandReceipt,
  renderCleanupReceipt,
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
      receiptSchemaVersion: 2,
      overallState: 'succeeded',
      command: 'install',
      plugins: ['workflow-parent-a', 'workflow-parent-b', 'workflow-child'],
      warnings: [dependencyWarning],
      nextStepsSchemaVersion: 1,
      nextSteps: [
        expect.objectContaining({
          label: expect.any(String),
          description: expect.any(String),
          command: expect.stringContaining('aw status workflow-parent-a'),
        }),
      ],
      legacyNextSteps: expect.any(Array),
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
    expect(buildCommandReceiptJson('install', receipt).targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: {
          pluginName: 'workflow-parent-a',
          platform: 'codex',
          scope: 'user',
        },
        action: 'install',
        state: 'completed',
      }),
      expect.objectContaining({
        target: {
          pluginName: 'workflow-parent-b',
          platform: 'codex',
          scope: 'user',
        },
        action: 'install',
        state: 'completed',
      }),
      expect.objectContaining({
        target: {
          pluginName: 'workflow-child',
          platform: 'codex',
          scope: 'user',
        },
        action: 'installDependency',
        state: 'completed',
      }),
    ]));

    const output = renderCommandReceipt('install', receipt).join('\n');
    expect(output).toContain('已安装 workflow-parent-a、workflow-parent-b。');
    expect(output).toContain('已自动安装依赖：workflow-child。');
    expect(output).toContain('下一步：');
    expect(output).toContain('运行 aw status workflow-parent-a');
    expect(output).not.toContain('下一步：aw status');
    expect(output).not.toMatch(/ledger|ref-count|dependencyEdges/i);
  });

  it('preserves dependency action types during upgrade receipts', () => {
    const receipt = {
      result: {
        platforms: ['codex'],
        plugins: ['upgrade-root'],
        warnings: [],
        marketplace: {
          rootDir: '/tmp/aw',
          changed: false,
          catalog: {
            rootDir: '/tmp/aw',
            source: 'local' as const,
            catalogVersion: '1.2.3',
          },
        },
        receiptTargets: [
          {
            plugin: 'upgrade-root',
            platform: 'codex',
            scope: 'user' as const,
            requested: true,
            selectedVersion: '2.0.0',
            selectedVersionSource: 'currentCatalog' as const,
          },
          {
            plugin: 'upgrade-child',
            platform: 'codex',
            scope: 'user' as const,
            requested: false,
            selectedVersion: '2.0.1',
            selectedVersionSource: 'currentCatalog' as const,
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
            selectedVersion: '2.0.1',
            selectedVersionSource: 'currentCatalog' as const,
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
            selectedVersion: '2.1.0',
            selectedVersionSource: 'currentCatalog' as const,
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
      receiptSchemaVersion: 2,
      catalog: {
        source: 'local',
        catalogVersion: '1.2.3',
      },
      historicalRuntimePersisted: true,
      overallState: 'succeeded',
      command: 'upgrade',
      nextStepsSchemaVersion: 1,
      nextSteps: [expect.objectContaining({ command: expect.stringContaining('aw status upgrade-root') })],
      upgraded: expect.arrayContaining([
        {
          plugin: 'upgrade-root',
          platform: 'codex',
          scope: 'user',
          requested: true,
          selectedVersion: '2.0.0',
          selectedVersionSource: 'currentCatalog',
        },
        {
          plugin: 'upgrade-child',
          platform: 'codex',
          scope: 'user',
          requested: false,
          selectedVersion: '2.0.1',
          selectedVersionSource: 'currentCatalog',
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
          selectedVersion: '2.1.0',
          selectedVersionSource: 'currentCatalog',
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
          selectedVersion: '2.0.0',
          selectedVersionSource: 'currentCatalog',
          status: 'succeeded',
        },
        {
          type: 'upgradeDependency',
          plugin: 'upgrade-child',
          platform: 'codex',
          scope: 'user',
          requested: false,
          selectedVersion: '2.0.1',
          selectedVersionSource: 'currentCatalog',
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
          selectedVersion: '2.1.0',
          selectedVersionSource: 'currentCatalog',
          dependencyOf: [{
            plugin: 'upgrade-root',
            platform: 'codex',
            scope: 'user',
          }],
          status: 'succeeded',
        },
      ]),
    });
    expect(buildCommandReceiptJson('upgrade', receipt).targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: {
          pluginName: 'upgrade-root',
          platform: 'codex',
          scope: 'user',
        },
        action: 'upgrade',
        state: 'completed',
      }),
      expect.objectContaining({
        target: {
          pluginName: 'upgrade-child',
          platform: 'codex',
          scope: 'user',
        },
        action: 'upgradeDependency',
        state: 'completed',
      }),
      expect.objectContaining({
        target: {
          pluginName: 'new-upgrade-child',
          platform: 'codex',
          scope: 'user',
        },
        action: 'installDependency',
        state: 'completed',
      }),
    ]));
  });

  it('keeps init receipts on the dedicated catalog cache warmup schema', () => {
    expect(buildInitReceiptJson({
      rootDir: '/tmp/aw',
      changed: true,
      warnings: [],
      catalog: {
        rootDir: '/tmp/aw',
        source: 'cache',
        catalogVersion: '1.2.3',
      },
    })).toMatchObject({
      receiptSchemaVersion: 2,
      receiptKind: 'catalogCacheWarmup',
      command: 'init',
      catalog: {
        source: 'cache',
        catalogVersion: '1.2.3',
      },
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
      receiptSchemaVersion: 2,
      overallState: 'succeeded',
      command: 'uninstall',
      plugins: ['cleanup-parent', 'cleanup-child', 'cleanup-grandchild'],
      nextStepsSchemaVersion: 1,
      nextSteps: [expect.objectContaining({ command: expect.stringContaining('aw status cleanup-parent') })],
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
    expect(buildCommandReceiptJson('uninstall', receipt).targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: {
          pluginName: 'cleanup-parent',
          platform: 'codex',
          scope: 'user',
        },
        action: 'uninstall',
        state: 'completed',
      }),
      expect.objectContaining({
        target: {
          pluginName: 'cleanup-child',
          platform: 'codex',
          scope: 'user',
        },
        action: 'uninstallAutoDependency',
        state: 'completed',
      }),
      expect.objectContaining({
        target: {
          pluginName: 'cleanup-grandchild',
          platform: 'codex',
          scope: 'user',
        },
        action: 'uninstallAutoDependency',
        state: 'completed',
      }),
    ]));

    const output = renderCommandReceipt('uninstall', receipt).join('\n');
    expect(output).toContain('已卸载 cleanup-parent。');
    expect(output).toContain('已清理相关文件和已安装项。');
    expect(output).toContain('运行 aw status cleanup-parent');
    expect(output).not.toContain('下一步：aw status');
    expect(output).not.toContain('已自动清理不再需要的依赖');
  });

  it('preserves explicit receipt v2 target result states for multi-target failures', () => {
    const receipt = {
      result: {
        platforms: ['codex', 'claude'],
        plugins: ['multi-state'],
        warnings: [],
        targetResults: [
          {
            target: {
              pluginName: 'multi-state',
              platform: 'codex' as const,
              scope: 'user' as const,
            },
            action: 'install',
            state: 'completed' as const,
            rollbackState: 'notNeeded' as const,
          },
          {
            target: {
              pluginName: 'multi-state',
              platform: 'claude' as const,
              scope: 'user' as const,
            },
            action: 'install',
            state: 'rolledBack' as const,
            rollbackState: 'completed' as const,
            message: 'Claude 写入失败后已回滚。',
          },
          {
            target: {
              pluginName: 'multi-state',
              platform: 'codex' as const,
              scope: 'project' as const,
            },
            action: 'install',
            state: 'notRun' as const,
            errorCode: 'preflightBlocked',
            message: '前置检查失败，未执行。',
          },
          {
            target: {
              pluginName: 'multi-state',
              platform: 'claude' as const,
              scope: 'project' as const,
            },
            action: 'install',
            state: 'failed' as const,
            rollbackState: 'failed' as const,
            errorCode: 'rollbackFailed',
            message: '写入和回滚都失败。',
          },
        ],
      },
      groups: [{
        scope: 'user' as const,
        platforms: ['codex', 'claude'],
        plugins: ['multi-state'],
      }],
    };

    expect(buildCommandReceiptJson('install', receipt)).toMatchObject({
      receiptSchemaVersion: 2,
      overallState: 'failed',
      targetResults: [
        expect.objectContaining({ state: 'completed' }),
        expect.objectContaining({ state: 'rolledBack', rollbackState: 'completed' }),
        expect.objectContaining({ state: 'notRun', errorCode: 'preflightBlocked' }),
        expect.objectContaining({ state: 'failed', rollbackState: 'failed', errorCode: 'rollbackFailed' }),
      ],
    });
  });

  it('renders cleanup plan receipts with stable schema fields and empty collections', () => {
    const payload = buildCleanupReceiptJson({
      payload: {
        ok: true,
        command: 'cleanup',
        generatedAt: '2026-05-13T00:00:00.000Z',
        dependencyIndex: false,
        cleanupPlanSchemaVersion: 1,
        dryRun: true,
        force: true,
        removeConfig: true,
        target: {
          plugin: 'cache-only',
          platform: 'codex',
          scope: 'user' as const,
          targetType: 'cache-only' as const,
        },
        forceReason: null,
        plannedRemovals: [{
          kind: 'native-cache',
          label: 'Codex active cache',
          path: '/tmp/cache',
        }],
        wouldBackups: [],
        wouldRemoveConfig: [{
          plugin: 'cache-only',
          scope: 'user' as const,
          path: '/tmp/config.json',
          status: 'planned' as const,
        }],
        skippedForeignItems: [],
        affectedDependents: [],
        blockingReasons: [],
        recommendedCommand: 'aw cleanup cache-only --platform codex --scope user --force --remove-config',
      },
      warnings: ['synthetic warning'],
    });

    expect(payload).toMatchObject({
      receiptSchemaVersion: 2,
      overallState: 'succeeded',
      cleanupPlanSchemaVersion: 1,
      dryRun: true,
      force: true,
      removeConfig: true,
      warnings: ['synthetic warning'],
      targetResults: [{
        action: 'cleanup',
        state: 'notRun',
      }],
      nextStepsSchemaVersion: 1,
      nextSteps: [expect.objectContaining({ label: expect.any(String), description: expect.any(String) })],
      plannedRemovals: [{
        kind: 'native-cache',
      }],
    });

    const output = renderCleanupReceipt({
      payload,
      warnings: [],
    }).join('\n');
    expect(output).toContain('cleanup 评估完成');
    expect(output).toContain('计划删除项');
    expect(output).toContain('受影响依赖');
    expect(output).toContain('- 无');
    expect(output).not.toContain('下一步：aw ');
  });

  it('renders cleanup execution receipts as failed when remaining items are still present', () => {
    const output = renderCleanupReceipt({
      payload: {
        ok: true,
        command: 'cleanup',
        generatedAt: '2026-05-13T00:00:00.000Z',
        dependencyIndex: false,
        cleanupPlanSchemaVersion: 1,
        dryRun: false,
        force: true,
        removeConfig: false,
        target: {
          plugin: 'git-commit',
          platform: 'codex',
          scope: 'user' as const,
          targetType: 'config-only' as const,
        },
        forceReason: null,
        plannedRemovals: [{
          kind: 'native-config',
          label: 'Codex enabled config',
          path: '/tmp/config.toml',
        }],
        wouldBackups: [],
        wouldRemoveConfig: [],
        skippedForeignItems: [],
        affectedDependents: [],
        blockingReasons: [],
        recommendedCommand: 'aw diagnose git-commit --platform codex --scope user',
        actualRemovals: [],
        actualBackups: [],
        skippedItems: [{
          kind: 'native-config',
          label: 'Codex enabled config',
          path: '/tmp/config.toml',
        }],
        remainingItems: [{
          kind: 'native-config',
          label: 'Codex enabled config',
          path: '/tmp/config.toml',
        }],
      },
      warnings: [],
    }).join('\n');

    expect(output).toContain('cleanup 失败');
    expect(output).toContain('执行跳过项');
    expect(output).toContain('未清项');
  });

  it('renders cleanup force receipts with affected dependents and follow-up guidance', () => {
    const output = renderCleanupReceipt({
      payload: {
        ok: true,
        command: 'cleanup',
        generatedAt: '2026-05-13T00:00:00.000Z',
        dependencyIndex: false,
        cleanupPlanSchemaVersion: 1,
        dryRun: false,
        force: true,
        removeConfig: false,
        target: {
          plugin: 'git-commit',
          platform: 'codex',
          scope: 'user' as const,
          targetType: 'config-only' as const,
        },
        forceReason: '目标仍被 verified dependents 引用，`--force` 会保留 dependent 本身，只清理当前目标；这些 dependent 后续可能需要 repair、reinstall 或 cleanup。',
        plannedRemovals: [{
          kind: 'native-config',
          label: 'Codex enabled config',
          path: '/tmp/config.toml',
        }],
        wouldBackups: [],
        wouldRemoveConfig: [],
        skippedForeignItems: [],
        affectedDependents: [{
          plugin: 'helper-local-dependent',
          platform: 'codex',
          scope: 'user' as const,
        }],
        blockingReasons: [],
        recommendedCommand: 'aw diagnose git-commit --platform codex --scope user',
        actualRemovals: [{
          kind: 'native-config',
          label: 'Codex enabled config',
          path: '/tmp/config.toml',
        }],
        actualBackups: [],
        skippedItems: [],
        remainingItems: [],
      },
      warnings: [],
    }).join('\n');

    expect(output).toContain('force 语义：已启用；目标仍被 verified dependents 引用');
    expect(output).toContain('repair、reinstall 或 cleanup');
    expect(output).toContain('受影响依赖：');
    expect(output).toContain('- codex/user/helper-local-dependent');
  });

  it('renders uninstall receipts with config removal failure without losing the main result', () => {
    const receipt = {
      result: {
        platforms: ['codex'],
        plugins: ['git-commit'],
        warnings: ['主体卸载已完成，但删除 git-commit 的 AW 自管配置失败：synthetic config removal failure'],
        receiptDetails: {
          configRemovalActions: [{
            plugin: 'git-commit',
            scope: 'user' as const,
            path: '/tmp/config.json',
            status: 'failed' as const,
            reason: 'synthetic config removal failure',
          }],
        },
      },
      groups: [{
        scope: 'user' as const,
        platforms: ['codex'],
        plugins: ['git-commit'],
      }],
    };
    expect(buildCommandReceiptJson('uninstall', receipt)).toMatchObject({
      configStoreRemovals: [{
        store: {
          pluginName: 'git-commit',
          storeKind: 'user',
        },
        state: 'failed',
        reasonCode: 'removeFailed',
        subjectTargets: [{
          pluginName: 'git-commit',
          platform: 'codex',
          scope: 'user',
        }],
      }],
    });

    const output = renderCommandReceipt('uninstall', receipt).join('\n');

    expect(output).toContain('已卸载 git-commit。');
    expect(output).toContain('配置处理：主体已完成，但 AW 自管配置删除失败。');
  });

  it('renders reinstall headlines directly instead of rewriting install strings after the fact', () => {
    const output = renderCommandReceipt('install', {
      result: {
        platforms: ['codex'],
        plugins: ['git-commit'],
        warnings: [],
        receiptDetails: {
          nativeTransactionMarker: {
            status: 'markerOnlyInstall',
            needsAttention: true,
            repairCommand: 'aw repair git-commit -p codex -s user',
            cleanupCommand: 'aw cleanup git-commit -p codex -s user',
          },
        },
      },
      groups: [{
        scope: 'user' as const,
        platforms: ['codex'],
        plugins: ['git-commit'],
      }],
    }, {
      headlineVariant: 'reinstall',
    }).join('\n');

    expect(output).toContain('主要重新安装已经完成，但还需要收口本机原生状态：git-commit。');
    expect(output).not.toContain('主要安装已经完成');
  });
});
