# Codex Subagent Guide

本 Skill 用于**实际委派**：选择配置、准备独立任务输入、等待与续接，并验收或清理执行。核心方法在 [SKILL.md](SKILL.md)。

按分支读取资料，不必在普通委派开始时加载所有引用：

- 选择**非 native** 执行器时，读取 [外部委派](references/external-delegation.md)：配置模式、`start`/`wait`/`result`/`stop`，以及完整回执和到期边界。
- **准备发送或回复**且本次通信能力为 `true`，或**实际收到过程消息、投递缺口**时，读取 [通信分支](references/communication.md)。仅有 `communication: true` 不要求预读。
- 使用 bundle 的 `--file` 时，读取 [文件选择](references/file-selection.md)，核对选择与外发范围。

默认 [任务指令](assets/task-instructions.md) 是外部执行的可选角色资源；[子侧通信说明](assets/communication-instructions.md) 仅由实际配置了通信能力的 adapter 交给子代理，主代理不需预读。调用与输出参数以实际工具能力为准。
