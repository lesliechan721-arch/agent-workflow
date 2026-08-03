---
name: codex-subagent-guide
description: 当用户、适用 AGENTS.md 或其它技能已明确要求 Codex 使用子代理、委派或并行 agent 工作时使用，为已获准的委派选择任务角色和参数、安排上下文，并管理等待、超时与清理。不用于判断是否应该委派；技能加载本身也不授予委派权限。
compatibility: Supports Codex multi-agent V1 and V2 collaboration tools with the bundled agent roles installed.
metadata:
  short-description: 子代理任务分类、fork 与等待指导
---

# Codex Subagent Guide

委派必须已经获准；本 skill 只指导参数和生命周期，不构成使用子代理的授权。

始终以当前会话公开的工具名称、schema 和描述为准。以下规则只在相应工具和字段公开时适用；未公开时跳过，不先判断子代理工具版本，也不从一个工具推断其它工具存在。若当前 schema 与本 skill 冲突，以 schema 为准。不要把文件变化、Git diff 或测试输出当作完成信号。

## Spawn 参数

{{spawnParameterGuidance}}

- 只传当前 `spawn_agent` schema 公开且目标模型支持的字段和值。
- 用户、其它技能或规则显式指定的自定义值不可用时停止并说明，不循环试探或降级到预定义任务。

## 选择上下文

默认使用干净上下文，并按当前 `spawn_agent` schema 传表示“不继承”的值，例如 `fork_turns: "none"` 或 `fork_context: false`。在 `message` 中写清目标、范围、必要事实和预期输出。

只有用户明确要求，或任务无法通过完整 `message` 自包含必要上下文时，才使用非干净上下文。完整历史、按轮次继承或其它非干净模式都统一视为继承上下文，具体参数和兼容性服从当前工具 schema；显式要求无法同时满足时停止并说明。不要仅为了少写委派说明而继承。

## 等待与关闭

只有下一步被必要结果阻塞时才调用 `wait_agent`。`timeout_ms` 是单次最长等待窗口，不是轮询周期：读取当前 schema 的 min、default、max，并选择足以覆盖预计剩余工作的长窗口。描述为 mailbox wait 时会被 mailbox 或用户输入提前唤醒，可以偏向较长窗口；其它 wait 按任务预计剩余时间选择。不要使用固定通用值。

- `wait_agent` 公开 `targets` 时，只传尚未终态的 agent；多个 targets 表示等待其中任意一个完成。整合返回的终态结果后只等待剩余 targets。
- `wait_agent` 未公开 `targets` 且描述为 mailbox wait 时，不传 targets。`Wait completed` 只表示发生了活动；最终内容来自完成通知。
- 当前工具列表公开 `close_agent` 时，目标及后代都不再需要后调用它释放槽位。`close_agent` 会连同后代一起关闭；不要关闭仍有必要后代工作的 agent。
- `list_agents` 只用于偶发状态对账；`interrupt_agent` 只中断当前 turn，不是 close。

timeout 不代表失败。结果仍必需且当前仍阻塞时，继续使用相同或更长的 wait；不要重复 spawn 相同任务。

不得使用 shell `sleep`、短 wait 循环、周期性 `list_agents`、反复读取文件/Git/测试状态或发送“进度如何”消息来监控子代理。没有 `wait_agent` 时继续不重叠工作并依赖完成通知；完全阻塞时说明等待能力缺失。
