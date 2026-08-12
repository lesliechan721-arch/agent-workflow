# Create Plugin Skill Evals

本目录评估 repo-local `create-aw-plugin` Skill 自身，不属于插件 production bundle，也不通过 `pnpm plugin:eval` 冒充 `plugins/<name>`。

静态 Skill 统一由 `skill-review` 的 runner 评估。先做确定性合同检查：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-aw-plugin --validate-only
```

中间产物固定写入项目 `.tmp/agent-workflows/evals/static/`，完成后清理。持久结果写入 `.agents/reports/create-aw-plugin/<batch-id>/`。

真实 Codex eval 复用 CLI 已有的隔离 trigger driver 和 app-server behavior driver，因此先构建 CLI：

```bash
pnpm build
```

默认使用 `gpt-5.6-luna`，并安全继承本机选中的 Codex provider；只复制 provider 所需配置和凭据，不继承本机 model、plugins、skills 或 MCP。认证或 provider 配置错误会被记录为 `incomplete`，不能形成 Skill 失败或发布通过证据。嵌套沙箱无法初始化时，应在外层沙箱之外运行，由中央 driver 自己建立隔离环境；每个 case 再按其 `sandbox` 合同使用只读或受限 workspace write。

只根据 train 结果调整 description：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-aw-plugin \
  --batch-name trigger-train \
  --suite trigger --split train --runs 3
```

验证触发泛化：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-aw-plugin \
  --batch-name trigger-validation \
  --suite trigger --split validation --runs 3
```

发布前再运行未参与调参的 sanity：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-aw-plugin \
  --batch-name trigger-sanity \
  --suite trigger --split sanity --runs 3
```

运行可写行为对照。每个 case 只在隔离临时副本中获得 `workspace-write`，并用
`allowed_workspace_changes` 和 `artifacts` 机械限制改动；报告保存
`with_skill` / `without_skill`、事件 trace、最终消息、workspace diff、最终文件摘要和 digest：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-aw-plugin \
  --batch-name behavior \
  --suite behavior --runs 1
```

真实运行必须使用 `--batch-name` 新建批次，或用已有输出中的 `--batch-id` 追加批次。不传 `--suite` 时运行 validation、sanity trigger 和 behavior。输出目录必须不存在，runner 不覆盖旧证据。behavior 的机械门验证运行完整、改动路径和声明的最终文件；`review.checks` 仍由 `skill-review` 对照 trace 做定性判分。真实模型证据当前只覆盖 Codex，不能据此声称 Claude 行为通过。
