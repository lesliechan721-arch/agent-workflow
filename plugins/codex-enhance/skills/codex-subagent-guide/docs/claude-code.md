# Claude Code 适配器

公共要求见 [配置与接入](configuration.md)、[Adapter v5](protocol.md) 和 [运行生命周期](runtime.md)。

Claude Code 固定 workspace，通过持续输入及已配置的 MCP 接入，使用 mcp / turn-boundary，同时提供主动收件。

Claude 通讯开启时，首次模型输入前检查显式 `--disallowedTools` / `--disallowed-tools` 和 `--settings` JSON 或文件中的 `permissions.deny`；完整工具名、裸 MCP server 名或官方支持的 `*` 工具名通配规则若禁止本次 AW send / receive，返回 `communicationToolDenied`，不更改权限。关闭通讯时保留这些参数并执行普通任务；不从 allow 列表推断拒绝，也不扫描用户默认配置。规则依据：[Claude 权限合同](https://code.claude.com/docs/en/permissions#tool-name-wildcards)、[MCP 匹配](https://code.claude.com/docs/en/permissions#mcp)及 [CLI 参数](https://code.claude.com/docs/en/cli-reference)。

## 恢复与工具重绑

恢复使用 `--resume <sessionId>` 续接绑定会话，每次重新传入 `--mcp-config` 的当前 AW bridge，并提供必要通信说明；只发送本次新消息，不重复初始任务，不 fork 或新建回退。收到真实 session_id 后及时发 session 帧；实际 ID 必须与绑定一致。

`--no-session-persistence` 或有效的 `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 关闭持久化时，resume 为 unsupported；配置关闭时为 disabled。用户 args 不得指定 `--session-id` 或覆盖 wrapper 拥有的 resume/fork 入口。会话缺失或恢复失败按真实错误收尾，不自动重发。Claude 不默认全局提高 MAX_MCP_OUTPUT_TOKENS；24 KiB 工具正文和封套须在实际版本及宿主预算下验证，server 已发送不证明模型已完整接收。真实会话恢复、当前工具绑定及平台支持须分别取得运行证据。
