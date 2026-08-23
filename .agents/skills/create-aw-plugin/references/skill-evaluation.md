# Skill 评估指南

新建 Skill、改变 description、调整核心工作流、renderer/config，或修复真实执行问题后读取本文。评估分为三层，不能互相替代：

- `aw plugin validate`：源码结构、manifest 和 eval manifest 作者合同。
- `pnpm plugin:test`：确定性脚本、转换和 bundle 合同，不调用模型。
- `pnpm plugin:eval`：Codex 最终制品 materialization 与真实模型行为。

当前模型 eval 只覆盖 Codex，且只在本地显式运行；不进入常规 CI。Claude 仍由 build、validator 和 `plugin:test` 验证确定性合同，不得据此声称 Claude 模型行为已通过。

## 作者期目录与 manifest

每个 eval 由一个 owner Skill 持有。eval 定义放在 Skill 源码根，完整工作批次放在项目临时目录；只有正式 review 进入插件级报告根：

```text
plugins/<name>/
├── README.md
├── skills/<skill>/
│   ├── README.md
│   ├── SKILL.md
│   └── evals/
│       ├── manifest.json
│       ├── trigger-cases.json
│       ├── trigger-fixture.mjs     # 可选，只准备领域 fixture
│       ├── evals.json
│       └── run-specialized-*.mjs   # 可选，只保留领域专用 suite
└── reports/<skill>/<batch-id>/
    ├── report.md                 # 人工整理的正式报告
    └── summary.json              # schema v2 高层索引

.tmp/agent-workflows/evals/plugin/<name>/<skill>/<batch-id>/
├── batch.json
├── summary.json
├── report.md
├── evals/
│   ├── runs/<run-id>/
│   └── <kind>/<target...>/<run-id>/
└── reviews/<mode>/<review-id>/
```

静态和动态 Skill 都使用 `skills/<skill>` 作为源码根。动态 Skill 声明 source 时必须包含该规范根；其它 `sourceDirs` 必须留在根内，且不能进入 Skill 根的直接子目录 `evals/` 或 `reports/`。更深层的同名领域目录可以进入 runtime。eval owner 固定为规范根中唯一的 `evals/manifest.json`；同一个 Skill 不能有多个 eval owner。插件根 `evals/` 已禁用。

任意路径段 basename 为 `.DS_Store` 的 macOS 临时文件不属于 production identity，不进入 runtime bundle、runtime package digest 或 review 完整文件集合；其它 hidden production 文件仍按普通 runtime 内容处理。Skill 根的直接子目录 `evals/`、`reports/` 和插件根 `reports/**` 都是作者期材料，也不属于 production runtime bundle 或 runtime package digest。更深层的同名目录按普通 runtime 资源处理。`evals/**` 和正式报告属于 Git 源码；完整工作批次位于 `.tmp/`，不进入 Git。Skill README 是发布内容，随 Skill 原样进入最终制品。动态 Skill 的评测对象不是源码占位文本，而是中央 materializer 通过真实 staging、renderer、ArtifactPlan 校验和 Codex adapter 得到的最终制品。

每个 owner 的 `evals/README.md` 只说明自己的 corpus、suite、具体运行命令、专用 runner 限制和历史结果。全仓统一的权限、隔离、进程管理、凭据、批次布局、发布路径和平台证据边界只在本文及 CLI `--help` 维护，不复制到各 Skill。

