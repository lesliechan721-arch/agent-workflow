---
name: review-aw-plugin
description: >-
  当用户要只读审核一个 AW 插件源码、其内部组件或 materialized Skill 时使用。负责单个插件的 manifest、组件组合、共享脚本、build/materialization、profile 差异和按 digest 去重的 leaf Skill Review；不修改插件，不评审跨多个插件的完整工作流，不输出发布资格。
compatibility: 需要 Node.js 22+、提供 `aw plugin validate` 的已安装 AW CLI、agent-content-toolkit 和 agent-skill-toolkit。
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

1. 由调用方显式给出非 Git workspace 根。不得从 cwd 或 Git 推断 workspace。
2. 发现 source 和调用方提供的 materialized targets。发现器先固定运行 PATH 上的 `aw plugin validate <plugin-root> --workspace-root <workspace-root> --json`；失败时停止，不读取 manifest 派生的 collection：

   ```bash
   node scripts/discover-aw-review-targets.mjs <plugin-root> \
     --workspace-root <workspace-root> \
     [--final <profile=path>]... \
     [--output-root <handoff-root>] \
     --format json
   ```

3. 读取 `references/plugin-composition-review.md`，评审 manifest/source truth、组件职责、共享脚本、build/materialization、profile 差异和插件依赖。插件 common path 由本 Skill 判断，不把插件包装成 `review-agent-skill` 的 target level。
4. 只有需要具体定位、source/final 内容不同或用户要求逐 Skill 结论时，才按 `uniqueReviews[]` 使用 `review-agent-skill`；相同 digest 最多评审一次。
5. 大型 reference 可按需使用 `review-agent-content`。
6. 输出 AW 机器错误、插件级 design/complexity、必要 leaf findings、真实 source/final 差异、最多 3 个高价值改进和关键 unknown。

leaf inventory 为空的条件是：合法 manifest 未声明 `skills`，且 `artifacts.targets` 也没有 `codex.skill` 或 `claude.skill`。此时仍评审插件级 composition target。动态 Skill 按 manifest 的 `skillKey`、platform 和 scopes 绑定对应 materialized final，不虚构 source Skill leaf。没有 materialized final 时，只评价当前可见 source 和插件组合质量；不声明 release readiness。跨多个插件共同完成一个用户结果时，不给完整结论。

## 独立 Release Check

用户明确要求 Release Check 时，才运行确定性 checker：

```bash
node scripts/check-aw-plugin-release.mjs <plugin-root> \
  --workspace-root <workspace-root> \
  [--review <review.json>]... \
  --final <profile=path> \
  [--preflight-audit <audit.json>] \
  [--run-bundle <bundle.json>] \
  [--triage-audit <audit.json>]
```

输出为独立 `release-check.json`。它拥有机器 readiness，不能写回 Quality Review；QualityReviewResult 不声明 Eval 证据等级。相同 production digest 可以共享一条证据链。Release Check 不进入普通 Review common path，也不是 Review mode。

release checker 只调用 `PATH` 上已安装的 `aw`，并只执行自身 bundle 内固定的普通文件脚本；不得使用环境变量替换 checker/validator，也不得从被评审项目发现或执行 CLI JavaScript。

## 可选报告归档

默认只在聊天中交付。用户明确要求归档且本 Skill 是本次请求的顶层 Reviewer 时，读取 [Review Publication](references/review-publication.md)；leaf Reviewer 只返回材料，不归档。

## 边界

- 不修改 Skill、Eval case、README、manifest 或 materialized final。
- 不生成旧版结构化 handoff 或旧版插件摘要。
- 不评审跨多个 AW 插件的完整用户工作流。
