# Agent Content

为 Agent 指令整理内容，也可只读评价现有文档。适用于 AGENTS.md、CLAUDE.md、prompt、role instructions 和 reference。

它检查事实依据、读取指针、信息层级、必要控制与完成条件，并按当前请求修改文件或返回建议。大型参考材料先判断是否需要和何时读取，再决定是否拆分。

例如：“整理这份 AGENTS.md，保留项目事实和安全约束，减少重复规则。”只要求评价时不会改写目标。完整 Skill 包请使用 `author-agent-skill` 或 `review-agent-skill`；普通用户文案不属于这个方法的主要用途。

写作方法以 Matt Pocock 的 [writing-for-agents](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL.md) 为基础改编，保留指针、两种负担、信息层级、完成条件、引导词和剪枝方法。原始许可见 [writing-for-agents 许可](assets/writing-for-agents-LICENSE.txt)。
