# Repo-local Static Skill Evaluation

本入口只评估当前仓库 `.agents/skills/<name>` 的最终 project Skill。AW 插件仍使用 `pnpm plugin:eval <plugin>`，因为插件必须经过 staging、renderer、adapter 和 project/user profile materialization。

## 定义与验证

静态 Skill 必须是 `.agents/skills/<name>` 的直接子目录，并在自身 `evals/manifest.json` 声明 `trigger`、`conversation` suite；profile 固定为隐式 `project-default`。可选的 `workspace.copy[]` 使用 repo-root relative `from` 和 subject-relative `to` 准备只读 fixture，不能逃出仓库/subject，也不能覆盖目标 Skill 或 `.codex`。目标包和复制源都不得包含 symlink。

`evals/behavior_cases.json` 和 `evals/scoring_cases.json` 是 portable 设计与校准语料，不是可执行 release evidence。只有 `evals/manifest.json` 声明且实际完成的 suite/case 才能形成模型行为证据。

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  <skill-name-or-dir> --validate-only
```

真实模型运行前先 `pnpm build`。调试只跑一个 case：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  <skill-name-or-dir> \
  --suite trigger --split validation --runs 1 \
  --output-dir /tmp/static-skill-eval
```

不传 `--suite` 时运行所有 release-required suite/split。输出目录必须不存在，也不能位于目标 Skill 或 workspace source 内，防止覆盖旧证据或递归复制。`--validate-only` 总是校验完整本地 corpus shape；构建后的中央 contract 可用时还会返回 `centralContract: true`。

## Codex 配置与证据

默认从当前 `CODEX_HOME/config.toml` 只提取顶层 model 选择和选中的 `model_providers.<id>`，不会继承 plugins、skills、MCP、agents 或其它用户配置。`--model`、`--model-provider`、`--codex-config` 可显式覆盖；`--no-inherit-codex-config` 使用干净的官方默认 provider。

provider 引用的 `env_key` / `env_http_headers` 会按名称透传，但不能使用 `HOME`、`CODEX_HOME`、`XDG_*`、`TMP*`、`PATH`、`AW_*` 等隔离保留变量；command harness 只继承固定网络/locale 白名单和 provider 明确声明的变量。配置内 bearer 只进入权限为 `0600` 的临时 runtime home，非官方 provider 一律不复制官方 auth。凭据变量不会进入模型 shell；endpoint、bearer、header、env credential 和官方 auth token 在写报告前统一脱敏。临时配置在成功、失败或 `SIGINT` / `SIGTERM` 后清理，持久报告只记录 provider ID、credential source 和不含 secret 的证据 digest。

runner 在复制前记录源 package digest、复制后核对 subject package digest，并在模型运行结束后再次确认源未变化。`inspect_skill_target.mjs --evaluation` 会验证整棵 subject Skill，而不只验证 `SKILL.md`。

将结果交给静态评审：

```bash
node .agents/skills/skill-review/scripts/inspect_skill_target.mjs \
  <skill-name-or-dir> \
  --evaluation /tmp/static-skill-eval/evaluation.json \
  --format json
```

`needs_review` 必须逐项读取 trace；`incomplete`、`failed` 或未完成的定性复核都不能形成 release pass。真实模型证据只覆盖 Codex。
