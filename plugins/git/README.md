# Git

为本地 Git 提交和正在进行的 merge 或 rebase 冲突提供有边界的工作流。

## Skills

- `git-commit`：检查 worktree 和 index，精确暂存目标文件，创建并验证提交。
- `resolving-merge-conflicts`：理解冲突两侧的变更意图，逐项解决、验证并继续当前 merge 或 rebase。

插件不执行 push。冲突 Skill 不启动新的 merge 或 rebase，也不自行 abort、skip、quit 或 reset 当前操作。
