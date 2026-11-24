---
name: git-commit
description: 用户显式调用时，核对授权范围与仓库状态，按提交规范创建并验证一个新的本地 Git commit。
user-invocable: true
disable-model-invocation: true
---

# Git Commit

只提交用户授权的改动，绝不执行 `git push`。不改变范围外的 index、worktree 或既有历史；不默认运行测试、构建或代码评审，仅执行用户或仓库明确要求的提交门禁及正常 hooks。

1. **检查完整仓库状态。** 存在未解决冲突或任何进行中的 merge、rebase、cherry-pick、revert 时立即停止并报告，不创建普通提交，也不继续或中止该操作（不要仅依赖 `--porcelain` 状态，它不会标出冲突已解决但尚未完成的合并）。
2. **精确隔离提交范围。** 需要暂存时仅指定精确路径，不使用 `git add .` 或 `git add -A`；用户仅授权已暂存内容时直接基于现有 index 提交。若暂存区已有范围外内容，严禁通过 `reset` 或 `restore --staged` 重排他人暂存区；仅在不改动范围外暂存状态的前提下安全隔离提交，无法无损隔离时停止并报告。
3. **核对 diff 与执行门禁。** 确认存在可提交改动，核对即将提交的完整 diff，并执行用户或仓库明确要求的提交门禁。
4. **Hook 失败红灯。** 正常运行 Git hooks；若 hook 拒绝提交，立即停止并报告，严禁绕过 hooks（`--no-verify`）、严禁误用 `--amend` 覆写上一条 commit、严禁修改 hook。
5. **验证并报告结果。** 提交后核对新 commit 内容与授权范围一致、范围外暂存和未暂存改动保持原状，报告 hash、subject 和剩余改动；失败或停止时报告实际的 HEAD、index 和 worktree 状态。

## Message

优先遵守用户和仓库规范；否则按仓库近期提交历史或当前对话语言使用 Conventional Commit。

body 按主题概括实际提交：非琐碎提交通常写 2–4 条，最多 4 条，每条记录一个可由本次 diff 或仓库上下文证实的关键事实。不逐文件复述、不凑数，不编造 diff 未体现的原因、issue 或外部影响。标题已充分说明的琐碎单点改动可省略 body。
