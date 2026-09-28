# Agent Content Toolkit

为 Agent 指令提供共同的写作与评价方法，帮助减少重复规则、弱指针和不必要的上下文负担。

```bash
aw install agent-content-toolkit --scope user --target codex
```

也支持 Claude Code，可改用 `--target claude-code`。包含 `agent-content`，用于 AGENTS.md、CLAUDE.md、prompt、role instructions 和 reference。

例如：“整理这份 AGENTS.md，保留事实与必要约束。”或“只读评价这些 reference 的读取路径。”它遵守当前请求的写入边界；普通输出是修改或人读建议。完整 Skill 包、模型评估和插件发布由对应能力负责。
