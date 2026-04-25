# `npm-plugin-marketplace-new.md` 实现复审报告

审查对象：`docs/dev/plans/npm-plugin-marketplace-new.md` 对应当前实现  
复审时间：2026-04-25

本轮实际验证：

- 静态复核 `build / init / install / uninstall / upgrade / status / current catalog / adapter / authoring tools / tracking` 关键实现
- `pnpm test`
- `pnpm test:smoke`
- `pnpm test:coverage`

## 结论摘要

这轮复审确认，上一轮报告里的问题已经全部修复，包括当时保留为低风险尾项的 `runtime.env` 透传一致性问题。

本轮没有发现新的高、中、低严重度问题。按执行计划定义的核心 contract、失败语义、测试 gate 和文档同步要求来看，当前实现已经可以认为严格按计划落地，主路径和关键 failure path 都有自动化测试兜底。

这次和上一轮相比，还有两个明显进展：

1. `runtime.env` 相关的一致性已经补齐，并有独立集成测试覆盖。
2. Claude 侧测试覆盖明显提升，`packages/cli/src/adapters/claude.ts` 覆盖率从上一轮的 `53.16%` 提升到了这轮的 `94.5%`。

## Findings

本轮未发现新的 Findings。

## 上一轮问题复核

### 1. `uninstall` 在 `historical / capabilityChanged` 路径下的 artifact rollback 问题已修复

上一轮最核心的遗留问题，是 `uninstall` 在历史卸载和能力变更路径下，失败回滚仍可能依赖 current catalog。现在这部分已经补齐。

- 修复证据：
  - `packages/cli/src/commands/uninstall.ts:284-347`
  - `packages/cli/src/commands/uninstall.ts:389-463`
- 当前行为：
  - 卸载前先抓取 repo-managed artifacts、Codex managed `developer_instructions`、hooks，以及 Claude permissions 的快照。
  - 失败时直接按卸载前快照恢复，不再通过“重新 install 当前 manifest”兜底。
- 回归测试：
  - `packages/cli/tests/unit/uninstall-command.test.ts:604-691`
  - `packages/cli/tests/unit/uninstall-command.test.ts:693-787`

### 2. Codex marketplace `source` 继续写 canonical `AW_HOME` path

- 代码位置：
  - `packages/cli/src/adapters/codex.ts:561-567`
- 回归测试：
  - `packages/cli/tests/unit/codex-adapter.test.ts:70-99`

这部分仍然符合计划要求，没有回退。

### 3. repo root `pnpm pack:cli` 入口和 tarball smoke 保持有效

- repo root 代理入口：
  - `package.json:5-14`
- package 级 `build / smoke / prepack`：
  - `packages/cli/package.json:8-24`
- smoke 配置：
  - `packages/cli/vitest.config.ts:3-10`
  - `packages/cli/tests/smoke/build-smoke.test.ts:15-33`
  - `packages/cli/tests/smoke/pack-smoke.test.ts:44-180`

这说明计划里关于 monorepo 统一验证入口、`prepack` 行为、以及 tarball 内 embedded bundle 验证的约束都还成立。

### 4. install 失败后的 repo-managed artifact rollback 仍然有效

这一点本轮继续保持关闭，没有发现回归。相关 failure path 仍然由集成测试覆盖：

- `packages/cli/tests/integration/cli.test.ts`

### 5. `runtime.env` 透传一致性问题已修复

上一轮报告里唯一保留的低风险问题，是命令层支持 `runtime.env`，但自动平台推断和 current catalog 读取没有完整透传。现在这部分已经关闭。

- 修复证据：
  - `packages/cli/src/commands/common.ts:254-308`
  - `packages/cli/src/utils/marketplace.ts:29-55`
  - `packages/cli/src/commands/status.ts:16-70`
- 回归测试：
  - `packages/cli/tests/integration/runtime-env.test.ts:73-127`

这意味着程序化调用、测试注入环境、默认 adapter 和 current catalog 解析，已经使用同一份环境上下文。

## 是否还有其他未发现的问题

本轮没有发现新的高、中、低严重度问题。

如果按“会不会破坏计划核心 contract”来衡量，这轮没有看到新的遗漏项，原因主要有三点：

1. build-time contract、runtime contract、local marketplace freshness 和 native state 边界是对齐的。
2. install / uninstall / upgrade / status 的主路径和失败路径现在都有明确的 degraded 语义和自动化测试。
3. 作者工具、夹具、历史文档清理这些容易在后续漂移的外围 contract，也已经被集成测试锁住。

所以这轮更准确的结论是：

- 没有新的问题
- 上一轮问题已经全部关闭
- 当前实现已经收口

## 代码实现质量

整体实现质量是好的，主要体现在下面几个方面：

