---
name: review-aw-plugin
description: >-
  仅当用户显式要求只读审核 agent-workflows 项目中的 plugins/<name>/ 插件、repo-local Skill、materialized final artifacts、Eval evidence 或发布就绪性时使用。负责项目证据准备、通用 Reviewer 组合和报告发布适配；不修改生产源码。
compatibility: >-
  Requires the agent-workflows repository, Node.js 22+, installed workspace dependencies, and a manually installed agent-content-toolkit >= 0.1.0.
disable-model-invocation: true
user-invocable: true
metadata:
  short-description: 只读评审 AW 插件源码、最终制品与 Eval 证据
---

# Review AW Plugin

本 Skill 是项目评审适配器。它准备 AW 证据并组合通用 Reviewer；不维护通用量表，也不修改插件源码。

## 依赖 Gate

必须能使用：

- `review-agent-skill`
- `audit-agent-skill-evals`
- `review-agent-content`（大型 reference / prompt 分支）

缺失时停止，不回退到内置简化量表。
人工安装是唯一依赖保证；manifest 不声明 plugin dependency。Agent 根据当前可用 Skill 判断能力是否存在。

## 模式

- `quick`：项目静态证据和用户关注点。
- `full`：完整项目证据 + 通用 full review。
- `delta`：旧 finding、source/final delta 和直接回归。
- `release`：full + current materialization / Eval evidence；正式写报告仍需授权。

## 工作流

1. **准备 ReviewInputBundle**
   - 区分 source、materialized final artifacts、profiles、Eval manifest/results、historical reports 和项目约束。
   - 运行 `node scripts/prepare-aw-review-bundle.mjs <plugin-root> [options]`。用 `--source name=path` 加入 batch 的全部 participant 插件；有 Eval audit 时必须同时传入实际 `--eval-case`，绑定 corpus digest。
   - 按 `assets/review-input-bundle.schema.json` 校验结果。规则见 `references/aw-review-bundle.md`。

2. **阶段隔离**
   - AW adapter 是项目组合流程的唯一 owner，输出 `ReviewInputBundle.orchestration.stageOwner=caller`。
   - 通用 Reviewer 只消费 `providedStages`；不得重复调度已完成的 Eval、reference 或 profile 阶段。
   - Eval case audit、reference/content audit、source Skill review、不同 final profile review 和 result triage 在材料非平凡时分别启动 fresh-context 子代理。
   - 具体子代理参数和生命周期由当前 Codex 或 Claude runtime 决定；本 Skill 只规定阶段输入输出，不实现调度器。
   - 父级 synthesis 不重新读取所有原始 case、reference 和 trace。
   - simple quick 只有在单一 Skill、无 Eval、无 materialized profile、无发布动作时可以在当前上下文完成。
   - 子代理结果按对应 schema 校验；无效时允许同一子代理修正一次，第二次失败则把阶段标为 blocked。

3. **Eval preflight**
   - 有 Eval 时，先运行 `audit-agent-skill-evals(preflight)`。
   - `validity=fail`：停止 release-relevant Eval；先修 suite。
   - `validity=unknown`：可继续静态 review，但 Eval 不进入发布门禁。

4. **通用 Skill Review**
   - 对每个 source Skill 和 required final Skill 分别调用 `review-agent-skill`。
   - 大型 Agent-facing reference 可先由 `review-agent-content` 产生 `ReferenceAudit`。
   - 通用 Reviewer 不接触 AW 发布路径和 CLI 权限细节。

5. **项目专有核验**
   - 检查 manifest、renderer/config、source-final 一致性、profile、digest、currentness 和项目权限。
   - 使用 `node scripts/inspect-aw-target.mjs <target> --repo-root <repo-root>` 做确定性检查。
   - 见 `references/aw-review-profile.md`。

6. **运行与结果 triage**
   - 用户授权且 Eval preflight 通过时，项目 CLI/harness 可运行 materialization 或真实模型 Eval。
   - 运行后由独立 `audit-agent-skill-evals(result-triage)` 解释失败；不把每个 failure 自动归因给 Skill。
   - 运行合同见 `references/aw-eval-runtime.md`。
   - 仓库 `.agents/skills/<name>` 的静态 Eval 使用 `scripts/run-static-skill-evals.mjs <target> --repo-root <repo-root>`；插件 Skill 使用 `pnpm plugin:eval`。
   - v1 真实模型证据只覆盖 Codex。Claude 只做确定性验证和 materialization。

7. **综合与发布**
   - 先运行 `node scripts/validate-review-result.mjs <review-result.json> --format json`。
   - 合并已校验的通用 `ReviewResult` 与项目 gate，输出 AW summary，并运行 `node scripts/validate-aw-review-summary.mjs <summary.json> --format json`。
   - 正式报告发布与批次封存是一个原子动作，需要明确授权；README 登记需要第二次授权。见 `references/aw-report-publication.md`。
   - 未获授权时只在会话返回或保存临时草稿。

## 设计边界

- `review-aw-plugin` 不修改生产 Skill、Eval case 或 plugin source；用户第二次明确授权的 Skill README 登记是唯一例外。
- `author-aw-plugin` 的自检不能替代本 Skill。
- 通用质量结论由 `review-agent-skill` 产生；当前 Skill 只增加 AW 项目 gate 和 evidence currentness。
