---
description: 快速启动代码审查工作流
claude:
  description: 使用 review-workflow skill 对当前分支改动执行代码审查。
  allowed-tools:
    - Bash
    - Read
  argument-hint: "[file-path]"
codex:
  description: 在 Codex 中手动启动代码审查工作流。
  interface:
    display_name: "Review Command"
    short_description: "显式启动代码审查、证据核验、风险分级与可执行建议生成工作流"
    icon_small: ./assets/review-16.svg
    icon_large: ./assets/review-64.svg
    brand_color: "#2563EB"
    default_prompt: "Use $review to review the current branch changes."
---

启动 `review-workflow` 代码审查工作流。

{{#if supportsCommands}}
按 `review-workflow` skill 的流程审查 $ARGUMENTS 指定的范围；如果没有参数，审查当前分支改动。
{{/if}}
{{#unless supportsCommands}}
确认审查范围后，使用 `$review-workflow` 执行完整审查。
{{/unless}}
