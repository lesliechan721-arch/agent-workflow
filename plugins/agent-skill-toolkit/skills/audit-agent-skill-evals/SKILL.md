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

1. 输入必须是 `plan.json`。先运行 `aw-skill-eval plan validate <plan.json>`；非零退出、`valid=false` 或 calculated digest 不完整时停止，不读取其它目标或 case。
2. 只读取已验证 plan 的 `target.path`、`cases.paths`，以及 `with-skill`/`previous-version` 配置绑定的 Skill。不得从调用方说明、suite source 或目录扫描扩大 corpus。
3. 对选中 case 检查 test layer、unit、preconditions、rationale、rule refs、observable assertion、allowed variance、minimal counterexample、provenance、case role 和 scenario family。
4. 检查 optimization policy 与 FN/FP 代价，以及 challenge/diagnostic 是否错误进入发布指标。正负数量相等不等于代价相等。
5. 对 plan 中每个 case 文件运行 `node scripts/validate-eval-cases.mjs <cases.json> --format json`。
6. 按 `assets/eval-audit-result-template.json` 输出 schema v3 `EvalAuditResult`，并设置 `runBundleDigest=null`。每个 distinct current/previous Skill digest 使用一份独立 Audit；每份 Audit 的 cases 必须精确覆盖 plan 选中的 case ID。
7. 运行 `node scripts/validate-eval-audit-result.mjs <audit.json> --plan <plan.json> --format json`。只有 target/corpus digest 同时等于 plan 声明值和 canonical 重算值、全部选中 case admission 通过且 `blockedCases=[]`，才能使用 `validity=pass`。

没有 validated plan 的 source-only 材料可以做设计审核，但 `validity` 必须是 `unknown` 或 `fail`，不得准许运行。

## Result triage

每个失败先归因：

`skill-defect | oracle-defect | fixture-defect | grader-defect | runtime-or-tool-defect | model-variance | stale-case | insufficient-runs | expected-tradeoff | unknown`

先运行 `node scripts/validate-eval-run-bundle.mjs <bundle.json> --format json`，要求 `EvalRunBundle v4` 有效且返回 calculated `bundleDigest`。再运行 `node scripts/validate-eval-audit-result.mjs <audit.json> --run-bundle <bundle.json> --format json`。输出 schema v3，并把实际 bundle bytes 的 digest 写入 `runBundleDigest`。`evidenceRequirement.satisfied=false` 时，不得输出发布资格或 `candidate-skill-fix`；只输出 `collect-more-data` 或 `runtime-issue`。只有 preflight 与 bundle 的 Skill/corpus digest 匹配、triage 精确绑定 `runBundleDigest`、场景现实可达、结果可复现并归因为 `skill-defect` 时，才输出 `candidate-skill-fix`。混合低样本结果默认是证据不足。

详细标准见 `references/eval-audit-standard.md`。

## 输出

- `preflight` 不运行 Eval。
- `result-triage` 不直接修改 Skill，只输出 `fix-eval-first | collect-more-data | candidate-skill-fix | accepted-risk | runtime-issue`。
- 有指定输出路径时写入 schema-conformant JSON；否则在回复中返回。
