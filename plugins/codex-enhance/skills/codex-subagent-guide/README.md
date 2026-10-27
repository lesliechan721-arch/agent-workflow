# Codex Subagent Guide

本 Skill 用于**实际委派**：选择配置、准备独立任务输入、等待与续接，并验收或清理执行。核心方法在 [SKILL.md](SKILL.md)。

按分支读取资料，不必在普通委派开始时加载所有引用：

- 调用方已选执行配置时直接调度；需要自行选择时，读取 [执行配置](references/execution-profiles.md)，优先按数组顺序匹配自定义配置，未匹配时使用内建档位。
- 选择**非 native** 执行器时，读取 [外部委派](references/external-delegation.md)：配置模式、`start`/`wait`/`result`/`stop`、本次完整通讯能力和诊断，以及到期边界。关闭通讯仍可运行和读取结果；当前 Antigravity 通讯未取得真实支持依据，开启时在模型输入前失败。
- **准备发送或回复**且本次通信能力为 `true`，或**实际收到过程消息、投递缺口**时，读取 [通信分支](references/communication.md)。仅有 `communication: true` 不要求预读。
- 使用 bundle 的 `--file` 时，读取 [文件选择](references/file-selection.md)，核对选择与外发范围。

默认 [任务指令](assets/task-instructions.md) 是外部执行的可选角色资源；[子侧通信说明](assets/communication-instructions.md) 仅由实际配置了通信能力的 adapter 交给子代理，主代理不需预读。调用与输出参数以实际工具能力为准。

配置或排查 Codex profile、hook 信任及显式 bypass 时，读取 [Codex profile](references/codex-profile.md)。CLI 来源、adapter wire 和后端验收范围见 [适配器说明](adapters.md)；支持范围需要对应后端和原生 OS 的真实证据。
