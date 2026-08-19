# Skill Eval 设计标准

> GENERATED from `standards/rules.json`; do not edit manually.

## `eval.oracle-validity`

Eval 必须先证明 Oracle、前提、层级和 assertion 有资格评价 Skill。

- **action：** 为关键 case 写 test layer、preconditions、rationale、rule refs、allowed variance 和 minimal counterexample。
- **completion：** case 能归入现实场景族且标签可解释。

Evidence: normative; sources: agent-skills.evaluating-skills, agent-workflows.eval-contract

## `eval.error-cost`

正负错误代价不默认对称；分别报告 recall、false negative、specificity 和 false positive。

- **action：** 声明 recall-first、precision-first、balanced 或 critical 及现实代价。
- **completion：** 样本数量不会冒充实际决策权重。

Evidence: normative; sources: agent-skills.evaluating-skills, agent-workflows.eval-contract

## `eval.change-safety`

Eval 失败先归因；只有有效、可复现且归因为 skill-defect 的场景族失败才能驱动修改。

- **action：** 为修复预留同族、minimal pair、相反标签和固定回归集。
- **completion：** 修改目标不是单个 query。

Evidence: normative; sources: agent-skills.evaluating-skills, agent-workflows.eval-contract
