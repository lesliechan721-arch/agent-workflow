# Run AW Skill Evals

使用 `aw-skill-eval` 执行 `AwSkillEvalExecutionPlan v3`，并生成 `EvalRunBundle v3`。

## 适合使用

- 已有有效的 `AwSkillEvalExecutionPlan`。
- 用户已允许模型成本、外部进程和临时输出。
- 已手动安装兼容的 `aw-skill-eval`，需要执行并收集结构化证据。

## 工作方式

使用 `$run-aw-skill-evals` 显式调用。Skill 会先确认本次副作用授权，再验证 plan、Skill digest 和 provider 能力，最后执行并验证证据包。

```text
使用 $run-aw-skill-evals 执行 plans/release-evals.json。
```

## 不适合使用

- 设计或审核 Eval case、Oracle 或 grader。
- 判断失败是否属于 Skill 缺陷。
- 修改 production Skill 或发布最终 Review。

## 边界

- 需要 `@lesliechan721/agent-skill-eval >= 0.1.0`。运行时根据 bin、capabilities v1 及 plan/bundle schema v3 fail closed。
- 不使用 `npx`，也不隐式安装或下载依赖。
- Provider 命令、模型成本、认证环境、网络和外部进程必须由用户明确授权。
- Plan 可用可选的 `minimumEvidenceLevel` 要求 `executed` 或 `comparative`；省略时保持 `executed`。
- macOS/Linux 的 comparative 运行要求 Full Access 或普通 Terminal 通过进程树能力探测。受限 Codex profile、未知非空 profile 或 Windows standalone 会在启动 provider 前阻断。单次提权不等于 Full Access。
- 共享包负责 provider、snapshot、进程、timeout、采集、bundle 和 evidence level；本 Skill 只负责人工授权、能力检查、命令编排和 bundle 完整性。
- 未经 Audit 和 result triage 的 bundle 只能作为原始诊断证据，不得进入 Review 或发布结论。
- Full Access 的 `verified-observed` 会在 marker 观察、冻结、清理、结束复查和 Skill digest 复查全部通过后接受 grading，并可产生 comparative evidence。它不是 OS 强隔离，bundle 必须保留该 limitation。
- 只要求 executed 时仍可在受限环境运行，但不接受 grading。清理验证失败时，runner 返回非成功并可保存诊断 bundle。
