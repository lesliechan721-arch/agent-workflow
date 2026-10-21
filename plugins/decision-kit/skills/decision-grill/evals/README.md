# Decision Grill 作者期评测

本目录由 `decision-grill` 持有。

## 准备与运行

`aw skill eval prepare` 每次按 manifest 注册的一个 suite/profile 和可选 case/split 选择生成 `EvalSpec v1`。`--output` 必须指向 Workspace 外尚不存在的新目录。只做 materialization 诊断时只执行 prepare，不启动 provider：

```bash
aw skill eval prepare decision-kit \
  decision-grill --suite trigger --profile project-default \
  --output /tmp/aw-eval-specs/decision-grill-trigger-project-default --json
```

需要模型时，先验证 Spec。复用与 current、可选 previous-version target 和 selected cases 精确绑定的单份 `EvalAudit v1`；没有可复用 Audit 时，由全新上下文生成一份。取得本次成本与副作用授权后，Runner 执行：

```bash
aw-skill-eval run /tmp/aw-eval-specs/<spec-dir>/spec.json --audit /tmp/aw-eval-specs/<spec-dir>/audit.json
```

该命令生成 `EvalResult v2`。随后运行 `aw-skill-eval result validate <result> --spec <spec> --audit <audit>`。clean success 不要求 triage。只有 execution/grade 失败、混合结果、baseline 回归，或结果将驱动生产 Skill 修改时，才由全新上下文做 result-triage；默认在聊天中返回，用户指定时可写 `triage.md`。

每个所选 suite/profile 应分别准备，不要合并为一个 Spec：

```bash
aw skill eval prepare decision-kit decision-grill --suite trigger --profile project-default --split validation --runs 3 --output /tmp/aw-eval-specs/decision-grill-trigger-validation --json
aw skill eval prepare decision-kit decision-grill --suite trigger --profile project-default --split sanity --runs 3 --output /tmp/aw-eval-specs/decision-grill-trigger-sanity --json
aw skill eval prepare decision-kit decision-grill --suite router --profile project-default --split validation --runs 10 --output /tmp/aw-eval-specs/decision-grill-router-validation --json
aw skill eval prepare decision-kit decision-grill --suite router --profile project-default --split sanity --runs 10 --output /tmp/aw-eval-specs/decision-grill-router-sanity --json
aw skill eval prepare decision-kit decision-grill --suite behavior --profile project-default --output /tmp/aw-eval-specs/decision-grill-behavior --json
aw skill eval prepare decision-kit decision-grill --suite decision-frame --profile project-default --output /tmp/aw-eval-specs/decision-grill-decision-frame --json
aw skill eval prepare decision-kit decision-grill --suite decision-comprehension --profile project-default --output /tmp/aw-eval-specs/decision-grill-decision-comprehension --json
```

单 Skill trigger
corpus 有 25 条用例：train 与 validation 各 10 条，另有 5 条 sanity。train/validation 各含 5 条隐式正例和 5 条近似负例；sanity 含显式调用、口语正例、短推荐、长上下文评审和完整实施任务。它覆盖计划、决策或想法访谈，以及一次性技术说明、直接推荐、内部执行计划和实施歧义等近似负例。`n09_implementation_ambiguity`
不加载项目规则，用于独立验证 description 边界；validation 和 sanity 负例零容忍。

`decision-kit-routing-cases.json` 是两个 Decision Kit Skill 的路由矩阵。它用 `expected_loaded_skills` 精确区分
`decision-grill`、`decision-prototype`
和不加载。validation 和 sanity 每条运行 10 次，正确路由至少为 90%，任何同时加载都失败。

`decision-grill-release-evals.json`
包含 3 个低提示代表性会话用例，检查依赖前沿、用户所有的取舍、明确延后和最终确认。`natural-owner-choice`
只在 case 的 `workspace_files`
中提供已确认事实，用来验证 agent 先读项目文档、不重复询问，再把用户所有的取舍交给用户。

`decision-frame-cases.json` 检查推断的共享决策方向对用户可见、方向歧义先选择、调用方方向复用，以及叶子 Skill 的独立交付。`decision-comprehension-cases.json` 检查紧凑默认呈现、非技术场景、短流程、时间线、上下文压缩和理解失败后的表现形式切换。
