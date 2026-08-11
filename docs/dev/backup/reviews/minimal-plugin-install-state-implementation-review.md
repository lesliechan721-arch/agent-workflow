# `minimal-plugin-install-state` 实现复审报告

审查对象：`minimal-plugin-install-state` 当前工作区实现（基于 HEAD `0887a0c`）  
对照计划：`docs/dev/plans/minimal-plugin-install-state-plan.md`  
审查时间：2026-05-08

## Findings

本轮复审没有发现新的实现缺陷，也没有发现上一版报告中仍未修复的遗留问题。

## 已修复项核对

上轮报告里的 3 个问题，这次都已经修到位，而且相关回归测试也补齐了。

1. Claude project scope shared identity 串项目问题已修复。
   `resolveProjectArtifactProjectRoot()` 现在会基于 Claude project scope 的 `projectKey` 推导 repo-relative project root，而不是继续把 locator 固定到 repo root：`packages/cli/src/install-state/paths.ts:190-216`。读路径、install 写路径 / preflight，以及 repair 的 dependency repair、same-bundle repair、adopt-existing 都已经统一接入这套解析：`packages/cli/src/install-state/evidence.ts:432-440`、`packages/cli/src/commands/install.ts:1235-1265`、`packages/cli/src/commands/install.ts:1737-1762`、`packages/cli/src/commands/install.ts:3089-3116`、`packages/cli/src/commands/repair.ts:945-962`、`packages/cli/src/commands/repair.ts:1223-1242`、`packages/cli/src/commands/repair.ts:1438-1498`。
   对应的回归测试现在不只覆盖读路径，也覆盖了命令级写路径和 ignore preflight：`packages/cli/tests/unit/install-state-status-projection.test.ts:112-170`、`packages/cli/tests/unit/install-command.test.ts:1482-1652`。

2. dependency health 漏看 `artifact.paths` 的问题已修复。
   依赖健康检查现在会同时检查主路径和 secondary paths：`packages/cli/src/install-state/evidence.ts:548-559`。对应测试验证 secondary path 缺失时会把目标投影为 `needsRepair`，而不是误判成健康：`packages/cli/tests/unit/install-state-status-projection.test.ts:468-529`。

3. historical lifecycle runtime ref 越界校验不足的问题已修复。
   validator 现在会把 `runtimeRoot` 绑定到 `AW_HOME/lifecycle-runtimes/<platform>/<scope>/<scopeKey>/<recordId>/...`，并在 install record file 校验阶段把 location 与 `recordId` 一起带入校验：`packages/cli/src/install-state/schema.ts:503-576`、`packages/cli/src/install-state/schema.ts:733-748`。对应负例测试已经补上：`packages/cli/tests/unit/install-state-schema.test.ts:292-337`。

## 计划一致性

这轮修复没有引入与计划相悖的新行为，复审范围内也没有看到偏差或遗漏：

- project shared identity 仍然是 repo-stable locator，只是把 Claude project scope 的 project root 解析修正为计划要求的“仓库内项目边界”，没有把绝对路径、cwd 或旧状态语义重新带回 shared identity。
- 状态投影仍然坚持只读证据模型；这次只是补齐 shared identity 读取和 dependency artifact 证据判断，没有引入读路径写文件、副作用 renderer 或额外 install truth。
- lifecycle runtime 仍然只作为卸载 / repair / reinstall 的历史运行时引用；这次补的是路径边界校验，没有把 runtime snapshot 重新扩展回 install record。

## 测试评估

这轮修复对应的测试闭环现在已经补齐。除了原有相关用例，我额外确认了下面几类回归都已经存在并通过：

- Claude project 子目录 shared identity 的读路径回归。
- Claude project 子目录 install 写路径和 `.gitignore` 冲突 preflight 回归。
- dependency secondary artifact path 缺失的状态投影回归。
- historical lifecycle runtime ref 越界的 schema 负例回归。

我实际复跑并通过了以下验证：

- `pnpm build`
- `pnpm --filter @lesliechan721/aw exec vitest run tests/unit/install-command.test.ts tests/unit/repair-command.test.ts tests/unit/install-state-status-projection.test.ts tests/unit/install-state-schema.test.ts tests/unit/config-write.test.ts tests/unit/install-state-project-boundary.test.ts tests/unit/uninstall-command.test.ts tests/unit/reinstall-command.test.ts tests/unit/diagnose-command.test.ts tests/unit/install-state-transactions.test.ts`
- `pnpm --filter @lesliechan721/aw exec vitest run tests/integration/plugin-lifecycle-command.test.ts tests/integration/discovery.test.ts`
- `pnpm test:smoke:build`

按这次变更涉及的代码面来看，相关实现和回归覆盖已经收口，没有再看到上一轮那种“helper 已修好，但真实命令链路没有测到”的缺口。

## 结论

当前实现质量良好，和 `minimal-plugin-install-state` 计划保持一致。上一轮报告指出的 3 个问题都已经修复，复审范围内没有发现新的高、中、低风险实现问题；这份实现报告可以更新为“通过”。
