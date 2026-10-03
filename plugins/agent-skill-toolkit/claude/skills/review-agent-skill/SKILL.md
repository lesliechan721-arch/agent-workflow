---
name: review-agent-skill
description: >-
  当用户明确要求只读审核一个可直接使用的 Agent Skill package、其修订版或可见源码设计时使用。检查真实价值、触发、职责、最小控制、信息层级、references、scripts、assets、结构化输出和已有 Eval 证据；不修改目标，不评审完整插件或跨 Skill 架构，不输出项目发布资格。
compatibility: 机器包检查使用当前环境可用的 Agent Skill validator；依赖 agent-content-toolkit。
metadata:
  short-description: 只读评审一个 Agent Skill 的设计、复杂度和证据
---

# Review Agent Skill

只评审一个 Skill package。

## 依赖与路由

- 大型或多分支 Agent-facing 内容使用 `agent-content`。
- 源 Eval case 的设计审核、正式准入或异常结果归因使用 `audit-agent-skill-evals`。
- 评审对象涵盖多个 Skill、完整插件、workflow 或 public surface 时使用 `review-agent-architecture`；本 Skill 不把 leaf 结果合成为全局 pass。

涉及调用属性/适用范围时读取 `references/skill-invocation.md`；涉及组合、caller/leaf、执行角色、独立上下文或固定输出时读取 `references/skill-composition.md`。

## 范围

- `quick`：默认；只检查用户问题和直接相关证据，最多 3 个主要问题。
- `full`：覆盖全部适用领域；用户要求评分时才使用数值维度。
- `delta`：只复核旧问题、受影响领域、直接回归和净复杂度。

## 流程

1. 固定用户决策、目标、成功标准、范围与判断所需证据（已知失败和关键 unknown），同时确认评审视图：完整包、已验证的平台产物，或仅源码设计。需要项目构建/注入的源目录由当前项目适配取得对应运行包；已有完整包可直接审核。未取得时只评价可见设计，并明确产物未验证。
2. 在实际完整包上检查 frontmatter、目录/name、relative references 和普通文件节点；源码及其 Eval 依各自合同检查。每条结论指明被审视图，机器错误只报告一次。
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

每条 finding 记录被审包/视图、位置、exact claim、affected scenario、证据、counterevidence、owner、最小行动和验证。运行包中的问题通过已知来源映射定位到源码、共享 provider 或构建规则；修改位置与发现位置分别说明。Owner 未确认时保留待定位。

## 输出

按 `assets/human-report-template.md` 输出：设计结论、复杂度、2–4 句判断、所有 critical/major、最多 3 项高价值改进、会改变结论的 unknown 和停止条件。空审计章节不输出。

用户指定报告文件时写入该位置。项目归档由相应调用方使用其归档能力完成；leaf 返回内容与证据。
