# Skill 评估指南

新建 Skill、改变 description、调整核心工作流、renderer/config，或修复真实执行问题后读取本文。评估分为三层，不能互相替代：

- `validate_plugin.mjs`：源码结构、manifest 和 eval manifest 作者合同。
- `pnpm plugin:test`：确定性脚本、转换和 bundle 合同，不调用模型。
- `pnpm plugin:eval`：Codex 最终制品 materialization 与真实模型行为。

模型 eval v1 只覆盖 Codex，且只在本地显式运行；不进入常规 CI。Claude 仍由 build、validator 和 `plugin:test` 验证确定性合同，不得据此声称 Claude 模型行为已通过。

## 作者期目录与 manifest

插件 eval 固定放在插件根，不放进声明的 Skill 子树：

```text
plugins/<name>/
├── evals/
│   ├── manifest.json
│   ├── trigger-cases.json
│   ├── trigger-fixture.mjs     # 可选，只准备领域 fixture
│   ├── evals.json
│   └── run-specialized-*.mjs   # 可选，只保留领域专用 suite
└── skills/ 或 templates/
```

`evals/**` 是作者期材料，不属于 production runtime bundle。动态 Skill 的评测对象也不是 template，而是中央 materializer 通过真实 staging、renderer、ArtifactPlan 校验和 Codex adapter 得到的最终制品。

`evals/manifest.json` 使用 schema v1：

```json
{
  "schemaVersion": 1,
  "plugin": "review-workflow",
  "profiles": [
    {
      "id": "project-default",
      "scope": "project",
      "config": {},
      "triggerPreference": "default",
      "runModel": true,
      "requiredForRelease": true
    },
    {
      "id": "user-default",
      "scope": "user",
      "config": {},
      "triggerPreference": "default",
      "runModel": false,
      "requiredForRelease": true
    }
  ],
  "suites": [
    {
      "id": "trigger",
      "kind": "trigger",
      "skill": "review-workflow",
      "cases": "./evals/trigger-cases.json",
      "observeSpawnAgent": false,
      "isolation": "standard",
      "strictNegativeSplits": ["validation"],
      "profiles": ["project-default"],
      "defaultRuns": 3,
      "releaseSplits": ["validation"],
      "requiredForRelease": true,
      "perRunTimeoutMs": 180000
    }
  ]
}
```

Profile 规则：

- v1 平台固定为 Codex。
- `config` 必须经 AW 配置存储和真实 renderer 消费，不能用字符串替换模拟最终 Skill。
- 真实模型只允许 `scope: "project"` 且 `runModel: true` 的 profile。
- user profile 必须 `runModel: false`；它只证明 native 写入前的确定性 materialized artifact，不声称经过 user native cache 的真实模型运行。
- 动态插件至少覆盖 default 与一个能改变制品的 non-default config；这些 profile 可以只 materialize，不必都调用模型。

Suite 规则：

- `trigger` 由中央 `codex exec --json` driver 执行，使用 materialized project Skill、隔离 `CODEX_HOME`、重复运行和统一报告。它原生支持 split/runs/case/model/codex-bin，不需要插件 runner。
- trigger corpus 使用 `{ "schemaVersion": 1, "skill": "...", "cases": [...] }`；每个 case 声明 `id`、`split`、`query`、`should_load_skill`，需要检查子代理时再声明 `should_spawn_agent`。
- `fixtureModule` 只能指向 `evals/*.mjs`，必须导出 `setupTriggerWorkspace({ workspaceRoot, evalCase, env })`；可选的 `captureTriggerWorkspaceState` 返回前后可比较的 JSON 状态。fixture 只能准备临时材料，不能修改 materialized 目标 Skill，也不能覆盖 HOME/CODEX_HOME/XDG/TMP/PATH。
- `command` 只用于 model-selection、routing、workflow 等领域专用 runner；`supports` 明确中央入口可以透传哪些参数。runner 必须接受 `--output`，并要求中央提供 `AW_PLUGIN_EVAL_PROJECT_ROOT`，不得回退到源码或 template 自行渲染。
- `perRunTimeoutMs` 是单次模型运行时限；`command` 还必须声明独立的 `suiteTimeoutMs` 作为整个领域 runner 的中央兜底，且不得小于 `perRunTimeoutMs`。中央只把前者透传为 `--timeout-ms`，只用后者终止整个子进程。
- `conversation` 由中央 Codex app-server driver 执行，使用 `skill` 指定 baseline 要移除的受管 Skill，适合需要 `request_user_input` 多轮回复的用例；case 保存结构化 `scripted_replies`，不得依赖运行时生成的 question id。
- suite 只能引用 `runModel: true` profile。materialize-only profile 不进入 suite。
- `requiredForRelease` 和 `releaseSplits` 决定无过滤参数运行时的发布证据集合。

`validate_plugin.mjs` 会在 `evals/manifest.json` 存在时检查 schema、路径、profile/suite 引用和 user/project 模型边界。eval manifest 不写入 `.agents-plugin/plugin.json`。

## 中央运行入口

