---
name: review-aw
description: >-
  当用户明确要求只读审核一个 AW Plugin、Catalog Workspace、跨插件 workflow 或 AW 能力 portfolio 时使用。负责取得 AW source/materialized/profile/snapshot/inventory 证据，并使用通用 Skill/Architecture/Eval Reviewer；不修改、build、test、联网发布。只有明确请求 Release Check 时才生成 AW-owned machine evidence。
user-invocable: true
compatibility: 需要 Node.js 22+、PATH 中可用的 aw CLI、agent-content-toolkit 和 agent-skill-toolkit；Release Check 的 Eval 链还需要兼容 aw-skill-eval。
metadata:
  short-description: 只读评审 AW Plugin、Catalog、workflow 或 portfolio
---

# Review AW

对被审 source、final、Eval 保持只读；用户明确要求的报告/Audit/机器证据输出可以写到指定外部目录。AW CLI 负责机器事实；通用 Reviewer 负责语义质量；本 Skill 负责 AW-specific scope、证据绑定和 owner。

## 依赖

- 单个 leaf Skill 使用 `review-agent-skill`；
- workflow/portfolio 使用 `review-agent-architecture`；
- 大型 Agent-facing 内容使用 `agent-content`；
- Eval Oracle 或异常结果使用 `audit-agent-skill-evals`。

## 入口

1. 从本 Skill 实际 root 运行 `aw self check --from <skill-root> --json`；失败即停止。
2. 按 `references/aw-review-routing.md` 固定 Workspace 和 scope：plugin、catalog、workflow 或 portfolio。
3. 用 `aw review inspect <target> --json` 取得 source、manifest、inventory、dependencies、profiles、materialized target、snapshot 和 digest；已有来源绑定时传 `--materialization <receipt>`。该入口不执行被审插件代码。`plugin validate` 可能运行 renderer fixture，`plugin status` 可能准备 bundle，不能用于本次只读取证。

## Scope 路由

| Scope | 读取/使用 |
| --- | --- |
| 单 Plugin | `references/plugin-review.md`；必要 leaf 使用 `review-agent-skill` |
| Catalog composition | `references/catalog-review.md` |
| 跨 Plugin workflow | `references/workflow-review.md` + `review-agent-architecture` workflow |
| 插件/Skill 公开能力组合 | `references/portfolio-review.md` + `review-agent-architecture` portfolio |
| Eval 证据影响结论 | `audit-agent-skill-evals` |

相同 production digest 且影响判断的 profile/权限/适用规范相同时可复用 leaf 内容 Review；profile 适配仍逐项检查，不能只按 digest 丢掉环境差异。普通 Review 不要求 materialization receipt；`requiredFinalMissing` 只记为 evidence gap，继续评价可见 source，明确 final 未验证。

完整 profile/final 审核或 Release Check 要求所需 final 均有当前可验证证据。缺项时暂不作完整结论，由独立的 `develop-aw` 阶段补齐；仅在已有授权未覆盖 preparation/materialization 时请求授权。随后通过 `--materialization` 只读消费返回的 `sourceBindingPath`。

## 普通 Review 输出

返回机器错误、scope、design、complexity、必要 findings、source/materialized 差异、最多 3 项高价值改进、关键 unknown 和停止条件；可参考 `assets/human-report-template.md`。默认只有人类报告，不生成通用 JSON、分数 artifact 或 release readiness。

## 独立 Release Check

用户明确要求时才读取 `references/release-check.md`，使用本 Skill 的 `scripts/check-aw-release.mjs`。环境不支持所需公开能力时返回缺口，不自制 ready=true。

兼容 consumer 明确要求时，按 `assets/aw-review-evidence.schema.json` 为每个 required subject 分别绑定质量结论与证据，并验证 required Eval 链；格式属于 AW consumer，不加入通用 Reviewer 默认输出。

普通人读报告不承诺发布资格。机器 checker 的结论也不授权 publication。

## 可选报告归档

默认只在聊天中交付。用户明确要求把本次顶层 AW Review 归档时，读取 `references/report-publication.md`，核对该归档入口的执行范围；leaf Reviewer 只返回材料，不单独归档。

## 边界

- 不修改 source、materialized、Eval 或报告对象；
- 普通评审不运行 Catalog/Plugin build/test/mutation/publish；显式报告归档按上述独立边界处理；
- 不把 leaf finding 改写为 Catalog owner；
- 不把局部 pass 合成为全局 pass；
