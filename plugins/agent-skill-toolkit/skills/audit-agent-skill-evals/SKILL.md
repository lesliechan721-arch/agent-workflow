---
name: audit-agent-skill-evals
description: >-
  当用户要只读审核 Agent Skill Eval case/suite 的 Oracle、现实性、错误代价、统计结果或修改安全时使用。支持运行前 preflight 和运行后 result-triage；不创建 case、不运行项目专有 Eval、不直接修改生产 Skill。
compatibility: 仅在运行 bundled 结构 validator 时需要 Node.js 20+。
metadata:
  short-description: 只读审核 Skill Eval Oracle、现实性、结果归因与修改安全
---

# Audit Agent Skill Evals

目标是先判断 Eval 是否有资格评价当前版本的 Skill，再判断运行结果能否驱动修改。审核必须与 case 设计处于独立上下文。

## 模式

- `preflight`：运行前审核 suite、case 和 Oracle。
- `result-triage`：运行后解释失败、方差、baseline 和修改安全。

## 运行前审核

1. 读取目标 Skill 当前目标、scope 和相关规则，并计算 `targetSkillDigest`。
2. 对关键 case 检查 test layer、unit、preconditions、rationale、rule refs、observable assertion、allowed variance、minimal counterexample、provenance、case role 和 scenario family。
3. 检查 optimization policy 与 FN/FP 代价；正负数量相等不等于代价相等。
4. 检查 challenge/diagnostic 是否错误进入发布指标。
5. 运行 `node scripts/validate-eval-cases.mjs <cases.json> --format json`。
6. 计算 `caseCorpusDigest`：`node scripts/validate-eval-audit-result.mjs --digest-only --case <cases.json>`。
7. 输出 schema v2 `EvalAuditResult`。`pass` 只允许独立上下文、无 blocked case、所有 release-relevant case admission 通过，且同时绑定当前 Skill digest 与 case corpus digest。

## 结果归因

每个失败先归因：

`skill-defect | oracle-defect | fixture-defect | grader-defect | runtime-or-tool-defect | model-variance | stale-case | insufficient-runs | expected-tradeoff | unknown`

只有 preflight 与 `EvalRunBundle` 的 Skill/corpus/audit digest 全部匹配、现实可达、可复现并归因为 `skill-defect` 的场景族失败可以进入修改候选。混合低样本结果默认是证据不足。

详细标准见 `references/eval-audit-standard.generated.md`。

## 输出边界

- `preflight` 不运行高成本 Eval。
- `result-triage` 不直接修改 Skill，只输出 `fix-eval-first | collect-more-data | candidate-skill-fix | accepted-risk | runtime-issue`。
- caller 未提供可写 handoff 路径时，在回复中返回 schema-conformant JSON。
