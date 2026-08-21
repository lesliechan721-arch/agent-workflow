---
name: review-aw-plugin
description: >-
  当用户要只读审核一个 AW 插件源码、materialized Skill 或发布准备状态时使用。负责 AW manifest/profile 的确定性检查、调用通用 review-agent-skill，并在显式发布检查时实时重算 profile coverage；不维护通用量表，不修改插件源码，不发布报告。
compatibility: 需要 Node.js 22+、agent-content-toolkit >= 0.5.0 和 agent-skill-toolkit >= 0.8.0。真实模型 Eval 可选使用 agent-skill-eval-runner >= 0.3.0。
user-invocable: true
metadata:
  short-description: 轻量只读评审 AW 插件并按需执行发布检查
---

# Review AW Plugin

本 Skill 是 AW 项目适配层。通用设计质量由 `review-agent-skill` 判断；AW 平台事实和发布资格由确定性工具计算。

## 普通 Review

1. 定位 `.agents-plugin/plugin.json` 和实际 `skills` 根。运行 `node scripts/inspect-aw-target.mjs <plugin-root> --repo-root <workspace-root>`，只把确定性错误作为机器阻断项。
2. 为每个 source Skill 运行通用 `review-agent-skill`。materialized final 已存在且内容不同于 source 时，再按唯一内容 digest 评审一次；相同 digest 复用设计结论。
3. 大型或多分支 reference 可以交给 fresh-context `review-agent-content`。有 Eval 时可以交给 `audit-agent-skill-evals`；不持久化 stageOwner、producer、independentContext 或 target plan。
4. 输出简洁人类报告：AW 机器错误、每个唯一 Skill digest 的设计结论、最多 3 个高价值改进和关键 unknowns。

普通 Review 不生成 `AWReviewTargetPlan`、`ReviewInputBundle` 或 `AWReviewSummary`，也不声明 release readiness。

## 发布检查

只有用户明确要求检查当前插件能否发布时，才准备所有目标 profile 的 materialized Skill，并运行：

```bash
node scripts/check-aw-plugin-release.mjs <plugin-root> \
  --review <review-result-lite.json> \
  --final <profile=materialized-root> \
  [--review <another-review.json>] \
  [--final <another-profile=materialized-root>] \
  --format json
```

发布检查器会实时：

- 从 manifest 推导全部支持 profile，或使用用户显式 `--profile` 范围；
- 对 source 和 final 重新运行 `check-agent-skill`；
- 按内容 digest 去重并绑定 `ReviewResultLite`；
- 拒绝缺失 final、缺失 review、机器检查失败或非 pass 的设计结论；
- 当 Eval manifest 把 suite 标为 `requiredForRelease` 时，要求 review 记录 executed/comparative 证据。

它直接输出 `ready` 和 reasons，不创建 target plan、coverage row、summary gate 或 evidence ID。可便宜重算的 profile、digest、closure 和 currentness 不持久化成模型 handoff。

## 边界

- 不修改 Skill、Eval case、README、manifest 或 materialized final。
- 普通 `.agents/skills/*` 直接使用通用 `review-agent-skill`。
- 旧 bundle/summary/target-plan 工具仅为历史报告兼容，不再属于默认 Skill 工作流；不要为新需求扩展旧合同。
- 正式发布、报告归档和 README 登记由工作区 release 工具负责。
