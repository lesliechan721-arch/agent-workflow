---
name: review-aw-plugin
description: >-
  当用户要只读审核一个 AW 插件源码、materialized Skill 或发布准备状态时使用。负责 AW manifest/profile 的确定性检查、把完整插件 common path 交给通用 review-agent-skill，并按需用内容 digest 定位单个 Skill 差异；显式发布检查时实时重算 profile coverage。不维护通用量表，不修改插件源码，不发布报告。
compatibility: 需要 Node.js 22+、提供 `aw plugin validate` 的已安装 AW CLI、agent-content-toolkit >= 0.1.0 和 agent-skill-toolkit >= 0.1.0。真实模型 Eval 可选使用 agent-skill-eval-runner >= 0.1.0。
user-invocable: true
metadata:
  short-description: 轻量只读评审 AW 插件及其端到端组合
---

# Review AW Plugin

本 Skill 是 AW 项目适配层。通用设计质量由 `review-agent-skill` 判断；AW 平台事实和发布资格由确定性工具计算。

## 普通 Review

1. 定位 `.agents-plugin/plugin.json` 和实际 `skills` 根。确认 `aw --version` 和 `aw plugin validate --help`，再按当前 help 运行 `aw plugin validate <plugin-root>`；确定性错误直接作为机器阻断项。
2. 发现 source 和调用方显式提供的 materialized targets：

   ```bash
   node scripts/discover-aw-review-targets.mjs <plugin-root> \
     [--final <profile=path>]... \
     [--output-root <handoff-root>] \
     --format json
   ```

   build-free 插件会检查 source 和调用方提供的 final。声明 `scripts.node.build` 的插件必须至少提供一个真实 materialized final；raw source 不代表完整 runtime，因此只检查 final。该命令对每个实际 target 运行 `check-agent-skill`，按 production digest 分组，并输出一个 `pluginReview` 目标，绑定完整插件根、所有 Skill target、唯一 digest 和 materialized profile。相同 digest 不重复做 leaf 评审。
3. 先把 `pluginReview` 作为 `target_level=plugin` 交给通用 `review-agent-skill`。多 Skill、runner、schema、validator 或持久 handoff 的 full Review 必须执行 End-to-End Minimum Architecture Challenge，写出真实 common path 和同样安全的最小候选架构；不能用单个 Skill 的局部结论替代插件级设计与复杂度判断。
4. 只有以下情况才按 `uniqueReviews[]` 调用 leaf `review-agent-skill(target_level=skill)`：
   - plugin Review 需要定位到具体 Skill；
   - source/final digest 不同，需要分别判断真实内容差异；
   - 用户明确要求逐 Skill 结论；
   - 显式发布检查需要与每个 digest 绑定的 `ReviewResultLite`。

   共享 digest 最多做一次 leaf Review。大型或多分支 reference 可以交给 fresh-context `review-agent-content`；有 Eval 时可以交给 `audit-agent-skill-evals`。fresh context 只属于运行 trace，不持久化 stageOwner、producer 或 independentContext。
5. 输出简洁人类报告：AW 机器错误、插件级设计与复杂度结论、必要的 leaf findings、真实 source/final 差异、最多 3 个高价值改进和关键 unknowns。

普通 Review 不生成 `AWReviewTargetPlan`、`ReviewInputBundle` 或 `AWReviewSummary`，也不声明 release readiness。没有提供 materialized final 时，只评价当前可见 source 和插件组合质量。

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
- 按内容 digest 去重并绑定 leaf `ReviewResultLite`；
- 拒绝缺失 final、缺失 review、机器检查失败或非 pass 的设计结论；
- 当 Eval manifest 把 suite 标为 `requiredForRelease` 时，要求 review 记录 executed/comparative 证据。

它直接输出 `ready` 和 reasons，不创建 target plan、coverage row、summary gate 或 evidence ID。可便宜重算的 profile、digest、closure 和 currentness 不持久化成模型 handoff。插件级人类结论用于普通设计判断，不替代 release checker 对每个 materialized Skill digest 的绑定。

## 边界

- 不修改 Skill、Eval case、README、manifest 或 materialized final。
- 普通 `.agents/skills/*` 直接使用通用 `review-agent-skill`。
- 旧 bundle/summary/target-plan 工具仅为历史报告兼容，不再属于默认 Skill 工作流；不要为新需求扩展旧合同。
- 正式发布、报告归档和 README 登记由工作区 release 工具负责。
