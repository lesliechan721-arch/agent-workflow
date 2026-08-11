---
name: codex-subagent-guide
description: 仅在 Codex 子代理委派已由用户、适用 AGENTS.md 或其它 skill 明确授权，当前任务要求实际启动子代理或继续管理已启动或已完成的子代理，且没有专用 skill 管理时使用；选择 role 与 model/reasoning_effort，默认使用干净上下文，并规范响应式等待和清理。若任务只要求判断、讨论或建议是否需要委派或多 Agent 并行，不要使用。本 skill 不授予或判断委派权限。
compatibility: Requires Codex multi-agent spawn_agent.agent_type and the four bundled roles; wait and cleanup rules apply only when exposed by the current tool schema.
metadata:
  short-description: 子代理任务分类、参数选择、上下文继承、等待与清理原则
---

# Codex Subagent Guide

以当前工具 schema 为准，只使用其公开能力；不要推断工具版本或其它工具存在。

## Spawn 参数

{{spawnParameterGuidance}}

## 上下文

默认使用干净上下文，按 schema 传“不继承”的值，例如 `fork_turns: "none"` 或 `fork_context: false`；`message` 应自包含目标、范围、必要事实、约束、成功标准、验证要求和预期输出。

只有明确要求继承，或任务无法通过完整 `message` 自包含时才继承；不要仅为缩短委派说明而继承。上下文选择独立于 preset/custom。

## 等待与清理

只在需要结果才能继续时调用 `wait_agent`。除非用户或专用 skill 明确覆盖，当前 schema 允许时首次使用至少 `{{minimumInitialWaitMinutes}}` 分钟的响应式窗口（`timeout_ms={{minimumInitialWaitTimeoutMs}}`）；超时不是失败，结果仍必要时继续使用不短于前次且不超过上限的窗口。只有工具结果或通知明确表示终态时才算完成。

通过 agent 工具等待和判断状态；不得使用 shell `sleep`、短 wait 循环、周期性查询、文件、Git、测试状态或重复进度询问进行监控。

当前工具提供 `close_agent` 时，在所需结果或终态信息已保留，且目标及其后代均不再需要后续调用后关闭。
