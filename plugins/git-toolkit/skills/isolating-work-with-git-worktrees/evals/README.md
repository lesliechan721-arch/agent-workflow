# 评估说明

## 准备与运行

`aw skill eval prepare` 每次按 manifest 注册的一个 suite/profile 和可选 case/split 选择生成 `EvalSpec v1`。`--output` 必须指向 Workspace 外尚不存在的新目录。只做 materialization 诊断时只执行 prepare，不启动 provider：

```bash
aw skill eval prepare git-toolkit \
  isolating-work-with-git-worktrees --suite router --profile project-default \
  --output /tmp/aw-eval-specs/git-worktree-materialization --json
```

需要模型时，先验证 Spec。复用与 current、可选 previous-version target 和 selected cases 精确绑定的单份 `EvalAudit v1`；没有可复用 Audit 时，由全新上下文生成一份。取得本次成本与副作用授权后，Runner 执行：

```bash
aw-skill-eval run /tmp/aw-eval-specs/<spec-dir>/spec.json --audit /tmp/aw-eval-specs/<spec-dir>/audit.json
```

该命令生成 `EvalResult v2`。随后运行 `aw-skill-eval result validate <result> --spec <spec> --audit <audit>`。clean success 不要求 triage。只有 execution/grade 失败、混合结果、baseline 回归，或结果将驱动生产 Skill 修改时，才由全新上下文做 result-triage；默认在聊天中返回，用户指定时可写 `triage.md`。

`trigger-cases.json` 使用 selected cases v1 trigger 合同，并同时观察 Git 插件内的三个 Skill。运行触发评估时，每条查询至少运行三次。重点检查另一个独立任务需要保护当前未提交工作时会触发，而继续当前 checkout 中的同一任务不会仅因工作区 dirty 而触发；跨分支构建、测试或复现即使不修改源码也可触发。不需要独立 checkout 的只读查询和例行 worktree 管理不触发。merge 协调请求应只路由到 `reconciling-git-merges`。

`trigger-diagnostic-cases.json` 单独保存完整仓库隔离请求，不进入 description 优化。若本 Skill 被加载但正确选择 clone，则记录为 expected tradeoff。运行 `source_15`：

```bash
aw skill eval prepare git-toolkit isolating-work-with-git-worktrees --suite router-diagnostic --profile project-default --case source_15 --runs 3 --output /tmp/aw-eval-specs/git-worktree-router-diagnostic-source-15 --json
```

`trigger-fixture.mjs` 默认提供干净的 feature checkout，只在 query 明确依赖本地状态时使用对应的 dirty、linked-worktree、commit-ready 或 merge-conflict fixture。fixture 必须与 query 声明的分支和 Git 状态一致，不能把评测宿主的偶然状态当作触发信号。

`evals.json` 将源 Skill 的行为场景拆成五个可验证用例。`run-worktree-evals.mjs` 每次在临时 Git 仓库中运行一个由 Eval engine 选定的 case、variant 和 attempt，并机械检查：

1. 当前工作区有无关本地修改且无项目路径约定时，是否保护原状态，并在手动创建时固定使用 `.worktrees/<分支或任务名>/`；若 `.worktrees/` 未被忽略，是否在 Git metadata 可写时停止且不创建 worktree 或分支；
2. 已有平台隔离时，是否直接复用，不让默认路径覆盖环境提供的生命周期；
3. 仓库级隔离请求是否创建完整 clone，而不是 linked worktree，并保持主仓库不变；
4. 本次只要求检查起点且失败后停止时，是否正确报告已有基线失败并保持源码不变。此例不评价获得修复授权后是否继续工作。

provider 直接使用用例声明的 prompt，仅附加临时目录安全边界，不替换任务目标。

fixture 只覆盖这些高价值边界，不枚举所有 `git worktree` 命令与低概率故障模式。Engine 负责 variant/attempt 循环、timeout、进程树和最终 EvalResult，默认对每个 behavior case 运行 3 次。

## AW 验证

```bash
pnpm plugin:test git-toolkit
aw skill eval prepare git-toolkit isolating-work-with-git-worktrees --suite router --profile project-default --split validation --runs 3 --output /tmp/aw-eval-specs/git-worktree-router-validation --json
aw skill eval prepare git-toolkit isolating-work-with-git-worktrees --suite router --profile project-default --split sanity --runs 3 --output /tmp/aw-eval-specs/git-worktree-router-sanity --json
aw skill eval prepare git-toolkit isolating-work-with-git-worktrees --suite behavior --profile project-default --runs 3 --output /tmp/aw-eval-specs/git-worktree-behavior --json
```

准备与运行中的 materialization 命令只验证 project/user 最终制品，不启动模型。其余 Spec 应分别交给 `$run-aw-skill-evals`；trigger 使用 manifest 的三次运行默认值。
