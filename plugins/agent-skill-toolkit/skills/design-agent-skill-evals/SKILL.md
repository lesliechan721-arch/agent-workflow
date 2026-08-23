---
name: design-agent-skill-evals
description: >-
  当用户要为一个 Agent Skill 创建或修改 trigger、routing、behavior、outcome 或 cost Eval case/suite 时使用。负责测试目标、场景族、Oracle、assertion 和运行策略；不审核 Oracle、不运行 Eval、不修改生产 Skill。
metadata:
  short-description: 设计现实、分层、可审核的 Agent Skill Eval case 与 suite
---

# Design Agent Skill Evals

本 Skill 只创建或修改 Eval 资产。

## 工作流

1. **定义决策目标**：明确 unit under test、test layer、optimization policy 与 false-negative / false-positive 的现实代价。
2. **建立场景族**：先列 representative、regression、boundary、challenge、diagnostic；不用同义 query 冒充独立场景。
3. **设计 case**：记录真实 query/fixture、preconditions、Oracle rationale、rule refs、allowed variance、observable assertions 和重要边界的 minimal pair。
4. **设计运行策略**：三次运行仅作初始取样；混合结果需要扩样和 trace。区分 train、validation、regression 与不进入发布指标的 challenge/diagnostic；选择合适 baseline。
5. **输出**：生成 case 文件、suite metadata 和预期 artifact，使用 `assets/eval-case-template.json`。详细标准见 `references/eval-design-standard.generated.md`。

交付时明确 `Audit status: not assessed`。是否审核或运行由用户请求或上层工作流决定；本 Skill 不自动启动审核、子代理或 Eval runner。
