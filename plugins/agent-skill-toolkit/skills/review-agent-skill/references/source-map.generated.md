# Source map

Last reviewed: 2026-08-19.

## Portable specification

- https://agentskills.io/specification

## Official guidance

- https://agentskills.io/skill-creation/best-practices
- https://agentskills.io/skill-creation/optimizing-descriptions
- https://agentskills.io/skill-creation/using-scripts
- https://agentskills.io/skill-creation/evaluating-skills

## Project policy

- Agent Workflows review and eval contracts in this plugin.

## Third-party heuristic

- https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-for-agents

`rules.json` 中规则的 `evidenceType` 表示规则来源；`ReviewResult.evidenceTypes` 表示 finding admission 类型，两者不是同一个枚举。生成器将 `specification`、`client-contract`、`project-policy` 与旧的 `normative` 映射为 `normative`，将 `third-party-heuristic` 与旧的 `heuristic` 映射为 `heuristic`。Portable specification、显式 client contract、project policy、observed evidence 和 structural contradiction 可以支持阻断 finding；official guidance 与第三方 heuristic 不能单独支持 P0/P1。
