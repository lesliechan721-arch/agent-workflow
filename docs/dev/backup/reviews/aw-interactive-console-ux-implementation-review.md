# `aw` 交互控制台实现复审报告

审查对象：`aw-interactive-console-ux` 当前实现（HEAD `03aeb92`）
对照计划：`docs/dev/plans/aw-interactive-console-ux-plan.md`
审查时间：2026-05-06

## Findings

本轮复审未发现新的实现问题、计划偏差或明显测试缺口。

上一次实现复审报告中的 2 个问题已经确认修复：

- `packages/cli/src/commands/console-model.ts:697-705` 现在让 `未安装` 详情页只保留 `安装`，`由其它来源管理` 不再暴露 `查看诊断命令`；`packages/cli/tests/unit/console-model.test.ts:469-482` 已补上动作集合断言。
- `packages/cli/src/commands/console.ts:487-533` 现在只会强制修复“必填字段”；已有但无效的可选字段仍可在同一轮表单里 `保留 / 更新 / 清空`，`packages/cli/tests/unit/console.test.ts:403-471` 已覆盖“当前值无效但显式清空”的路径。

## 结论

- 代码实现质量：友好状态投影、主入口控制器、配置写入 helper、refresh-only helper、CLI receipt/output 边界和 prompt runtime 这几条主链路都比较完整，模块职责和计划里的拆分基本一致。
- 计划一致性：本次重点核对的交互入口、六类友好状态、详情页动作合同、只读预检先于配置输入、`updatedKeys/removedKeys` 语义、`reapplyConfigRefresh`、旧交互 flag 移除、`config configure` 移除、`status --json` 追加 `friendlySummaries/consoleItems`、默认输出禁词收口，当前实现都与计划一致。
- 测试覆盖：计划要求的关键合同基本都有单元或集成回归，包括动作矩阵、配置显式清空、read-only preflight、JSON stdout 边界、dynamic artifact refresh 成功/失败/skipped、以及 tarball 打包后的运行时验证。额外 spot check 也确认公开文档、`README.md` 和 `.agents/` 路径里没有遗留面向用户的 `--interactive`、`--no-interactive`、`config configure` 说明。

## 验证记录

- `pnpm test:smoke:build`：通过
- `pnpm test:unit`：通过
- `pnpm test:integration`：通过
- `pnpm --filter @lesliechan721/aw test:smoke:pack`：通过

补充说明：第一次把 `test:unit` / `test:integration` 和 `test:smoke:build` 并行触发时，少数依赖 `packages/cli/plugins-dist` 的用例会先报“先跑 `pnpm build`”。这属于验证顺序问题，不是产品缺陷；在 `smoke:build` 完成后重跑，相关用例已全部通过。
