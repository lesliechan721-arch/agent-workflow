# 评估说明

## 准备与运行

`aw dev eval prepare` 每次按 manifest 注册的一个 suite/profile 和可选 case/split 选择生成 `EvalSpec v1`。`--output` 必须指向 Workspace 外尚不存在的新目录。只做 materialization 诊断时只执行 prepare，不启动 provider：

```bash
aw dev eval prepare git-toolkit \
  git-reconcile --suite router --profile project-default \
  --output /tmp/aw-eval-specs/git-reconcile-materialization --json
```

需要模型时，先验证 Spec。复用与 current、可选 previous-version target 和 selected cases 精确绑定的单份 `EvalAudit v1`；没有可复用 Audit 时，由全新上下文生成一份。取得本次成本与副作用授权后，Runner 执行：

```bash
aw-skill-eval run /tmp/aw-eval-specs/<spec-dir>/spec.json --audit /tmp/aw-eval-specs/<spec-dir>/audit.json
```

该命令生成 `EvalResult v2`。随后运行 `aw-skill-eval result validate <result> --spec <spec> --audit <audit>`。clean success 不要求 triage。只有 execution/grade 失败、混合结果、baseline 回归，或结果将驱动生产 Skill 修改时，才由全新上下文做 result-triage；默认在聊天中返回，用户指定时可写 `triage.md`。

`trigger-cases.json` 使用 selected cases v1 trigger 合同。`trigger-fixture.mjs` 为 train/validation 的 merge、rebase、cherry-pick 冲突、语义合并、fast-forward、already-up-to-date、独立 clean merge 和相邻 commit 路由准备小型 Git 状态。运行触发评估时，每条查询至少运行三次。重点观察 merge/rebase/cherry-pick 冲突与语义交互协调能够召回，而 fast-forward、already up to date、无冲突且无语义风险信号的常规 merge/rebase/cherry-pick 和普通本地提交保持不触发。

`evals.json`、`files/` 与 `run-reconcile-evals.mjs` 覆盖 6 条 Git 行为用例：
- 4 条基于附件的 merge 用例：不可裁决保留策略冲突、同文件 clean-merge 语义冲突、跨文件 clean-merge 契约冲突、脏工作区只读风险分析；
- 2 条程序生成的冲突与跨文件消费者协调延续用例：`rebase_conflict_reconcile`（辨明基线刻意删除与单位变更、适配跨文件消费者，并通过 `git rebase --continue` 保持线性单父提交）与 `cherry_pick_conflict_reconcile`（辨明基线刻意删除与字段重命名、适配跨文件消费者，并沿原操作完成单个新提交）。

`run-reconcile-evals.mjs` 每次在全新工作区中运行一个由 Eval engine 选定的 case、variant 和 attempt，直接透传 `evals.json` 的任务提示词，并机械检查最终历史形态、无遗留进行中状态、index 与 tracked worktree 均等于 HEAD、测试通过、不可变外部语义探针和只读不变量。所有用例只向内层 Codex 开放该临时仓库自身的 Git metadata（使 analysis-only 的只读不变量在具备写能力的前提下真实受测，并结合命令轨迹与前后仓库快照双重验证未执行写操作）。Engine 负责 variant/attempt 循环、timeout、进程树和最终 EvalResult，默认对每个 behavior case 运行 3 次。

保留策略冲突允许两种有依据的暂停：执行 merge 前保持仓库原状，或执行 merge 后保留未解决冲突。两者都必须报告真实的不兼容意图和待决问题；不允许自行决定保留策略。

`analysis_only_dirty_worktree` 开始前，记录 `HEAD`、refs、index、worktree 和 `README.md` 的本地差异；运行后应完全一致。

## AW 验证

```bash
pnpm plugin:test git-toolkit
aw dev eval prepare git-toolkit git-reconcile --suite router --profile project-default --split validation --runs 1 --output /tmp/aw-eval-specs/git-reconcile-router-validation --json
aw dev eval prepare git-toolkit git-reconcile --suite behavior --profile project-default --runs 3 --output /tmp/aw-eval-specs/git-reconcile-behavior --json
```

准备与运行中的 materialization 命令只验证 project/user 最终制品，不启动模型。其余 Spec 应分别交给 `$run-aw-skill-evals`；trigger 使用 manifest 的三次运行默认值。
