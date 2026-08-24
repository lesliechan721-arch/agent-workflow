---
name: review-aw-plugin
description: >-
  当用户要只读审核一个 AW 插件源码、其内部组件或 materialized Skill 时使用。负责单个插件的 manifest、组件组合、共享脚本、build/materialization、profile 差异和按 digest 去重的 leaf Skill Review；不修改插件，不评审跨多个插件的完整工作流，不输出发布资格。
compatibility: 需要 Node.js 22+、提供 `aw plugin validate` 的已安装 AW CLI、agent-content-toolkit >= 0.1.0 和 agent-skill-toolkit >= 0.1.0。
user-invocable: true
metadata:
  short-description: 只读评审一个 AW 插件及其 materialized profiles
---

# Review AW Plugin

只评审一个 `.agents-plugin/plugin.json` 所定义的插件。

## 依赖

- `review-agent-skill`：按唯一 production digest 评审插件内 leaf Skill。
- `review-agent-content`：按需评审大型或多分支 Agent-facing 内容。

## 普通 Review

1. 定位插件根和实际 Skill 根，运行 `aw plugin validate <plugin-root>`。
2. 发现 source 和调用方提供的 materialized targets：

   ```bash
   node scripts/discover-aw-review-targets.mjs <plugin-root> \
     [--final <profile=path>]... \
     [--output-root <handoff-root>] \
     --format json
   ```

3. 读取 `references/plugin-composition-review.md`，评审 manifest/source truth、组件职责、共享脚本、build/materialization、profile 差异和插件依赖。插件 common path 由本 Skill 判断，不把插件包装成 `review-agent-skill` 的 target level。
4. 只有需要具体定位、source/final 内容不同或用户要求逐 Skill 结论时，才按 `uniqueReviews[]` 使用 `review-agent-skill`；相同 digest 最多评审一次。
5. 大型 reference 可按需使用 `review-agent-content`。
6. 输出 AW 机器错误、插件级 design/complexity、必要 leaf findings、真实 source/final 差异、最多 3 个高价值改进和关键 unknown。

没有 materialized final 时，只评价当前可见 source 和插件组合质量；不声明 release readiness。跨多个插件共同完成一个用户结果时，不给完整结论。

## 发布检查

用户明确要求发布准备状态时，才运行确定性 release checker：

```bash
node scripts/check-aw-plugin-release.mjs <plugin-root> \
  --review <review.json> \
  --final <profile=path> \
  [--preflight-audit <audit.json>] \
  [--run-bundle <bundle.json>] \
  [--triage-audit <audit.json>]
```

发布只接受 full、coverage 100%、总体 confidence 为 medium/high 且 effective design 为 pass 的 ReviewResultLite v2。声明 required Eval 的目标必须按 production digest 提供 Audit v3 preflight、RunBundle v3 和 Audit v3 result-triage 三段链；Review 内的 `evalEvidence` 不作为发布事实。相同 production digest 可以共享一条证据链。发布机器事实不进入普通 Review common path。

## 边界

- 不修改 Skill、Eval case、README、manifest 或 materialized final。
- 不生成 `AWReviewTargetPlan`、`ReviewInputBundle` 或 `AWReviewSummary`。
- 不评审跨多个 AW 插件的完整用户工作流。
