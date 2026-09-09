# TUI v7.2 验收索引

本索引把设计发现绑定到现有的真实 Ink 行为测试。`fixtureId` 只用于测试名称、证据导航和失败报告。它不进入生产路由、Controller 或持久状态。

| 范围 | fixtureId | 主要测试位置 |
| --- | --- | --- |
| Review 分页与技术层 | `review/user-fields/paged-technical` | `tui-console-app-v5.test.tsx` 的 compact、many rows 和 layered Review 用例 |
| 官方来源下载方式 | `source-edit/official/https`、`source-edit/official/custom-url` | `tui-console-app-v5.test.tsx` 的同名 HTTPS 轨迹和 custom mirror 用例 |
| 来源根目录 | `source-edit/team-tools/subdir-empty` | `tui-console-app-v5.test.tsx` 的 cleared Catalog subdirectory 用例。当前只覆盖编辑页和修改汇总 |
| 来源恢复与技术边界 | `source-detail/damaged-default` | `tui-console-app-v5.test.tsx` 的 source detail、damaged Active 和 source technical 用例 |
| 自动恢复任务 | `plugin-write-task/restore-unambiguous` | `tui-plugin-write-task-v7.test.tsx` 的 unambiguous restore 用例 |
| 插件详情结论 | `plugin-detail/healthy-no-update-no-config`、`plugin-detail/config-only` | `tui-console-app-v5.test.tsx` 的 healthy without config 和 saved settings without install 用例 |
| 未确认依赖 | `plugin-detail/dependency-unconfirmed` | plugin detail、dependency issue 和 planned recovery 的组合用例。当前没有独立的 Enter 负例 |
| 插件预览 | `plugin-preview/decision-summary` | `tui-console-app-v5.test.tsx` 的 D01/P04 尺寸用例和 `tui-portable-skills-v1.test.tsx` 的 manifest capability 用例 |
| 批量选择 | `batch-selection/update-hidden-selected` | `tui-console-app-v5.test.tsx` 的同名轨迹、长中文列表和工具动作用例 |
| 批量位置 | `batch-maintenance/target-prune`、`batch-placement/install-two-dimensions` | `tui-console-app-v5.test.tsx` 的 exact targets、batch placement 和 maintenance 用例 |
| 依赖图 | `dependency-graph/shared-human-node` | `tui-dependency-graph-v7.test.tsx` 的 shared、directional、node 和 references 用例 |
| 配置影响 | `config-save/impact-known-empty`、`config-save/impact-known-affected`、`config-save/impact-unknown`、`config-save/impact-check-failed` | `tui-config-experience-v7.test.tsx` |
| 风险确认 | `review/shared-risk/stale` | `tui-console-app-v5.test.tsx` 的同名轨迹和 shared impact 尺寸矩阵 |
| 技术信息边界 | `default-surface/technical-boundary` | Review、来源、依赖图、诊断和批量页的默认/`d`/More 组合用例 |
| 进度与结果 | `progress/plugin-write-task/update-running` | `tui-real-progress.test.tsx` 的 intent/goal 矩阵和真实 rebuild 链 |

在仓库根目录运行相关 TUI 验证：

```sh
cd packages/cli
node ../../scripts/test/run-vitest.mjs run --project filesystem-isolated \
  tests/unit/tui-console-app-v5.test.tsx \
  tests/unit/tui-dependency-graph-v7.test.tsx \
  tests/unit/tui-config-experience-v7.test.tsx \
  tests/unit/tui-plugin-write-task-v7.test.tsx \
  tests/unit/tui-input-display-v7.test.tsx \
  tests/unit/tui-real-progress.test.tsx \
  tests/unit/tui-portable-skills-v1.test.tsx
```

如需生成本地 Frame 和键盘轨迹，在同一目录运行：

```sh
AW_TUI_ACCEPTANCE_TRACE_DIR="$PWD/../../.tmp/tui-v7-2-review/production-acceptance" \
  node ../../scripts/test/run-vitest.mjs run --project filesystem-isolated \
  tests/unit/tui-console-app-v5.test.tsx \
  -t '\[batch-selection/update-hidden-selected\]|\[source-edit/official/https\]|\[review/shared-risk/stale\]'
```

轨迹文件记录 `fixtureId`、尺寸、输入和真实 Ink Frame。测试断言行宽、行数、ANSI 色码边界和唯一可见焦点。轨迹不是逐字 golden，也不提交到仓库。

这些测试使用 synthetic catalog 和 fake native runner。它们不访问用户配置，也不证明真实 SSH、网络来源、PTY 尺寸协商、原生平台安装、共享 native 内容写入或外部插件工具。真实环境行为仍需要独立 qualification 或人工证据。

依赖图的已确认位置与连续路径用例显式注入合成的 `placementReferences`，只证明关系计算和渲染能正确处理这类证据。当前 runtime 不采集消费者与已应用依赖位置的绑定证据，因此生产页面仍将没有证据的关系显示为“仅声明／未验证”；这些测试不证明生产端已经取得实际引用。
