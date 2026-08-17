# Repo-local Static Skill Evaluation

本入口只评估当前仓库 `.agents/skills/<name>` 的最终 project Skill。AW 插件仍使用 `pnpm plugin:eval <plugin>`，因为插件必须经过 staging、renderer、adapter 和 project/user profile materialization。

## 定义与验证

静态 Skill 必须是 `.agents/skills/<name>` 的直接子目录，并在自身 `evals/manifest.json` 声明 `trigger`、`conversation` suite；profile 固定为隐式 `project-default`。每个 suite 用 `skills[]` 声明参与评估的 repo-local sibling Skills，并必须包含 owner。current 安装全部 participants；conversation baseline 只移除 owner，保留 companions。`scripted_replies` 是 current 行为断言；baseline 的交互步骤差异只保存为比较证据，不能使 required suite 机械失败。baseline 的完成、隔离、宿主源码访问和 workspace 安全仍是机械门禁。conversation 模型工作副本位于源码树外；trace 读取宿主 participant 源码时机械失败，避免 baseline 绕过安装边界。可选的 `workspace.copy[]` 使用 repo-root relative `from` 和 subject-relative `to` 准备只读 fixture，不能逃出仓库/subject，也不能覆盖任一 participant Skill 或 `.codex`。目标包和复制源都不得包含 symlink。静态 Skill eval 不执行目标提供的 fixture module；manifest 的 `fixtureModule` 和 trigger case 的 `workspace_fixture` 不受支持。需要的 fixture 必须通过 `workspace.copy[]` 声明。

`evals/behavior_cases.json` 和 `evals/scoring_cases.json` 是 portable 设计与校准语料，不是可执行 release evidence。只有 `evals/manifest.json` 声明且实际完成的 suite/case 才能形成模型行为证据。

conversation case 默认使用 `read-only`。需要验证创建或修改行为时，case 必须显式写 `sandbox: "workspace-write"`，同时声明 `review.workspace_unchanged: false`、最小 `allowed_workspace_changes` 和非空 `artifacts`。写入只发生在每次运行的隔离临时副本；runner 对当前版本机械检查 diff、文件存在、文本或 JSON 子集，并为 current/baseline 保存 artifact digest。不得允许 `.git`、`.agents` 或 `.codex` 控制目录。

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  <skill-name-or-dir> --validate-only
```

真实模型运行前先 `pnpm build`。调试只跑一个 case：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  <skill-name-or-dir> \
  --batch-name trigger-validation \
  --suite trigger --split validation --runs 1
```

真实运行必须用 `--batch-name` 新建批次或 `--batch-id` 追加批次。不传 `--suite` 时运行所有 release-required suite/split。完整批次固定在项目 `.tmp/agent-workflows/evals/static/<skill>/<batch-id>/`；其中 `work/<run-id>/` 完成后清理，其余机械证据保留供 review 使用。用户明确要求发布时，`review:publish` 生成的正式报告固定在 `.agents/reports/<skill>/<batch-id>/{report.md,summary.json}`。两个入口都不能用 `--output-dir` 改写。Skill 根 `evals/` 不进入被测 runtime package 或 package digest。运行前必须执行 `pnpm build`；批次 harness 身份使用实际加载的 `packages/cli/dist` 驱动和当前 review runner 摘要，不使用可能与构建产物不一致的 TypeScript 源码摘要。`--validate-only` 总是校验完整本地 corpus shape；构建后的中央 contract 可用时还会返回 `centralContract: true`。

runner 在每个 case 的全部 repetitions 结束后发布检查点。case 为 `incomplete` 时停止当前命令。再次使用同一 `--batch-id` 时，runner 复用 terminal case，并重跑 incomplete 或 missing case；当前未完成 case 的全部 repetitions 会重新运行。没有 case 合同的 suite 以整个 suite 为恢复单位。真实模型 eval 可能运行几十分钟到数小时。保留同一个进程 session，首轮和后续等待都直接使用工具允许的最长响应式等待时间。等待超时不表示 eval 失败。不得另开短周期 wait、`sleep`、`ps`、报告文件或其它状态轮询命令。

