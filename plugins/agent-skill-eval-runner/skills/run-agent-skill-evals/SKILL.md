---
name: run-agent-skill-evals
description: >-
  仅当用户或上层工作流明确要求执行已经通过独立 Oracle preflight 的 Agent Skill Eval plan，并允许相应模型成本、进程和临时输出时使用。负责运行、隔离和采集证据；不设计或审核 case，不解释失败归因，不修改 Skill，也不发布最终 Review。
disable-model-invocation: true
user-invocable: true
compatibility: Requires Node.js 20+, agent-skill-toolkit >= 0.4.0, and an explicitly configured provider command.
metadata:
  short-description: 执行已审核的 Skill Eval plan 并产生可移植证据包
---

# Run Agent Skill Evals

本 Skill 是显式、高成本执行入口。缺少用户授权、有效 plan、匹配当前 Skill/corpus 的 `EvalAuditResult(validity=pass)`，或 provider 能力不足时停止。

## 工作流

1. **验证计划**：运行 `node scripts/validate-eval-execution-plan.mjs <plan.json> --format json`。验证 audit 文件、digest、目标 Skill digest、case corpus digest、输出目录和 provider argv。
2. **核对权限与能力**：计划必须绑定 provider capability 文件。`command` 只保证显式 argv 进程与基础采集；`codex-trigger` 使用 AW CLI 的 canonical Codex app-server driver，且只支持通过严格隔离探测的 with-skill trigger discovery。不得请求 provider 未声明的 baseline、trace、sandbox 或 materialization。`inheritEnvironment=true` 会把当前进程环境交给 provider，只能在用户明确授权且 provider 需要认证时使用；默认使用最小环境。
3. **执行**：运行 `node scripts/run-agent-skill-evals.mjs <plan.json>`。Codex trigger provider 的 argv 使用 `node providers/codex-trigger-provider.mjs`，并通过 `AW_CODEX_EVAL_DRIVER_ROOT` 指向已构建的 AW CLI driver。不得改写 case、Oracle 或生产 Skill；不得用 shell 包装 provider command。
4. **采集**：保存每次 stdout、stderr、provider artifacts、exit code、duration、configuration 和 digest；只在 provider 明确返回时记录 usage/grading。
5. **交付**：返回 `EvalRunBundle` 路径、digest、evidence level、limitations 和未完成 run。失败归因交给 fresh-context `audit-agent-skill-evals(result-triage)`。

## 边界

- 无 runner 不等于 Skill 缺陷；Review 仍可把证据等级记为 `structural`。
- `executed` 仅证明运行发生；有 with-skill 与 baseline 才可记为 `comparative`。
- 本 runner 不自动宣称 `release-grade`，除非外部 provider/harness 另有可验证合同。
- 不维护项目 report publish/release、README 登记、batch/currentness 或 AW materialization。
