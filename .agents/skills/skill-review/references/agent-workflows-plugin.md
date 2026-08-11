# Agent Workflows Plugin Review

仅当目标是当前仓库的 `plugins/<name>` 时读取本文件。标准静态 Skill 继续使用主工作流，不套用 AW profile、renderer 或安装语义。

## 评审对象

AW 插件同时检查三层材料：

1. 源码：`.agents-plugin/plugin.json`、受管 Skill、renderer、config schema、roles/instructions 和相关资源。
2. 最终制品：由中央 materializer 生成的 Codex project/user subjects；动态 Skill 不以源模板代替最终制品。
3. 证据：确定性插件测试、EvaluationBundle、suite report 和真实 trace。corpus 或 materialized artifact 本身不是模型通过证据。

先运行作者校验与确定性检查：

```bash
node .agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.mjs plugins/<name>
pnpm plugin:test <name> --platform codex --scope project
pnpm plugin:eval <name> --skill <owner-skill> --materialize-only
node .agents/skills/skill-review/scripts/inspect_skill_target.mjs \
  plugins/<name> \
  --evaluation <owner-skill-root>/reports/evals/<run-id>/raw/evaluation.json \
  --format json
```

对每个源码 Skill 和 required project final `SKILL.md` 分别应用主工作流的静态诊断；renderer/config 改变内容时，还要比较 default 与 non-default profile。user subject 只提供 materialized evidence，不声称经过 Codex native cache 模型运行。

## Release 证据

release 模式再显式运行：

```bash
pnpm plugin:eval <name> --skill <owner-skill>
```

一次命令只运行一个 owner Skill。跨 Skill 或跨插件组合由 owner manifest 的 `skills[]` 和 `profiles[].plugins[]` 声明；companion 插件必须来自当前仓库。strict current 只保留 participant Skills，conversation baseline 只移除 owner。这个组合只属于 eval fixture，不形成 production dependency。

release-required suite 必须 complete；不得用 `--allow-environment-skips` 形成发布证据。真实模型默认要求 Full Access；若用户用 `--allow-unmanaged-processes` 确认降级运行，review 必须明确记录后代进程清理不受保证。`needs_review` 或 `qualitativeReview=required` 必须读取对应 trace 逐项判分。Codex 版本、model、profile、已安装插件、participant Skills、config digest、bundle digest 和 content digest 应随报告保存，防止混用不同制品。

eval 报告固定保存在 `<owner-skill-root>/reports/evals/<run-id>/`。最终 review 的 `report.md` 和 `scorecard.json` 固定保存在 `<owner-skill-root>/reports/reviews/<review-run-id>/`；只把临时草稿放到项目 `.tmp/agent-workflows/reviews/`。

所有模型行为结论仅覆盖 Codex。`plugin:test` 只能证明确定性行为；`plugin:eval` 的真实 suite 才能证明模型行为。插件级 release verdict 取 required profiles/suites 中最差门禁，不用平均分掩盖失败。
