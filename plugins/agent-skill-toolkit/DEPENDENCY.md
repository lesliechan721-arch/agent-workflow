# 手动依赖合同

必需插件：`agent-content-toolkit >= 0.1.0`。

必需 Skill：

- `write-agent-content`：编写 Agent-facing 文本；
- `review-agent-content`：作为内容和 reference 审计的权威 owner。

可选执行插件：`agent-skill-eval-runner >= 0.1.0` 或其它兼容 provider。缺少执行插件不会阻断编写或质量评审，只会限制 Eval 证据等级。

在支持插件依赖前，由仓库策略或人工操作员保证安装。缺少必需内容能力时流程 fail closed，不复制下层标准的备用副本。
