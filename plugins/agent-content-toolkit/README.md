# Agent Content Toolkit

提供 `agent-content`，用于编写、重构和只读评价给 Agent 读取的文档（AGENTS.md、CLAUDE.md、prompt、角色说明和 reference），减少抽象空话、重复免责条款、弱指针与多跳读取负担。

```bash
aw target set codex
aw plugin install agent-content-toolkit --scope user
```

安装目标包括 Codex、Claude Code、Antigravity、Cursor、OpenCode、Pi、GitHub Copilot CLI 和 Grok Build；`generic` 只输出通用 Skills。AW 按目标核对组件能力，并提示客户端无法保证的调用控制。

例如：“整理这份 AGENTS.md，去掉泛泛而谈的空话，保留项目事实和安全约束。”或“只读评价这些 reference 的信息层级和跳转路径。”它遵守当前请求的写入边界；完整 Skill 包处理请使用 `agent-skill`。
