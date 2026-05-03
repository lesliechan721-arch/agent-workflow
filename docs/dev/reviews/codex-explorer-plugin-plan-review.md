# `codex-explorer-plugin.md` 执行计划审查报告

审查对象：`docs/dev/plans/codex-explorer-plugin.md`  
审查时间：2026-05-04

本轮是复查，重点确认 4 件事：

- 上一轮报告提出的问题是否已经修复
- 计划是否严格落实 `docs/dev/specs/codex-explorer-plugin-spec.md`
- 计划是否和当前 CLI 基线对得上、能直接落地
- 测试矩阵是否完整覆盖计划承诺的行为

对照依据：

- 计划文档：`docs/dev/plans/codex-explorer-plugin.md`
- 需求 spec：`docs/dev/specs/codex-explorer-plugin-spec.md`
- 测试约定：`docs/testing.md`
- 当前基线实现：`packages/cli/src/types.ts`、`packages/cli/src/utils/tracking.ts`、`packages/cli/src/utils/codex-project-surface.ts`、`packages/cli/src/commands/codex-project-safety.ts`、`packages/cli/src/utils/plugin-config.ts`、`packages/cli/src/utils/plugin-scripts.ts`、`packages/cli/src/adapters/codex.ts`、`packages/cli/src/commands/install.ts`、`packages/cli/src/commands/upgrade.ts`、`packages/cli/src/index.ts`

## 复查结论

上一轮报告里点名的问题，这次都已经补进计划正文或测试矩阵了，尤其是之前唯一还挂着的 refresh “非对称 scope”分支，现在正文和集成测试都已经单独锁住：

- 轻量 instruction 的内容边界已经写回计划正文，也进入了内容回归，包括“不内嵌大段示例 prompt / 不讲插件机制、安装方式或配置命令 / 默认 25 行以内 / 配置模型不可用或用户显式指定其它模型时先说明再处理”，见 `docs/dev/plans/codex-explorer-plugin.md:497-504`、`883-890`
- 多 instruction 稳定合成，以及 role 注册项和 role layer `description` 不一致的 status 诊断，都已经进入测试矩阵，见 `docs/dev/plans/codex-explorer-plugin.md:720`、`727`、`865-866`
- config-triggered refresh 不执行 lifecycle 脚本的回归已经补进集成测试矩阵，见 `docs/dev/plans/codex-explorer-plugin.md:795-798`
- refresh 的 role registration drift / role content drift 保护分支，以及 upgrade 路径的 role 冲突 preflight，也已经单独进入测试矩阵，见 `docs/dev/plans/codex-explorer-plugin.md:824-826`、`843-848`
- “未安装插件时先写配置，后续 install / upgrade 按最新 artifact render config 首次落盘”的路径已经被单独锁住，见 `docs/dev/plans/codex-explorer-plugin.md:741-745`
- refresh 目标选择的“非对称 scope”分支已经补回计划正文和集成测试矩阵：正文明确了 project-only / store-only 的判断边界，测试也分别覆盖了 project-only 安装、store-only 场景、current repo 定位和多 repo `refreshReach`，见 `docs/dev/plans/codex-explorer-plugin.md:378-383`、`397-398`、`803-818`

对照 `docs/dev/specs/codex-explorer-plugin-spec.md` 逐段复查后，我这次没有再看到新的 spec 偏差或遗漏。计划主线仍然和 spec 完全一致：动态能力真值来自 `artifacts.targets`，写路径通过 renderer 产出 ArtifactPlan，AW CLI 负责 preflight、apply、tracking、status、rollback、upgrade、uninstall 和 config-triggered refresh。旧版 `extensions.*` / `codexRole` binding 方案也没有再混进正文。

从当前 CLI 基线看，这份计划也能直接落地。现有代码里已经有明确承接点：`types.ts` 可以扩 manifest / tracking / status 类型；`plugin-config.ts` 和 `index.ts` 能接 config 写入后的 refresh；`plugin-scripts.ts` 能承接 renderer runtime；`codex-project-surface.ts` / `codex-project-safety.ts` 能扩动态 capability 与 preflight；`codex.ts` / `codex-config.ts` 则能继续承接 Codex config / role apply 路径。方案没有脱离当前代码结构另起一套平行机制。

测试矩阵也已经补齐到可以支撑实现落地的程度：manifest / renderer / ArtifactPlan 校验、Codex target apply、config-triggered refresh、status / uninstall / upgrade、静态 `extensions.*` 兼容层、内容回归、作者工具和 smoke 覆盖都在文档里各自落到了具体用例上。

## Findings

本轮未发现新的问题。

## 结论

这次复查可以确认四件事：

- 上一轮报告提出的问题已经修复
- 计划仍然严格围绕 spec 制定，没有看到新的偏差或遗漏
- 文档内部自洽，且能挂到当前 CLI 基线上继续落地
- 测试矩阵已经覆盖计划承诺的关键行为，可以进入实现

当前这份执行计划可以视为通过复查；后续实现如果严格按这版计划推进，不需要再先回头补 plan 级问题。
