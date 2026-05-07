# `plugin-dependencies` 实现复审报告

审查对象：`plugin-dependencies` 当前实现（HEAD `d74b397`），本报告保留首轮审查结论，并记录 2026-05-07 对修复后代码的复审结果。  
对照文档：`docs/dev/plans/plugin-dependencies-plan.md`、`docs/dev/specs/plugin-dependencies.md`  
首轮审查时间：2026-05-07  
复审时间：2026-05-07

## 首轮 Findings

### 1. 高：`uninstall` 在 dependency metadata 不完整时没有对“被依赖保护” fail closed，仍可能继续卸载

复审状态：已关闭。

首轮判断：

- `collectUninstallPlannerState()` 会把 ledger 中所有 scope record 原样送进 planner，允许 `installSource` / `dependencyEdges` 缺失。
- 当时的 `planPluginDependencyUninstall()` 只在自动清理路径上用 `dependencyMetadataComplete` 做保守处理，没有把同样的 fail-closed 门槛覆盖到“当前目标是否仍被依赖”的阻断判定。
- 这样一来，只要缺失 metadata 的 record 正好落在 dependent 一侧，就可能把 `blocked` 错算为空，继续卸载实际上仍被依赖的目标。

本轮确认的修复：

- `packages/cli/src/utils/plugin-dependency-planner.ts:1106-1117` 新增 `collectVisibleIncompleteDependencyMetadataLocations()`，按当前命令可见范围收集 metadata 不完整的 record。
- `packages/cli/src/utils/plugin-dependency-planner.ts:1296-1321` 现在会在进入 uninstall protect 计算前直接返回 `incompleteMetadataLocations`，先 fail closed。
- `packages/cli/src/commands/uninstall.ts:1267-1278` 在执行前把这类情况提升为确定性错误，不再继续卸载。
- 新增覆盖：
  - `packages/cli/tests/unit/plugin-dependency-planner.test.ts:940-980`
  - `packages/cli/tests/unit/uninstall-command.test.ts:424-522`

### 2. 高：`upgrade --all` 的 planner 会把缺少 explicit 保留标记的 legacy record 重新当成 roots

复审状态：已关闭。

首轮判断：

- 命令入口已经只把 `installSource.explicitlyRequested === true` 的位置收进 `explicitRootLocations`。
- 但当时 `planPluginDependencyUpgradeAll()` 又从 candidate roots 重新派生一遍 roots，并用 `record.installSource?.explicitlyRequested !== false` 作为条件，把 `undefined` 也算进去了。
- 结果是：只要同一批候选里存在至少一个合法显式根，混在一起的 legacy record 就会被重新当成 roots，违反计划里“`upgrade --all` 只把显式保留安装作为根”的合同。

本轮确认的修复：

- `packages/cli/src/utils/plugin-dependency-planner.ts:1153-1165` 现在只接受 `record.installSource?.explicitlyRequested === true` 作为 upgrade-all roots。
- `packages/cli/src/commands/upgrade.ts:336-374` 的显式 root 收集逻辑与 planner 现在使用同一真值，不再前后放宽。
- 新增覆盖：
  - `packages/cli/tests/unit/plugin-dependency-planner.test.ts:693-734`
  - `packages/cli/tests/integration/upgrade-command.test.ts:877-910`

### 3. 中：`upgrade --all --scope project --platform both` 把双平台 project key 压成了一个值，可能漏掉一侧平台

复审状态：已关闭。

首轮判断：

- Claude project key 与 Codex project key 的解析锚点本来就不同，仓库子目录执行时二者可能分叉。
- 当时 `runUpgradeAll()` 只把单个 `projectKey` 传给 planner，导致 root 过滤和 auto cleanup 可见性只能保住其中一侧平台。
- 这会让 `--scope project --platform both` 的双平台规划在子目录场景下错误漏掉一侧。

本轮确认的修复：

- `packages/cli/src/utils/plugin-dependency-planner.ts:1018-1031` 的 `isLocationInScope()` 已升级为按平台读取 `projectKeysByPlatform`。
- `packages/cli/src/utils/plugin-dependency-planner.ts:1123-1244` 的 candidate root 过滤与 auto cleanup 可见性现在都使用 platform-aware project key。
- `packages/cli/src/commands/upgrade.ts:1898-1928` 以及 `2073-2082` 两次 planner 调用都改为传递 `projectKeysByPlatform`，不再把双平台 key 压成单值。
- 新增覆盖：
  - `packages/cli/tests/unit/plugin-dependency-planner.test.ts:736-786`
  - `packages/cli/tests/integration/upgrade-command.test.ts:1195-1311`

## 复审结果

审查方法：

- 静态对照修复点、联动 helper 和 plan / spec，重点复核 `uninstall`、`upgrade --all`、`project scope` 三条语义链路。
- 复查新增测试是否真的命中首轮 3 个 finding，而不是只覆盖 happy path。
- 运行定向 unit / integration 与 build smoke，确认修复没有只停留在测试夹具层面。

执行命令：

- `rg` / `sed` / `nl`：通读计划、spec、实现、测试和现有 review 报告
- `pnpm --filter @yiliang/aw exec vitest run tests/unit/plugin-dependency-planner.test.ts tests/unit/uninstall-command.test.ts tests/unit/upgrade-command.test.ts`
- `pnpm --filter @yiliang/aw exec vitest run tests/integration/upgrade-command.test.ts`
- `pnpm test:smoke:build`

验证结果：

- `tests/unit/plugin-dependency-planner.test.ts`、`tests/unit/uninstall-command.test.ts`、`tests/unit/upgrade-command.test.ts` 共 39 个测试全部通过。
- `tests/integration/upgrade-command.test.ts` 19 个测试全部通过。
- `tests/smoke/build-smoke.test.ts` 5 个测试全部通过。

本轮未发现需要修复的问题。

已验证关闭的首轮 finding：

1. `uninstall` 现在会在当前命令可见范围内发现缺失 dependency metadata 的 record 时直接拒绝执行，符合 `docs/dev/specs/plugin-dependencies.md:338-347` 的 fail-closed 要求。
2. `upgrade --all` 现在只把显式保留安装作为 roots，不会再把缺少 explicit 标记的 legacy record 重新当成 roots，符合 `docs/dev/plans/plugin-dependencies-plan.md:57-59` 与 `docs/dev/specs/plugin-dependencies.md:345-347`。
3. `upgrade --all --scope project --platform both` 现在按平台保留各自的 project key，子目录执行时不会漏掉另一侧平台，符合 `docs/dev/specs/plugin-dependencies.md:330` 的 project key 语义。

修复影响面的覆盖抽查：

- `uninstall`：fail-closed 保护放在 planner 入口之前的阻断阶段，后续 auto cleanup 仍保持原有保守策略，没有放宽跨 project 清理边界；与 `docs/dev/specs/plugin-dependencies.md:290-299` 一致。
- `upgrade --all`：root 过滤、skip 传播、二次 replan 和 auto cleanup candidate 现在使用同一套 platform-aware scope 语义，没有看到新的 root 扩散或 project key 丢失问题。
- `project scope`：Codex / Claude 在 `both` 模式下的 project key 已贯通到 root 选择和后续 replan；新增 unit / integration 测试都覆盖了“子目录执行、双 key 分叉”的场景。

## 结论

结论：未发现需修复问题
