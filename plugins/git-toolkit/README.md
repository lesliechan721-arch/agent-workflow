# Git Toolkit

为高频且容易误操作的本地 Git 工作提供有边界的 Agent 工作流。

插件聚焦两个明确场景：用户显式触发的精确本地提交，以及覆盖 `merge`、`rebase` 与 `cherry-pick` 的文本冲突与跨分支语义协调。插件绝不执行 `git push`。

## 安装

```bash
aw target set codex claude
aw plugin install git-toolkit --scope user
```

安装目标包括 Codex、Claude Code、Antigravity、Cursor、OpenCode、Pi、GitHub Copilot CLI 和 Grok Build。`generic` 交付通用 Skills。安装结果按目标说明实际交付和适用的调用提示。

## 包含的 Skill

| Skill | 什么时候使用 |
| --- | --- |
| [`git-commit`](skills/git-commit/) | 手动调用，按提交规范创建指定范围的本地提交 |
| [`git-reconcile`](skills/git-reconcile/) | `merge`、`rebase` 或 `cherry-pick` 发生冲突，或需要排查、协调跨分支语义与契约交互 |

## 典型用法

```text
$git-commit 只提交这次修复涉及的文件，不要动 index 里其它内容。
```

```text
当前 feature rebase 到 main 冲突了，请结合双方提交意图解决冲突并验证组合结果。
```

```text
$git-reconcile 深度审计将 origin/feature 合并到 main 是否存在跨文件契约冲突，但不要修改当前工作区。
```

提交示例使用 Codex 的调用方式。Claude Code 使用 `/git-toolkit:git-commit`，Pi 使用 `/skill:git-commit`，OpenCode 使用 `@git-commit`，Grok Build 使用 `/git-commit`。`git-reconcile` 在出现冲突或语义协调信号时可由支持自动调用的客户端启用，也支持显式调用以审计 clean merge。

在 Antigravity CLI 中，User 安装使用 `/git-toolkit:git-commit`。Project 安装使用目录前缀，形如 `/aw-<来源 ID>-git-toolkit:git-commit`。在安装所在的项目运行 `/skills` 查找完整名称。若同一 Skill 在两个范围都已安装，会话清单显示当前项目采用的入口。

`generic` 交付两个技能的完整文件。是否能保证 `git-commit` 只在用户显式选择时调用，由读取这些文件的客户端决定。AW 会在安装结果中提示这一限制。

## 安全边界

- 绝不执行 `git push`。
- 提交前后都会检查目标范围与剩余状态，不通过 `git reset` 重排他人已暂存内容。
- 提交技能不默认追加测试、构建或评审；明确的提交门禁与正常 Git hooks 仍须执行，拒绝时不绕过 hooks 或误用 `--amend`。
- 整合协调不只处理冲突标记，也检查 clean merge 中可能出现的跨文件语义冲突；仅分析时不修改 refs、index 或 worktree。
- 双方业务规则冲突且缺乏依据时停止并报告待决问题，不自行拍板或发明折中方案。

## 维护者

Skill 指令和评测位于各 Skill 目录。