每个临时批次只属于一个 owner Skill，可以聚合同一源码、materialization 环境、中央 eval harness 和 release target 合同下的多次运行。首个真实模型运行会固定该批次的模型、provider、Codex 版本和进程管理环境；此前的 `--materialize-only` 运行可以留在同一批次。`materialization`、`trigger`、`conversation`、`command` 是第一层 eval 类型，后续路径表示 suite、profile、split、case 等具体 target。临时批次保存统一自动汇总和完整 raw 证据，供追加运行和 review 使用。

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
- companion 插件只从当前仓库 `plugins/<name>` 解析。Eval fixture 的组合安装不会自动形成 production dependency；只有生产运行确实必需时才显式声明同 source `dependencies`，并把 `compatibility.aw.minVersion` 设置为至少 `0.1.0`。
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
- `command` 只用于 model-selection、routing、workflow 等领域专用 runner；`supports` 明确中央入口可以透传哪些参数。支持 `case` 时必须用 `cases` 指向同一 eval 目录中的 `{ skill_name, evals[] }` case 文档，并在报告中返回覆盖所选 case 的 `case_results[]`；每项包含 `id`、`outcome`、`complete` 和 `mechanical_passed`。中央据此从中断的 full run 保存已完成 case，并组合分批证据。runner 必须接受 `--output`，并要求中央提供 `AW_PLUGIN_EVAL_PROJECT_ROOT`，不得回退到源码或 template 自行渲染。
- command runner 同时收到 `AW_PLUGIN_EVAL_OWNER_SKILL`、`AW_PLUGIN_EVAL_PARTICIPANT_SKILLS` 和 `AW_PLUGIN_EVAL_INSTALLED_PLUGINS`。后两项是 JSON 数组。
- `perRunTimeoutMs` 是单次模型运行时限；`command` 还必须声明独立的 `suiteTimeoutMs` 作为整个领域 runner 的中央兜底，且不得小于 `perRunTimeoutMs`。中央只把前者透传为 `--timeout-ms`，只用后者终止整个子进程。
- `conversation` 由中央 Codex app-server driver 执行，适合需要 `request_user_input` 多轮回复的用例；driver 会在 Default 协作模式显式启用该工具，case 保存结构化 `scripted_replies`，不得依赖运行时生成的 question id。`scripted_replies` 是 current 的行为断言，并用于向两个 variant 提供相同步骤的回答；current 的步骤、问题数或未消费回复不匹配会机械失败，baseline 的同类差异只保存为比较证据。baseline 的完成、隔离、宿主源码访问和 workspace 安全仍属于机械门禁。case 可用 `workspace_files` 提供小型、脱敏的只读仓库输入；runner 在 workspace 快照前把相同内容写入 current 与 baseline，拒绝绝对路径、非规范路径、控制目录和与 materialized subject 冲突的目标。strict current 只保留 `skills[]` 的精确集合；baseline 只移除 owner Skill，并保留 companion Skills。模型工作副本位于源码树外，runner 还会审计 trace；current 或 baseline 读取宿主 participant 源码时机械失败。这样可以测量 owner 的增量作用，不破坏真实组合环境。当前 conversation driver 不支持 split 过滤，因此 `releaseSplits` 必须为空数组。
- suite 只能引用 `runModel: true` profile。materialize-only profile 不进入 suite。
- `requiredForRelease` 和 `releaseSplits` 决定无过滤参数运行时的发布证据集合。

`aw plugin validate` 会发现每个 Skill 的 `evals/manifest.json`，检查 schema、owner、路径、repo-local companion、Skill 归属、profile/suite 引用和 user/project 模型边界。eval manifest 不写入 `.agents-plugin/plugin.json`。

## 中央运行入口

只生成最终制品，不启动模型：

```bash
pnpm plugin:eval <plugin> --skill <skill> \
  --batch-name materialization --materialize-only
```

运行一个小范围真实 Codex eval：

```bash
pnpm plugin:eval <plugin> \
  --skill <skill> \
  --batch-name trigger-validation \
  --suite trigger \
  --split validation \
  --runs 1
```

本地发布评估直接运行，不传 suite/profile/split 过滤：

```bash
pnpm plugin:eval <plugin> --skill <skill> --batch-name release
```

一次命令只运行一个 owner Skill。`--skill` 必填，插件级 `--all` 不受支持。每次运行还必须用 `--batch-name <name>` 新建批次，或用前一次输出中的 `--batch-id <id>` 追加同一批次；二者只能提供一个。跨 Skill 或跨插件组合由该 Skill manifest 的 `skills[]` 和 `profiles[].plugins[]` 明确声明。默认执行该 owner manifest 中所有 release-required suite/split，同时 materialize 所有 profile。常用调试参数还有 `--profile`、`--case`、`--model`、`--codex-bin`。suite 不支持的参数会失败，不能静默忽略。

