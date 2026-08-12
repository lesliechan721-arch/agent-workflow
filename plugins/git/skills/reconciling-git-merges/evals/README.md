# 评估说明

`trigger-cases.json` 将源 Skill 的触发查询适配为 AW schema v2 trigger corpus。运行触发评估时，每条查询至少运行三次。重点观察 fast-forward、already up to date、普通 merge 请求、rebase 和明显独立的 clean merge是否保持不触发。

`evals.json` 和 `files/` 保留源 Skill 的四个 Git 行为用例及附件。`run-merge-evals.mjs` 在全新工作区中分别运行 current 与 baseline，并机械检查合并结果、测试和只读不变量。

第四个用例开始前，记录 `HEAD`、refs、index、worktree 和 `README.md` 的本地差异；运行后应完全一致。

先查看首轮 trace，再决定是否增加 assertions；只保留能相对 baseline 产生可测行为增益的规则。

## AW 验证

```bash
pnpm plugin:test git
pnpm plugin:eval git --skill reconciling-git-merges --batch-name materialization --materialize-only
pnpm plugin:eval git --skill reconciling-git-merges --batch-name router-validation --suite router --split validation --runs 1
```

中央 manifest 运行 materialization、trigger 路由和四个 Git fixture 行为用例。`pnpm plugin:test git` 只确定性校验 runner、合同和附件；真实模型行为仅由 `pnpm plugin:eval` 证明。
