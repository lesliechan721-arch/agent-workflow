# 评估说明

`trigger-cases.json` 将源 Skill 的触发查询适配为 AW schema v2 trigger corpus。`trigger-fixture.mjs` 为 train/validation 的冲突、语义合并、fast-forward、already-up-to-date、独立 clean merge、rebase/cherry-pick 冲突和相邻 commit 路由准备小型 Git 状态。运行触发评估时，每条查询至少运行三次。重点观察 fast-forward、already up to date、普通 merge 请求、rebase 和明显独立的 clean merge 是否保持不触发。

`evals.json` 和 `files/` 保留源 Skill 的四个 Git 行为用例及附件。`run-merge-evals.mjs` 在全新工作区中分别运行 current 与 baseline，并机械检查只产生一个双父合并提交、测试通过、不可变外部语义探针和只读不变量。三个写用例只向内层 Codex 开放该临时仓库的 Git metadata；analysis-only 用例保持 metadata 只读。Release 默认对每个 behavior case 的 current 和 baseline 各运行 3 次。

第四个用例开始前，记录 `HEAD`、refs、index、worktree 和 `README.md` 的本地差异；运行后应完全一致。

先查看首轮 trace，再决定是否增加 assertions；只保留能相对 baseline 产生可测行为增益的规则。

## AW 验证

```bash
pnpm plugin:test git
pnpm plugin:eval git --skill reconciling-git-merges --batch-name materialization --materialize-only
pnpm plugin:eval git --skill reconciling-git-merges --batch-name router-validation --suite router --split validation --runs 1
```

该 manifest 运行 materialization、trigger 路由和四个 Git fixture 行为用例。
