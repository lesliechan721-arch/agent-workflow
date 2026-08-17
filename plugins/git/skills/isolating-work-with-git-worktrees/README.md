# isolating-work-with-git-worktrees

安全创建或复用独立 Git worktree，保护当前工作区并确认可信起点。

## 什么时候使用

- 你明确要求 worktree，或任务必须在不触碰当前未完成工作的情况下处理另一分支。
- 你需要同时处理多个 checkout，并接受它们共享对象库和多数 refs。

不要仅因为工作区有未提交修改或任务涉及代码修改就使用。普通只读检查、例行 worktree 管理和需要完整仓库隔离的任务也不适用。

## 怎样调用

模型可以在任务确实需要独立 checkout 时自动调用，也可以显式使用 `$isolating-work-with-git-worktrees`。

示例请求：

- “为 release 分支修复创建独立 worktree，不要触碰当前未完成修改。”
- “复用现有隔离环境处理这个并行任务，并报告路径和基点。”

## 会发生什么

1. Agent 先检查现有 worktree 或平台隔离是否已经满足要求。
2. 需要创建时，Agent 确认 ignore、路径、基点和分支，再安全创建 worktree。
3. Agent 在隔离目录中确认初始状态，并把后续任务限制在那里。

## 权限和边界

- 可以创建本地 worktree 和必要分支，但不会 stash、reset 或丢弃当前修改。
- `.worktrees/` 未被忽略、路径或基点不明确时会停止询问。
- 不自动清理 worktree；只有用户要求且没有未保存工作时才使用 Git 的正常清理入口。
