---
name: review-aw-plugin
description: >-
  当用户要只读审核一个 AW 插件源码、materialized Skill 或发布准备状态时使用。负责 AW manifest/profile 的确定性检查、插件级 common path 评审、按 digest 去重的 Skill 评审和显式发布检查；不修改插件源码或发布报告。
compatibility: 需要 Node.js 22+、提供 `aw plugin validate` 的已安装 AW CLI、agent-content-toolkit >= 0.1.0 和 agent-skill-toolkit >= 0.1.0。
user-invocable: true
metadata:
  short-description: 轻量只读评审 AW 插件及其端到端组合
---

# Review AW Plugin

## 依赖

- `review-agent-skill`：评审插件和唯一 Skill digest 的设计质量。
- `review-agent-content`：按需审核大型或多分支 reference。
- `audit-agent-skill-evals`：审核 Eval Oracle 或归因运行结果。

## 普通 Review

1. 定位 `.agents-plugin/plugin.json` 和实际 Skill 根，运行 `aw plugin validate <plugin-root>`。
2. 发现 source 和调用方提供的 materialized targets：

   ```bash
   node scripts/discover-aw-review-targets.mjs <plugin-root> \
     [--final <profile=path>]... \
     [--output-root <handoff-root>] \
     --format json
   ```

   build-free 插件检查 source 和 final；声明 `scripts.node.build` 的插件至少需要一个真实 final。命令对 target 运行 `check-agent-skill` 并按 production digest 分组。
3. 先使用 `review-agent-skill` 按 `target_level=plugin` 评审完整 common path。只有需要定位具体 Skill、source/final 内容不同、用户要求逐 Skill 结论或显式发布绑定时，才按唯一 digest 做 leaf Review。
4. 大型 reference 按需使用 `review-agent-content`。需要新增昂贵 Eval 证据时，沿用 `review-agent-skill` 的审核门禁；适合隔离注意力时使用独立上下文子代理。
5. 输出 AW 机器错误、插件级设计与复杂度、必要 leaf findings、真实 source/final 差异、最多 3 个高价值改进和关键 unknown。

普通 Review 不声明 release readiness。

## 发布检查

用户明确要求检查发布准备状态时，准备目标 profile 的 materialized Skill，并运行：

```bash
node scripts/check-aw-plugin-release.mjs <plugin-root> \
  --review <review-result-lite.json> \
  --final <profile=materialized-root> \
  [--review <another-review.json>] \
  [--final <another-profile=materialized-root>] \
  --format json
```

检查器实时计算 profile coverage、machine check、digest 去重和 Review 绑定，直接输出 `ready` 与 reasons。

## 边界

- 不修改 Skill、Eval case、README、manifest 或 materialized final。
- 不生成 `AWReviewTargetPlan`、`ReviewInputBundle` 或 `AWReviewSummary`。
- 不扩展旧 bundle/summary/target-plan 兼容合同。