`--suite`、`--profile`、`--split`、`--case` 都会把单次 bundle 标为 `complete: false`、`outcome: incomplete`；低于 suite `defaultRuns` 的 `--runs` 还会把对应 target 本身标为 `incomplete`，不能作为 release target 通过证据。此类局部运行即使机械检查通过也退出 `1`。使用同一 `--batch-id` 可以补跑 missing 或 incomplete target；历史 attempt 和失败 run 会保留，但最新完整 attempt 进入有效汇总。声明 `cases` 的 suite 在全部 case target 完整后，中央会把它们组合成 `/all` release target。只有相同批次中所有 release target 都被完整、通过的有效 target 覆盖时，批次汇总才能给出完整 release 结果；不同源码摘要、materialization subject、模型环境、harness、case 集或 target 合同不能混入同一批次。

中央入口在每个 case 的全部 repetitions 结束后原子发布检查点。case 返回 `incomplete` 或运行环境异常时，当前命令停止，不再启动后续 case。再次用同一 `--batch-id` 运行时，入口复用已有的 terminal case，重跑 incomplete 或 missing case。当前未完成 case 的全部 repetitions 会重新运行；不会从某个 repetition 中间继续。`failed` 和 `needs_review` 也是 terminal 结果，默认不会自动重跑。没有 case 合同的 suite 仍以整个 suite 为恢复单位。进程在 run 终态写入前退出时，已发布的 case 检查点仍可复用；后续追加会把旧 run 标为 `failed`。

真实模型 eval 可能运行几十分钟到数小时。agent 启动命令时，首个执行调用应直接使用工具允许的最大 `yield_time_ms`。工具返回进程 session 后，后续等待应继续使用同一个 session，并直接使用单次调用允许的最大响应式等待时间。一次等待超时只表示本次等待窗口结束，不表示 eval 失败。不要使用短周期 wait 循环，也不要另开 `sleep`、`ps`、报告目录、日志文件、Git 或其它命令轮询状态。

真实模型默认使用 `gpt-5.6-luna`；`--model` 可显式覆盖。当前 `CODEX_HOME/config.toml` 只提供选中的 `model_providers.<id>`、provider 连接配置及其它允许的 model 设置，不再决定默认模型；不会继承用户 plugins、skills、MCP、agents 或其它配置。所有中央 eval 都把 `cli_auth_credentials_store` 和 `mcp_oauth_credentials_store` 固定为 `file`，并关闭 `features.secret_auth_storage`，因此临时 Codex 进程不应访问 macOS 钥匙串。可用 `--model-provider <id>`、`--codex-config <path>` 显式选择 provider 来源，或用 `--no-inherit-codex-config` 回到干净的官方默认 provider。provider 引用的环境变量按名称透传，但隔离保留变量会被拒绝，command runner 也不会继承其它宿主 secret；配置内 bearer 只写入 `0600` 临时 runtime home，非官方 provider 一律不复制官方 auth。凭据变量排除出模型 shell，endpoint、token、header 或环境变量值在写任何 eval 证据前统一脱敏；临时 capsule 在正常结束、失败和进程信号中清理。

strict 模式在启动模型前检查 `/etc/codex`（Windows 对应系统目录）和 macOS `com.openai.codex` 的受管配置键；启动 app-server 后再读取有效 config layers、requirements、Skill 清单和 MCP 清单。检测到系统、MDM、云端或旧式 managed config、非目标 Skill、MCP server、Skill discovery error，或任一关闭项未生效时，suite 以 `incomplete` 结束，不产生发布通过证据。报告的 `environment.isolation` 保存这些检查结果。

