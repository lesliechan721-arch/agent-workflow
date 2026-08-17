# Evidence and severity

> GENERATED from `standards/rules.json`; do not edit manually.

## Evidence

- `observed`：trace、复现、测试或用户确认失败。
- `normative`：适用官方规范、schema、项目硬规则或用户要求。
- `structural`：直接材料在同一可达路径上支持 exact claim，不依赖未证实前提。
- `heuristic`：第三方设计原则或经验建议。
- `inferred`：尚未验证的推演。

## P0/P1 admission

- 至少包含 observed、normative 或 structural 之一。
- 记录直接 evidence、location 和 exact claim。
- 所有 material premise 均有来源、证据并为 supported。
- reachability 为 supported，并记录路径和证据。
- 记录 impact、counterevidence、owner、minimal action 和 validation。

Owner 未证明为 Skill 时，不得要求修改生产 SKILL.md。Heuristic/inferred 默认最多 P2 或 unknown。
