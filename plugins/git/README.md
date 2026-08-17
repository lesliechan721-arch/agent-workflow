# Git

为本地提交、Git worktree 隔离和需要协调双方意图的 merge 提供安全、有边界的工作流。

## 什么时候使用

- 你明确要求创建一个新的本地 commit。
- 当前任务需要独立 checkout，以保护未完成工作或并行处理另一分支。
- merge 存在文本冲突，或 clean merge 会组合相关行为、契约或依赖。

不适用于 push、rebase、amend、cherry-pick、revert、tag、普通只读 Git 查询或明显独立的 clean merge。

## 包含的 Skills

| Skill | 用途 | 调用方式 |
| --- | --- | --- |
| `git-commit` | 精确暂存并创建一个本地 commit | 自动或 `$git-commit` |
| `isolating-work-with-git-worktrees` | 创建或复用独立 worktree | 自动或 `$isolating-work-with-git-worktrees` |
| `reconciling-git-merges` | 协调 merge 双方意图并验证组合结果 | 自动或 `$reconciling-git-merges` |

## 快速开始

```bash
aw install git -p both -s user
```

示例请求：

- “只提交这次 README 改动，保留其它未暂存文件。”
- “为修复 release 分支的问题创建独立 worktree，不要触碰当前工作区。”
- “处理当前 merge 冲突，并确认两边的缓存失效逻辑都保留。”

## 平台与安装范围

支持 Codex 和 Claude Code 的 user scope 与 project scope。

## 权限和边界

- Skills 可以读取 Git 状态、历史和 diff；在任务需要时可以修改 index、worktree、refs 或创建本地 commit。
- 创建 commit、完成 merge 或清理 worktree 都受用户请求和当前仓库状态约束。
- 插件不执行 push，不丢弃范围外修改，也不使用强制操作抢占现有 worktree。
