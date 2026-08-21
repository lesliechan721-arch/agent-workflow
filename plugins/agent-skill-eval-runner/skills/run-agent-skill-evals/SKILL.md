---
name: run-agent-skill-evals
description: >-
  仅当用户明确要求执行已经通过独立 Oracle preflight 的 Agent Skill Eval plan，并明确授权相应模型成本、进程、凭据、网络和临时输出时使用。负责人工 gate、preflight、共享 CLI 编排和结果交接；不设计或审核 case，不实现 runner，不解释失败归因，不修改 Skill，也不发布最终 Review。
disable-model-invocation: true
user-invocable: true
compatibility: 需要 Node.js 22+、agent-skill-toolkit >= 0.5.0 和 @lesliechan721/agent-skill-eval >= 0.1.0-beta.2，且 aw-skill-eval 必须位于 PATH。
metadata:
  short-description: 人工授权后执行已审核的 Skill Eval plan 并交接证据
---

# Run Agent Skill Evals

本 Skill 是 manual-only 编排入口。它只调用已安装的 `aw-skill-eval`。不得使用 `npx`，不得隐式联网安装依赖，也不得回退到 Skill-local runner、provider、schema 或 validator。

## 1. 人工授权 gate

在读取凭据或启动进程前，列出 plan 需要的模型成本、外部进程、凭据、网络访问和临时输出。只有用户对这些项目给出当前运行的明确授权后才能继续。缺少授权时停止并请求选择；不得把安装 Skill、提供 plan 或以前的授权解释为本次运行授权。

完成条件：已记录用户对本次运行所需副作用的明确选择，或已停止且没有运行命令。

## 2. 依赖与 capability/version preflight

1. 确认 `aw-skill-eval` 已在 `PATH`。共享包跟随 AW lockstep 版本，不设独立 SemVer 上界。缺少命令时停止，要求用户手动安装满足最低版本的兼容包。
2. 运行 `aw-skill-eval capabilities --json`。要求输出是单个 JSON 对象，且 `schemaVersion` 为 `1`。
3. plan 使用共享 process provider 时，把 stdout 原始字节保存到 plan 目录内的 `./eval-runtime-capabilities.json`，计算原始文件的 SHA-256，并把 path 和 digest 写入 plan。要求 provider id 为 `aw-skill-eval-process`。plan 使用其它 provider 时，必须取得该 provider 自己的 v1 capability document；不得用共享 process provider 文档冒充。
4. 核对 plan 请求的执行能力均被绑定的 capability document 声明支持。能力不足时停止；不得降低 plan 要求或扩大 capability 声明。能力为 `true` 只表示当前生产入口可执行该 mode，不表示有操作系统 sandbox、干净模型上下文或后代清理保证。必须保留 capability document 的全部 `limitations`。
5. 运行以下命令，从已安装包读取 canonical schema；不要保存或复制 schema：

   - `aw-skill-eval schema print eval-execution-plan`
   - `aw-skill-eval schema print eval-audit-result`
   - `aw-skill-eval schema print eval-run-bundle`

6. 要求 plan、audit 和预期 bundle 的 `schemaVersion` 均为 `2`。其它版本不兼容。

完成条件：命令可用，capabilities v1 有效，所需能力存在，三种合同均为 schema v2。

## 3. EvalAuditResult 运行前审核

必须按以下顺序检查，不得在失败后继续：

1. audit 文件存在，plan 中的 audit digest 与当前文件匹配。
2. audit 符合 canonical `eval-audit-result` schema v2。
3. `producer` 是 `audit-agent-skill-evals`，`mode` 是 `preflight`，并且结果来自独立上下文。
4. `validity` 是 `pass`，`blockedCases` 为空，所有计划执行的 case 均已准入。
5. 运行 `aw-skill-eval digest skill <skill-dir>`，并要求输出的 digest 同时匹配 plan target digest 和 audit target Skill digest。
6. 要求当前 case corpus digest 同时匹配 plan 和 audit。不得改写 case、Oracle 或 audit 来消除不匹配。

任一步失败时，返回具体不匹配项，并交回 `audit-agent-skill-evals(preflight)`。不得启动 run。

完成条件：当前 Skill、case corpus、plan 和独立 preflight audit 形成同一组 digest 绑定，且没有 blocked 或未准入 case。

## 4. 验证并执行

1. 运行 `aw-skill-eval plan validate <plan.json>`。要求 stdout JSON 中 `valid` 为 `true`； `valid=false` 或非零退出时停止并报告 `errors`。
2. 重新确认 plan 没有在 preflight 后变化。
3. 运行 `aw-skill-eval run <plan.json>`。不得用 shell 包装命令，也不得自行实现 provider、 snapshot、进程管理、timeout、采集或 evidence-level 逻辑。
4. 要求 stdout 是 `{valid:true,bundlePath,bundleDigest,evidenceLevel}`。非零退出时保存脱敏的 stderr 摘要并停止；不得把不完整运行称为通过。standalone process provider 使用进程观察和 Skill 前后 digest 时，后代清理不受保证，bundle 必须保留该限制，且不得称为 comparative 或 release-grade 证据。
5. 运行 `aw-skill-eval bundle validate <bundle.json>`，其中路径使用上一步返回的 `bundlePath`。要求 stdout JSON 中 `valid` 为 `true`，并核对 calculated digest 与 run 返回的 `bundleDigest`。

完成条件：plan validation、run 和 bundle validation 均成功，且 bundle path 和 digest 已绑定。

## 5. 结果归因交接

把以下内容交给 fresh-context `audit-agent-skill-evals(result-triage)`：plan 路径、preflight audit 路径与 digest、bundle 路径与 digest、`evidenceLevel`、capabilities、运行限制、失败或未完成项。由 triage 读取真实 bundle 和证据后判断 failure attribution、有效性与下一步。

本 Skill 不自行解释失败，不修改 production Skill，不发布 Review，也不维护 batch 或 currentness。

完成条件：triage 已收到可验证路径、digest 和限制；若运行未形成有效 bundle，则已交接失败摘要且没有发布结论。

## 边界

- `aw-skill-eval` 和 `@lesliechan721/agent-skill-eval` 是机器合同的唯一执行真值。
- 模型可读的 plan 模板位于 `assets/eval-execution-plan.template.json`；它不是 schema 或 validator，使用前必须复制到工作区并填充真实绑定。
- provider、snapshot、process、timeout、capture、bundle 和 evidence level 均由共享包负责。
- 新进程或 Skill snapshot 本身不证明独立上下文或操作系统 sandbox。
- capability 支持不等于证据等级。只有 bundle 中真实的 `evidenceLevel` 和 `limitations` 能说明本次运行可支持的结论。
