# Claude Code 适配器

公共要求见 [配置与接入](configuration.md)、[Adapter v5](protocol.md) 和 [运行生命周期](runtime.md)。

Claude Code 固定 workspace，通过持续输入及已配置的 MCP 接入，使用 mcp / turn-boundary，同时提供主动收件。

通信开启且不能可靠确认完整权限时，为本次 `--mcp-config` 的动态 server `aw_parent_<runId>`，在启动 argv 中加入两个精确工具名的 `--allowedTools`：`mcp__aw_parent_<runId>__send_parent`、`mcp__aw_parent_<runId>__receive_parent`。用户已有 `--allowedTools` / `--allowed-tools` 规则合并为一个等价列表；保留 --settings 及其它 MCP，不写用户或项目权限文件，不使用 server 通配、通用审批回调或 settings 热加载。动态 server 与项目 .mcp.json 的信任审批不同，本次不批准其它 server。

需要额外许可时，在首次模型输入前检查显式 `--disallowedTools` / `--disallowed-tools` 和 `--settings` JSON 或文件中的 `permissions.deny`、`permissions.ask`。完整工具名、裸 MCP server 名或官方支持的 `*` 通配若限制本次 send/receive，分别返回 `communicationToolDenied` 或 `communicationToolApprovalRequired`，保留限制。后端才暴露的默认配置、管理策略和交互审批按真实失败处理；allow 存在不证明已放行。规则依据：[Claude 权限合同](https://code.claude.com/docs/en/permissions#tool-name-wildcards)、[MCP 匹配](https://code.claude.com/docs/en/permissions#mcp)及 [CLI 参数](https://code.claude.com/docs/en/cli-reference)。

executor full-access、default 下显式 --dangerously-skip-permissions / --permission-mode=bypassPermissions，或正常读取的显式 settings.permissions.defaultMode=bypassPermissions 且未被显式 mode 覆盖时，跳过额外通信 allow 和专属冲突预检；仍绑定当前 bridge。仅 --allow-dangerously-skip-permissions 不表示已进入完整权限。无法在启动前可靠取得的隐式继承模式按精确许可路径处理，不复制后端配置合并器。communication=false 不准备通信许可或读取专属权限配置；普通任务的模式及配置加载保持原行为。

## 恢复与工具重绑

恢复使用 `--resume <sessionId>` 续接绑定会话，每次重新传入 `--mcp-config` 的当前 AW bridge，在首次输入前按上述条件合并当前两个工具的 allow，并提供必要通信说明；只发送本次新消息，不重复初始任务，不 fork 或新建回退。收到真实 session_id 后及时发 session 帧；实际 ID 必须与绑定一致。

`--no-session-persistence` 或有效的 `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 关闭持久化时，resume 为 unsupported；配置关闭时为 disabled。用户 args 不得指定 `--session-id` 或覆盖 wrapper 拥有的 resume/fork 入口。会话缺失或恢复失败按真实错误收尾，不自动重发。Claude 不默认全局提高 MAX_MCP_OUTPUT_TOKENS；24 KiB 工具正文和封套须在实际版本及宿主预算下验证，server 已发送不证明模型已完整接收。真实会话恢复、当前工具绑定及平台支持须分别取得运行证据。
