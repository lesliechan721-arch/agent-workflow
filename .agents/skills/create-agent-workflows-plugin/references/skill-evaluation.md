# Skill 评估指南

新建 Skill、改变 description、调整核心工作流、renderer/config，或修复真实执行问题后读取本文。评估分为三层，不能互相替代：

- `validate_plugin.mjs`：源码结构、manifest 和 eval manifest 作者合同。
- `pnpm plugin:test`：确定性脚本、转换和 bundle 合同，不调用模型。
- `pnpm plugin:eval`：Codex 最终制品 materialization 与真实模型行为。

当前模型 eval 只覆盖 Codex，且只在本地显式运行；不进入常规 CI。Claude 仍由 build、validator 和 `plugin:test` 验证确定性合同，不得据此声称 Claude 模型行为已通过。

## 作者期目录与 manifest

每个 eval 由一个 owner Skill 持有。定义和持久报告固定放在该 Skill 源码根：

```text
plugins/<name>/
└── skills/<skill>/ 或 templates/<skill>/
    ├── SKILL.md
    ├── evals/
    │   ├── manifest.json
    │   ├── trigger-cases.json
    │   ├── trigger-fixture.mjs     # 可选，只准备领域 fixture
    │   ├── evals.json
    │   └── run-specialized-*.mjs   # 可选，只保留领域专用 suite
    └── reports/
        ├── evals/<run-id>/
        └── reviews/<run-id>/
```

静态 Skill 使用 `skills/<skill>/evals/`。动态 Skill 在目标声明的 `sourceDirs` 中选择唯一包含 `evals/manifest.json` 的源码根；同一个 Skill 不能有多个 eval owner。插件根 `evals/` 已禁用。

`evals/**` 和 `reports/**` 都是作者期材料，不属于 production runtime bundle，也不参与 runtime package digest。动态 Skill 的评测对象不是 template，而是中央 materializer 通过真实 staging、renderer、ArtifactPlan 校验和 Codex adapter 得到的最终制品。

`evals/manifest.json` 使用 schema v2：

