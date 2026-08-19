# Skill Eval 审核标准

> GENERATED from canonical content rules plus `standards/skill-rules.json`; do not edit manually.

## `review.evidence-admission`

设计建议、已证实缺陷和未知项必须分开；claim 不得强于直接证据。

- **check：** expected output 只证明 Oracle，不证明实际失败。

Evidence: normative; sources: agent-workflows.review-contract

## `eval.oracle-validity`

Eval 必须先证明 Oracle、前提、层级和 assertion 有资格评价 Skill。

- **check：** 先审 suite validity；错误 Oracle 不进入发布和 Skill 修改。

Evidence: normative; sources: agent-skills.evaluating-skills, agent-workflows.eval-contract

## `eval.error-cost`

正负错误代价不默认对称；分别报告 recall、false negative、specificity 和 false positive。

- **check：** 检查 representative/regression 是否主导发布，challenge 不得绑架通用规则。

Evidence: normative; sources: agent-skills.evaluating-skills, agent-workflows.eval-contract

## `eval.change-safety`

Eval 失败先归因；只有有效、可复现且归因为 skill-defect 的场景族失败才能驱动修改。

- **check：** 检查 failure triage、运行方差、baseline、净收益和复杂度回归。

Evidence: normative; sources: agent-skills.evaluating-skills, agent-workflows.eval-contract
