---
name: codex-subagent-guide
description: 当用户、适用 AGENTS.md 或其它技能已经授权 Codex 使用子代理、委派或并行 agent 工作，且没有专用 skill 自行完整管理本次委派时使用；提供通用的子代理调度、上下文与等待清理原则。不与已经定义独立委派流程的专用 skill 叠加使用，也不用于判断是否应该委派；技能加载本身不授予委派权限。
compatibility: Preset routing requires Codex multi-agent V1 or V2 spawn_agent with agent_type exposed and the four bundled agent roles installed; waiting and cleanup guidance uses only capabilities exposed by the current tool schema.
metadata:
  short-description: 子代理任务分类、参数选择、上下文继承、等待与清理原则
---

# Codex Subagent Guide

委派必须已经获准；本 skill 只指导调度参数、上下文、等待和清理原则，不构成使用子代理的授权。

始终以当前会话公开的工具名称、schema 和描述为准。以下规则只在相应工具和字段公开时适用；未公开时跳过，不先判断子代理工具版本，也不从一个工具推断其它工具存在。若当前 schema 与本 skill 冲突，以 schema 为准。不要把文件变化、Git diff 或测试输出当作完成信号。

## Spawn 参数

{{spawnParameterGuidance}}

## 选择上下文

默认使用干净上下文，并按当前 `spawn_agent` schema 传表示“不继承”的值，例如 `fork_turns: "none"` 或 `fork_context: false`。在 `message` 中写清目标、范围、必要事实、约束、成功标准、验证要求和预期输出。

只有用户、适用规则或其它已加载 skill 明确要求继承，或任务无法通过完整 `message` 自包含必要上下文时，才使用非干净上下文。具体模式和兼容性服从当前工具 schema。context 选择独立于预设或自定义任务分类；不要仅为了少写委派说明而继承。

## 等待与关闭

只有下一步被必要结果阻塞时才调用 `wait_agent`。`timeout_ms` 是单次最长等待窗口，不是轮询周期。用户或任务专用 skill 明确指定单次等待时优先遵守；否则首次等待在当前 schema 允许时至少使用 `{{minimumInitialWaitMinutes}}` 分钟的响应式窗口（`timeout_ms={{minimumInitialWaitTimeoutMs}}`）。调用时只等待尚未终态的 agent；活动通知不等于最终结果。

timeout 不是终态或失败。结果仍必需时，继续使用相同或更长且不超过当前 schema 上限的响应式等待窗口；只有工具结果或运行时通知明确表示终态时才视为完成。

收到终态结果后按任务成功标准校验。存在可恢复缺口时，若当前工具支持复用仍可用的原 agent 继续或重新答复，发送一次聚焦缺口的 follow-up 并重新校验；不要为相同任务重复 spawn。结果仍不合格、原 agent 不可用或缺口需要新授权时，适用规则允许则由主代理补齐安全且范围内的缺口，否则向用户说明未解决项。

不得使用 shell `sleep`、短 wait 循环、周期性状态查询、反复读取文件、Git 或测试状态，以及重复进度询问来监控子代理。

当前工具提供 `close_agent` 时，只有在所需结果或终态信息已保留，且目标及其后代均不再需要后续调用后，才关闭目标。没有 `close_agent` 时无需额外清理。