真实模型 eval 应从普通 Terminal 会话直接运行。不要通过会临时导出或改写用户 keychain search list 的 GUI、沙箱或提权包装器启动；这类外层包装器可能留下失效的 `accountsKeychainExport` 路径，并在 Codex 启动前触发 macOS“找不到钥匙串”弹窗。中央入口在 macOS 检测到该包装器路径时会直接拒绝真实模型 eval，不会修改用户 keychain search list；`--materialize-only` 和确定性测试不执行该检查，也不需要启动 Codex 模型进程。

真实模型 eval 默认还要求 Full Access 可用，以便发现并清理 Codex 的已观察后代进程。入口先检查原始 `CODEX_PERMISSION_PROFILE`，再执行 macOS keychain 检查或进程树探测。来源为 `workspace` 或 `read-only` 且没有 `--allow-unmanaged-processes` 时，入口立即阻断；不会执行 keychain 检查、进程树探测、报告目录分配或模型启动。单次 `sandbox_permissions=require_escalated` 不等于整个会话的 Full Access，并且会保留原始受限 profile；不得用单次提权重试该门禁。探测成功只记录为 `observed`、`descendantCleanupGuaranteed: false` 和固定 limitation，不能记录为 `managed` 或后代清理保证。

用户明确选择 `--allow-unmanaged-processes` 时，受限来源直接进入 `unmanaged-confirmed`，不执行进程树探测。该模式只跟踪直接子进程，timeout、信号或 runner 退出后可能遗留后代进程，报告会记录 `descendantCleanupGuaranteed: false`。Windows 当前没有 Job Object containment，也必须使用该显式降级选择。agent 不得自行添加参数；如果用户尚未选择，必须停下并让用户选择“切换整个会话到 Full Access”或“明确使用 `--allow-unmanaged-processes`”。CLI 只能把参数视为调用方确认，不能证明参数由人还是模型添加。真正的人工确认必须由 Codex 审批或 UI 层保证。release reviewer 必须明确接受 `observed` 或 `unmanaged-confirmed` 运行的环境限制。

<!-- aw-full-access-consent-policy:v1 -->
| policy invariant | Agent requirement |
|---|---|
| `single_escalation_is_not_full_access` | 单次提权不等于整个会话的 Full Access，agent 不得用单次提权重试该门禁。 |
| `agent_must_not_add_allow_unmanaged_processes` | agent 不得自行添加 `--allow-unmanaged-processes`。 |
| `agent_must_stop_without_user_choice` | 用户未明确选择整个会话使用 Full Access 或明确接受 unmanaged 降级时，agent 必须停止并请求用户选择。 |
<!-- /aw-full-access-consent-policy -->

`pnpm plugin:eval` 是唯一支持的模型 eval 入口。不要直接运行插件 `evals/` 下的 command runner；直接调用既缺少 final-artifact profile/digest，也会因缺少 `AW_PLUGIN_EVAL_PROJECT_ROOT` 失败。

`--allow-environment-skips` 只用于诊断已知环境限制；任何 skip 都必须保持 `incomplete`，不能形成发布通过证据。

完整批次固定在项目内 `.tmp/agent-workflows/evals/plugin/<plugin>/<skill>/<batch-id>/`。其中 `work/<run-id>/` 在命令结束后清理；run、target、raw、scorecard 和自动汇总保留到用户清理 `.tmp`。CLI 不接受任意 `--output-dir`。

`pnpm review:publish` 是唯一的正式报告发布动作，只在用户明确要求发布时执行。执行前应说明目标正式目录和批次封存后不能追加 eval。命令验证人读 Markdown 和 scorecard，把完整 review 留在临时批次，并原子写入 `plugins/<plugin>/reports/<skill>/<batch-id>/{report.md,summary.json}`。正式 `summary.json` 使用 schema v2，只保存 owner、来源 commit、eval 发布结果与覆盖、review 结论、分数、置信度和 finding 数量；不保存 run、target、digest、trace 或 scorecard。正式目录不可覆盖，发布后临时批次封存但不自动删除。该命令不更新 Skill README。

正式摘要合同：

