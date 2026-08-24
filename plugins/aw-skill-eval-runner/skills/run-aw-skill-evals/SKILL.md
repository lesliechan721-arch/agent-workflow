---
name: run-aw-skill-evals
description: >-
  当任务需要使用 aw-skill-eval 验证或执行 AwSkillEvalExecutionPlan，并在执行时生成 EvalRunBundle 时使用。负责本次副作用授权、运行时能力检查、共享 CLI 编排和 bundle 完整性验证；不审核 case，不执行 Audit 或 result triage，不解释失败归因，不修改 Skill，也不发布 Review。
compatibility: 需要 Node.js 22+、@lesliechan721/agent-skill-eval >= 0.1.0，且 aw-skill-eval 位于 PATH。
user-invocable: true
metadata:
  short-description: 使用 aw-skill-eval 执行 Eval plan 并生成证据
---

# Run AW Skill Evals

## 依赖

本 Skill 只调用已安装的 `aw-skill-eval`。不得使用 `npx`，不得自行实现 provider、snapshot、进程管理、timeout、采集或 evidence-level 逻辑。

## 1. 确认操作模式与人工授权

先确认用户要求“只验证”还是“执行”。只验证时不得启动 provider、产生模型成本、读取模型凭据或创建 Eval 输出，不要求模型执行副作用授权。执行时，在读取凭据或启动 provider 前，列出 plan 需要的模型成本、外部进程、凭据、网络访问和临时输出。只有用户对本次运行明确授权后才能继续；缺少授权时停止，不运行命令。

## 2. Capability preflight

1. 运行 `aw-skill-eval capabilities --json`，要求 `schemaVersion=1`。
2. 保存当前 provider capability document，并确认 plan 绑定其 path 与 SHA-256。
3. 核对 plan 请求的能力均被声明支持，并保留全部 `limitations`。
4. 读取 `minimumEvidenceLevel`；省略时按 `executed`。要求 `comparative` 时，只有 macOS/Linux 的 Full Access 或普通 Terminal 能力探测通过，或者宿主提供更强 external containment，才能启动 provider。`workspace`、`read-only` 和未知非空 permission profile 必须在启动前阻断；单次提权不等于 Full Access。
5. 从已安装包读取 canonical schema：
   - `aw-skill-eval schema print aw-skill-eval-execution-plan`
   - `aw-skill-eval schema print eval-run-bundle`
6. 要求 plan 和 bundle 使用 schema v3。

命令或合同不兼容时停止并报告，不降低 plan 要求。

## 3. 验证与执行

1. 运行 `aw-skill-eval digest skill <skill-dir>`，确认当前 Skill digest 与 plan 一致。
2. 运行 `aw-skill-eval plan validate <plan.json>`，要求 `{valid:true}`。
3. 若用户只要求验证，返回验证结果并停止；不得调用 `aw-skill-eval run <plan.json>`。
4. 若用户要求执行，运行 `aw-skill-eval run <plan.json>`。
5. 要求返回 `{valid:true,bundlePath,bundleDigest,evidenceLevel,requirementsMet}`。
6. 运行 `aw-skill-eval bundle validate <bundle.json>`，核对 calculated digest 与返回的 `bundleDigest`。

`requirementsMet=false` 或非零退出时停止，不称为满足计划。若清理验证失败后返回了诊断 bundle，仍验证并报告该 bundle，但不得把其中的 `executed` 证据升级为 `comparative`。bundle 验证失败时停止。

## 4. 输出边界

只验证时返回 plan、capability 和 schema 的验证结果，并明确说明未执行。执行时返回 bundle path、bundle digest、`runner.id`、`runner.version`、`evidenceLevel`、`evidenceRequirement`、`processManagement`、`requirementsMet` 和全部 `limitations`。

`EvalRunBundle` 是原始诊断执行证据。没有 preflight Audit 和 result triage 时，它不得影响 Review、生产 Skill 修改或发布结论。本 Skill 不调用 Auditor，也不把 Audit 缺失作为执行门禁。

## 完成条件

- 执行请求已获得本次副作用授权；只验证请求未启动 provider 或创建 Eval 输出。
- plan、capability 和 schema 兼容。
- 只验证请求已返回验证结果并明确说明未执行；或执行成功，且 bundle digest 与独立验证结果一致。
- 执行输出明确标记证据级别和限制，不声称已通过 Review 或发布门禁。
- comparative 证据明确标记 `verified-observed` 或更强的 `managed`；前者不是 OS 强隔离，不得声称绝对后代清理保证。
