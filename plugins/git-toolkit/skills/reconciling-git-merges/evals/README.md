# 评估说明

## 准备与运行

`aw skill eval prepare` 每次只准备 manifest 注册的一个 suite/profile。`--output` 必须指向 Workspace 外尚不存在的新目录。只做 materialization 诊断时只执行 prepare，不启动 provider：

```bash
aw skill eval prepare git-toolkit \
  --skill reconciling-git-merges --suite router --profile project-default \
  --output /tmp/aw-eval-plans/git-merge-materialization --json
```

需要模型时，先按目标 suite/profile 生成新的 Plan，再对该目录的 `plan.json` 使用 `$run-aw-skill-evals`。该 Skill 先协调独立 `audit-agent-skill-evals` 上下文完成 preflight Audit，再取得本次模型成本、外部进程、凭据、网络和临时输出的明确授权；授权后由 runner 执行带 Audit 的命令，并在运行后完成 result-triage：

```bash
aw-skill-eval run /tmp/aw-eval-plans/<plan-dir>/plan.json --audit /tmp/aw-eval-plans/<plan-dir>/preflight-audit.json
```

上面的命令只表示 `$run-aw-skill-evals` 在 Audit 和授权通过后调用的 `aw-skill-eval run <plan.json> --audit <audit.json>`。没有 Audit 或 result-triage 的 bundle 只能作为诊断证据，不能用于 Review、修改 Skill 或发布结论。

`trigger-cases.json` 将源 Skill 的触发查询适配为 AW schema v2 trigger corpus。`trigger-fixture.mjs` 为 train/validation 的冲突、语义合并、fast-forward、already-up-to-date、独立 clean merge、rebase/cherry-pick 冲突和相邻 commit 路由准备小型 Git 状态。运行触发评估时，每条查询至少运行三次。重点观察 fast-forward、already up to date、普通 merge 请求、rebase 和明显独立的 clean merge 是否保持不触发。

`evals.json` 和 `files/` 保留源 Skill 的四个 Git 行为用例及附件。`run-merge-evals.mjs` 每次在全新工作区中运行一个由 Eval engine 选定的 case 和 configuration，并机械检查只产生一个双父合并提交、测试通过、不可变外部语义探针和只读不变量。三个写用例只向内层 Codex 开放该临时仓库的 Git metadata；analysis-only 用例保持 metadata 只读。Engine 负责 configuration/runs 循环、timeout、进程树和最终 EvalRunBundle，默认对每个 behavior case 和 configuration 运行 3 次。

第四个用例开始前，记录 `HEAD`、refs、index、worktree 和 `README.md` 的本地差异；运行后应完全一致。

先查看首轮 trace，再决定是否增加 assertions；只保留能相对 baseline 产生可测行为增益的规则。

## AW 验证

```bash
pnpm plugin:test git
aw skill eval prepare git-toolkit --skill reconciling-git-merges --suite router --profile project-default --split validation --runs 1 --output /tmp/aw-eval-plans/git-merge-router-validation --json
aw skill eval prepare git-toolkit --skill reconciling-git-merges --suite behavior --profile project-default --runs 3 --output /tmp/aw-eval-plans/git-merge-behavior --json
```

该 manifest 的 trigger 路由和四个 Git fixture 行为用例应分别交给 `$run-aw-skill-evals`；materialization 诊断只使用前面的 prepare 命令。
