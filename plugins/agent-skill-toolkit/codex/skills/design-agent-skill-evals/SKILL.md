---
name: design-agent-skill-evals
description: >-
  当用户要为一个 Agent Skill 创建或修改 trigger、conversation 或 custom-process Eval case/suite 时使用。负责测试目标、现实场景族、Oracle、错误成本和最小 case 合同；不审核 Oracle、不运行 Eval、不修改生产 Skill。
metadata:
  short-description: 设计最小、现实、可审核的 Agent Skill Eval case 与 suite
---

# Design Agent Skill Evals

本 Skill 只创建或修改 Eval 资产。

## 工作流

1. **定义 suite 决策**：选择 `trigger`、`conversation` 或 `custom-process`，明确 unit under test。把 participants、optimization policy、false-negative/false-positive 成本和 runtime 条件放在 suite，不复制到普通 case。
2. **建立场景族**：覆盖 materially distinct 的 representative、regression、boundary、challenge 和 diagnostic 场景。使用简短 tag 或设计说明表示场景归属；不用同义 query 增加虚假覆盖。
3. **写最小 case**：写入前读取 [case 合同](references/case-contract.md)。普通 case 只保留 `id`、`split`、`tags` 和 suite kind 所需的输入、预期或 assertions。只有关键 tag 才添加条件性 `audit` metadata。
4. **设计现实 Oracle**：assertion 必须可从模型输出、工具事件、workspace 变化或明确 artifact 观察。为重要错误说明现实代价；允许方差和 minimal counterexample 只在相应风险需要时记录。
5. **交付**：更新 case 文件、suite metadata 和必要 fixture；可从 `assets/eval-case-template.json` 起稿。运行策略由 suite/profile 与执行时选择拥有，不能在每个 case 重复。交付时写明 `Audit status: not assessed`，并把结构验证交给当前公开 `aw skill eval prepare` 和 `aw-skill-eval spec validate` 路径。

不自动调用 Auditor、Runner 或子代理。用户未要求生产 Skill 修改时，不扩大到 Skill 作者任务。