```json
{
  "schemaVersion": 2,
  "batchId": "...",
  "name": "release",
  "owner": { "kind": "plugin-skill", "plugin": "...", "skill": "..." },
  "publishedAt": "...",
  "source": { "commits": ["..."], "inScopeDirty": false },
  "eval": { "releaseOutcome": "passed", "covered": 5, "required": 5 },
  "review": {
    "reviewId": "...",
    "mode": "release",
    "verdict": "pass",
    "weightedScore": 90.4,
    "coveragePercent": 100,
    "confidence": "high",
    "findings": { "p0": 0, "p1": 0, "p2": 0, "advisory": 0 }
  },
  "reportPath": "report.md"
}
```

review-only 使用 `releaseOutcome: "not_run"` 和 `covered/required: 0/0`。quick、delta 或证据不足的 review 可以把分数、覆盖率或置信度写为 `null`。

run 在批次锁内预留。每个 case target 在独立的批次锁事务中原子发布；全部工作结束后，run 终态在后续锁事务中写入。若本机进程在写入终态前结束，后续 refresh、append 或 review 会把该 run 恢复为 `failed`，但保留已发布检查点，避免批次永久停在 `running`。失败 run 只保留 provenance 和诊断；它留下的 missing target 补齐后，不再永久把 release 结论固定为 failed。

正式 `reports/` 不属于被评估源码，中央 source revision 检查会忽略该目录；插件源码、README、eval 夹具、脚本和作者/评审工具的未提交修改仍会令 `source.inScopeDirty=true`。

插件和每个 Skill 都必须有非空 README，并按 `docs/readme-standard.md` 面向最终用户说明用途、调用、结果、权限和边界。正式报告以 `reports/**/summary.json` 为事实源，不登记到 production README。普通 Eval 和报告发布不改变 README。

## Eval Case Audit 作者合同

可执行 runner 合同和 Eval 决策审核是两个层次。`evals/manifest.json`、trigger 字段和 conversation `review` 字段继续控制运行。Audit metadata 只说明用例能否用于修改或发布，不改变 runner 行为。

每个有正负决策的 suite 在 case 文档顶层声明 `policy`：

```json
{
  "policy": {
    "optimization": "balanced",
    "false_negative_cost": "high",
    "false_positive_cost": "high",
    "rationale": "说明两类错误影响，以及为什么选择该优化方向。"
  }
}
```

`optimization` 只使用 `recall-first`、`precision-first`、`balanced` 或 `critical`。错误代价只使用 `low`、`medium`、`high` 或 `critical`。正负例数量相同不表示两类错误代价相同。

会进入 train、validation、sanity、regression、发布判断或当前修改的 case，应补齐：

- `eval_type`：`trigger`、`gate`、`routing`、`behavior`、`outcome` 或 `cost`；每个 assertion 只检查一个主层级。
- `case_role`、`provenance` 和 `scenario_family`；runner split 仍只使用 `train`、`validation` 和 `sanity`，`regression`、`boundary`、`challenge`、`diagnostic` 是 role，不是新 split。
- `unit_under_test` 和会改变 oracle 的 `preconditions`。
- `oracle.rationale`、非空 `rule_refs`、`confidence` 和 `allowed_variance`。
- boundary 或 regression case 的 `oracle.minimal_counterexample`。
- 可从输出、trace、文件或仓库状态判定的机械期望或断言。

审计字段模板以 `.agents/skills/skill-review/assets/eval-case-template.json` 为准。它们并入当前可执行 case，不另建一份平行语料。历史 case 可以渐进迁移；缺少 metadata 时只能作为低置信诊断信号，不能单独驱动 Skill 修改或发布。

`aw plugin init` 和 `aw plugin add-skill` 生成的 trigger starter 带有中等置信 synthetic/boundary metadata，behavior starter 标为低置信 diagnostic。它们用于提示完整结构，不是领域发布证据。发布前必须替换 prompt、near-miss、场景族、oracle 和断言，并按真实错误代价调整 policy 与 role。

先用兼容模式检查历史文档；它把缺失的 admission metadata 报为 warning：

