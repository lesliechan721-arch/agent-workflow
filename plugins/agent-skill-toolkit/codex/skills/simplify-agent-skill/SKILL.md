---
name: simplify-agent-skill
description: >-
  用户明确要求对已有 Agent Skill 做简化、剪枝、减少控制和上下文负担，并以 baseline、ablation 或 Eval 检查行为回归时使用。包含简化计划及授权范围内的候选对照；不是普通修词，不替代独立 Oracle 审核或发布裁决。
compatibility: 已验证应用需要可写隔离副本和兼容 Eval runner；缺少运行条件时仍可制定计划。内容方法使用 agent-content。
metadata:
  short-description: 以固定对照验证 Skill 减法，不追求未经证明的全局最优
---

# Simplify Agent Skill

降低实际 active-path context、无用约束和维护成本，同时保留用户目标、领域事实与硬安全边界。没有运行证据只能称候选或计划，不称安全等价。

## 开始

明确允许修改的 Skill、不可变 baseline、成功/不可接受回归、预算和候选范围。已有明确局部候选可直接处理；只有目标或保留规则有争议才使用 `review-agent-skill`。正文方法使用 `agent-content`，不强制为每次小改编写完整行为合同。

可直接编辑和消费的完整包走普通路径。构建或注入源码由项目适配提供可写 source、冻结的 baseline 源码上下文及其 final、候选重建方式。沿用已有适配上下文，只补缺项，不递归重启开发任务。只有 final、没有可追踪源码时，不把生成物编辑声明为生产简化完成。

用户只要计划，或缺少必要输入、有效对照、运行权限时，只给计划或未验证候选及验证需求，不修改生产目标。已有预算沿用；未给预算时可以提出最小一轮方案，但不得承诺无限迭代或自动花费。

## 有限对照

1. 读取 `references/simplification-method.md`，选择一个可归因的变化族。一次文件拆分允许同步改指针，不把“一个变化族”误解成只能改一个文件。
2. 在隔离候选的权威源码中应用修改；必要时使用 `author-agent-skill`。需要构建时由项目适配按与 baseline 相同的 profile 和未变构建条件取得候选运行包，分别保留来源并比较实际读入内容。baseline、用户已有修改和 Oracle 保持不变。源码缩短而 final 未变时，只报告维护成本变化。
3. 对照使用相同 corpus、grader、环境和错误代价。Oracle 的 source audit 与候选的精确绑定是两件事：每个 candidate 都须满足当前 Runner 的 Spec/Audit 绑定规则，不能复用旧 target 的 passing Audit。
4. 公开兼容 Runner 执行已授权实验；需要独立 Audit/triage 时在隔离上下文使用 `audit-agent-skill-evals`。没有该能力时保留为未验证候选。
5. 用 `references/ablation-acceptance.md` 判断 accept/reject/inconclusive。只在用户授权的目标应用已接受改动，不进行全仓 reset 或覆盖其他工作。
6. 预算耗尽、收益不明确、需改变 Oracle 或无合理下一候选时停止。报告当前最佳已验证版本及未试候选。

## 交付

说明删减了什么、保留了什么、对照范围、实际结果与限制。必要实验记录使用简短 Markdown；运行状态沿用 Runner 产物，不新增通用多轮状态 schema。

结论只限于“本次固定环境和已审核用例内未观察到不可接受回归，复杂度指标下降”，不声称全局最优或普遍无回归。
