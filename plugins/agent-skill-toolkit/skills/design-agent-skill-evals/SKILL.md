---
name: design-agent-skill-evals
description: >-
  当用户要为一个 Agent Skill 创建或修改 trigger、routing、behavior、outcome 或 cost Eval case/suite 时使用。负责测试目标、场景族、Oracle、assertion 和运行策略；不审核自己设计的 Oracle，不运行高成本 Eval，也不据此修改生产 Skill。
metadata:
  short-description: 设计现实、分层、可审计的 Agent Skill Eval case 与 suite
---

# Design Agent Skill Evals

## 工作流

1. **定义决策目标**：明确 unit under test、test layer、optimization policy 与 false-negative / false-positive 的现实代价。
2. **建立场景族**：先列 representative、regression、boundary、challenge、diagnostic；不用同义 query 冒充独立场景。
3. **设计 case**：记录真实 query/fixture、preconditions、Oracle rationale、rule refs、allowed variance、observable assertions 和重要边界的 minimal pair。
4. **设计运行策略**：三次运行仅作初始取样；混合结果需要扩样和 trace。区分 train、validation、sanity/regression 与不进入发布指标的 challenge/diagnostic；选择 without-skill、minimal-skill 或 previous-version baseline。
5. **输出**：生成 case 文件、suite metadata 和预期 artifact，使用 `assets/eval-case-template.json`。详细标准见 `references/eval-design-standard.generated.md`。

## 必须独立审核

完成 case 或 suite 后，必须启动独立上下文子代理，使用 `audit-agent-skill-evals` 的 `preflight` 模式审核。当前上下文不得给自己设计的 Oracle 输出 `validity=pass`。

只有审核结果满足以下条件，suite 才能交给兼容 Eval runner：

- `validity=pass`；
- `blockedCases` 为空；
- 待运行 case 的 admission 全部为 `pass`；
- target Skill digest 与 case corpus digest 均匹配当前材料。

`fail`、`unknown` 或 digest 不匹配时停止 Eval 执行分支，先修复 Eval 或补足证据。
