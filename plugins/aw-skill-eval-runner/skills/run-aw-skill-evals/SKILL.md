---
name: run-aw-skill-evals
description: >-
  当用户要准备、验证或执行 AW Agent Skill Eval 时使用。支持已有 plan+preflight Audit，或 plugin/skill/suite/profile/case/split 选择条件；编排独立 Auditor、单次副作用授权、aw-skill-eval 执行、EvalRunBundle 验证和结果归因。不设计 case、不修改 Skill、不发布 Review。
compatibility: 需要 Node.js 22+、@lesliechan721/agent-skill-eval >= 0.1.0，且 aw 与 aw-skill-eval 位于 PATH；依赖 agent-skill-toolkit。
user-invocable: true
metadata:
  short-description: 准备、审核并执行 AW Skill Eval，返回完整证据链
---

# Run AW Skill Evals

本 Skill 是默认 AW Eval 流程的唯一 Agent-facing 编排入口。用户可以直接调用；不要求先进入 Reviewer。

## 边界

- `aw` 只准备真实 plugin/profile 输入；`aw-skill-eval` 是 plan validation、provider、执行和 bundle 的唯一机器 owner。
- `audit-agent-skill-evals` 独立审核 Oracle 和结果；Runner 不代替 Auditor，也不解释失败归因。
- 不隐式安装依赖，不复制 provider、snapshot、进程、timeout、采集、schema 或 digest 实现。
- 无 passing preflight Audit 不得启动 provider、产生模型诊断或调用 run。`prepare`、plan/schema/capabilities/Audit validation 可在无 Audit 时运行；这些只读检查不得调用 Plan 的 provider。

## 1. 选择入口

接受以下一种输入：

1. 已有 `<plan.json>`，以及 plan 中每个 distinct current/previous Skill digest 对应的一份 passing preflight `<audit.json>`。
2. `<plugin>`、`<skill>`、`<suite>`、`<profile>`，以及可选 `<workspace-root>`、`<case>`、`<split>`、runs 或 baseline 条件。

第二种入口先读取 `aw skill eval prepare --help`，只使用公开参数，然后运行：

```bash
aw skill eval prepare <plugin> --skill <skill> --suite <suite> --profile <profile> --output <new-plan-directory> --json
```

按用户条件添加公开的 `--workspace-root`、`--case`、`--split`、`--runs`、`--baseline` 或 `--previous-version`。receipt 必须 `ok=true`，随后只使用 `<new-plan-directory>/plan.json`。

## 2. 无副作用的合同检查

1. 先运行 `aw-skill-eval plan validate <plan.json>`。只有 `valid=true` 且 calculated target、corpus、provider capabilities 和 configuration Skill digests 完整时，才读取其它 target、case 或 Audit 输入。
2. 运行 `aw-skill-eval capabilities --json`，要求 `EvalProviderCapabilities v2`。它只描述 runner 的进程能力，不启动 Plan 中的 provider。Plan validation 已核验 Plan 绑定的 provider capabilities 文件和 digest。
3. 从当前 executable 运行以下 schema 查询，要求 Plan v4、Audit v3、Bundle v4、provider capabilities v2 和 provider output v1；不复制 schema：

```bash
aw-skill-eval schema print aw-skill-eval-execution-plan
aw-skill-eval schema print eval-audit-result
aw-skill-eval schema print eval-run-bundle
aw-skill-eval schema print eval-provider-capabilities
aw-skill-eval schema print eval-provider-output
```

4. 已有 Audit 时，对每份运行 `aw-skill-eval audit validate <audit.json>`。随后仍须由 Auditor 的 bundled validator 用当前 plan 检查 exact target/corpus/case binding；Audit 数量和 distinct Skill digest 的最终机器门禁由 run 再检查。

只要求 prepare 时，输出仅限新 Plan 目录并在此停止。只要求 validate 时不得创建任何输出。两种请求都不得请求执行授权、启动 provider 或创建 EvalRunBundle。

## 3. 独立 preflight

第二种入口在全新上下文调用 `audit-agent-skill-evals` 的 preflight 模式，并只传 validated plan。plan 含 distinct previous Skill digest 时，为每个 distinct current/previous digest 取得一份独立 preflight Audit。第一种入口也在全新上下文把 validated plan 和已有 Audit 交给 Auditor，验证 Audit 与该 plan 的 exact binding；不得只信调用方说明。

每份 Audit 必须通过：

```bash
aw-skill-eval audit validate <audit.json>
```

并由 Auditor 的 bundled validator 证明 target/corpus 和 selected case admission 精确绑定 plan。任一 Audit 的 `validity` 不是 `pass`、`blockedCases` 非空或 validation 失败时停止 Eval 分支。不得为了通过而修改 Audit、case 或 Skill。

## 4. 本次执行授权

只有全部 preflight Audit 通过后，才根据 validated plan 和 capabilities 明确列出：模型及重复运行成本、provider 外部进程、将读取的凭据环境变量、网络访问、临时输出、持久输出与最终输出目录、最低 evidence level、进程管理限制和其它 `limitations`。列出凭据名称时不得读取凭据值。

必须取得用户对本次运行的明确授权。授权只适用于当前 plan、Audit 集和已展示副作用；缺少授权时停止。不得读取模型凭据或启动 provider。

要求 `comparative` 时，只有 macOS/Linux 的 Full Access 或普通 Terminal 能力探测通过，或者宿主提供更强 external containment，才能启动 provider。`workspace`、`read-only` 和未知非空 permission profile 必须阻断；单次提权不等于 Full Access。

## 5. 执行和验证

把每份独立 preflight Audit 作为单独的 `--audit` 参数运行：

```bash
aw-skill-eval run <plan.json> --audit <audit.json>
```

公开 run receipt 必须包含 `valid=true`、`bundlePath`、`bundleDigest`、`evidenceLevel` 和 `requirementsMet`。非零退出或 `requirementsMet=false` 时停止，不称为满足计划。若失败返回诊断 bundle，仍可验证并报告，但不得升级 evidence level。

run 只接受 provider output v1；该验证、进程执行和输出采集由 `aw-skill-eval` 负责，Runner 不单独实现或修复 provider output。

随后运行：

```bash
aw-skill-eval bundle validate <bundle.json>
```

要求 Bundle v4 有效，calculated bundle digest 与 run 返回值一致。

prepare 或 run 中断后，删除本次不完整输出，并从新的 `prepare`、独立 preflight Audit、本次授权和 `run` 重新开始。不得续跑旧 Plan/Audit，也不得创建 checkpoint、batch ledger 或其它恢复状态。

## 6. 独立 result triage

Bundle 验证通过后，在新的全新上下文调用 `audit-agent-skill-evals` 的 result-triage 模式，只传验证后的 Bundle v4 和对应 preflight 证据。要求 triage `EvalAuditResult v3` 的 `runBundleDigest` 精确等于 bundle bytes。

Triage 失败不改写原始 bundle，但完整证据链未成立。没有 result triage 时，不得给出 Skill 缺陷、修改或发布结论。

## 输出

只验证时返回 plan/capability/schema/Audit validation，并明确说明没有执行。执行时返回 plan path、preflight Audit paths、bundle path、bundle digest、runner/provider identity、evidence level、evidence requirement、process management、requirementsMet、limitations，以及 result-triage Audit path 和结论。不得声称已通过 Quality Review 或 Release Check。
