# git-commit

按用户授权范围创建一个新的本地 Git commit，并保留范围外状态。

## 什么时候使用

- 你明确要求实际创建一个新的本地 commit。
- “提交并推送”请求中的 commit 步骤也可以使用，但 push 不由本 Skill 执行。

不要用于只拟写 message、查看状态、推送已有提交，或执行 amend、merge、rebase、cherry-pick、revert、tag。

## 怎样调用

模型可以按明确的提交请求自动调用，也可以显式使用 `$git-commit`。

示例请求：

- “只提交 docs 目录的改动，保留当前已暂存的应用代码。”
- “检查 diff 后按仓库规范创建一个本地 commit。”

## 会发生什么

1. Agent 检查 worktree、index、相关 diff 和提交规范。
2. Agent 只暂存授权路径，核对完整 staged diff，并正常运行 hooks 创建 commit。
3. Agent 验证 commit，报告 hash、subject 和剩余改动。

## 权限和边界

- 可以修改 index 并创建一个本地 commit。
- 不使用 `git add .` 或 `git add -A`，不丢弃范围外状态，也不执行 push。
- 存在未解决冲突、进行中的 Git 操作或范围无法隔离时停止并报告。