## 正式报告发现与当前性

静态 Skill 的正式报告以 `.agents/reports/<skill>/*/summary.json` 为事实源。判断当前 `release-evidence` 时，先枚举正式 summary，再比较其 source commit 和 `inScopeDirty` 与当前目标。报告来源或当前目标任一 `inScopeDirty=true` 时，相同 commit 仍不足以证明内容相同，必须有匹配的封存 package digest；digest 缺失或不匹配时，当前证据为 `unknown`。来源不匹配的报告只记为 historical evidence：保留旧 pass/fail 和 finding，但不能替代当前版本的 release evidence。

## Codex 配置与证据

默认模型为 `gpt-5.6-luna`。当前 `CODEX_HOME/config.toml` 只提供选中的 `model_providers.<id>`、provider 连接配置及其它允许的 model 设置，不再决定默认模型；不会继承 plugins、skills、MCP、agents 或其它用户配置。`--model`、`--model-provider`、`--codex-config` 可显式覆盖；`--no-inherit-codex-config` 使用干净的官方默认 provider。

provider 引用的 `env_key` / `env_http_headers` 会按名称透传，但不能使用 `HOME`、`CODEX_HOME`、`XDG_*`、`TMP*`、`PATH`、`AW_*` 等隔离保留变量；command harness 只继承固定网络/locale 白名单和 provider 明确声明的变量。配置内 bearer 只进入权限为 `0600` 的临时 runtime home，非官方 provider 一律不复制官方 auth。凭据变量不会进入模型 shell；endpoint、bearer、header、env credential 和官方 auth token 在写 eval 证据前统一脱敏。临时配置在成功、失败或 `SIGINT` / `SIGTERM` 后清理。

runner 在复制前记录源 package digest、复制后核对 subject package digest，并在模型运行结束后再次确认源未变化。`inspect_skill_target.mjs --evaluation` 会验证整棵 subject Skill，而不只验证 `SKILL.md`。

真实模型运行默认要求整个会话使用 Full Access，以便管理 Codex 后代进程。runner 先检查原始 `CODEX_PERMISSION_PROFILE`。`workspace` 或 `read-only` 来源没有显式参数时，会在 keychain 检查、进程树探测、报告分配和模型启动前阻断。单次 `sandbox_permissions=require_escalated` 不等于 Full Access；不得请求单次提权重试。用户明确选择 `--allow-unmanaged-processes` 后，受限来源直接进入 `unmanaged-confirmed` 并跳过进程树探测；报告记录 `descendantCleanupGuaranteed: false`。agent 不得自行添加该参数。用户未选择时必须停下，让用户选择切换整个会话到 Full Access，或明确使用该参数。CLI 不能证明参数由人添加；人工确认必须由 Codex 审批或 UI 层保证。

将结果交给静态评审：

```bash
node .agents/skills/skill-review/scripts/inspect_skill_target.mjs \
  <skill-name-or-dir> \
  --evaluation .tmp/agent-workflows/evals/static/<skill>/<batch-id>/evals/runs/<run-id>/raw/evaluation.json \
  --format json
```

该命令读取单次运行的原始 `EvaluationBundle`。批次根的 `evals/evaluation.json` 只用于跨运行汇总。

`needs_review` 必须逐项读取 trace；`incomplete`、`failed` 或未完成的定性复核都不能形成 release pass。评审默认只返回结果。用户明确要求发布时，用 `pnpm review:publish -- --skill <skill> --batch-id <batch-id> --report <report.md> --scorecard <scorecard.json>` 发布正式人读报告和 schema v2 摘要，并封存临时批次；review-only 使用 `--batch-name`。`review:publish` 不修改 Skill README。中间草稿放项目 `.tmp/agent-workflows/reviews/`。真实模型证据只覆盖 Codex。
