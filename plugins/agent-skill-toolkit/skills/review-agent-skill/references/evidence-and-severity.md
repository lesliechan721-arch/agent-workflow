# Evidence and severity

> GENERATED from `standards/rules.json`; do not edit manually.

## ReviewResult evidence admission

- `observed`：trace、复现、测试或用户确认失败。
- `normative`：适用官方规范、schema、项目硬规则或用户要求。
- `structural`：直接材料在同一可达路径上支持 exact claim，不依赖未证实前提。
- `heuristic`：第三方设计原则或经验建议。
- `inferred`：尚未验证的推演。
- `official-guidance`：官方设计建议；影响质量评分，但不能单独支持 P0/P1。

规则来源标签与 ReviewResult admission 类型不同；生成器负责映射，Reviewer 不把 `project-policy` 等来源标签直接写入 ReviewResult。

## P0/P1 admission

- 至少包含 observed、normative 或 structural 之一。
- 记录直接 evidence、location 和 exact claim。
- 所有 material premise 均有来源、证据并为 supported。
- reachability 为 supported，并记录路径和证据。
- 记录 impact、counterevidence、owner、minimal action 和 validation。

Owner 未证明为 Skill 时，不得要求修改生产 SKILL.md。Official-guidance、heuristic 和 inferred 默认最多 P2 或 unknown。
