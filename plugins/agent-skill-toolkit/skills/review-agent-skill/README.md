# Review Agent Skill

独立、只读评审 Agent Skill 的职责、触发边界、信息层级、脚本使用和发布准备度。

## 检查重点

- Skill 是否确有 baseline gap，而不是重复模型常识。
- description 是否覆盖用户意图和最接近的 near-miss。
- 主文件是否只保留每次执行都需要的内容。
- references、scripts 和 assets 是否有明确加载条件。
- 规则是否由真实失败或评测支持。
- 复杂度是否与任务风险匹配。

该 Skill 不修改生产 Skill。修复由 `author-agent-skill` 完成。

## Eval 与阶段证据

- Trigger suite 只评估路由。
- Behavior suite 检查 selective bundle consumption、stale-stage rejection、canonical standard ownership 和 provisional release evidence；在取得真实重复运行前，它保持 diagnostic-only，不参与发布计权。
- `providedStages` 必须通过 `validate-review-stage-result.mjs` 重新绑定 target、result 和 digest，字段齐全本身不构成完成证据。

主要指令见 [`SKILL.md`](SKILL.md)。
