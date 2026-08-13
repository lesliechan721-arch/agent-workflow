# Git

为本地 Git 提交、worktree 隔离和需要协调双方意图的 Git merge 提供有边界的工作流。

## Skills

- `git-commit`：检查 worktree 和 index，精确暂存目标文件，创建并验证提交。
- `isolating-work-with-git-worktrees`：安全创建或复用独立 Git 工作目录，保护当前工作区和未完成修改。
- `reconciling-git-merges`：检查文本或语义冲突，协调 merge 双方意图并验证组合结果。

插件不执行 push。Worktree Skill 不处理普通代码修改、只读检查、例行 worktree 管理或需要完整仓库隔离的任务。Merge Skill 不处理 fast-forward、already up to date、rebase 或明显独立的 clean merge。
