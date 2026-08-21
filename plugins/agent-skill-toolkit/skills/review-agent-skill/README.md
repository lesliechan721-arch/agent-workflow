# review-agent-skill

通用、只读、质量导向的 Agent Skill Reviewer。

默认产物是人类可读报告。确定性包事实由 `check-agent-skill.mjs` 提供；需要自动化交接时，可选输出薄 `ReviewResultLite`。本 Skill 不维护多阶段 handoff 状态，不计算项目发布资格，也不要求 quick/full/delta 生成 bundle。
