# Git Commit

通过手动调用，创建一个范围精确、结果可验证的本地 Git commit。

## 怎样调用

在 Codex 中使用 `$git-commit`，在 Claude Code 中使用 `/git-toolkit:git-commit`，在 Pi 中使用 `/skill:git-commit`，在 OpenCode 中使用 `@git-commit`，在 Grok Build 中使用 `/git-commit`。调用时说明本次提交范围。

```text
$git-commit 只提交这次修复涉及的文件，保留其它暂存和未暂存改动。
```

技能声明仅由用户显式调用。使用 `generic` 文件时，读取文件的客户端决定是否执行这项限制。

## 适合使用

- 用户明确要求提交当前改动。
- 只允许提交指定文件或指定工作范围。
- index 或 worktree 中还有其它未完成内容，需要保持原状。

## 工作方式

Skill 会检查完整仓库状态与适用提交规范，精确隔离目标范围，按需执行明确门禁与正常 hooks，创建提交并核对结果与剩余改动。

它不默认运行测试、构建或代码评审；无仓库或用户格式要求时，按仓库近期提交历史或对话语言使用 Conventional Commit。

## 安全边界

- 不执行 `git push`。
- 不把范围外改动带入提交，也不通过 `git reset` 重排他人已暂存内容。
- hook 拒绝时不绕过 hooks，也不用 `--amend` 覆写上一条提交。
- 存在未解决冲突或进行中的 merge、rebase、cherry-pick、revert 时停止并报告。

主要指令见 [`SKILL.md`](SKILL.md)，评测材料见 [`evals/`](evals/)。
