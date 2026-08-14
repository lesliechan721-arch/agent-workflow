# 评估说明

`trigger-cases.json` 将源 Skill 的发布触发查询适配为 AW schema v2 trigger corpus，并同时观察 Git 插件内的三个 Skill。运行触发评估时，每条查询至少运行三次。重点检查另一个独立任务需要保护当前未提交工作时会触发，而继续当前 checkout 中的同一任务不会仅因工作区 dirty 而触发；跨分支构建、测试或复现即使不修改源码也可触发。不需要独立 checkout 的只读查询和例行 worktree 管理不触发。merge 协调请求应只路由到 `reconciling-git-merges`。

`trigger-diagnostic-cases.json` 单独保存完整仓库隔离请求，不进入 release 或 description 优化。若本 Skill 被加载但正确选择 clone，则记录为 expected tradeoff。运行 `source_15`：

```bash
pnpm plugin:eval git --skill isolating-work-with-git-worktrees --batch-name source-15-diagnostic --suite router-diagnostic --case source_15 --runs 3
```

`trigger-fixture.mjs` 默认提供干净的 feature checkout，只在 query 明确依赖本地状态时使用对应的 dirty、linked-worktree、commit-ready 或 merge-conflict fixture。fixture 必须与 query 声明的分支和 Git 状态一致，不能把评测宿主的偶然状态当作触发信号。

`evals.json` 将源 Skill 的行为场景拆成五个可验证用例。`run-worktree-evals.mjs` 在临时 Git 仓库中分别运行 current 与 baseline，并机械检查：

1. 当前工作区有无关本地修改且无项目路径约定时，是否保护原状态，并在手动创建时固定使用 `.worktrees/<分支或任务名>/`；若 `.worktrees/` 未被忽略，是否在 Git metadata 可写时停止且不创建 worktree 或分支；
2. 已有平台隔离时，是否直接复用，不让默认路径覆盖环境提供的生命周期；
3. 仓库级隔离请求是否创建完整 clone，而不是 linked worktree，并保持主仓库不变；
4. 修改前已有测试失败时，是否正确标记为基线问题。

fixture 只覆盖这些高价值边界，不枚举所有 `git worktree` 命令与低概率故障模式。

## AW 验证

```bash
pnpm plugin:test git
pnpm plugin:eval git --skill isolating-work-with-git-worktrees --batch-name materialization --materialize-only
pnpm plugin:eval git --skill isolating-work-with-git-worktrees --batch-name release
```

第二条命令只验证 project/user 最终制品，不启动模型。第三条命令在一个批次中运行 materialization、validation/sanity trigger 路由和五个 Git fixture 行为用例；trigger 使用 manifest 的三次运行默认值。
