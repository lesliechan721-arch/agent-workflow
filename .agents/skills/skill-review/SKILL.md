---
name: skill-review
description: 当需要审核、评分、发布检查、比较或重构 Agent Skill 及其 SKILL.md、description、references、scripts、assets、evals、相关角色配置或当前 agent-workflows 项目的插件 Skill 时使用；评估调用与触发、范围、程序与完成边界、信息层级与渐进式披露、架构职责、脚本、资源、行为证据、安全和维护性，给出发布门禁、分数及最小改进集。不要用于普通代码或文档 review。
compatibility: Requires the agent-workflows repository, Node.js 20+, installed workspace dependencies, and current Agent Skills documentation access for release reviews.
metadata:
  short-description: 多维度、证据化、可计算的 Agent Skill 评审
---

# Skill Review

目标是判断 Skill 是否以最小、可验证、职责归属正确的机制解决真实问题，而不是让它覆盖所有理论边界。

## 评审模式

- **quick**：材料不完整或用户只要快速检查；报告已知问题和临时分数，不作发布通过结论。
- **full**：检查完整技能包；默认模式。
- **release**：在 full 基础上核对当前官方规范，安全验证可运行脚本，并要求 trigger、behavior 或等价发布证据。
- **delta**：有上一版时，只复核旧问题、受影响维度、直接回归、复杂度变化和新证据。

## 固定评审合同

先从用户材料提取：目标问题、真实失败、成功标准、适用环境、范围外事项、相邻 Skill 和发布要求。只评估已提供材料；缺失内容标为 `unknown`，并降低 coverage。

Finding 的证据类型使用：

- `observed`：trace、复现、测试或用户确认的失败。
- `normative`：官方规范、目标 runtime/schema、项目硬规则或用户明确要求。
- `structural`：被审包内可直接验证的断裂引用、无效配置、矛盾或不可执行关系。
- `heuristic`：第三方设计原则、可读性模式或经验性建议。
- `inferred`：尚未验证的未来风险或静态推演。

只有 `observed`、`normative` 或 `structural` 能单独支持 P0/P1；纯 `heuristic` 或 `inferred` 默认最多是 P2。

## 执行流程

1. 枚举 `SKILL.md`、一层可达资源、eval、相关角色和配置；记录缺失、不可达及重复来源。
2. 运行静态诊断：
   ```bash
   node scripts/inspect_skill_target.mjs <skill-dir-or-SKILL.md-or-plugin> --format json
   ```
   delta 模式增加 `--previous <old-SKILL.md>`；相关 TOML 用可重复的 `--related '<glob>'`。诊断是证据线索，不是自动 finding。
3. 计分前读取 `references/scoring-model.md`；full/release 再读取 `references/review-dimensions.md`。
4. 只在对应 branch 到达时读取：
   - Skill 包含异步状态、重试、跨 actor 协议、权限或复杂工具编排：`references/architecture-boundaries.md`
   - Skill 含脚本、references、assets，或反复重做确定性逻辑：`references/scripts-and-resources.md`
   - 有上一版或多轮修订：`references/delta-review.md`
   - release 模式或需要判断证据权威：`references/source-map.md`，并重新核对其中标记为 current-check 的官方来源。
   - 当前仓库静态 Skill 的 release 评审或用户明确要求真实 eval：读取 `references/static-skill-evaluation.md` 和 `evals/manifest.json`；先运行 `node scripts/run_static_skill_evals.mjs <skill-dir-or-name> --validate-only`。
   - 当前仓库的 AW 插件或动态 Skill：`references/agent-workflows-plugin.md`
5. 完成三项语义审计：
   - **Invocation/Pointer Audit**：description 和每个外部指针是否说明目标及真正不同的触发 branch。
   - **Information Hierarchy Map**：把内容分类为 in-file step、in-file reference、disclosed reference 或 environment lookup。
   - **Completion Boundary Audit**：关键步骤是否有清晰、可检查且覆盖充分的完成标准。
6. 填写 `assets/scorecard-template.json`，再运行：
   ```bash
   node scripts/validate_scorecard.mjs <scorecard.json> --format json
   ```
   使用脚本给出的权重、coverage、confidence 和 release verdict。
7. 按 `assets/report-template.md` 输出与当前模式匹配的章节；先给方向、门禁和分数，再给最小改进集。

## 评审完成边界

只有同时满足以下条件才结束评审：

- 所有适用维度都有分数、置信度和证据定位；无法评估的维度明确为 `unknown`。
- 所有发布门禁都被判定为 `pass`、`fail`、`unknown` 或 `not_applicable`。
- 每个 P0/P1 都包含证据类型、正确职责层、最小修改和验证方式。
- pointer、信息层级和完成边界审计已覆盖适用对象。
- 报告包含 stop decision，且没有未归属或重复计罚的 finding。

## 评分纪律

- 同一根因只在一个主维度扣分；其它维度只说明影响。
- scripts、references 或 assets 正确省略时可以高分；文件数量不是质量指标。
- 优先删除、替换、合并或改用环境事实源；新增自然语言条件必须有行为或规范证据。
- Tool/schema 已直接提供的事实不在 Skill 中维护缓存，除非 Skill 需要记录稳定选择、理由或非显然 gotcha。
- Skill 以自然语言维护计时、额度、pending、跨 actor 握手、乱序事件或取消/关闭竞态时，先判定职责归属，再决定是否修改文本。
- 第三方写作启发只能形成 heuristic finding；不得冒充 Agent Skills 官方规范。

## 停止条件

当评审合同清楚、核心行为已有验证方案、没有证据支持的 P0/P1，且继续修改只会增加 context、状态或维护负担时，给出通过或带 advisory 通过并停止。delta 模式没有新 `observed`、`normative` 或 `structural` 证据时，不扩张新的发布阻断项。
