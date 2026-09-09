# TUI v7.2 验收索引

本索引保留既有覆盖范围，并把本轮修复绑定到现存的行为测试和本地轨迹。`fixtureId` 只用于轨迹文件和失败定位；它不进入生产路由、Controller 或持久状态。测试名称是可定位的现存 `it` / `it.each` 名称；本索引不表示下列所有套件已经在本轮运行成功。

## 既有覆盖范围

| 范围 | fixtureId | 主要行为测试 |
| --- | --- | --- |
| Review 分页与技术层 | `review/user-fields/paged-technical` | `keeps every compact Review change and confirmation in one bounded focus viewport`；`summarizes many kept and warning Review rows without clipping actions or HelpBar` |
| 官方来源下载方式 | `source-edit/official/https`、`source-edit/official/custom-url` | `[source-edit/official/https] reviews an official HTTPS to SSH transport switch before any source write`；`keeps a custom official mirror as an editable address` |
| 来源根目录 | `source-edit/team-tools/subdir-empty` | `shows an explicitly cleared Catalog subdirectory as the repository root` |
| 来源恢复与技术边界 | `source-detail/damaged-default` | `[source-detail/damaged-default] keeps damaged Active unavailable when its freshness check also fails`；`renders safe source detail and technical data without raw path, credentials, or failure text` |
| 自动恢复任务 | `plugin-write-task/restore-unambiguous` | `prepares an unambiguous restore once and lets Esc return without a loop` |
| 插件详情结论 | `plugin-detail/healthy-no-update-no-config`、`plugin-detail/config-only` | `shows one usage action and an explicit health conclusion for a healthy plugin without config`；`does not claim saved settings make an uninstalled plugin usable` |
| 未确认依赖 | `plugin-detail/dependency-unconfirmed` | `keeps every unverified declarer accessible without counting it as an actual consumer`；`restores focus for an unverified reverse relation after its detail` |
| 插件预览 | `plugin-preview/decision-summary` | `keeps Portable capability, dependency summary, primary action, and HelpBar visible on D01 at 60x18`；`advertises only the manifest capability before entry, then selects candidates and executes the reviewed subset` |
| 批量选择 | `batch-selection/update-hidden-selected` | `[batch-selection/update-hidden-selected] keeps canonical selections across source and query changes and exposes the complete selected set` |
| 批量位置 | `batch-maintenance/target-prune`、`batch-placement/install-two-dimensions` | `lets batch %s edit exact existing locations without adding another platform`；`moves through batch install placement actions in visual order at %ix%i` |
| 依赖图 | `dependency-graph/shared-human-node` | `uses explicit edges, marks a shared node, and excludes an uninstalled declared consumer`；`keeps four placement references reachable and returns to the selected node` |
| 配置影响 | `config-save/impact-known-empty`、`config-save/impact-known-affected`、`config-save/impact-unknown`、`config-save/impact-check-failed` | `uses save settings when the changed field has no consumer`；`offers apply only for targets returned by config impact analysis`；`labels unknown impact as unknown and only saves the selected settings layer`；`keeps a failed impact check read-only until an explicit retry succeeds` |
| 风险确认 | `review/shared-risk/stale` | `[review/shared-risk/stale] invalidates an open risk confirmation when a new Review token replaces it` |
| 技术信息边界 | `default-surface/technical-boundary` | `renders safe source detail and technical data without raw path, credentials, or failure text`；`keeps every referenced non-root node action and its full explanation reachable at 60x18` |
| 进度与结果 | `progress/plugin-write-task/update-running` | `shows the user action for running targets: %s/%s`；`renders real rebuild events, reloads status, and restores the reporter session` |

## 本轮追加覆盖

