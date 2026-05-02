---
description: Review the current change set.
claude:
  description: Review the current change set with Claude Code tools.
  allowed-tools:
    - Bash(git diff *)
    - Bash(git status *)
    - Read
  model: inherit
  argument-hint: "[path]"
  shell: bash
codex:
  description: Review the current change set as a manual Codex skill.
  interface:
    display_name: Fixture Review
    short_description: Review repository changes
    icon_small: ./assets/review-16.svg
    icon_large: ./assets/review-64.svg
    brand_color: "#2563EB"
    default_prompt: Use $review to inspect the current change set.
---

# Review

{{reviewIntro}}

{{#if claudeCommandSyntax}}
Use `$ARGUMENTS` or `$1` to narrow the review target.

```!
git diff --stat
```
{{/if}}
{{#unless claudeCommandSyntax}}
Run `git status` and `git diff` yourself before summarizing the change set.
{{/unless}}

Return risks first, then the smallest useful fix suggestion.
