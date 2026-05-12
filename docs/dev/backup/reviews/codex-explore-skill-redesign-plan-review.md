# `codex-explore-skill-redesign-plan.md` 执行计划复审报告

审查对象：`docs/dev/plans/codex-explore-skill-redesign-plan.md`  
关联需求：`docs/dev/specs/codex-explore-skill-redesign.md`  
复审时间：2026-05-09

## Findings

本轮未发现新的 open finding。

## 已关闭项

- 上一轮指出的 refresh 闭环遗漏已经修复。P5 现在明确把“重新应用配置”/ `reapplyConfigRefresh()` 纳入 `codex.skill` 刷新范围，并要求 refresh 成功后同步更新 install record 与 project artifact identity，见 `docs/dev/plans/codex-explore-skill-redesign-plan.md:261-276`。P10 也补了 refresh-only / reapply 回归，要求验证 `reapplyConfigRefresh()` 能识别 tracked `codex.skill`，且刷新后 `status` / `diagnose` 不再沿用旧 identity，见 `docs/dev/plans/codex-explore-skill-redesign-plan.md:393-395,413`。这已经对齐 spec 对 refresh 与“重新应用配置”的要求，见 `docs/dev/specs/codex-explore-skill-redesign.md:161-162`。

## 复审结论

这版计划已经覆盖 spec 主线，没有再看到明显遗漏或偏差。`codex.skill` 基础设施、静态/动态 skill 协调、project 与 user 双 scope apply 闭环、config refresh、status / diagnose / repair、stale prune / cleanup / uninstall、插件形态改造、dedent 修复、作者工具与文档同步、smoke / pack 验证，以及 runtime contract 发布门禁，都已经落进阶段任务或阶段验收，见 `docs/dev/plans/codex-explore-skill-redesign-plan.md:28-37,52-77,159-179,188-203,212-228,237-278,287-325,334-417,426-437`。

计划内部现在也是自洽的，阶段依赖和当前仓库基线能对上。它点到的关键改造入口在现有代码里都真实存在，例如 project scope 仍有 `requiresCodexProjectConfig` 的旧假设，见 `packages/cli/src/utils/artifact-plan.ts:129-131`；refresh 当前还只识别 `codex.developerInstructionsBlock` / `codex.agentRole`，见 `packages/cli/src/utils/artifact-refresh.ts:58-69`；控制台也确实存在“重新应用配置”入口，见 `packages/cli/src/commands/console.ts:818-823`。这说明计划不是脱离基线的抽象设计，而是能直接落到当前实现结构上的改造清单。

测试覆盖也已经补齐到这轮变更范围。计划不只覆盖 manifest/schema、renderer、trigger truth table 和 dedent，还把 project/user install、refresh-only / reapply、status drift、`diagnose --deep`、repair、shared runtime owner replay、uninstall 后 rematerialize、本地 marketplace rebuild replay、非 AW-owned 冲突保护、smoke build、pack/tarball 验证都列成了显式回归项，见 `docs/dev/plans/codex-explore-skill-redesign-plan.md:174-203,221-228,246-301,318-325,352-362,391-417`。

本轮复审确认上一轮报告里的问题已经修复，目前没有新增问题。唯一仍需持续关注的是 Codex runtime 对内置 `explorer` 的通用只读探索 contract，这属于外部前置条件，不是当前执行计划的遗漏；计划已经把它收敛为 P0 / P11 的发布门禁，见 `docs/dev/plans/codex-explore-skill-redesign-plan.md:73-77,137-150,426-437`。
