# Agent Workflows Plugin Review

仅当目标是当前仓库的 `plugins/<name>` 时读取本文件。标准静态 Skill 继续使用主工作流，不套用 AW profile、renderer 或安装语义。

## 评审对象

AW 插件同时检查三层材料：

1. 源码：`.agents-plugin/plugin.json`、受管 Skill、renderer、config schema、roles/instructions 和相关资源。
2. 最终制品：由中央 materializer 生成的 Codex project/user subjects；动态 Skill 不以源模板代替最终制品。
3. 证据：确定性插件测试、EvaluationBundle、suite report 和真实 trace。corpus 或 materialized artifact 本身不是模型通过证据。

## 静态检查与执行型验证

普通 quick/full 评审先做源码和已有制品的静态检查，不执行目标插件的 test、renderer 或 materialization：

```bash
node .agents/skills/skill-review/scripts/inspect_skill_target.mjs \
  plugins/<name> --format json
```

下列命令不是普通 quick/full 评审的无条件前置步骤。只有 release 模式，或用户明确要求运行验证，并且 reviewer 已完成副作用检查、确认风险可控和隔离充分时，才运行：

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

没有执行授权或没有可用的既有结果时，把确定性运行和 materialized evidence 标为 `unknown`；不要把未运行写成目标缺陷。

`inspect_skill_target.mjs` 读取单次运行的原始 `EvaluationBundle`。批次根的 `evals/evaluation.json` 是跨运行聚合，不是该命令的输入。

对每个源码 Skill 和 required project final `SKILL.md` 分别应用主工作流的静态诊断；renderer/config 改变内容时，还要比较 default 与 non-default profile。user subject 只提供 materialized evidence，不声称经过 Codex native cache 模型运行。

## Release 证据

release 模式再显式运行：

```bash
pnpm plugin:eval <name> --skill <owner-skill> --batch-name release
```

一次命令只运行一个 owner Skill，并用 `--batch-name` 新建或 `--batch-id` 追加批次。跨 Skill 或跨插件组合由 owner manifest 的 `skills[]` 和 `profiles[].plugins[]` 声明；companion 插件必须来自当前仓库。strict current 只保留 participant Skills，conversation baseline 只移除 owner。`scripted_replies` 是 current 行为断言；baseline 的交互步骤差异属于比较证据，不是 owner mechanical failure。baseline 的完成、隔离、宿主源码访问和 workspace 安全仍是机械门禁。conversation 模型工作副本位于源码树外；trace 读取宿主 participant 插件源码时机械失败。这个组合只属于 eval fixture，不形成 production dependency。

release-required suite 必须 complete；不得用 `--allow-environment-skips` 形成发布证据。真实模型默认要求整个会话使用 Full Access。单次 `sandbox_permissions=require_escalated` 不等于 Full Access，不得用它重试门禁。只有用户明确选择后才能传 `--allow-unmanaged-processes`；agent 不得自行添加。用户未选择时必须停下询问。若用户确认降级运行，review 必须明确记录后代进程清理不受保证。`needs_review` 或 `qualitativeReview=required` 必须读取对应 trace 逐项判分。Codex 版本、model、profile、已安装插件、participant Skills、config digest、bundle digest 和 content digest 应随报告保存，防止混用不同制品。

完整 eval 可以运行几十分钟到数小时。保留原命令的进程 session，首轮和后续等待都直接使用工具允许的最长响应式等待时间。等待超时不是 eval 失败。不得用短周期 wait、`sleep`、`ps`、报告文件或其它命令轮询状态。同一批次的 case 检查点可以恢复；terminal case 被复用，incomplete 或 missing case 从该 case 的全部 repetitions 重新运行。

完整 eval/review 批次固定保存在 `.tmp/agent-workflows/evals/plugin/<name>/<owner-skill>/<batch-id>/`。评审默认只返回结果。用户明确要求发布时，用 `pnpm review:publish -- --plugin <name> --skill <owner-skill> --batch-id <batch-id> --report <report.md> --scorecard <scorecard.json>` 发布正式 `report.md` 和 schema v2 `summary.json`，并封存临时批次。eval 通过、失败或 `incomplete` 只影响正式结论，不改变发布授权。没有完整 eval 但用户要求发布时，用 `--batch-name` 创建 review-only 批次。正式目录位于 `plugins/<name>/reports/<owner-skill>/<batch-id>/`，其它证据和草稿只保留在 `.tmp/agent-workflows/`。

`review:publish` 不更新 Skill README。用户另行明确要求登记时，用 `pnpm review:release -- --plugin <name> --skill <owner-skill> --batch-id <batch-id>` 更新 README。登记失败不影响已经发布的正式报告，可以重试同一命令。README 登记属于 production source 变化；登记后直接提高插件源码 manifest 的稳定版本。插件 README 不记录 Skill 验证信息。

所有模型行为结论仅覆盖 Codex。`plugin:test` 只能证明确定性行为；`plugin:eval` 的真实 suite 才能证明模型行为。插件级 release verdict 取 required profiles/suites 中最差门禁，不用平均分掩盖失败。
