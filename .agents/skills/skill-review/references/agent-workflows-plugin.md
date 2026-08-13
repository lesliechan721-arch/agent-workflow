# Agent Workflows Plugin Review

仅当目标是当前仓库的 `plugins/<name>` 时读取本文件。标准静态 Skill 继续使用主工作流，不套用 AW profile、renderer 或安装语义。

## 评审对象

AW 插件同时检查三层材料：

1. 源码：`.agents-plugin/plugin.json`、受管 Skill、renderer、config schema、roles/instructions 和相关资源。
2. 最终制品：由中央 materializer 生成的 Codex project/user subjects；动态 Skill 不以源模板代替最终制品。
3. 证据：确定性插件测试、EvaluationBundle、suite report 和真实 trace。corpus 或 materialized artifact 本身不是模型通过证据。

先运行作者校验与确定性检查：

```bash
node .agents/skills/create-aw-plugin/scripts/validate_plugin.mjs plugins/<name>
node .agents/skills/create-aw-plugin/scripts/check_plugin_versions.mjs <name> --base <git-ref>
pnpm plugin:test <name> --platform codex --scope project
pnpm plugin:eval <name> --skill <owner-skill> \
  --batch-name materialization --materialize-only
node .agents/skills/skill-review/scripts/inspect_skill_target.mjs \
  plugins/<name> \
  --evaluation .tmp/agent-workflows/evals/plugin/<name>/<owner-skill>/<batch-id>/evals/runs/<run-id>/raw/evaluation.json \
  --format json
```

`inspect_skill_target.mjs` 读取单次运行的原始 `EvaluationBundle`。批次根的 `evals/evaluation.json` 是跨运行聚合，不是该命令的输入。

对每个源码 Skill 和 required project final `SKILL.md` 分别应用主工作流的静态诊断；renderer/config 改变内容时，还要比较 default 与 non-default profile。user subject 只提供 materialized evidence，不声称经过 Codex native cache 模型运行。

## Release 证据

release 模式再显式运行：

```bash
pnpm plugin:eval <name> --skill <owner-skill> --batch-name release
```

一次命令只运行一个 owner Skill，并用 `--batch-name` 新建或 `--batch-id` 追加批次。跨 Skill 或跨插件组合由 owner manifest 的 `skills[]` 和 `profiles[].plugins[]` 声明；companion 插件必须来自当前仓库。strict current 只保留 participant Skills，conversation baseline 只移除 owner。这个组合只属于 eval fixture，不形成 production dependency。

release-required suite 必须 complete；不得用 `--allow-environment-skips` 形成发布证据。真实模型默认要求 Full Access；若用户用 `--allow-unmanaged-processes` 确认降级运行，review 必须明确记录后代进程清理不受保证。`needs_review` 或 `qualitativeReview=required` 必须读取对应 trace 逐项判分。Codex 版本、model、profile、已安装插件、participant Skills、config digest、bundle digest 和 content digest 应随报告保存，防止混用不同制品。

完整 eval/review 批次固定保存在 `.tmp/agent-workflows/evals/plugin/<name>/<owner-skill>/<batch-id>/`。full/release 评审消费完整 eval 批次并验证 scorecard 后，默认用 `pnpm review:publish -- --plugin <name> --skill <owner-skill> --batch-id <batch-id> --report <report.md> --scorecard <scorecard.json>` 发布正式 `report.md` 和 schema v2 `summary.json`，并封存临时批次。eval 通过、失败或 `incomplete` 只影响正式结论，不取消发布；只有用户明确要求草稿时才让报告停在 `.tmp`。没有完整 eval 但用户要求持久化时，用 `--batch-name` 创建 review-only 批次。正式目录位于 `plugins/<name>/reports/<owner-skill>/<batch-id>/`，其它证据和草稿只保留在 `.tmp/agent-workflows/`。

full 模式发布不更新 Skill README。release 模式在正式报告写入并封存批次后自动登记 README；若登记失败，正式报告保持有效，并可用 `pnpm review:release -- --plugin <name> --skill <owner-skill> --batch-id <batch-id>` 重试。已经发布的 full 报告也可以用同一命令以后登记。README 登记属于 production source 变化，必须由现有或新增 release intent 覆盖；插件 README 不记录 Skill 验证信息。

所有模型行为结论仅覆盖 Codex。`plugin:test` 只能证明确定性行为；`plugin:eval` 的真实 suite 才能证明模型行为。插件级 release verdict 取 required profiles/suites 中最差门禁，不用平均分掩盖失败。
