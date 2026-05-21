# `agent-version-gate-and-codex-0131-plan.md` 审查报告

审查对象：`docs/dev/plans/agent-version-gate-and-codex-0131-plan.md`  
对应 Spec：`docs/dev/specs/agent-version-gate-and-codex-0131.md`  
审查时间：2026-05-21

## Findings

本轮复审未发现新的 blocking finding。上一轮报告里的两个问题都已经补齐：

- 阶段 5、测试矩阵和阶段验收已经把 `codex plugin add/remove` 的写后本地证据校验写成明确待办，并把它作为成功条件。
- 阶段 2、阶段 5、测试矩阵和最终回归已经把 `aw upgrade --all` 当作独立写路径验收，不再隐含地并入普通 `upgrade`。

## 非阻塞建议

- `docs/dev/plans/agent-version-gate-and-codex-0131-plan.md:349-364`、`docs/dev/plans/agent-version-gate-and-codex-0131-plan.md:581-584` 已经把不带 `--verbose` 的 `status --json` 约束成只读路径，但测试矩阵还没有单独钉住“仍需保留必要的 agent version 诊断”这层公开合同。Spec 在 `docs/dev/specs/agent-version-gate-and-codex-0131.md:121`、`docs/dev/specs/agent-version-gate-and-codex-0131.md:212`、`docs/dev/specs/agent-version-gate-and-codex-0131.md:270` 已经把这条边界说清楚；如果后续想再收紧验证，可以补一条显式断言，避免实现时只保证“不启动 app-server / JSON 可解析”，却把非 verbose JSON 的版本诊断做薄了。

## 结论

这版计划已经覆盖当前 Spec 的关键需求、阶段拆分、并行边界和主要验收闭环，可以按此开工。
