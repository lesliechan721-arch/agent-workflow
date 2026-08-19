# Agent Skill 作者标准

> GENERATED from canonical content rules plus `standards/skill-rules.json`; do not edit manually.

## `agent.pointer`

每个上下文指针同时说明目标材料与到达条件；同义词不冒充独立 branch。

- **action：** description 先表达用户意图；外部资源指针写明读取条件。

Evidence: official-guidance; sources: agent-skills.best-practices, writing-for-agents

## `agent.information-hierarchy`

将内容放在 in-file step、in-file reference、disclosed reference、script、asset 或 environment lookup 的正确层级。

- **action：** 主 SKILL.md 只保留所有命中 branch 都需要的工作流和 gotcha。

Evidence: official-guidance; sources: agent-skills.best-practices, writing-for-agents

## `agent.completion-boundary`

关键步骤以清晰、可检查且要求充分的完成条件结束。

- **action：** 只为脆弱或必须持续跟踪的关键步骤设置完成门。

Evidence: official-guidance; sources: agent-skills.best-practices, writing-for-agents

## `agent.minimum-control`

控制强度匹配任务脆弱性；多种方案合理时保留模型判断空间。

- **action：** 默认改进顺序为 delete → relax → move → rewrite → add。

Evidence: official-guidance; sources: agent-skills.best-practices, writing-for-agents

## `agent.source-of-truth`

环境、schema、配置、目录和 --help 是事实源；文档只缓存理由、约定和非显然 gotcha。

- **action：** 工具 schema 已给出的字段细节不在 Skill 中维护第二份文档。

Evidence: official-guidance; sources: agent-skills.best-practices, writing-for-agents

## `agent.co-location`

同一概念的定义、规则和 caveat 位于一个权威位置；区分 duplication 与 scattering。

- **action：** 共享规则只维护一个 source，并生成动作视图。

Evidence: official-guidance; sources: agent-skills.best-practices, writing-for-agents

## `skill.problem-value`

Skill 必须解决可观察的真实问题，并相较无 Skill 或最小 Skill 产生增量价值。

- **action：** 先写 SkillDesignBrief：真实任务、失败、baseline gap、成功指标和范围外事项。
- **completion：** 无法证明增量时使用更简单能力或不创建 Skill。

Evidence: official-guidance; sources: agent-skills.best-practices

## `skill.invocation-trigger`

调用方式和 description 是设计输入；触发覆盖真实用户意图并排除高价值 near-miss。

- **action：** 先决定 model/manual 等调用意图，再写 discovery description。
- **completion：** description 与 invocation metadata 一致。

Evidence: official-guidance; sources: agent-skills.optimizing-descriptions

## `skill.composition-fitness`

一个 Skill 应拥有一个可独立解释和触发的工作单元；独立意图、权限、证据生命周期和环境 profile 不应被局部正确性掩盖。

- **action：** 枚举 independent intents、permission modes、evidence lifecycles、environment profiles、clean-context phases 和 stable handoffs。
- **completion：** 拆分或保留决定有明确理由和 artifact contract。

Evidence: heuristic; sources: agent-skills.best-practices, writing-for-agents

## `skill.package-resources`

scripts、references、assets 和 evals 按真实用途存在；缺省不是缺陷。

- **action：** 重复、确定、可测试逻辑进入 script；特定 branch 资料进入 focused reference。
- **completion：** 所有资源一层可达并有明确读取或执行条件。

Evidence: official-guidance; sources: agent-skills.best-practices, agent-skills.using-scripts
