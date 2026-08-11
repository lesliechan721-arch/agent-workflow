# Create Plugin Skill Evals

本目录评估 repo-local `create-agent-workflows-plugin` Skill 自身，不属于插件 production bundle，也不通过 `pnpm plugin:eval` 冒充 `plugins/<name>`。

静态 Skill 统一由 `skill-review` 的 runner 评估。先做确定性合同检查：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-agent-workflows-plugin --validate-only
```

中间产物固定写入项目 `.tmp/agent-workflows/evals/static/`，完成后清理。持久结果写入当前 Skill 的 `reports/evals/<run-id>/`。

真实 Codex eval 复用 CLI 已有的隔离 trigger driver 和 app-server behavior driver，因此先构建 CLI：

```bash
pnpm build
```

默认会安全继承本机选中的 Codex model/provider；只复制 provider 所需配置和凭据，不继承 plugins、skills 或 MCP。认证或 provider 配置错误会被记录为 `incomplete`，不能形成 Skill 失败或发布通过证据。嵌套沙箱无法初始化时，应在外层沙箱之外运行，由中央 driver 自己建立隔离的只读环境。

只根据 train 结果调整 description：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-agent-workflows-plugin \
  --suite trigger --split train --runs 3
```

验证触发泛化：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-agent-workflows-plugin \
  --suite trigger --split validation --runs 3
```

运行只读行为对照；每个 case 都保存 `with_skill` / `without_skill`、事件 trace、最终消息和 workspace diff：

```bash
node .agents/skills/skill-review/scripts/run_static_skill_evals.mjs \
  create-agent-workflows-plugin \
  --suite behavior --runs 1
```

不传 `--suite` 时运行 validation trigger 和 behavior。输出目录必须不存在，runner 不覆盖旧证据。behavior 的机械门只验证运行完整且工作区未变化；`review.checks` 仍由 `skill-review` 对照 trace 做定性判分。真实模型证据当前只覆盖 Codex，不能据此声称 Claude 行为通过。
