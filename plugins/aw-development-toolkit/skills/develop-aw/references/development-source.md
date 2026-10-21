# Development Source

只有用户明确要求本地 CLI 使用当前 Workspace 时运行 `aw catalog dev activate`。该命令拥有 build、complete validate、managed source 注册、sync 和 readiness；不要前后重复组成 build→validate→activate→status 链。

activate 返回完整结果时，直接采用其 readiness。结果不完整或需要诊断当前状态时，在当前任务内查询 `aw catalog dev status`；用户明确要求查看时也使用该入口。

停用按当前任务的明确授权执行 `aw catalog dev deactivate`。不使用低层 source mutation 替代开发源操作。