```bash
node .agents/skills/skill-review/scripts/validate_eval_cases.mjs \
  plugins/<plugin>/skills/<skill>/evals/trigger-cases.json --format json
node .agents/skills/skill-review/scripts/validate_eval_cases.mjs \
  plugins/<plugin>/skills/<skill>/evals/evals.json --format json
```

会用于发布或当前修改的 case 补全后，对对应文档增加 `--strict`。`aw plugin validate` 仍负责可执行作者合同；`validate_eval_cases.mjs` 只做确定性结构检查。它不能判断 oracle 语义、现实性或 trace 是否正确，也不能替代 `eval-validity`、`release-evidence` 和 `eval-change-safety` 三个评审门禁。

## 触发评估

只有允许模型自动发现的 Skill 才把自动触发率作为验收门。固定 manual Skill 仍要保持 description 精确，但验收重点是不会误触发且 `$skill-name` 显式入口可用。

准备约 20 条真实 query：

- 8–10 条 `should_trigger: true`，覆盖正式、口语、错别字、短请求和长上下文。
- 8–10 条共享关键词但目标不同的 near-miss 负例，不使用天气、斐波那契等无重叠任务。
- 固定拆成约 60% train、40% validation，并另留 5–10 条 sanity。
- 每条在干净 project session 中运行至少 3 次；只根据 train 调 description，用 validation/sanity 检查泛化。
- 单目标正例默认要求命中率高于 `0.5`，负例默认低于 `0.5`；需要 validation 零误触时把该 split 放进 `strictNegativeSplits`。相邻 Skill 路由应使用 `expected_loaded_skills` 和更高的 `minimumPassRate`，不能只检查 owner Skill 是否未加载。
- 自动触发 train/validation/sanity 不写 `$skill-name`；显式调用另放 smoke。manual Skill 的正向验收使用显式调用 smoke，负例验证未显式调用时不误加载。
- 重要触发边界使用同一 `scenario_family` 的 minimal pair，只改变一个决定性条件。不要用多条同义改写冒充多个场景族。
- 分别报告 positive recall、false-negative rate、negative specificity 和 false-positive rate。不要把所有结果压成一个总准确率。

漏触发时扩大用户意图或场景类别；误触发时收紧相邻任务边界。不要把失败 query 原词逐个堆进 description。

## 输出与多轮行为评估

从 2–3 个真实任务开始。`evals/evals.json` 中的 prompt 要像真实用户输入，覆盖边界条件；`expected_output` 描述成功，不固定无关措辞。fixture 必须小型、脱敏，大型或私有输入留在本地 eval workspace。

每个 case 使用相同 prompt、workspace、权限、model 和输入规则比较：

1. `with_skill`：最终 materialized Skill。
2. `without_skill`：不加载 Skill 的 baseline；改进已有 Skill 时也可以对比冻结的 `old_skill`。

第一轮先看实际输出，再把真正有区分度的机械断言写回 case。可检查文件、字段、数量、具体证据和 workspace diff；不要断言完全相同文案。

需要验证 agent 是否先读取仓库事实时，用 `workspace_files` 把事实只放进隔离 workspace，不要在 prompt 中重复答案：

```json
{
  "prompt": "先检查 docs/policy.md，再只确认仍未决定的产品行为。",
  "workspace_files": {
    "docs/policy.md": "# Policy\n\n- Existing sessions expire after 30 days.\n"
  }
}
```

路径必须是规范化的 POSIX workspace 相对路径，不能进入 `.git`、`.agents` 或 `.codex`，也不能覆盖 materialized subject 已有文件。内容必须非空。`workspace_files` 是 case 输入，不计入模型 workspace diff；current 与 baseline 得到完全相同的文件。

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

`aw plugin init` 和 `aw plugin add-skill` 会为支持 Codex 的新 Skill 生成 trigger train/validation/sanity 和一个可写 behavior starter。starter 只提供合法结构；发布前必须替换为领域真实任务、near-miss、允许改动路径和可区分的断言。当前 v2 模型 eval 固定运行 Codex；Claude-only 插件的 `aw plugin add-skill` 不生成不可运行的 eval manifest，作者只运行确定性校验并明确记录模型行为未验证。