```json
{
  "schemaVersion": 2,
  "plugin": "review-workflow",
  "skill": "review-workflow",
  "profiles": [
    {
      "id": "project-default",
      "scope": "project",
      "plugins": [
        { "name": "review-workflow", "config": {} },
        { "name": "review-policy", "config": {} }
      ],
      "runModel": true,
      "requiredForRelease": true
    },
    {
      "id": "user-default",
      "scope": "user",
      "plugins": [
        { "name": "review-workflow", "config": {} },
        { "name": "review-policy", "config": {} }
      ],
      "runModel": false,
      "requiredForRelease": true
    }
  ],
  "suites": [
    {
      "id": "trigger",
      "kind": "trigger",
      "skills": ["review-workflow", "review-policy"],
      "cases": "./trigger-cases.json",
      "observeSpawnAgent": false,
      "isolation": "strict",
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

- v2 平台固定为 Codex。manifest 的 `plugin` 和 `skill` 定义证据 owner。
- `plugins[]` 按声明顺序安装到同一个隔离 subject；必须包含 owner 插件，名称不能重复。每项 `config` 必须经对应插件的 AW 配置存储和真实 renderer 消费，不能用字符串替换模拟最终 Skill。
- companion 插件只从当前仓库 `plugins/<name>` 解析。跨插件安装只属于 eval fixture，不形成 production dependency；插件 manifest 仍不支持 `dependencies`。
- 同一 profile 的已安装插件不能生成重名 Codex Skill。
- 真实模型只允许 `scope: "project"` 且 `runModel: true` 的 profile。
- user profile 必须 `runModel: false`；它只证明 native 写入前的确定性 materialized artifact，不声称经过 user native cache 的真实模型运行。
- 动态插件至少覆盖 default 与一个能改变制品的 non-default config；这些 profile 可以只 materialize，不必都调用模型。

Suite 规则：

- 每个 suite 必须声明非空、无重复的 `skills[]`，并包含 owner Skill。profile 中安装的插件必须能提供全部 participant Skills。
- `trigger` 由中央 Codex app-server driver 执行，使用 materialized project Skill、隔离 `CODEX_HOME`、重复运行和统一报告。driver 会观察 `skills[]` 中每个 participant Skill。Skill 加载由完成的 `commandExecution` 读取事件确认：命令成功时直接采用；复合命令整体失败时，只有 captured output 明确包含对应 Skill 的 `name` frontmatter 才采用，避免后续搜索失败抹掉已完成的读取，也避免把未成功的读取尝试当成证据。启用 `observeSpawnAgent` 时，实际委派由 V2 `subAgentActivity(kind=started)` 确认。该事件不包含完整 spawn 参数；需要校验 role、model 或 effort 时使用领域 command suite。中央 driver 原生支持 split/runs/case/model/codex-bin，不需要插件 runner。
- `trigger` 和 `conversation` 都支持 `isolation: "standard" | "strict"`，schema v2 省略时默认为 `standard`。用于发布门禁、触发边界或行为归因的 suite 应显式使用 `strict`；只需要兼容旧语料或调试宿主集成时才使用 `standard`。
- trigger corpus 使用 `{ "schemaVersion": 1, "skill": "...", "cases": [...] }`。每个 case 必须声明 `id`、`split`、`query`，并在以下两种期望中选择一种：
  - 单目标触发用 `should_load_skill: boolean`，只判断 owner Skill。
  - 相邻 Skill 竞争路由用 `expected_loaded_skills: string[]`，精确声明应加载的 participant Skill 集合；空数组表示不应加载任何 participant。
- 精确路由 suite 可以用 `minimumPassRate` 设置正确路由下限，并用 `forbidMultipleSkillLoads: true` 禁止任一次同时加载多个 Skill。报告记录 `first_loaded_skill`、`all_loaded_skills`、逐 Skill 读取证据、问题工具调用、等待状态、最终响应和终止原因。
- trigger 只判断路由，不等待完整澄清会话。未读取目标 Skill，并调用 `request_user_input` 时，以 `waiting_on_user_input` 正常结束，不计为 timeout 或 execution error。
- `strictNegativeSplits` 对负例使用零容忍：重复运行中任何一次误加载或错误委派都会让该 split 失败，不能用三次中的多数结果掩盖一次错误。
- `fixtureModule` 只能指向 owner Skill 的 `evals/*.mjs`，必须导出 `setupTriggerWorkspace({ workspaceRoot, evalCase, env })`；可选的 `captureTriggerWorkspaceState` 返回前后可比较的 JSON 状态。fixture 只能准备临时材料，不能修改 materialized participant Skill，也不能覆盖 HOME/CODEX_HOME/XDG/TMP/PATH；strict 模式还禁止修改 `.agents` 和 `.codex` 控制面。
- `command` 只用于 model-selection、routing、workflow 等领域专用 runner；`supports` 明确中央入口可以透传哪些参数。runner 必须接受 `--output`，并要求中央提供 `AW_PLUGIN_EVAL_PROJECT_ROOT`，不得回退到源码或 template 自行渲染。
- command runner 同时收到 `AW_PLUGIN_EVAL_OWNER_SKILL`、`AW_PLUGIN_EVAL_PARTICIPANT_SKILLS` 和 `AW_PLUGIN_EVAL_INSTALLED_PLUGINS`。后两项是 JSON 数组。
- `perRunTimeoutMs` 是单次模型运行时限；`command` 还必须声明独立的 `suiteTimeoutMs` 作为整个领域 runner 的中央兜底，且不得小于 `perRunTimeoutMs`。中央只把前者透传为 `--timeout-ms`，只用后者终止整个子进程。
- `conversation` 由中央 Codex app-server driver 执行，适合需要 `request_user_input` 多轮回复的用例；driver 会在 Default 协作模式显式启用该工具，case 保存结构化 `scripted_replies`，不得依赖运行时生成的 question id。strict current 只保留 `skills[]` 的精确集合；baseline 只移除 owner Skill，并保留 companion Skills。这样可以测量 owner 的增量作用，不破坏真实组合环境。当前 conversation driver 不支持 split 过滤，因此 `releaseSplits` 必须为空数组。
- suite 只能引用 `runModel: true` profile。materialize-only profile 不进入 suite。
- `requiredForRelease` 和 `releaseSplits` 决定无过滤参数运行时的发布证据集合。

`validate_plugin.mjs` 会发现每个 Skill 的 `evals/manifest.json`，检查 schema、owner、路径、repo-local companion、Skill 归属、profile/suite 引用和 user/project 模型边界。eval manifest 不写入 `.agents-plugin/plugin.json`。

## 中央运行入口

只生成最终制品，不启动模型：

```bash
pnpm plugin:eval <plugin> --skill <skill> --materialize-only
```

运行一个小范围真实 Codex eval：

```bash
pnpm plugin:eval <plugin> \
  --skill <skill> \
  --suite trigger \
  --split validation \
  --runs 1
```

本地发布评估直接运行，不传 suite/profile/split 过滤：

```bash
pnpm plugin:eval <plugin> --skill <skill>
```

一次命令只运行一个 owner Skill。`--skill` 必填，插件级 `--all` 不受支持。跨 Skill 或跨插件组合由该 Skill manifest 的 `skills[]` 和 `profiles[].plugins[]` 明确声明。默认执行该 owner manifest 中所有 release-required suite/split，同时 materialize 所有 profile。常用调试参数还有 `--profile`、`--case`、`--model`、`--codex-bin`。suite 不支持的参数会失败，不能静默忽略。

`--suite`、`--profile`、`--split`、`--case` 都会把 bundle 标为 `complete: false`、`outcome: incomplete`；低于 suite `defaultRuns` 的 `--runs` 也相同。此类局部调试即使机械检查通过也退出 `1`，不能作为发布证据。

真实模型默认使用 `gpt-5.6-luna`；`--model` 可显式覆盖。当前 `CODEX_HOME/config.toml` 只提供选中的 `model_providers.<id>`、provider 连接配置及其它允许的 model 设置，不再决定默认模型；不会继承用户 plugins、skills、MCP、agents 或其它配置。所有中央 eval 都把 `cli_auth_credentials_store` 和 `mcp_oauth_credentials_store` 固定为 `file`，并关闭 `features.secret_auth_storage`，因此临时 Codex 进程不应访问 macOS 钥匙串。可用 `--model-provider <id>`、`--codex-config <path>` 显式选择 provider 来源，或用 `--no-inherit-codex-config` 回到干净的官方默认 provider。provider 引用的环境变量按名称透传，但隔离保留变量会被拒绝，command runner 也不会继承其它宿主 secret；配置内 bearer 只写入 `0600` 临时 runtime home，非官方 provider 一律不复制官方 auth。凭据变量排除出模型 shell，endpoint、token、header 或环境变量值在写持久报告前统一脱敏；临时 capsule 在正常结束、失败和进程信号中清理。

strict 模式在启动模型前检查 `/etc/codex`（Windows 对应系统目录）和 macOS `com.openai.codex` 的受管配置键；启动 app-server 后再读取有效 config layers、requirements、Skill 清单和 MCP 清单。检测到系统、MDM、云端或旧式 managed config、非目标 Skill、MCP server、Skill discovery error，或任一关闭项未生效时，suite 以 `incomplete` 结束，不产生发布通过证据。报告的 `environment.isolation` 保存这些检查结果。

真实模型 eval 应从普通 Terminal 会话直接运行。不要通过会临时导出或改写用户 keychain search list 的 GUI、沙箱或提权包装器启动；这类外层包装器可能留下失效的 `accountsKeychainExport` 路径，并在 Codex 启动前触发 macOS“找不到钥匙串”弹窗。中央入口在 macOS 检测到该包装器路径时会直接拒绝真实模型 eval，不会修改用户 keychain search list；`--materialize-only` 和确定性测试不执行该检查，也不需要启动 Codex 模型进程。

真实模型 eval 默认还要求 Full Access 可用，以便发现并清理 Codex 的后代进程。检查失败时，入口会在创建报告目录和启动模型前阻断。Windows 当前没有 Job Object containment，也走同一阻断路径。确认可接受风险后，可以显式传 `--allow-unmanaged-processes`；该模式只跟踪直接子进程，timeout、信号或 runner 退出后可能遗留后代进程，报告会记录 `descendantCleanupGuaranteed: false`。它可以用于本地运行，但 release reviewer 必须明确接受这项环境风险。

`pnpm plugin:eval` 是唯一支持的模型 eval 入口。不要直接运行插件 `evals/` 下的 command runner；直接调用既缺少 final-artifact profile/digest，也会因缺少 `AW_PLUGIN_EVAL_PROJECT_ROOT` 失败。

`--allow-environment-skips` 只用于诊断已知环境限制；任何 skip 都必须保持 `incomplete`，不能形成发布通过证据。

中间产物固定在项目内 `.tmp/agent-workflows/evals/plugins/<plugin>/<skill>/<run-id>/`，命令结束后清理。持久报告固定在 `<owner-skill-root>/reports/evals/<run-id>/`：`run.json` 记录运行状态，`summary.json` 和 `report.md` 用于长期保存，`raw/evaluation.json`、materialized subjects 和 suite trace 用于复核。`raw/` 默认不提交 Git，但不能在 review 完成前删除。CLI 不接受任意 `--output-dir`。

持久 `reports/` 不属于被评估源码，中央 source revision 检查会忽略该目录；插件源码、eval 夹具、脚本和作者/评审工具的未提交修改仍会令 `source.inScopeDirty=true`。

## 触发评估

只有允许模型自动发现的 Skill 才把自动触发率作为验收门。固定 manual Skill 仍要保持 description 精确，但验收重点是不会误触发且 `$skill-name` 显式入口可用。

准备约 20 条真实 query：

- 8–10 条 `should_trigger: true`，覆盖正式、口语、错别字、短请求和长上下文。
- 8–10 条共享关键词但目标不同的 near-miss 负例，不使用天气、斐波那契等无重叠任务。
- 固定拆成约 60% train、40% validation，并另留 5–10 条 sanity。
- 每条在干净 project session 中运行至少 3 次；只根据 train 调 description，用 validation/sanity 检查泛化。
- 单目标正例默认要求命中率高于 `0.5`，负例默认低于 `0.5`；需要 validation 零误触时把该 split 放进 `strictNegativeSplits`。相邻 Skill 路由应使用 `expected_loaded_skills` 和更高的 `minimumPassRate`，不能只检查 owner Skill 是否未加载。
- 自动触发 train/validation/sanity 不写 `$skill-name`；显式调用另放 smoke。manual Skill 的正向验收使用显式调用 smoke，负例验证未显式调用时不误加载。

漏触发时扩大用户意图或场景类别；误触发时收紧相邻任务边界。不要把失败 query 原词逐个堆进 description。

## 输出与多轮行为评估

从 2–3 个真实任务开始。`evals/evals.json` 中的 prompt 要像真实用户输入，覆盖边界条件；`expected_output` 描述成功，不固定无关措辞。fixture 必须小型、脱敏，大型或私有输入留在本地 eval workspace。

每个 case 使用相同 prompt、workspace、权限、model 和输入规则比较：

1. `with_skill`：最终 materialized Skill。
2. `without_skill`：不加载 Skill 的 baseline；改进已有 Skill 时也可以对比冻结的 `old_skill`。

第一轮先看实际输出，再把真正有区分度的机械断言写回 case。可检查文件、字段、数量、具体证据和 workspace diff；不要断言完全相同文案。

需要实际创建或修改文件时，conversation case 显式声明：

```json
{
  "sandbox": "workspace-write",
  "review": {
    "workspace_unchanged": false,
    "allowed_workspace_changes": ["outputs/**"],
    "artifacts": [
      {
        "path": "outputs/result.json",
        "exists": true,
        "json": { "status": "ok" },
        "contains": ["evidence"],
        "not_contains": ["TODO"]
      }
    ],
    "checks": ["trace 执行完整工作流"]
  }
}
```

`workspace-write` 只作用于每次运行的隔离临时副本，关闭网络写入能力，并要求非空的允许改动路径和最终 artifact 断言。机械门对当前版本检查改动路径、文件存在、文本和 JSON 子集；baseline 使用相同 sandbox 和输入，并保留自己的 diff、artifact digest、token 和时间。只读 case 省略 `sandbox`，默认保持 `read-only`。

`init_plugin.mjs` 会生成 trigger train/validation/sanity 和一个可写 behavior starter。starter 只提供合法结构；发布前必须替换为领域真实任务、near-miss、允许改动路径和可区分的断言。

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

- [ ] owner Skill 的 `evals/manifest.json` 通过作者 validator。
- [ ] `skills[]` 覆盖真实 participant；跨插件 profile 只引用当前仓库插件，且不被误写为 production dependency。
- [ ] 自动 Skill 有 train/validation/sanity 的正例与 near-miss。
- [ ] 动态 Skill 覆盖 default/non-default、project/user 最终制品。
- [ ] 真实模型只运行 Codex project profile，user 只 materialize。
- [ ] current 与 baseline 使用相同输入和干净上下文。
- [ ] 写入行为只使用隔离 `workspace-write`，并有最小允许改动路径和最终 artifact 机械断言。
- [ ] 机械断言优先，定性 checks 都能绑定 trace/diff 证据。
- [ ] `plugin:test`、materialization 和模型 eval 没有互相冒充。
- [ ] release required suite 没有 skip、incomplete 或未复核的 `needs_review`。
- [ ] eval 报告保存在 owner Skill 的 `reports/evals/<run-id>/`；review 报告保存在 `reports/reviews/<run-id>/`。

## 上游参考

- [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills)
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)