只生成最终制品，不启动模型：

```bash
pnpm plugin:eval <plugin> --materialize-only --output-dir /tmp/aw-eval
pnpm plugin:eval --all --materialize-only --output-dir /tmp/aw-eval
```

运行一个小范围真实 Codex eval：

```bash
pnpm plugin:eval <plugin> \
  --suite trigger \
  --split validation \
  --runs 1 \
  --output-dir /tmp/aw-eval
```

本地发布评估直接运行，不传 suite/profile/split 过滤：

```bash
pnpm plugin:eval <plugin> --output-dir /tmp/aw-eval
```

默认执行 manifest 中所有 release-required suite/split，同时 materialize 所有 profile。常用调试参数还有 `--profile`、`--case`、`--model`、`--codex-bin`。suite 不支持的参数会失败，不能静默忽略。

`pnpm plugin:eval` 是唯一支持的模型 eval 入口。不要直接运行插件 `evals/` 下的 command runner；直接调用既缺少 final-artifact profile/digest，也会因缺少 `AW_PLUGIN_EVAL_PROJECT_ROOT` 失败。

`--allow-environment-skips` 只用于诊断已知环境限制；任何 skip 都必须保持 `incomplete`，不能形成发布通过证据。

规范输出位于 `<output-dir>/<plugin>/evaluation.json`。它记录 plugin/version、Codex version、model、profile/scope、config/bundle/content digest、suite 结果和证据路径。显式指定 output dir 时保留 materialized subjects 和原始 suite report；未指定时临时目录会在命令结束后清理。

## 触发评估

只有允许模型自动发现的 Skill 才把自动触发率作为验收门。固定 manual Skill 仍要保持 description 精确，但验收重点是不会误触发且 `$skill-name` 显式入口可用。

准备约 20 条真实 query：

- 8–10 条 `should_trigger: true`，覆盖正式、口语、错别字、短请求和长上下文。
- 8–10 条共享关键词但目标不同的 near-miss 负例，不使用天气、斐波那契等无重叠任务。
- 固定拆成约 60% train、40% validation，并另留 5–10 条 sanity。
- 每条在干净 project session 中运行至少 3 次；只根据 train 调 description，用 validation/sanity 检查泛化。
- 正例默认要求命中率高于 `0.5`，负例默认低于 `0.5`；需要 validation 零误触时把该 split 放进 `strictNegativeSplits`。

漏触发时扩大用户意图或场景类别；误触发时收紧相邻任务边界。不要把失败 query 原词逐个堆进 description。

## 输出与多轮行为评估

从 2–3 个真实任务开始。`evals/evals.json` 中的 prompt 要像真实用户输入，覆盖边界条件；`expected_output` 描述成功，不固定无关措辞。fixture 必须小型、脱敏，大型或私有输入留在本地 eval workspace。

每个 case 使用相同 prompt、workspace、权限、model 和输入规则比较：

1. `with_skill`：最终 materialized Skill。
2. `without_skill`：不加载 Skill 的 baseline；改进已有 Skill 时也可以对比冻结的 `old_skill`。

第一轮先看实际输出，再把真正有区分度的机械断言写回 case。可检查文件、字段、数量、具体证据和 workspace diff；不要断言完全相同文案。

需要 `request_user_input` 时，回复按步骤和问题索引保存，例如：

```json
{
  "expected_question_count": 1,
  "answers_by_index": ["保留兼容窗口"],
  "unexpected_question_answer": "我暂时不知道，请先处理已回答部分。"
}
```

中央 app-server driver 在运行时把这些答案映射到真实 question id，并保存问题、答复、最终消息、token usage、事件 trace 和 workspace diff。

## 结果与定性复核

`EvaluationBundle` outcome：

- `passed`：运行完整且机械检查通过，不需要额外定性判分。
- `failed`：机械行为或已判分检查失败。
- `needs_review`：运行和机械检查完整，但自然语言 checks 尚需 reviewer 逐项给证据结论。
- `incomplete`：认证、Codex/app-server 协议、timeout、rollout、environment skip 或制品缺失导致证据不完整。

本仓库不增加第二个 judge 模型。`needs_review` 由 `.agents/skills/skill-review/` 读取真实 trace，按 case/check 给出 PASS/FAIL 和证据。release 模式会自动运行 required suites；`incomplete`、未完成定性复核或 required profile 缺失都不能通过发布门禁。

## 完成检查

- [ ] `evals/manifest.json` 通过作者 validator。
- [ ] 自动 Skill 有 train/validation/sanity 的正例与 near-miss。
- [ ] 动态 Skill 覆盖 default/non-default、project/user 最终制品。
- [ ] 真实模型只运行 Codex project profile，user 只 materialize。
- [ ] current 与 baseline 使用相同输入和干净上下文。
- [ ] 机械断言优先，定性 checks 都能绑定 trace/diff 证据。
- [ ] `plugin:test`、materialization 和模型 eval 没有互相冒充。
- [ ] release required suite 没有 skip、incomplete 或未复核的 `needs_review`。

## 上游参考

- [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills)
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)
