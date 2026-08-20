---
name: review-aw-plugin
description: >-
  当用户要只读审核一个 AW 插件根、materialized final artifacts、Eval evidence 或工作区发布就绪性时使用。目标根由 `.agents-plugin/plugin.json` 标识，可以位于任意兼容工作区；负责证据准备、通用 Reviewer 组合和报告发布适配，不评审普通 repo-local Skill，也不修改插件生产源码。
compatibility: Requires Node.js 22+, target workspace dependencies, agent-content-toolkit >= 0.4.0 and agent-skill-toolkit >= 0.4.0. Real model Eval optionally uses agent-skill-eval-runner >= 0.1.0.
user-invocable: true
metadata:
  short-description: 只读评审 AW 插件源码、最终制品与 Eval 证据
---

# Review AW Plugin

本 Skill 准备 AW 插件证据并组合通用 Reviewer；不维护通用量表，不处理普通 repo-local Skill，也不修改生产源码。

## 依赖 Gate

必须能使用 `review-agent-skill`、`audit-agent-skill-evals`、`review-agent-content`。缺失时停止。真实模型 Eval 只有在显式 runner 可用和用户授权时执行；缺少 runner 只降低证据等级。

## 工作流

1. 运行 `node scripts/prepare-aw-review-bundle.mjs <plugin-root> --repo-root <workspace-root> [options]`；再用 `validate-review-input-bundle.mjs` 验证真实 stage 文件、digest、schema、producer 和 subject binding。
2. 运行 `prepare-aw-review-targets.mjs`，为每个 source Skill 生成 `aw-plugin-skill` target，为每个 materialized Skill/profile 生成 `materialized-skill` target。提供 plugin bundle 时，只携带 Skill digest 匹配的 audit、run result 和 stage；不得让模型自行配对。
3. Eval audit、reference audit、每个 source/final review 与 result triage 在材料非平凡时使用 fresh context；父级只消费结构化结果。
4. 有 Eval 时先运行 `audit-agent-skill-evals(preflight)`。用户授权且 runner 可用时生成 `EvalExecutionPlan` 并调用 `run-agent-skill-evals`；否则 `evalEvidenceLevel=structural`，release evidence provisional，不视为 Skill finding。
5. 对每个 target 分别调用 `review-agent-skill`；大型 reference 先由 `review-agent-content` 审计。
6. 使用 `inspect-aw-target.mjs <plugin-root> --repo-root <workspace-root>` 检查 manifest、source-final、profile、digest、currentness、权限与版本。
7. 聚合通用 ReviewResult 和项目 gate。正式报告发布需要明确授权；README/manifest 写入交给 `author-aw-plugin` 或工作区 release 工具。

## 边界

- 不修改生产 Skill、Eval case、README 或 plugin source。
- 普通 `.agents/skills/*` 直接使用通用 `review-agent-skill`；旧项目 publish/release、README 登记和 static batch/currentness 不迁移。
- 通用质量结论由 `review-agent-skill` 产生；本 Skill 只增加 AW 工作区证据和 gate。
