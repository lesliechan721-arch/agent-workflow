# Isolating Work with Git Worktrees

当任务需要独立 checkout 时，安全创建或精确复用 Git worktree，保护当前工作区和未完成修改。

## 适合使用

- 用户明确要求 worktree。
- 需要在不触碰当前任务的情况下处理另一分支。
- 需要同时维护多个 checkout。

## 不适合使用

- 继续当前 checkout 中的同一任务。
- 只读检查或例行 worktree 管理。
- 需要独立 refs 或对象库的完整仓库隔离；此时应使用独立 clone。

## 安全边界

Skill 会在变更前检查路径、分支和现有 worktree，在创建或复用后验证实际结果。它不会仅因工作区存在未提交修改就自动创建新 worktree。

主要指令见 [`SKILL.md`](SKILL.md)，评测材料见 [`evals/`](evals/)。
