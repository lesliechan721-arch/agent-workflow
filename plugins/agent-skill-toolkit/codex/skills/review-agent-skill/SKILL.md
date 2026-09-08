---
name: review-agent-skill
description: >-
  当用户明确要求只读审核一个已有 Agent Skill package 或修订版时使用。检查真实价值、触发、职责、最小控制、信息层级、references、scripts、assets、结构化输出和已有 Eval 证据；不修改目标，不评审完整插件或跨 Skill 架构，不输出项目发布资格。
compatibility: 机器包检查使用当前环境可用的 Agent Skill validator；依赖 agent-content-toolkit。
metadata:
  short-description: 只读评审一个 Agent Skill 的设计、复杂度和证据
---

# Review Agent Skill

只评审一个 Skill package。

## 依赖与路由

- 大型或多分支 Agent-facing 内容使用 `agent-content`。
- 源 Eval case 的设计审核、正式准入或异常结果归因使用 `audit-agent-skill-evals`。
- 多个 Skill、完整插件、workflow 或 public surface 使用 `review-agent-architecture`；本 Skill 不把 leaf 结果合成为全局 pass。

涉及调用属性/触发时读取 `references/skill-invocation.md`；涉及组合、caller/leaf 或固定输出时读取 `references/skill-composition.md`。

## 范围

- `quick`：默认；只检查用户问题和直接相关证据，最多 3 个主要问题。
- `full`：覆盖全部适用领域；用户要求评分时才使用数值维度。
- `delta`：只复核旧问题、受影响领域、直接回归和净复杂度。

## 流程

1. 固定目标、用户决策、真实失败、成功标准、范围外和关键 unknown。
2. 使用当前可用 validator 检查 frontmatter、目录/name、relative references、普通文件节点和 Eval JSON；机器错误只报告一次。
3. 读取 `references/review-standard.md`，按当前范围检查：problem value、description、public/manual invocation、Skill-to-Skill、composition、minimum control、references、scripts、assets、Consumer Boundary、Eval 证据和 change discipline。
4. 必要证据缺失时将对应结论标为 `not-assessed` 或 unknown；quick/delta 不计算总分。full 依评分参考区分结构证据与行为效果，只有适用维度都能评价且用户要求时才计算分数，且缺少运行证据不自动成为生产 Skill 缺陷。
5. 准备 critical/major finding 或 evidence 类型有争议时读取 `references/evidence-and-severity.md`。Exact claim 不得强于证据；有重要未证实前提的跨文件推演、运行时状态或可能共载最高为 minor/advisory/unknown；直接证据成立的跨文件冲突仍可按影响定级。
6. full 需要数值评分时读取 `references/review-dimensions.md`；分数只用于定位弱项，不能覆盖 finding 证据或项目 release gate。
7. 静态证据不足且新运行会实质改变用户决策时，可在用户允许成本、Skill/corpus 已固定且兼容 Runner 可用的前提下使用公开 Runner；由 Runner 复用与当前输入绑定的有效 Audit，或取得独立 preflight；不在 Review 和 Runner 重复审核同一绑定，异常或回归结果先 triage。没有这些条件时只报告 evidence gap。
8. 按需输出人类可读报告。

## Finding 纪律

- `critical`：机器可证包/能力失败、安全越权或硬规范冲突。
- `major`：observed、normative 或直接 structural 证据证明目标场景会产生实质失败。
- `minor`：有限范围质量、维护或证据问题。
- `advisory`：official guidance、heuristic、未来风险或需实验验证的建议。

每条 finding 记录位置、exact claim、affected scenario、证据、counterevidence、owner、最小行动和验证。Owner 未证明是该 Skill 时，不建议修改其生产 SKILL.md。

## 输出

按 `assets/human-report-template.md` 输出：设计结论、复杂度、2–4 句判断、所有 critical/major、最多 3 项高价值改进、会改变结论的 unknown 和停止条件。空审计章节不输出。

用户明确要求归档且本 Skill 是本次顶层 Reviewer 时，读取 `references/report-publication.md`；leaf 只返回材料。