1. 运行时边界清楚。`embedded plugins root`、`~/.aw`、平台原生状态、tracking manifest 和 CLI ledger 的职责拆分是稳定的。
2. build-time 和 runtime contract 对得上。`bundle-plugins.ts`、`plugins-dist`、`resolveEmbeddedPluginsRoot()`、repo root 代理脚本和 smoke 验证已经形成闭环。
3. failure path 处理完整。现在 install / uninstall 的 rollback、`degraded` 标记、历史卸载恢复和 capability drift 处理都比较扎实。
4. 内部一致性比上一轮更好。`runtime.env` 透传已经补齐，Claude 侧状态和测试也明显收口。

如果一定要说还有什么值得继续加强，更多是常规性的覆盖率丰满，而不是架构或行为正确性问题。

## 是否严格按照计划实现

就计划里的核心目标、关键 contract 和验收项来看，这次可以给出“已经严格按照计划实现”的结论。

本轮确认已经对齐的关键点包括：

1. Phase 1 的 build / publish / smoke contract 已落地：
   - `package.json:5-14`
   - `packages/cli/package.json:8-24`
   - `packages/cli/vitest.config.ts:3-10`
   - `packages/cli/scripts/bundle-plugins.ts:20-68`
2. `embedded plugins root` 与 runtime bundle 读取边界已落地：
   - `packages/cli/src/utils/paths.ts:89-101`
   - `packages/cli/src/utils/plugin-catalog.ts:25-60`
3. marketplace mirror 与 current catalog contract 已落地：
   - `packages/cli/src/utils/marketplace.ts:29-55`
4. Codex / Claude 平台状态和 scope 语义已落地：
   - `packages/cli/src/adapters/codex.ts`
   - `packages/cli/src/adapters/claude.ts`
   - `packages/cli/src/commands/common.ts`
5. install / uninstall / upgrade / status 编排与失败语义已落地：
   - `packages/cli/src/commands/install.ts`
   - `packages/cli/src/commands/uninstall.ts`
   - `packages/cli/src/commands/upgrade.ts`
   - `packages/cli/src/commands/status.ts`
6. 作者工具与历史文档同步约束已落地：
   - `packages/cli/tests/integration/authoring-tools.test.ts:183-217`

因此，这次不需要再保留“主体完成但还差收尾”的判断。更贴切的说法是：

- 计划定义的核心行为已经实现
- 关键失败语义已经实现
- 文档和作者工具同步要求也已经实现

## 测试与覆盖率

### 本轮实测

我实际执行了：

- `pnpm test`
- `pnpm test:smoke`
- `pnpm test:coverage`

三组命令全部通过。

### 测试结果

- `pnpm test`：`26` 个测试文件、`107` 个测试全部通过
- `pnpm test:smoke`：`2` 个 smoke 测试全部通过
- `pnpm test:coverage`：通过

### 当前覆盖率

`pnpm test:coverage` 结果：

- `Statements`: `86.65%`
- `Branches`: `78.60%`
- `Functions`: `95.38%`
- `Lines`: `86.65%`

和本次复审最相关的模块里，覆盖率表现是：

- `packages/cli/src/adapters/claude.ts`：`94.5%`
- `packages/cli/src/adapters/codex.ts`：`90.47%`
- `packages/cli/src/commands/install.ts`：`86.99%`
- `packages/cli/src/commands/uninstall.ts`：`82.18%`
- `packages/cli/src/commands/upgrade.ts`：`85.96%`
- `packages/cli/src/commands/common.ts`：`78.72%`
- `packages/cli/src/utils/local-marketplace.ts`：`91.69%`
- `packages/cli/src/utils/plugin-catalog.ts`：`98.97%`
- `packages/cli/src/utils/marketplace.ts`：`90.47%`
- `packages/cli/src/utils/tracking.ts`：`100%`

### 对测试覆盖情况的判断

当前测试矩阵已经足以支撑“实现已按计划收口”的结论，原因是关键风险点都已经有对应守门：

1. build / pack contract 有 smoke 测试。
2. `~/.aw` freshness、repair、fallback 和 degraded ledger 有 unit + integration。
3. `runtime.env`、Codex config round-trip、canonical path、repo-root artifact anchoring 都有专项测试。
4. install / uninstall / upgrade / status 的主路径、拒绝路径和 failure path 都有覆盖。
5. 作者工具、夹具契约和历史文档清理也有集成测试。

所以这次的测试结论不是“所有分支都覆盖到了”，而是：

- 核心行为覆盖已经够用
- 关键 failure path 已经补齐
- 当前覆盖率足以支撑本轮复审结论

## 最终判断

这轮复审的最终结论如下：

- 上一轮报告里的问题已经全部修复
- 本轮没有发现新的高、中、低严重度问题
- 当前实现质量良好
- 现在可以认为已经严格按照计划实现
- 测试矩阵和覆盖率足以支撑当前结论

如果要更新项目状态，我建议把结论更新为：

**“执行计划已按实现 contract 收口，当前进入常规维护和增量测试增强阶段。”**
