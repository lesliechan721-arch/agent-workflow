# Agent Skill 评审标准

> GENERATED from canonical content rules plus `standards/skill-rules.json`; do not edit manually.

## `agent.pointer`

每个上下文指针同时说明目标材料与到达条件；同义词不冒充独立 branch。

- **check：** 检查 description、resource pointer 与实际 branch 是否一致。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.information-hierarchy`

将内容放在 in-file step、in-file reference、disclosed reference、script、asset 或 environment lookup 的正确层级。

- **check：** 审计 active path，而非只看包总大小。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.completion-boundary`

关键步骤以清晰、可检查且要求充分的完成条件结束。

- **check：** 不得用更完整的完成条件挽救本应删除的步骤。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.minimum-control`

控制强度匹配任务脆弱性；多种方案合理时保留模型判断空间。

- **check：** 最小控制覆盖该 Skill 的正文、直接资源和必要机器合同；不把跨插件或跨工作流状态纳入单 Skill Review。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.source-of-truth`

环境、schema、配置、目录和 --help 是事实源；文档只缓存理由、约定和非显然 gotcha。

- **check：** 区分领域策略、可重算机器事实与必须持久化的昂贵证据。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.co-location`

同一概念的定义、规则和 caveat 位于一个权威位置；区分 duplication 与 scattering。

- **check：** 不因物理拆文件或拆 Skill 就默认认为渐进式披露及组合设计成立。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `review.evidence-admission`

设计建议、已证实缺陷和未知项必须分开；claim 不得强于直接证据。

- **check：** 区分 observed、normative、structural、official-guidance、heuristic 和 inferred；推演不伪装成直接矛盾。

Evidence: normative; sources: agent-content-toolkit.review-contract

## `skill.problem-value`

Skill 必须解决可观察的真实问题，并相较无 Skill 或最小 Skill 产生增量价值。

- **check：** 区分真实项目知识与模型已知的泛化常识。

Evidence: official-guidance; sources: agent-skills.best-practices

## `skill.invocation-trigger`

调用方式和 description 是设计输入；触发覆盖真实用户意图并排除高价值 near-miss。

- **check：** 分别评价触发召回、误触发代价和相邻 Skill 竞争。

Evidence: official-guidance; sources: agent-skills.optimizing-descriptions

## `skill.composition-fitness`

一个 Agent Skill 应承接一个可独立解释和触发的工作单元；单 Skill 内部的独立意图、权限或证据生命周期不得靠更多分支维持。

- **check：** 只评价当前 Skill 内部 composition；跨多个 Skill、插件或 runner 的 common path 交给 workflow Reviewer。

Evidence: heuristic; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `skill.package-resources`

scripts、references、assets 和 evals 按真实用途存在；缺省不是缺陷。

- **check：** 逐 reference 审计必要性、职责、branch locality、active-path load 和替代位置。

Evidence: official-guidance; sources: agent-skills.best-practices, agent-skills.using-scripts
