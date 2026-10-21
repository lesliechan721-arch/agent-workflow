# Git Workflows

为高风险、容易误操作的 Git 工作提供有边界的 Agent 工作流。

插件聚焦本地提交、worktree 隔离和 merge 意图协调。它不会执行 push，也不会把每个普通代码任务都强制迁移到独立工作区。

## 安装

```bash
aw install git-toolkit -p both
```

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| [`git-commit`](skills/git-commit/) | 手动调用，按提交规范创建指定范围的本地提交 |
| [`isolating-work-with-git-worktrees`](skills/isolating-work-with-git-worktrees/) | 需要保护当前工作区、并行处理另一分支或显式创建 worktree |
| [`reconciling-git-merges`](skills/reconciling-git-merges/) | merge 双方存在文本冲突，或 clean merge 仍有语义、契约或依赖交互 |

## 典型用法

```text
$git-commit 只提交这次修复涉及的文件，不要动 index 里其它内容。
```

```text
为 feature/invite-expiry 创建独立 worktree，保留当前未完成工作。
```

```text
合并这两个分支，并检查双方行为意图是否仍然同时成立。
```

提交示例使用 Codex 的调用方式；Claude Code 使用 `/git-toolkit:git-commit`。另外两个技能保留自动调用。

## 安全边界

- 不执行 `git push`。
- 不使用 worktree 处理不需要独立 checkout 的普通任务。
- 提交前后都会检查目标范围和结果。
- 提交技能不默认追加测试、构建或评审；明确的提交门禁和 Git hooks 仍须执行。
- merge 不只处理冲突标记，也检查 clean merge 中可能出现的行为冲突。
- 需要完整独立 refs 或对象库时，应使用独立 clone，而不是 worktree。

## 维护者

Skill 指令和评测位于各 Skill 目录。
