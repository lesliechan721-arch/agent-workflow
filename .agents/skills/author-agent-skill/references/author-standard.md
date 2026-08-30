# Agent Skill 作者标准

## `agent.pointer`

每个上下文指针同时说明目标材料与到达条件；同义词不冒充独立 branch。

- **action：** description 先表达用户意图；外部资源指针写明读取条件。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.information-hierarchy`

将内容放在 in-file step、in-file reference、disclosed reference、script、asset 或 environment lookup 的正确层级。

- **action：** 主 SKILL.md 只保留所有命中 branch 都需要的工作流和 gotcha。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.completion-boundary`

关键步骤以清晰、可检查且要求充分的完成条件结束。

- **action：** 只为脆弱或必须持续跟踪的关键步骤设置完成门。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.minimum-control`

控制强度匹配任务脆弱性；多种方案合理时保留模型判断空间。

- **action：** 默认改进顺序为 delete → relax → move → rewrite → add。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.source-of-truth`

环境、schema、配置、目录和 --help 是事实源；文档只缓存理由、约定和非显然 gotcha。

- **action：** 工具 schema 已给出的字段细节不在 Skill 中维护第二份文档。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.co-location`

同一概念的定义、规则和 caveat 位于一个权威位置；区分 duplication 与 scattering。

- **action：** 共享规则只维护一个 source，并生成动作视图。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

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

一个 Agent Skill 应承接一个可独立解释和触发的工作单元；单 Skill 内部的独立意图、权限或证据生命周期不得靠更多分支维持。可复用 standalone/leaf 不反向依赖已知 caller 的目录、生命周期、阶段、状态名或后续能力；caller 或 orchestrator 负责适配这些上下文。

- **action：** 标明 standalone、leaf 或 orchestrator，枚举直接消费者、caller-specific 假设、用户意图、权限和证据生命周期；把 caller 拥有的目录、阶段、状态和后续能力保留在 caller、adapter 或 orchestrator。
- **completion：** 可复用 standalone/leaf 在不加载 caller 或 orchestrator 时仍能完成自己的直接用户意图；每个保留 branch 不能独立成为另一个 Skill，或拆分已有清晰 handoff。

Evidence: heuristic; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `skill.output-boundary`

固定输出字段或机器结构只用于真实 consumer boundary；同一 Agent 在同一上下文连续使用多个 Skill 不自动形成该边界。

- **action：** 增加固定输出前，记录 consumer、边界类型、持久性、validation owner 和缺少合同时的具体失败；没有真实 consumer 时改用语义完成条件或简短人类摘要。
- **completion：** 每个固定字段都会改变 parser、持久 artifact、独立 actor 或明确人类决策者的行为；否则删除或放宽，且不新增 schema 或 validator。

Evidence: normative; sources: agent-skill-toolkit.output-boundary

## `skill.package-resources`

scripts、references、assets 和 evals 按真实用途存在；缺省不是缺陷。

- **action：** 重复、确定、可测试逻辑进入 script；特定 branch 资料进入 focused reference。
- **completion：** 所有资源一层可达并有明确读取或执行条件。

Evidence: official-guidance; sources: agent-skills.best-practices, agent-skills.using-scripts
