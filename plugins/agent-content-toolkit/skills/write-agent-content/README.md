# write-agent-content

创建或编辑 AGENTS.md、CLAUDE.md、prompt、role instruction、reference 等 Agent 直接读取的内容。

## 什么时候使用

- 你要新增或修改一份 Agent-facing 指令文档。
- 现有内容需要更清楚的上下文指针、完成边界或内容剪枝。

不要用于完整 Agent Skill 包的创建或变更，也不要用于只读质量评审。

## 怎样调用

模型可以按任务自动调用，也可以显式使用 `$write-agent-content`。

示例请求：

- “重写这份 AGENTS.md，只保留每次任务都需要的规则。”
- “为这个代码审核 role 写一份简短 prompt，并明确停止条件。”

## 会发生什么

1. Agent 读取目标、上层指令和可达参考资料。
2. Agent 选择最小必要结构，修改目标内容，并删除本次修改造成的冗余。
3. Agent 返回修改文件、主要取舍和已做检查。

## 权限和边界

- 可以修改用户指定的 Agent-facing 文件。
- 不创建完整 Skill 包，不做独立质量评分，也不改动范围外文档。
