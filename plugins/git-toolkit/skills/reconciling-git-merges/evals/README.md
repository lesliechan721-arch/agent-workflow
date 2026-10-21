# 评估说明

## 准备与运行

`aw skill eval prepare` 每次按 manifest 注册的一个 suite/profile 和可选 case/split 选择生成 `EvalSpec v1`。`--output` 必须指向 Workspace 外尚不存在的新目录。只做 materialization 诊断时只执行 prepare，不启动 provider：

```bash
aw skill eval prepare git-toolkit \
  reconciling-git-merges --suite router --profile project-default \
  --output /tmp/aw-eval-specs/git-merge-materialization --json
```

需要模型时，先验证 Spec。复用与 current、可选 previous-version target 和 selected cases 精确绑定的单份 `EvalAudit v1`；没有可复用 Audit 时，由全新上下文生成一份。取得本次成本与副作用授权后，Runner 执行：

```bash
aw-skill-eval run /tmp/aw-eval-specs/<spec-dir>/spec.json --audit /tmp/aw-eval-specs/<spec-dir>/audit.json
```

该命令生成 `EvalResult v2`。随后运行 `aw-skill-eval result validate <result> --spec <spec> --audit <audit>`。clean success 不要求 triage。只有 execution/grade 失败、混合结果、baseline 回归，或结果将驱动生产 Skill 修改时，才由全新上下文做 result-triage；默认在聊天中返回，用户指定时可写 `triage.md`。

`trigger-cases.json` 使用 selected cases v1 trigger 合同。`trigger-fixture.mjs` 为 train/validation 的冲突、语义合并、fast-forward、already-up-to-date、独立 clean merge、rebase/cherry-pick 冲突和相邻 commit 路由准备小型 Git 状态。运行触发评估时，每条查询至少运行三次。重点观察 fast-forward、already up to date、普通 merge 请求、rebase 和明显独立的 clean merge 是否保持不触发。

`evals.json` 和 `files/` 保留源 Skill 的四个 Git 行为用例及附件。`run-merge-evals.mjs` 每次在全新工作区中运行一个由 Eval engine 选定的 case、variant 和 attempt，并机械检查只产生一个双父合并提交、测试通过、不可变外部语义探针和只读不变量。三个写用例只向内层 Codex 开放该临时仓库的 Git metadata；analysis-only 用例保持 metadata 只读。Engine 负责 variant/attempt 循环、timeout、进程树和最终 EvalResult，默认对每个 behavior case 运行 3 次。

第四个用例开始前，记录 `HEAD`、refs、index、worktree 和 `README.md` 的本地差异；运行后应完全一致。

先查看首轮 trace，再决定是否增加 assertions；只保留能相对 baseline 产生可测行为增益的规则。

## AW 验证

```bash
pnpm plugin:test git
aw skill eval prepare git-toolkit reconciling-git-merges --suite router --profile project-default --split validation --runs 1 --output /tmp/aw-eval-specs/git-merge-router-validation --json
aw skill eval prepare git-toolkit reconciling-git-merges --suite behavior --profile project-default --runs 3 --output /tmp/aw-eval-specs/git-merge-behavior --json
```

所选 trigger 路由和 Git fixture 行为用例应分别准备 Spec 并交给 `$run-aw-skill-evals`；materialization 诊断只使用前面的 prepare 命令。
