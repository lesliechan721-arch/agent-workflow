---
description: 启动或继续结构化开发工作流
claude:
  argument-hint: "[开发请求]"
codex:
  description: 显式启动或继续 Dev Workflow，并为当前开发请求选择最小可行能力。
  interface:
    display_name: "Dev Workflow"
    short_description: "显式启动原型、规格、实现与双轴审查组成的结构化开发流程"
    default_prompt: "使用 $dev 为当前开发请求选择最小可行路径并继续。"
---

加载并执行 `dev-workflow` Skill。入口只负责选择和衔接能力，不复制专业 Skill 的流程。

{{#if supportsCommandArguments}}
当前开发请求：$ARGUMENTS
{{/if}}
{{#unless supportsCommandArguments}}
使用当前用户消息和会话中已有的 Spec、Prototype、`work.md`、diff 或 Review 作为输入。
{{/unless}}
