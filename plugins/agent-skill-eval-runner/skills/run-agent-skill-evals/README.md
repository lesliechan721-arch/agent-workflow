# Run Agent Skill Evals

显式执行已经通过独立 Oracle preflight 的 Agent Skill Eval plan，并生成可移植的 `EvalRunBundle` 证据包。

## 适合使用

- 已有有效的 `EvalExecutionPlan` 和匹配当前 Skill/case corpus 的审核结果。
- 用户已允许模型成本、外部进程和临时输出。
- 已手动安装兼容的 `aw-skill-eval`，需要执行并收集结构化证据。

## 工作方式

使用 `$run-agent-skill-evals` 显式调用。Skill 会先验证 plan、audit、digest 和 provider 能力，再通过共享 CLI 执行已准入的 case，并把证据包交给 result triage。

```text
使用 $run-agent-skill-evals 执行 plans/release-evals.json。
```

## 不适合使用

- 设计或审核 Eval case、Oracle 或 grader。
- 判断失败是否属于 Skill 缺陷。
- 修改 production Skill 或发布最终 Review。

## 边界

- 需要 `agent-skill-toolkit` 和 `@lesliechan721/agent-skill-eval >= 0.1.1`。共享包跟随 AW lockstep 版本；运行时根据 bin、capabilities v1、plan/bundle schema v2 和 audit schema v3 fail closed。
- 不使用 `npx`，也不隐式安装或下载依赖。
- Provider 命令、模型成本、认证环境、网络和外部进程必须由用户明确授权。
- 共享包负责 provider、snapshot、进程、timeout、采集、bundle 和 evidence level；本 Skill 只负责人工 gate、preflight、命令编排和 triage 交接。
- standalone 进程观察不保证后代清理，也不产生 comparative 或 release-grade 证据；使用方必须保留 bundle 的 `evidenceLevel` 和 `limitations`。
