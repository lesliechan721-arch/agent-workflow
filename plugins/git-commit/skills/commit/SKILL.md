---
name: commit
description: 当用户要求实际创建新的本地 Git commit 时使用，包括“提交并推送”中的 commit 步骤。仅拟写或评审 commit message、查看或暂存改动、推送已有提交，或执行 merge、amend、rebase、cherry-pick、revert、tag 时不要使用。
---

# Commit

只提交用户授权改动，不主动改变范围外的 index、worktree 或既有历史。本 skill 不执行 push；范围无法精确隔离、存在未解决冲突或进行中的 Git 操作时停止并报告。

1. 检查状态和相关 diff，确定提交范围与 message。
2. 需要暂存时仅使用精确路径，不使用 `git add .` 或 `git add -A`；核对完整 staged diff 后正常运行 hooks，创建一个新 commit。
3. 验证新 commit，报告 hash、subject 和剩余改动；失败时报告实际的 HEAD、index 和 worktree 状态。

## Message

优先遵守用户和仓库规范；否则使用中文 Conventional Commit：

```text
<type>(<scope>): <中文标题>

- <关键变更及其作用或影响>
- <另一项有排查价值的变更>
- <必要的测试、文档、依赖或版本同步>
```

scope 没有明确模块时省略。body 是供后续检索的变更摘要：非琐碎提交通常写 2–4 条，最多 4 条；每条只记录一个可由 diff 或仓库上下文证实的关键事实。合并同类改动，不逐文件复述，不为凑数加入实现噪音；原因或影响没有证据时不推测。标题已充分说明的琐碎单点改动可省略 body。
