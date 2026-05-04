---
name: codex-explore
description: 手动启动 Codex 专用只读 explorer，帮助主 agent 并行调查代码库问题。
user-invocable: true
metadata:
  short-description: 手动只读代码库探索 workflow
---

# Codex Explore

这是手动 `$codex-explore` workflow。只有用户显式调用 `$codex-explore`，或安装时把该 skill 改为 auto trigger 后，主 agent 才应按这里的完整流程委派专用探索角色。

## 何时使用

先判断是否真的需要 explorer。已知单个文件、单个符号，或 2 到 3 个文件内的小搜索，优先由主 agent 用本地工具完成。

适合委派的情况包括：问题边界不清、涉及多个模块、需要比较既有实现模式、需要独立核对假设，或探索任务能和主 agent 的本地工作并行推进。

## 委派规则

主 agent 使用 `spawn_agent`，并把 `agent_type` 设为 `"codex-explorer"`。除非用户另有要求，默认启动 1 个 explorer；复杂且互不重叠的问题可启动 2 到 3 个；极复杂场景最多 4 个。

每个 explorer 的 prompt 必须包含：
- 范围：限定目录、文件、模块或行为边界。
- 具体问题：说明要回答什么，不要只写“看看这个模块”。
- 探索深度：只能使用 `quick`、`medium`、`very thorough`。
- 输出格式：要求返回关键结论、证据路径、必要行号、不确定点和建议主 agent 下一步查看的内容。
- 只读要求：明确不得创建、编辑、移动、删除、格式化或回退文件，不得安装依赖，不得运行破坏性命令。

不要把实现、修改、格式化、提交、需要用户授权的动作，或主 agent 下一步必须立即依赖的阻塞决策交给 explorer。

## 等待与整合

explorer 运行时，主 agent 继续做不重叠的本地调查。已经启动 explorer 后，必须等待它进入最终状态并读取结果；不要因为等待一段时间没有返回，就关闭 explorer 并自己完成同一个探索问题。

整合结果时，只保留关键结论、文件路径、必要行号和不确定点。必要时补读少量代码验证，不要把完整子代理回复倾倒给用户。

读取并整合结果后，立即用 `close_agent` 关闭本 workflow 启动的 explorer。`wait_agent` 只代表等待结果，不等于关闭 agent。
