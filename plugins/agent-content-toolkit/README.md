# Agent Content Toolkit

为 Agent 指令提供共同的写作与评价方法，帮助减少重复规则、弱指针和不必要的上下文负担。

```bash
aw target set codex
aw plugin install agent-content-toolkit --scope user
```

安装目标包括 Codex、Claude Code、Antigravity、Cursor、OpenCode、Pi、Gemini CLI、GitHub Copilot CLI 和 Grok Build；`generic` 只输出通用 Skills。实际调用控制与客户端能力按目标核对，无法保留的组件语义会显示为未满足。包含 `agent-content`，用于 AGENTS.md、CLAUDE.md、prompt、role instructions 和 reference。

例如：“整理这份 AGENTS.md，保留事实与必要约束。”或“只读评价这些 reference 的读取路径。”它遵守当前请求的写入边界；普通输出是修改或人读建议。完整 Skill 包、模型评估和插件发布由对应能力负责。
