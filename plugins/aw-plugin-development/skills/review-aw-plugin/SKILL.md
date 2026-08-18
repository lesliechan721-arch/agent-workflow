---
name: review-aw-plugin
description: >-
  仅当用户显式要求只读审核 agent-workflows 项目中的 plugins/<name>/ 插件、materialized final artifacts、Eval evidence 或发布就绪性时使用。负责项目证据准备、通用 Reviewer 组合和正式报告发布适配；不评审 repo-local Skill，也不修改插件生产源码。
compatibility: >-
  Requires the agent-workflows repository, Node.js 22+, installed workspace dependencies, agent-content-toolkit >= 0.2.0, and agent-skill-toolkit >= 0.1.0.
disable-model-invocation: true
user-invocable: true
metadata:
  short-description: 只读评审 AW 插件源码、最终制品与 Eval 证据
---

# Review AW Plugin

本 Skill 是 AW 项目评审适配器。它准备插件证据并组合通用 Reviewer；不维护通用量表，不处理 repo-local Skill，也不修改插件生产源码。

## 依赖 Gate

必须能使用：

- `review-agent-skill`
- `audit-agent-skill-evals`
- `review-agent-content`（大型 reference / prompt 分支）

缺失时停止，不回退到内置简化量表。人工安装是当前依赖保证。

## 模式

- `quick`：项目静态证据和用户关注点。
- `full`：完整项目证据 + 通用 full review。
- `delta`：旧 finding、source/final delta 和直接回归。
- `release`：full + current materialization / Eval evidence；正式写报告仍需授权。

## 工作流

1. **准备 ReviewInputBundle**
   - 目标必须是 `plugins/<name>/` AW plugin root。
   - 区分 source、materialized final artifacts、profiles、Eval manifest/results、historical reports 和项目约束。
   - 运行 `node scripts/prepare-aw-review-bundle.mjs <plugin-root> [options]`。用 `--source name=path` 加入 batch 的全部 participant 插件；有 Eval audit 时同时传实际 `--eval-case` 绑定 corpus digest。
   - 按 `assets/review-input-bundle.schema.json` 校验结果。final artifact 只表示材料可用，不表示 `materialized-profile-review` 已完成。

2. **阶段隔离与完成记录**
   - AW adapter 是项目组合流程 owner，输出 `stageOwner=caller`。
   - Eval case audit、reference/content audit、source Skill review、不同 final profile review 和 result triage 在材料非平凡时分别使用 fresh-context 子代理或独立 session。
   - 只有阶段结果通过对应 schema、记录 producer、target digest、result path/digest 和 independent-context 证据后，才能加入 `providedStages`。
   - 父级 synthesis 不重新读取所有原始 case、reference 和 trace。
   - 具体子代理参数和生命周期由 runtime/harness 决定；无效结果允许原 producer 修正一次，再次失败则标为 blocked。

3. **Eval preflight**
   - 有 Eval 时先运行 `audit-agent-skill-evals(preflight)`。
   - `validity=fail`：停止 release-relevant Eval；先修 suite。
   - `validity=unknown`：可继续静态 review，但 Eval 不进入发布门禁。

4. **通用 Skill Review**
   - 对每个 source Skill 和 required final Skill 分别调用 `review-agent-skill`。
   - 大型 Agent-facing reference 可先由 `review-agent-content` 产生 `ReferenceAuditResult`。
   - 通用 Reviewer 不接触 AW 发布路径和 CLI 权限细节。

5. **项目专有核验**
   - 检查 manifest、renderer/config、source-final 一致性、profile、digest、currentness 和项目权限。
   - 使用 `node scripts/inspect-aw-target.mjs <plugin-root> --repo-root <repo-root>` 做确定性检查。
   - 见 `references/aw-review-profile.md`。

6. **运行与结果 triage**
   - 用户授权且 Eval preflight 通过时，项目 CLI/harness 可运行 materialization 或真实模型 Eval。
   - 运行后由独立 `audit-agent-skill-evals(result-triage)` 解释失败；不把每个 failure 自动归因给 Skill。
   - 插件 Skill 使用 `pnpm plugin:eval`。本适配器不再提供 repo-local static Skill runner。
   - 首版真实模型证据只覆盖 Codex；Claude 只做确定性验证和 materialization。

7. **综合与发布**
   - 校验通用 `ReviewResult`，合并项目 gate 后输出并校验 AW summary。
   - 正式报告发布与批次封存需要明确授权；发布只写 review artifact，不修改插件 production source。
   - README 登记或 manifest version 变化输出结构化 registration request，交给 `author-aw-plugin` 或项目 release 工具在独立写授权下执行。
   - 未获授权时只在会话返回或保存临时草稿。

## 设计边界

- `review-aw-plugin` 不修改生产 Skill、Eval case、README 或 plugin source。
- `author-aw-plugin` 的自检不能替代本 Skill。
- 通用质量结论由 `review-agent-skill` 产生；当前 Skill 只增加 AW 项目 gate、evidence currentness 和报告发布适配。
