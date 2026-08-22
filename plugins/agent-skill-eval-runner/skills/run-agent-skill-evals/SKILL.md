---
name: run-agent-skill-evals
description: >-
  当任务需要验证或执行已经通过独立 Oracle preflight 的 Agent Skill Eval plan，或需要拦截未经审核的高成本 Eval 请求时使用。负责人工授权、Audit/digest 门禁、共享 CLI 编排和结果交接；不设计或审核 case，不解释失败归因，不修改 Skill，也不发布 Review。
compatibility: 需要 Node.js 22+、agent-skill-toolkit >= 0.1.0、@lesliechan721/agent-skill-eval >= 0.1.0-beta.2，且 aw-skill-eval 位于 PATH。
metadata:
  short-description: 审核门禁后执行 Skill Eval plan 并交接证据
---

# Run Agent Skill Evals

## 依赖

本 Skill 只调用已安装的 `aw-skill-eval`。不得使用 `npx`，不得自行实现 provider、snapshot、进程管理、timeout、采集或 evidence-level 逻辑。

## 1. 人工授权

在读取凭据或启动进程前，列出 plan 需要的模型成本、外部进程、凭据、网络访问和临时输出。只有用户对本次运行明确授权后才能继续。缺少授权时停止，不运行命令。

## 2. Capability preflight

1. 运行 `aw-skill-eval capabilities --json`，要求 `schemaVersion=1`。
2. 保存当前 provider capability document，并把 path 与 SHA-256 绑定到 plan。
3. 核对 plan 请求的能力均被声明支持，并保留全部 `limitations`。
4. 从已安装包读取 canonical schema：
   - `aw-skill-eval schema print eval-execution-plan`
   - `aw-skill-eval schema print eval-audit-result`
   - `aw-skill-eval schema print eval-run-bundle`
5. 要求 plan、audit 和 bundle 使用 schema v2。

命令或合同不兼容时停止并报告，不降低 plan 要求。

## 3. Audit 门禁

在任何模型或外部 provider 启动前，确认：

- audit 文件和 plan 中的 audit digest 匹配；
- audit 符合 canonical schema，`producer=audit-agent-skill-evals`、`mode=preflight`；
- `validity=pass`、`blockedCases` 为空、所有计划 case admission 为 `pass`；
- `aw-skill-eval digest skill <skill-dir>` 同时匹配 plan 和 audit 的 target Skill digest；
- 当前 case corpus digest 同时匹配 plan 和 audit。

任一条件失败时停止执行，并使用 `audit-agent-skill-evals` 的 `preflight` 模式重新审核；不得改写 case、Oracle 或 audit 来消除不匹配。

## 4. 执行

1. 运行 `aw-skill-eval plan validate <plan.json>`，要求 `{valid:true}`。
2. 运行 `aw-skill-eval run <plan.json>`。
3. 要求返回 `{valid:true,bundlePath,bundleDigest,evidenceLevel}`。
4. 运行 `aw-skill-eval bundle validate <bundle.json>`，核对 calculated digest 与返回的 `bundleDigest`。

非零退出、不完整运行或 bundle 验证失败时停止，不称为通过。

## 5. 结果交接

启动独立上下文子代理，使用 `audit-agent-skill-evals` 的 `result-triage` 模式审核 plan、preflight audit、bundle、capabilities、limitations 和失败项。

本 Skill 不自行解释失败，也不把未经 triage 的结果用于修改生产 Skill。
