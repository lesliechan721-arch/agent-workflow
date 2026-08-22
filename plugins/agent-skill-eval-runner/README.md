# agent-skill-eval-runner

执行已经通过独立 Oracle 审核的 Agent Skill Eval。

插件依赖 `agent-skill-toolkit` 和 `@lesliechan721/agent-skill-eval`。安装系统负责解析插件依赖；运行环境必须提供 `aw-skill-eval` 命令。

`run-agent-skill-evals` 可以由模型自动选择，也可由用户显式调用。它会先执行本次运行的人工授权 gate，再核对 `EvalAuditResult`、Skill digest 和 case corpus digest；未经审核或绑定不一致的请求会在启动模型前停止。

本插件不设计或审核 case，不实现 provider、snapshot、进程控制、timeout、证据分级、schema 或 validator。运行结果必须交给 `audit-agent-skill-evals` 的 `result-triage` 模式审核。
