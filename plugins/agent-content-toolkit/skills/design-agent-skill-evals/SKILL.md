---
name: design-agent-skill-evals
description: >-
  当用户要为一个 Agent Skill 创建或修改 trigger、routing、behavior、outcome 或 cost Eval case/suite 时使用。负责测试目标、场景族、Oracle、assertion 和运行策略；不审核自己设计的 Oracle，不运行高成本 Eval，也不据此修改生产 Skill。
metadata:
  short-description: 设计现实、分层、可审计的 Agent Skill Eval case 与 suite
---

# Design Agent Skill Evals

本 Skill 负责创建 Eval 资产，不负责证明这些资产有效。

## 工作流

1. **定义决策目标**
   - 明确 unit under test 和 test layer：trigger、gate、routing、behavior、outcome 或 cost。
   - 声明 optimization policy 与 false-negative / false-positive 的现实代价。

2. **建立场景族**
   - 先列 representative、regression、boundary、challenge、diagnostic 场景族。
   - 不用多个同义 query 冒充多个独立场景。

3. **设计 case**
   - 写真实用户可能提出的 query 或 fixture。
   - 记录 preconditions、Oracle rationale、rule refs、allowed variance 和 observable assertions。
   - 重要边界提供 minimal counterexample / minimal pair。

4. **设计运行策略**
   - 三次运行仅作初始取样；混合结果需要扩样和 trace。
   - 区分 train、validation、sanity/regression 与不进入发布指标的 challenge/diagnostic。
   - 行为和 outcome 选择适用 baseline：without-owner、minimal-skill 或 previous-version。

5. **输出**
   - 生成 case 文件、suite metadata 和预期 artifact。
   - 使用 `assets/eval-case-template.json`。
   - 详细标准见 `references/eval-design-standard.generated.md`。

## 独立审核边界

完成后必须启动新的子代理，在独立上下文调用 `audit-agent-skill-evals` 做 preflight。具体调度参数由当前 runtime 决定。Author 或本 Skill 的自检只能发现结构错误，不能给 Oracle 出 `validity=pass`。
