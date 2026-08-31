---
name: audit-agent-skill-evals
description: >-
  当用户要在执行前只读审核 Agent Skill Eval 的 suite、case、Oracle 和错误代价，或在执行后归因失败、混合结果与 baseline 回归时使用。preflight 生成 EvalAudit v1；result-triage 只返回诊断，不运行 Eval、不修改 Skill、不作发布决定。
compatibility: 需要 aw-skill-eval 位于 PATH；仅在运行本地 case 检查脚本时需要 Node.js 20+。
metadata:
  short-description: 只读审核 Skill Eval 准入，并归因失败、混合结果和回归
---

# Audit Agent Skill Evals

本 Skill 保留两个只读模式：`preflight` 决定当前 EvalSpec 是否可以执行；`result-triage` 解释已验证结果。参与 case 或 Oracle 设计的上下文不能为同一输入完成 preflight。

## Preflight

1. 只接受 `aw-skill-eval spec validate <spec.json>` 返回 `valid=true` 的 EvalSpec。验证失败或只有 source-only 材料时停止，不输出 preflight Audit。
2. 机器 validator 核对 provider、整个 workspace digest、current target、可选 previous-version target、case digest 和 selected cases。人工只读 selected cases 明确引用的 fixture、custom-process provider entrypoint 和 participant Skill；不得扫描无关源目录、源 suite、邻近目录或调用方补充的 corpus。
3. 审核 suite policy 是否说明优化方向、false-negative/false-positive 的现实代价和理由。普通 case 只检查其 suite kind 所需的最小字段。仅当 tag 是 `boundary`、`regression`、`release-critical`、`high-cost` 或 `high-variance` 时，要求对应的条件性 `audit` metadata。还要判断场景是否现实可达、Oracle 是否可观察，以及错误成本是否与预期一致。结构辅助检查可运行 `node scripts/validate-eval-cases.mjs <cases.json> --format json`；它不代替机器 validator 或独立判断。
4. 从 `assets/eval-audit-template.json` 生成一份 EvalAudit v1。`workspaceDigest`、`providerDigest` 和 `caseDigest` 使用 spec 绑定值；`targets` 同时绑定 current 和可选 previous-version。只有全部 case 通过时，`status=pass` 且 `approvedCaseIds` 精确覆盖 selected cases；否则记录 `blockedCases` 和 `issues`，并使用 `fail` 或 `unknown`。
5. 运行 `aw-skill-eval audit validate <audit.json> --spec <spec.json>`。只有零退出且 `valid=true` 才准许运行；`fail`、`unknown`、绑定不符或 case 覆盖不完整均停止 Eval 分支。

独立或全新上下文是调用方的编排属性，不写入 EvalAudit JSON。

## Result triage

只接受 `aw-skill-eval result validate <result.json> --spec <spec.json> --audit <audit.json>` 已验证的 EvalResult。逐项区分 provider/进程失败、timeout、grader 失败、Oracle 或 fixture 缺陷、模型方差、current 混合结果和 current 相对 baseline 的回归。证据不足时说明还需要哪些运行或诊断，不把不确定性改写成 Skill 缺陷。

默认在聊天中返回归因、证据和下一步。用户指定文件时可写 `triage.md`。不得生成新的 JSON 合同、`releaseEligible` 或机器 gate；不得直接修改 case 或生产 Skill。全部运行 clean success 时不要求 result-triage。

## 完成条件

- preflight 返回一份与 spec 精确绑定的 EvalAudit v1，且没有运行模型。
- result-triage 只解释已验证结果，并明确已知、未知和建议动作。
