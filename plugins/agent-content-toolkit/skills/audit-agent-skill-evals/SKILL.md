---
name: audit-agent-skill-evals
description: >-
  当用户要只读审核 Agent Skill Eval case/suite 的 Oracle、现实性、错误代价、统计结果或修改安全时使用。支持运行前 preflight 和运行后 result-triage；不创建 case、不运行项目专有 Eval、不直接修改生产 Skill。
metadata:
  short-description: 只读审核 Skill Eval Oracle、case 现实性和结果归因
---

# Audit Agent Skill Evals

目标是先判断 Eval 是否有资格评价 Skill，再判断运行结果能否驱动修改。

## 模式

- `preflight`：运行前审核 suite、case 和 Oracle。
- `result-triage`：运行后解释失败、方差、baseline 和修改安全。

## Preflight

1. 读取目标 Skill 当前目标、scope 和相关规则。
2. 对关键 case 检查：test layer、unit、preconditions、rationale、rule refs、observable assertion、allowed variance、minimal counterexample、provenance、case role 和 scenario family。
3. 检查 optimization policy 与 FN/FP 代价；正负数量相等不等于代价相等。
4. 检查 challenge/diagnostic 是否错误进入发布指标。
5. 运行安全的结构 validator：

```bash
node scripts/validate-eval-cases.mjs <cases.json> --format json
```

6. 用相同 case 文件计算 corpus digest：

```bash
node scripts/validate-eval-audit-result.mjs --digest-only --case <cases.json>
```

7. 输出 `validity=pass | unknown | fail`。使用 `assets/eval-audit-result-template.json`，记录 `producer`、`auditId` 和 `independentContext`，再运行：

```bash
node scripts/validate-eval-audit-result.mjs <audit.json> --case <cases.json> --format json
```

`validity=pass` 只允许独立上下文、无 blocked case 且所有 release-relevant case admission 通过。

## Result triage

每个失败先归因：

`skill-defect | oracle-defect | fixture-defect | grader-defect | runtime-or-tool-defect | model-variance | stale-case | insufficient-runs | expected-tradeoff | unknown`

只有通过 preflight、现实可达、可复现并归因为 `skill-defect` 的场景族失败可以进入 Skill 修改候选。混合低样本结果默认是证据不足。

每个 triage 条目必须记录 case、attribution、action 和直接 evidence。`candidate-skill-fix` 必须有 `skill-defect` 条目支持。

修改后必须回归：原 case、同族变体、minimal pair、相反标签 near-miss、固定 validation/sanity 和关键 regression，并记录 Skill 复杂度 delta。

详细标准见 `references/eval-audit-standard.generated.md`。

## 输出边界

- `preflight` 不运行高成本 Eval。
- `result-triage` 不直接修改 Skill；只输出建议动作：`fix-eval-first | collect-more-data | candidate-skill-fix | accepted-risk | runtime-issue`。
