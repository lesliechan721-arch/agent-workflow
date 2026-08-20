# Agent-facing 内容评审标准

> GENERATED from `standards/rules.json`; do not edit manually.

## `agent.pointer`

每个上下文指针同时说明目标材料与到达条件；同义词不冒充独立 branch。

- **check：** 检查弱指针、重复 branch 和必须内容是否被错误隐藏。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.information-hierarchy`

将内容放在 in-file step、in-file reference、disclosed reference、script、asset 或 environment lookup 的正确层级。

- **check：** 检查 sprawl、错误内联、过度披露和伪渐进式披露。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.completion-boundary`

关键步骤以清晰、可检查且要求充分的完成条件结束。

- **check：** 先判断步骤是否必要，再评价完成边界。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.minimum-control`

控制强度匹配任务脆弱性；多种方案合理时保留模型判断空间。

- **check：** 对正确但过重的规则使用 relax、move、delete 或 needs-ablation。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.source-of-truth`

环境、schema、配置、目录和 --help 是事实源；文档只缓存理由、约定和非显然 gotcha。

- **check：** 检查缓存、过期事实和无效 source map。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `agent.co-location`

同一概念的定义、规则和 caveat 位于一个权威位置；区分 duplication 与 scattering。

- **check：** 识别重复、散落和互相矛盾的权威来源。

Evidence: official-guidance; sources: agent-skills.best-practices; heuristic lenses: writing-for-agents

## `review.evidence-admission`

设计建议、已证实缺陷和未知项必须分开；claim 不得强于直接证据。

- **check：** 缺少行为证据时，不把可读性偏好或推演升级成阻断项。

Evidence: normative; sources: agent-content-toolkit.review-contract
