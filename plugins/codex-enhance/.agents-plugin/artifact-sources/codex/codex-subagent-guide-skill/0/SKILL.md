---
name: codex-subagent-guide
description: 仅当 Codex 子代理委派已由用户、适用 AGENTS.md 或其它 skill 明确授权，且没有专用 skill 管理本次委派时使用；选择 role 与 model/reasoning_effort，默认使用干净上下文，并规范响应式等待和清理。若任务只要求判断、讨论或建议是否需要委派或多 Agent 并行，不要使用。本 skill 不授予或判断委派权限。
compatibility: Requires Codex multi-agent spawn_agent.agent_type and the four bundled roles; wait and cleanup rules apply only when exposed by the current tool schema.
metadata:
  short-description: 子代理任务分类、参数选择、上下文继承、等待与清理原则
---

# Codex Subagent Guide

以当前工具 schema 为准，只使用其公开能力。

## Spawn 参数

显式指定 `model`、`reasoning_effort` 或 `agent_type` 时按其作用域作为自定义任务；否则按当前 `agent_type` schema 中 `codex-subagent-*` role 的描述选择足以可靠满足验收的最低档。依据歧义、依赖耦合、验证难度和关键遗漏代价，不按任务名称分类。

- preset 的路由字段只传所选 `agent_type`；role 不可用时停止，不改用动态 model override。
- 自定义任务只传作用于该子任务、schema 公开且目标模型支持的显式字段；不可用或冲突时停止，不猜测、试探或降级。

## 上下文

默认使用干净上下文，按 schema 传 `fork_turns: "none"` 或 `fork_context: false`。`message` 自包含目标、范围、必要事实、约束、成功标准、验证要求和预期输出。

只有明确要求继承，或任务无法通过完整 message 自包含时才继承；不为缩短说明而继承。上下文选择独立于 preset/custom。不能同时满足指定继承范围和路由字段时停止，不省略参数或用更多历史近似。

## 续接与新建

仅为续接或补足同一交付复用原代理，且其工作状态仍有效、值得保留，并且不要求独立重评。临时执行故障优先恢复并促使原代理续接；先核对已落地进度，避免重复副作用。原代理不可恢复时，确认原工作已停止后，以可核验进度移交新代理。

新交付或对当前版本的独立全面重审使用干净代理。移交只带必要事实、产物、当前版本和未完成项，不把旧结论当作前提或检查范围上限。不单凭主题相近、空闲时长或推测的缓存命中决定复用。

## 等待与清理

只在需要结果才能继续时等待。除非用户或专用 skill 明确覆盖，当前 schema 允许时，首次响应式等待至少 10 分钟；超时不是失败，结果仍必要时继续使用不短于前次且不超过上限的窗口。只有工具结果或通知明确表示终态时才算完成。

通过代理工具或通知判断状态，不用短周期轮询、主动探测或工作区变化监控。所需结果已保留且目标及其后代没有具体的待续接工作时，按当前工具能力清理；停止未确认仍视为活跃。
