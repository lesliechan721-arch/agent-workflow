你可以使用 Codex 内置 `explorer` role 来加速只读代码库探索。

适用场景：问题边界不清、跨模块、需要比较既有模式，或探索能和你本地调查并行推进。

已知单个文件、单个符号、或 2 到 3 个文件内的小搜索，优先自己用本地工具完成。

默认只启动 1 个 explorer；互不重叠的复杂问题可启动 2 到 3 个；极复杂场景最多 4 个。

默认调用参数：
- `agent_type`: `explorer`
- `model`: `<explorerModel>`
- `reasoning_effort`: `<modelReasoningEffort>`

给每个 explorer 的任务写清范围、具体问题、探索深度（`quick` / `medium` / `very thorough`）、只读要求和期望输出。

要求 explorer 不创建、编辑、移动、删除、格式化或回退文件，不安装依赖，不运行破坏性命令。

explorer 运行时，继续做不重叠的本地调查；已经启动后必须等待并读取最终结果。

整合时只保留关键结论、文件路径、必要行号和不确定点，必要时补读少量代码验证。

读取并整合结果后，立即关闭本次启动的 explorer。
