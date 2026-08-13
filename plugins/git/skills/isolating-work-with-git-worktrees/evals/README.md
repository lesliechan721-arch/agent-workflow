# 评估说明

`trigger-cases.json` 将源 Skill 的触发查询适配为 AW schema v2 trigger corpus，并同时观察 Git 插件内的三个 Skill。运行触发评估时，每条查询至少运行三次。重点检查普通代码修改、只读检查和例行 worktree 管理不会触发；merge 协调请求应只路由到 `reconciling-git-merges`；需要完整仓库隔离时不应误用 linked worktree。

`evals.json` 将源 Skill 的三个行为场景拆成四个可验证用例。`run-worktree-evals.mjs` 在临时 Git 仓库中分别运行 current 与 baseline，并机械检查：

1. 当前工作区有无关本地修改且无项目路径约定时，是否保护原状态，并在手动创建时固定使用 `.worktrees/<分支或任务名>/`；若 `.worktrees/` 未被忽略，是否停止而不是任意换目录；
2. 已有平台隔离时，是否直接复用，不让默认路径覆盖环境提供的生命周期；
3. 修改前已有测试失败时，是否正确标记为基线问题。

fixture 只覆盖这些高价值边界，不枚举所有 `git worktree` 命令与低概率故障模式。

## AW 验证

```bash
pnpm plugin:test git
pnpm plugin:eval git --skill isolating-work-with-git-worktrees --batch-name materialization --materialize-only
pnpm plugin:eval git --skill isolating-work-with-git-worktrees --batch-name router-validation --suite router --split validation --runs 1
pnpm plugin:eval git --skill isolating-work-with-git-worktrees --batch-name behavior --suite behavior
```

该 manifest 运行 materialization、trigger 路由和四个 Git fixture 行为用例。
