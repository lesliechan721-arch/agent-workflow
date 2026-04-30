---
description: 对当前分支的改动执行代码审查
claude:
  description: 使用 Claude Code 工具对当前分支改动执行代码审查。
  allowed-tools:
    - Bash
    - Read
  argument-hint: "[file-path]"
codex:
  description: 在 Codex 中手动执行代码审查工作流。
  interface:
    display_name: "Review Command"
    short_description: "手动代码审查命令"
    icon_small: ./assets/review-16.svg
    icon_large: ./assets/review-64.svg
    brand_color: "#2563EB"
    default_prompt: "Use $review to review the current branch changes."
---

执行代码审查。

{{#if supportsCommands}}
如果指定了 $ARGUMENTS，只审查指定文件；否则审查当前分支所有改动。
{{/if}}
{{#unless supportsCommands}}
先确认审查范围，再使用 `git diff --name-only` 获取改动文件列表。
{{/unless}}

1. 使用 `git diff --name-only` 获取改动文件列表
2. 逐文件审查
3. 输出审查报告
