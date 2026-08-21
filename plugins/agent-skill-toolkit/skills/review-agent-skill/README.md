# review-agent-skill

通用、只读、质量导向的 Agent Skill Reviewer。它既可评单个 Skill，也可在用户明确要求时评审由多个 Skill、runner 和合同组成的 workflow/plugin/system。

默认产物是人类可读报告。确定性包事实由 `check-agent-skill.mjs` 提供；需要自动化交接时，可选输出薄 `ReviewResultLite`。本 Skill 不维护多阶段 handoff 状态，不计算项目发布资格，也不要求 quick/full/delta 生成 bundle。

系统级评审先做端到端最小架构挑战：比较当前 common path 与同样安全的最小候选，并把可重算状态、重复 owner、持久 handoff 与语义 schema 一并纳入最小控制审计。
