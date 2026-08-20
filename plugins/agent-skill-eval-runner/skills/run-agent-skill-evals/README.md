# Run Agent Skill Evals

显式执行已经通过独立 Oracle preflight 的 Agent Skill Eval plan，并生成可移植的
`EvalRunBundle` 证据包。

## 适合使用

- 已有有效的 `EvalExecutionPlan` 和匹配当前 Skill/case corpus 的审核结果。
- 用户已允许模型成本、外部进程和临时输出。
- 需要通过已配置的 provider 执行并收集结构化证据。

## 工作方式

使用 `$run-agent-skill-evals` 显式调用。Skill 会先验证 plan、audit、digest 和 provider
能力，再执行已准入的 case，并返回证据包路径、digest、限制和未完成项。

```text
使用 $run-agent-skill-evals 执行 plans/release-evals.json。
```

## 不适合使用

- 设计或审核 Eval case、Oracle 或 grader。
- 判断失败是否属于 Skill 缺陷。
- 修改 production Skill 或发布最终 Review。

## 边界

- Provider 命令、模型成本、认证环境和外部进程必须由用户明确授权。
- Skill snapshot 和 digest 核验用于隔离与变更检测，不等同于操作系统 sandbox。
- Runner 只记录 provider 能证明的能力，不自动声明 `release-grade`、独立上下文或比较证据。
