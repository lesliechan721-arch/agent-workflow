# Decision Grill 作者期评测

本目录由 `decision-grill` 持有。

## 准备与运行

`aw skill eval prepare` 每次只准备 manifest 注册的一个 suite/profile。`--output` 必须指向 Workspace 外尚不存在的新目录。只做 materialization 诊断时只执行 prepare，不启动 provider：

```bash
aw skill eval prepare ask-me \
  --skill decision-grill --suite trigger --profile project-default \
  --output /tmp/aw-eval-plans/decision-grill-trigger-project-default --json
```

需要模型时，先为目标 suite/profile 生成新的 Plan，再对该目录的 `plan.json` 使用 `$run-aw-skill-evals`。该 Skill 先协调独立 `audit-agent-skill-evals` 上下文完成 preflight Audit，再取得本次模型成本、外部进程、凭据、网络和临时输出的明确授权；授权后执行带 Audit 的命令，并在运行后完成 result-triage：

```bash
aw-skill-eval run /tmp/aw-eval-plans/<plan-dir>/plan.json --audit /tmp/aw-eval-plans/<plan-dir>/preflight-audit.json
```

上面的 `aw-skill-eval run` 仅表示 `$run-aw-skill-evals` 在 Audit 和授权通过后调用的 `aw-skill-eval run <plan.json> --audit <audit.json>`。没有 Audit 或 result-triage 的 bundle 只能作为诊断证据，不能用于 Review、修改 Skill 或发布结论。

发布所需的 manifest suite/profile 应分别准备；不要把多个 suite 合并为一个 Plan：

```bash
aw skill eval prepare ask-me --skill decision-grill --suite trigger --profile project-default --split validation --runs 3 --output /tmp/aw-eval-plans/decision-grill-trigger-validation --json
aw skill eval prepare ask-me --skill decision-grill --suite trigger --profile project-default --split sanity --runs 3 --output /tmp/aw-eval-plans/decision-grill-trigger-sanity --json
aw skill eval prepare ask-me --skill decision-grill --suite router --profile project-default --split validation --runs 10 --output /tmp/aw-eval-plans/decision-grill-router-validation --json
aw skill eval prepare ask-me --skill decision-grill --suite router --profile project-default --split sanity --runs 10 --output /tmp/aw-eval-plans/decision-grill-router-sanity --json
aw skill eval prepare ask-me --skill decision-grill --suite behavior --profile project-default --output /tmp/aw-eval-plans/decision-grill-behavior --json
aw skill eval prepare ask-me --skill decision-grill --suite decision-frame --profile project-default --output /tmp/aw-eval-plans/decision-grill-decision-frame --json
```

单 Skill trigger
corpus 有 25 条用例：train 与 validation 各 10 条，另有 5 条 sanity。train/validation 各含 5 条隐式正例和 5 条近似负例；sanity 含显式调用、口语正例、短推荐、长上下文评审和完整实施任务。它覆盖计划、决策或想法访谈，以及一次性技术说明、直接推荐、内部执行计划和实施歧义等近似负例。`n09_implementation_ambiguity`
不加载项目规则，用于独立验证 description 边界；validation 和 sanity 负例零容忍。

`ask-me-routing-cases.json` 是两个 Ask Me Skill 的路由矩阵。它用 `expected_loaded_skills` 精确区分
`decision-grill`、`decision-prototype`
和不加载。核心 validation 和 sanity 用例都是发布门禁；每条运行 10 次，正确路由至少为 90%，任何同时加载都失败。

`decision-grill-release-evals.json`
包含 3 个低提示代表性会话用例，检查依赖前沿、用户所有的取舍、明确延后和最终确认。`natural-owner-choice`
只在 case 的 `workspace_files`
中提供已确认事实，用来验证 agent 先读项目文档、不重复询问，再把用户所有的取舍交给用户。它是发布必需的 behavior
suite。

`decision-grill-evals.json`
保留 15 个非发布诊断用例。多数用例隔离检查单条正文规则；`reopen-existing-decision`、`avoid-exhaustion`
和 `shared-understanding-confirmation` 使用低提示自然任务检查完整 Skill。它不是当前 manifest 注册的
suite，不通过 `aw skill eval prepare` 运行。conversation baseline 只移除 owner Skill，并保留
`decision-prototype`。
