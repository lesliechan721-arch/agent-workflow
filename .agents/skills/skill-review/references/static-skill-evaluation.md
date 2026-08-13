# Repo-local Static Skill Evaluation

本入口只评估当前仓库 `.agents/skills/<name>` 的最终 project Skill。AW 插件仍使用 `pnpm plugin:eval <plugin>`，因为插件必须经过 staging、renderer、adapter 和 project/user profile materialization。

## 定义与验证

静态 Skill 必须是 `.agents/skills/<name>` 的直接子目录，并在自身 `evals/manifest.json` 声明 `trigger`、`conversation` suite；profile 固定为隐式 `project-default`。每个 suite 用 `skills[]` 声明参与评估的 repo-local sibling Skills，并必须包含 owner。current 安装全部 participants；conversation baseline 只移除 owner，保留 companions。conversation 模型工作副本位于源码树外；trace 读取宿主 participant 源码时机械失败，避免 baseline 绕过安装边界。可选的 `workspace.copy[]` 使用 repo-root relative `from` 和 subject-relative `to` 准备只读 fixture，不能逃出仓库/subject，也不能覆盖任一 participant Skill 或 `.codex`。目标包和复制源都不得包含 symlink。

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

真实运行必须用 `--batch-name` 新建批次或 `--batch-id` 追加批次。不传 `--suite` 时运行所有 release-required suite/split。完整批次固定在项目 `.tmp/agent-workflows/evals/static/<skill>/<batch-id>/`；其中 `work/<run-id>/` 完成后清理，其余机械证据保留供 review 使用。`review:publish` 生成的正式报告固定在 `.agents/reports/<skill>/<batch-id>/{report.md,summary.json}`。两个入口都不能用 `--output-dir` 改写。Skill 根 `evals/` 不进入被测 runtime package 或 package digest。运行前必须执行 `pnpm build`；批次 harness 身份使用实际加载的 `packages/cli/dist` 驱动和当前 review runner 摘要，不使用可能与构建产物不一致的 TypeScript 源码摘要。`--validate-only` 总是校验完整本地 corpus shape；构建后的中央 contract 可用时还会返回 `centralContract: true`。

## Codex 配置与证据

默认模型为 `gpt-5.6-luna`。当前 `CODEX_HOME/config.toml` 只提供选中的 `model_providers.<id>`、provider 连接配置及其它允许的 model 设置，不再决定默认模型；不会继承 plugins、skills、MCP、agents 或其它用户配置。`--model`、`--model-provider`、`--codex-config` 可显式覆盖；`--no-inherit-codex-config` 使用干净的官方默认 provider。

provider 引用的 `env_key` / `env_http_headers` 会按名称透传，但不能使用 `HOME`、`CODEX_HOME`、`XDG_*`、`TMP*`、`PATH`、`AW_*` 等隔离保留变量；command harness 只继承固定网络/locale 白名单和 provider 明确声明的变量。配置内 bearer 只进入权限为 `0600` 的临时 runtime home，非官方 provider 一律不复制官方 auth。凭据变量不会进入模型 shell；endpoint、bearer、header、env credential 和官方 auth token 在写 eval 证据前统一脱敏。临时配置在成功、失败或 `SIGINT` / `SIGTERM` 后清理。

runner 在复制前记录源 package digest、复制后核对 subject package digest，并在模型运行结束后再次确认源未变化。`inspect_skill_target.mjs --evaluation` 会验证整棵 subject Skill，而不只验证 `SKILL.md`。

真实模型运行默认要求 Full Access，以便管理 Codex 后代进程。检查失败时会在启动模型前阻断。用户明确接受后代进程可能遗留的风险后，可传 `--allow-unmanaged-processes`；报告会把该运行标为 `unmanaged-confirmed` 和 `descendantCleanupGuaranteed: false`。

将结果交给静态评审：

```bash
node .agents/skills/skill-review/scripts/inspect_skill_target.mjs \
  <skill-name-or-dir> \
  --evaluation .tmp/agent-workflows/evals/static/<skill>/<batch-id>/evals/runs/<run-id>/raw/evaluation.json \
  --format json
```

该命令读取单次运行的原始 `EvaluationBundle`。批次根的 `evals/evaluation.json` 只用于跨运行汇总。

`needs_review` 必须逐项读取 trace；`incomplete`、`failed` 或未完成的定性复核都不能形成 release pass。完整 eval 的 full/release 评审默认用 `pnpm review:publish -- --skill <skill> --batch-id <batch-id> --report <report.md> --scorecard <scorecard.json>` 发布正式人读报告和 schema v2 摘要，并封存临时批次；review-only 使用 `--batch-name`。中间草稿放项目 `.tmp/agent-workflows/reviews/`。full 模式不更新 Skill README；release 模式发布后自动登记，已发布 full/release 报告也可用 `pnpm review:release -- --skill <skill> --batch-id <batch-id>` 以后登记。真实模型证据只覆盖 Codex。
