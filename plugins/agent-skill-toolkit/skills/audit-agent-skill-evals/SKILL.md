---
name: audit-agent-skill-evals
description: >-
  当用户要只读审核 Agent Skill Eval case/suite 的 Oracle、现实性、错误代价、统计结果或修改安全时使用。支持运行前 preflight 和运行后 result-triage；不创建 case、不运行 Eval、不直接修改生产 Skill。
compatibility: 仅在运行 bundled 结构 validator 时需要 Node.js 20+。
metadata:
  short-description: 只读审核 Skill Eval Oracle、现实性、结果归因与修改安全
---

# Audit Agent Skill Evals

先判断 Eval 是否有资格评价当前版本的 Skill，再判断运行结果能否驱动修改。

## 模式

- `preflight`：运行前审核 suite、case 和 Oracle。
- `result-triage`：运行后解释失败、方差、baseline 和修改安全。

如果当前上下文参与了 case 或 Oracle 设计，不能在同一上下文输出 `validity=pass`；应由独立上下文完成 preflight。

## Preflight

1. 读取目标 Skill 的当前目标、scope 和规则，并计算 `targetSkillDigest`。
2. 对关键 case 检查 test layer、unit、preconditions、rationale、rule refs、observable assertion、allowed variance、minimal counterexample、provenance、case role 和 scenario family。
3. 检查 optimization policy 与 FN/FP 代价；正负数量相等不等于代价相等。
4. 检查 challenge/diagnostic 是否错误进入发布指标。
5. 运行 `node scripts/validate-eval-cases.mjs <cases.json> --format json`。
6. 计算 `caseCorpusDigest`：`node scripts/validate-eval-audit-result.mjs --digest-only --case <cases.json>`。
7. 按 `assets/eval-audit-result-template.json` 输出 schema v3 `EvalAuditResult`，并设置 `runBundleDigest=null`。只有无 blocked case、待运行 case admission 通过，且 Skill/corpus digest 均匹配时，才能使用 `validity=pass`。

## Result triage

每个失败先归因：

`skill-defect | oracle-defect | fixture-defect | grader-defect | runtime-or-tool-defect | model-variance | stale-case | insufficient-runs | expected-tradeoff | unknown`

运行 `node scripts/validate-eval-audit-result.mjs <audit.json> --run-bundle <bundle.json> --format json`。输出 schema v3，并把实际 bundle bytes 的 digest 写入 `runBundleDigest`。只有 preflight 与 `EvalRunBundle` 的 Skill/corpus/audit digest 全部匹配、场景现实可达、结果可复现并归因为 `skill-defect` 时，才输出 `candidate-skill-fix`。混合低样本结果默认是证据不足。

详细标准见 `references/eval-audit-standard.md`。

## 输出

- `preflight` 不运行 Eval。
- `result-triage` 不直接修改 Skill，只输出 `fix-eval-first | collect-more-data | candidate-skill-fix | accepted-risk | runtime-issue`。
- 有指定输出路径时写入 schema-conformant JSON；否则在回复中返回。
