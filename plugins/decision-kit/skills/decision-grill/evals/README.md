# Decision Grill 作者期评测

本目录由 `decision-grill` 持有。

## 准备与运行

`aw dev eval prepare` 每次按 manifest 注册的一个 suite/profile 和可选 case/split 选择生成 `EvalSpec v1`。`--output` 必须指向 Workspace 外尚不存在的新目录。只做 materialization 诊断时只执行 prepare，不启动 provider：

```bash
aw dev eval prepare decision-kit \
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
aw dev eval prepare decision-kit decision-grill --suite trigger --profile project-default --split validation --runs 3 --output /tmp/aw-eval-specs/decision-grill-trigger-validation --json
aw dev eval prepare decision-kit decision-grill --suite trigger --profile project-default --split sanity --runs 3 --output /tmp/aw-eval-specs/decision-grill-trigger-sanity --json
aw dev eval prepare decision-kit decision-grill --suite router --profile project-default --split validation --runs 10 --output /tmp/aw-eval-specs/decision-grill-router-validation --json
aw dev eval prepare decision-kit decision-grill --suite router --profile project-default --split sanity --runs 10 --output /tmp/aw-eval-specs/decision-grill-router-sanity --json
aw dev eval prepare decision-kit decision-grill --suite behavior --profile project-default --output /tmp/aw-eval-specs/decision-grill-behavior --json
aw dev eval prepare decision-kit decision-grill --suite decision-frame --profile project-default --output /tmp/aw-eval-specs/decision-grill-decision-frame --json
aw dev eval prepare decision-kit decision-grill --suite sustained-interview --profile project-default --output /tmp/aw-eval-specs/decision-grill-sustained-interview --json
aw dev eval prepare decision-kit decision-grill --suite decision-comprehension --profile project-default --output /tmp/aw-eval-specs/decision-grill-decision-comprehension --json
aw dev eval prepare decision-kit decision-grill --suite bounded-question-trigger --profile project-default --output /tmp/aw-eval-specs/decision-grill-bounded-question --json
aw dev eval prepare decision-kit decision-grill --suite presentation-handoff --profile project-default --output /tmp/aw-eval-specs/decision-grill-presentation-handoff --json
```

单 Skill trigger
corpus 有 25 条用例：train 5 正 5 负、validation 3 正 7 负、sanity 2 正 3 负。它覆盖用户拥有的重要取舍、计划访谈，以及一次性技术说明、内部工程选型、直接推荐和单项实施澄清等近似负例。`n09_implementation_ambiguity`
不加载项目规则，用于独立验证单项选择可直接澄清的边界；validation 和 sanity 负例零容忍。

`decision-kit-routing-cases.json` 是两个 Decision Kit Skill 的路由矩阵。它用 `expected_loaded_skills` 精确区分
`decision-grill`、`decision-prototype`
和不加载。validation 和 sanity 每条运行 10 次，正确路由至少为 90%，任何同时加载都失败。

`decision-grill-release-evals.json`
包含 3 个低提示代表性会话用例，检查依赖前沿、用户所有的取舍、明确延后和最终确认。`natural-owner-choice`
只在 case 的 `workspace_files`
中提供已确认事实，用来验证 agent 先读项目文档、不重复询问，再把用户所有的取舍交给用户。

`decision-frame-cases.json` 检查推断的共享决策方向对用户可见、方向歧义先选择、调用方方向复用，以及叶子 Skill 的独立交付。`decision-comprehension-cases.json` 检查紧凑默认呈现、非技术场景、短流程、时间线、上下文压缩和理解失败后的表现形式切换。

`sustained-interview-cases.json` 检查开放主题在没有“请继续”提示时仍根据实际回答展开、单轮题数上限不丢失剩余问题、局部证据缺口不阻塞其他取舍，以及含糊方向需要具体后果核对。开放主题不预先提供依赖树；只评价实际提问与答复的先后，不把会话运行器追加的脚本答复当作主动继续的证据。批量用例的三题与两题来自用户显式要求，其他用例按用户要求每轮一题。保留已有单题、委托、暂停和无新增含义时不重复确认的回归用例。

`bounded-question-trigger` 检查显式指定或由协调者委派的一题访谈，以及解释、原型反馈的近似负例。`presentation-handoff` 单独暴露 explain-clearly，检查复杂材料的辅助呈现能回到当前问题；两种 `independent-delivery` suite 保留独立交付、证据不足和已授权局部记录的回归。
