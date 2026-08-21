# 手动依赖合同

插件合同版本：`0.8.0`。

必需插件：`agent-content-toolkit >= 0.5.0`。

必需 Skill：

- `write-agent-content`：编写 Agent-facing 文本；
- `review-agent-content`：作为内容和 reference 审计的权威 owner。

可选执行插件：`agent-skill-eval-runner >= 0.2.0` 或其它兼容 provider。缺少该插件不会阻断编写或设计评审，但会把 Eval 证据限制为结构性或 preflight 证据，并使适用的发布准备度保持 provisional。

在支持插件依赖前，由仓库策略或人工操作员保证安装。缺少必需的内容能力时，流程会 fail closed，且不会携带下层标准的备用副本。
