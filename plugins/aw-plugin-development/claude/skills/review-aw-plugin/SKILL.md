---
name: review-aw-plugin
description: >-
  当用户要只读审核一个 AW 插件源码、其内部组件或 materialized Skill 时使用。负责单个插件的 manifest、组件组合、共享脚本、build/materialization、profile 差异和按 digest 去重的 leaf Skill Review；不修改插件，不评审跨多个插件的完整工作流，不输出发布资格。
compatibility: 需要 Node.js 22+、提供 `aw plugin validate` 的已安装 AW CLI、agent-content-toolkit 和 agent-skill-toolkit；Release Check 还需要 PATH 上兼容的 `aw-skill-eval`。
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

1. 从平台 Skill locator 或当前加载的 `SKILL.md` 确定本 Skill 的真实 `<skill-root>`，不从 cwd 推断。首次 AW 命令必须是 `aw self check --from <skill-root> --json`。命令不可用时停止并报告 `aw` 缺失；receipt 的 `ok` 为 false 时停止并精确报告其 `missingCapabilities`。
2. 依次从用户明确的 Workspace root、canonical `<root>/plugins/<name>` target、或上游 handoff 的 resolved root 确定 `<workspace-root>`，再把插件名或 path 解析为该 root 下的 canonical `<plugin-root>`。canonical target 和 handoff path 必须与所选 root 一致；多个 target 推导出不同 root、root 缺失或定位有歧义时停止并询问。后续 `plugin validate`、`plugin status` 和其它现有只读流程都传同一 `--workspace-root <workspace-root>`；不得增加 Catalog 命令。
3. 发现 source 和调用方提供的 materialized targets。发现器先运行 PATH 上的 `aw plugin validate <plugin-root> --workspace-root <workspace-root> --json`；失败时停止，不读取 manifest 派生的 collection：

   ```bash
   node scripts/discover-aw-review-targets.mjs <plugin-root> \
     --workspace-root <workspace-root> \
     [--final <profile=path>]... \
     [--output-root <handoff-root>] \
     --format json
   ```

4. 读取 `references/plugin-composition-review.md`，评审 manifest/source truth、组件职责、共享脚本、build/materialization、profile 差异和插件依赖。插件 common path 由本 Skill 判断，不把插件包装成 `review-agent-skill` 的 target level。
5. 只有需要具体定位、source/final 内容不同或用户要求逐 Skill 结论时，才按 `uniqueReviews[]` 使用 `review-agent-skill`；相同 digest 最多评审一次。
6. 大型 reference 可按需使用 `review-agent-content`。
7. 输出 AW 机器错误、插件级 design/complexity、必要 leaf findings、真实 source/final 差异、最多 3 个高价值改进和关键 unknown。

leaf inventory 为空的条件是：合法 manifest 未声明 `skills`，且 `artifacts.targets` 也没有 `codex.skill` 或 `claude.skill`。此时仍评审插件级 composition target。动态 Skill 按 manifest 的 `skillKey`、platform 和 scopes 绑定对应 materialized final，不虚构 source Skill leaf。没有 materialized final 时，只评价当前可见 source 和插件组合质量；不声明 release readiness。跨多个插件共同完成一个用户结果时，不给完整结论。

## 独立 Release Check

用户明确要求 Release Check 时，先准备 checker 的完整输入。对 leaf inventory 的每个唯一 production digest，使用 `review-agent-skill` 的 `full` 模式生成 `QualityReviewResult v1`；机器检查和 Quality Review validator 必须通过，validator 的 `effectiveDecision` 必须为 `pass`，coverage 必须为 100%，总体 confidence 必须为 medium 或 high。Review 必须精确覆盖这些 digest；重复、未匹配或未消费的 Review 都是输入错误。Quality Review 不声明 Eval 执行事实，也不拥有 Eval machine gate。

动态 Skill 还必须提供对应 platform×scope 的 materialized final。对每个 materialized target 和 Eval manifest 中适用的 release-required profile×suite，分别准备 exact 绑定的 `EvalSpec v1`、passing `EvalAudit v1` 和 `EvalResult v1`；不得合并多个 suite corpus。静态 Skill 只在其 Eval manifest 声明 release-required suite 时需要三件套。Reviewer 检查三件套、当前 manifest corpus、required case 的 minimum runs、完成状态、grade 通过率和 baseline 回归。缺少任一 required input 时停止并列出具体 profile/suite 缺口；不要先运行 checker，也不要把 Quality Review 内的 Eval 描述当作发布证据。需要新运行或失败诊断时读取 `references/aw-eval-runtime.md`。失败结果的 triage 不是 Release Check 输入或 machine gate；clean success 不需要 triage。

输入完整后运行确定性 checker：

```bash
node scripts/check-aw-plugin-release.mjs <plugin-root> \
  --workspace-root <workspace-root> \
  [--review <review.json>]... \
  --final <profile=path> \
  [--eval-spec <spec.json>]... \
  [--eval-audit <audit.json>]... \
  [--eval-result <result.json>]...
```

输出为独立 `release-check.json`。它拥有机器 readiness，不能写回 Quality Review。相同 production digest 的不同 required profile/suite 仍必须各有一条完整链。Release Check 不进入普通 Review common path，也不是 Review mode。

release checker 只调用 `PATH` 上已安装的 `aw`，并只执行自身 bundle 内固定的普通文件脚本；不得使用环境变量替换 checker/validator，也不得从被评审项目发现或执行 CLI JavaScript。

## 可选报告归档

默认只在聊天中交付。用户明确要求归档且本 Skill 是本次请求的顶层 Reviewer 时，读取 [Review Publication](references/review-publication.md)；leaf Reviewer 只返回材料，不归档。

## 边界

- 不修改 Skill、Eval case、README、manifest 或 materialized final。
- 不得运行任何 Catalog 命令，包括 mutation、build、status、validate 或 publish；也不得因 Review 运行 `plugin test` 或 `plugin build`。
- 不生成旧版结构化 handoff 或旧版插件摘要。
- 不评审跨多个 AW 插件的完整用户工作流。