需要 `request_user_input` 时，回复按步骤和问题索引保存，例如：

```json
{
  "expected_question_count": 1,
  "answers_by_index": ["保留兼容窗口"],
  "unexpected_question_answer": "我暂时不知道，请先处理已回答部分。"
}
```

中央 app-server driver 在运行时把这些答案映射到真实 question id，并保存问题、答复、最终消息、token usage、事件 trace 和 workspace diff。baseline 没有复现 current 的提问步骤时，未消费回复保留为对照证据，不把预期增量误报为 owner failure。

## 从 Eval 结果到 Skill 修改

先审 suite，再解释运行结果。`1/3`、`2/3` 或其它混合低样本结果表示证据不足；先增加运行并读取 trace，不能直接向 Skill 增加窄规则。

每个失败先归因为 `skill-defect`、`oracle-defect`、`fixture-defect`、`grader-defect`、`runtime-or-tool-defect`、`model-variance`、`stale-case`、`insufficient-runs`、`expected-tradeoff` 或 `unknown`。只有通过 Case Admission 且归因为 `skill-defect` 的失败可以进入 Skill 修改候选。

Eval-driven 修改必须面向场景族。修改后重跑原 case、同族变体、minimal pair、相反标签 near-miss、固定 validation/sanity 和关键 regression，并记录质量、token、时间和复杂度变化。只让单个 query 转绿，或已知错误 oracle 仍驱动修改时，不接受该修改。

## 结果与定性复核

`EvaluationBundle` outcome：

- `passed`：运行完整且机械检查通过，不需要额外定性判分。
- `failed`：机械行为或已判分检查失败。
- `needs_review`：运行和机械检查完整，但自然语言 checks 尚需 reviewer 逐项给证据结论。
- `incomplete`：认证、Codex/app-server 协议、timeout、rollout、environment skip 或制品缺失导致证据不完整。

本仓库不增加第二个 judge 模型。`needs_review` 由 `.agents/skills/skill-review/` 读取真实 trace，按 case/check 给出 PASS/FAIL 和证据。release 模式会自动运行 required suites；`incomplete`、未完成定性复核或 required profile 缺失都不能通过发布门禁。

## 完成检查

- [ ] owner Skill 的 `evals/manifest.json` 通过作者 validator。
- [ ] suite 已声明 optimization policy 和正负错误代价；关键 case 已通过 Case Admission 结构检查。
- [ ] `skills[]` 覆盖真实 participant；跨插件 profile 只引用当前仓库插件，且不被误写为 production dependency。
- [ ] 自动 Skill 有 train/validation/sanity 的正例与 near-miss。
- [ ] 重要边界有 minimal pair；报告分开显示 positive recall 和 negative specificity。
- [ ] 动态 Skill 覆盖 default/non-default、project/user 最终制品。
- [ ] 真实模型只运行 Codex project profile，user 只 materialize。
- [ ] current 与 baseline 使用相同输入和干净上下文。
- [ ] 写入行为只使用隔离 `workspace-write`，并有最小允许改动路径和最终 artifact 机械断言。
- [ ] 机械断言优先，定性 checks 都能绑定 trace/diff 证据。
- [ ] Eval failure 已完成归因；只有 `skill-defect` 驱动修改，并已重跑同族、相反标签和固定回归集。
- [ ] `plugin:test`、materialization 和模型 eval 没有互相冒充。
- [ ] release required suite 没有 skip、incomplete 或未复核的 `needs_review`。
- [ ] 完整 eval/review 证据位于 `.tmp`，正式报告目录只包含人读 `report.md` 和 schema v2 `summary.json`。
- [ ] 用户要求发布时已执行 `review:publish`；插件和 Skill README 不包含 Eval 或正式报告登记。

## 上游参考

- [Evaluating skill output quality](https://agentskills.io/skill-creation/evaluating-skills)
- [Optimizing skill descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)