| 修复 | 行为测试 | 轨迹 fixtureId |
| --- | --- | --- |
| R01：维护范围 | `tui-console-app-v5.test.tsx`：`lets batch %s edit exact existing locations without adding another platform` | `batch-selection/update-hidden-selected` |
| R02：核心内容、完整阅读和小屏分页 | `tui-console-app-v5.test.tsx`：`keeps a multi-field config summary and its complete final change reachable at %ix%i`、`keeps a multi-field source summary and its complete final change reachable at %ix%i`；`tui-dependency-graph-v7.test.tsx`：`keeps every referenced non-root node action and its full explanation reachable at 60x18`、`paginates complete long canonical reference IDs at 60 columns` | `review/user-fields/paged-technical` |
| R03：混合范围 | `tui-console-app-v5.test.tsx`：`keeps four scoped platform conclusions and all detail actions reachable at %ix%i`、`does not copy one scoped collision to the ready Status v8 scope` | `plugin-detail/mixed-scope-60x18`、`plugin-detail/mixed-scope-80x24` |
| R04：草稿退出守卫 | `tui-console-app-v5.test.tsx`：`keeps the same-scope target selection after Back and confirms Ctrl-C from help`、`routes $key from the transport picker through the parent draft guard` | `source-edit/official/https` |
| R05：可见继续动作和 `c` | `tui-console-app-v5.test.tsx`：`uses the visible recommended-update continuation for the %s path` | `batch-selection/update-hidden-selected` |
| R06：批量安装焦点和分组 | `tui-console-app-v5.test.tsx`：`moves through batch install placement actions in visual order at %ix%i` | `batch-selection/update-hidden-selected` |
| 当前可用依赖关系 | `tui-controller-runtime-v5.test.ts`：`projects ready dependency checks as current availability without creating applied references`；`tui-dependency-graph-v7.test.tsx`：`uses explicit edges, marks a shared node, and excludes an uninstalled declared consumer`；`write-commands.test.ts`：`preserves user actual when a project dependency is reassigned to project scope`（真实 Status → runtime → Ink bridge） | `dependency-graph/current-available` |

`availablePlacementReferences` 只来自 Status v8 中状态为 `ready` 的依赖和现场 consumer 证据。它描述本次检查中所需依赖当前可用的关系：默认范围只包括当前项目和个人位置，其他项目未检查。consumer 本身仍可处于需要同步或被阻止状态。该投影与声明边不同，也不填充历史已应用绑定；历史绑定仍未实现。它不增加 I/O、持久记录或移除门禁。

## 定向验证

在仓库根目录运行下列定向套件。命令本身不表示已经成功运行。

```sh
cd packages/cli
node ../../scripts/test/run-vitest.mjs run --project filesystem-isolated \
  tests/unit/tui-console-app-v5.test.tsx \
  tests/unit/tui-dependency-graph-v7.test.tsx \
  tests/unit/tui-controller-runtime-v5.test.ts \
  tests/unit/tui-config-experience-v7.test.tsx
```

既有范围的相关套件仍可按原索引运行：

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

如需生成本地关键 Frame 和键盘轨迹，运行：

```sh
cd packages/cli
AW_TUI_ACCEPTANCE_TRACE_DIR="$PWD/../../.tmp/tui-v7-2-followup/production-acceptance" \
  node ../../scripts/test/run-vitest.mjs run --project filesystem-isolated \
  tests/unit/tui-console-app-v5.test.tsx \
  -t '\[batch-selection/update-hidden-selected\]|\[source-edit/official/https\]|\[review/shared-risk/stale\]|keeps four scoped platform conclusions and all detail actions reachable|keeps a multi-field (config|source) summary and its complete final change reachable|summarizes many kept and warning Review rows without clipping actions or HelpBar|budgets D10 with dependency and dependent rows and projects mixed placement status consistently'
```

轨迹使用现有 `writeAcceptanceTrace` helper，记录 `fixtureId`、终端尺寸、输入和真实 Ink Frame。它不是逐字 golden，也不提交到仓库。

## 本轮结果和边界

性能定向验证已由主代理运行：`tests/perf/performance-budget.test.ts -t 'large Active-only TUI load plus Review'` 退出 0，1 项通过、10 项跳过。8 个样本的 TUI load 加操作汇总 p95 为 297.35 ms（预算 5000 ms），本地 Catalog p95 为 1 ms（预算 500 ms）；fixture 还验证 provider 调用数为 0，以及单次 Catalog load 和 validation。该结果只覆盖 fake native runner，不代表原生工具耗时。

本轮的 Ink、runtime、graph 和 config 定向结果已写入 `.tmp/tui-v7-2-followup/production-acceptance/acceptance-report.md`，并与上述 JSON 轨迹一同保留。native 平台安装、PTY 尺寸协商和网络来源未由这些 synthetic 测试执行；历史已应用绑定和 Agent 实际调用也不在本轮完成范围内。
