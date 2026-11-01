---
name: git-commit
description: 用户显式调用时，核对授权范围与仓库状态，按提交规范创建并验证一个新的本地 Git commit。
user-invocable: true
disable-model-invocation: true
---

# Git Commit

只提交用户授权改动，不主动改变范围外的 index、worktree 或既有历史。不执行 push；范围无法精确隔离、存在未解决冲突或进行中的 Git 操作时停止并报告。

提交前核对完整 staged diff，提交后核对新 commit，确保实际内容与授权范围一致，范围外的已暂存和未暂存改动保持原状。需要暂存时仅使用精确路径，不使用 `git add .` 或 `git add -A`。

不默认运行测试、构建或代码评审；执行用户或仓库要求的提交门禁及正常 hooks。成功后报告 hash、subject 和剩余改动；失败时报告实际的 HEAD、index 和 worktree 状态。

## Message

优先遵守用户和仓库规范；否则使用 Conventional Commit。

body 按主题概括实际提交：非琐碎提交通常写 2–4 条，最多 4 条，每条一个有 diff 或仓库上下文依据的关键事实。不逐文件复述、不凑数，不推测无依据的原因或影响。标题已充分说明的琐碎单点改动可省略 body。
