# 依赖合同

manifest 声明 `agent-content-toolkit` 为同一 source 内的必需依赖。AW 在安装、升级或重装本插件时解析依赖闭包，并先安装或升级该插件。

这只保证 manifest 中的同 source 插件 placement；它不安装外部工具，也不求解或保证第三方版本范围。

必需 Skill：

- `write-agent-content`：编写 Agent-facing 文本；
- `review-agent-content`：作为内容和 reference 审计的权威 owner。

可选执行插件：`agent-skill-eval-runner >= 0.1.0` 或其它兼容 provider。缺少执行插件不会阻断编写或质量评审，只会限制 Eval 证据等级。

Skill 运行前仍检查所需 Skill 能力和版本。缺少必需内容能力时流程 fail closed，不复制下层标准的备用副本。
