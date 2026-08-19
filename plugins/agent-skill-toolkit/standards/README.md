# Skill standards

`skill-rules.json` 是 Agent Skill 作者、评审与 Eval 的唯一人工维护专属规则源。它只包含 Skill/Eval 规则、Composition Fitness、Finding Admission、评分维度，以及对内容层规则的动作投影。

`rules.json` 是生成文件：由 `agent-content-toolkit/standards/rules.json` 的内容层规则与 `skill-rules.json` 组合而成。`contentRuleExtensions` 只能增加 `skill_author`、`skill_review`、`eval_design` 或 `eval_audit` 投影，不得重新定义内容规则的 principle、证据类型或来源。

Agent-facing 内容写作与 reference 审计的执行流程由 `agent-content-toolkit` 提供；本插件生成 Skill/Eval 视图，运行时不同时加载完整规则库。
