# Codex Subagent Guide

本 Skill 用于**实际委派**：选择配置、准备独立任务输入、等待与续接，并验收或清理执行。核心方法在 [SKILL.md](SKILL.md)。

按分支读取资料，不必在普通委派开始时加载所有引用：

- 调用方已选执行配置时直接调度；需要自行选择时，读取 [执行配置](references/execution-profiles.md)，优先按数组顺序匹配自定义配置，未匹配时使用内建档位。
- 选择**非 native** 执行器时，读取 [外部委派](references/external-delegation.md)：配置模式、稳定 AW 入口下的 `start`/`wait`/`result`/`stop`，以及文件输入/导出、简短回执、通信、诊断和到期边界。
- **准备发送或回复**且本次通信能力为 `true`，**恢复已结束且恢复能力为 `true` 的任务**，或**实际收到过程消息、投递缺口**时，读取 [通信与恢复](references/communication.md)。仅有 `communication=true` 不要求预读。
- 使用 bundle 的 `--file` 时，读取 [文件选择](references/file-selection.md)，核对选择与外发范围。

默认 [任务指令](assets/task-instructions.md) 是外部执行的可选角色资源；[子侧通信说明](assets/communication-instructions.md) 仅由实际配置了通信能力的 adapter 交给子代理，主代理不需预读。任务和消息仅接受文本或文件，完整结果可直接导出到新文件。升级、重装或删除 Guide 及托管 adapter 前，先完成或停止活跃任务。

外部任务保存在 `~/.aw-subagent`，保留期由 `subagentRetentionHours` 控制，默认 24 小时；`0` 表示永不过期且不扫描。恢复复用原句柄、执行器、配置和后端 session，只保留最新一次执行；需要旧结果时先导出。同一用户可凭句柄跨父会话恢复，是否可用以实际 `resume` 能力和停止证据为准。消息正文最多 24 KiB，长消息使用文件输入；普通 wait/result 总回执最多 32 KiB，大报告直接导出。

外部入口的 `--help` 显示操作总览，`<操作> --help` 显示当前操作的参数与示例。正常信息默认省略，最终报告不重复 ready 阶段已报告的诊断；需要查看完整诊断时，在该次命令加 `--diagnostics`，导出时也可使用。

开发或维护执行器时，读取 [适配器说明](docs/README.md)。
