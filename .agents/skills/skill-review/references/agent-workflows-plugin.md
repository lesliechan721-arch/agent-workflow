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
pnpm plugin:eval <name> --materialize-only --output-dir <temp-dir>
node .agents/skills/skill-review/scripts/inspect_skill_target.mjs \
  plugins/<name> --evaluation <temp-dir>/<name>/evaluation.json --format json
```

对每个源码 Skill 和 required project final `SKILL.md` 分别应用主工作流的静态诊断；renderer/config 改变内容时，还要比较 default 与 non-default profile。user subject 只提供 materialized evidence，不声称经过 Codex native cache 模型运行。

## Release 证据

release 模式再显式运行：

```bash
pnpm plugin:eval <name> --output-dir <temp-dir>
```

release-required suite 必须 complete；不得用 `--allow-environment-skips` 形成发布证据。`needs_review` 或 `qualitativeReview=required` 必须读取对应 trace 逐项判分。Codex 版本、model、profile、config digest、bundle digest 和 content digest 应随报告保存，防止混用不同制品。

所有模型行为结论仅覆盖 Codex。`plugin:test` 只能证明确定性行为；`plugin:eval` 的真实 suite 才能证明模型行为。插件级 release verdict 取 required profiles/suites 中最差门禁，不用平均分掩盖失败。
