# aw-plugin-development

在兼容工作区中创建、维护和只读评价 AW 插件。目标插件由 `.agents-plugin/plugin.json` 标识，不要求固定目录。

必需：`agent-content-toolkit >= 0.1.0`、`agent-skill-toolkit >= 0.1.0`。真实模型 Eval 可选使用 `agent-skill-eval-runner >= 0.1.0`。

| Skill | 用途 |
| --- | --- |
| `author-aw-plugin` | 创建或维护 AW 插件源码、README、manifest、构建和确定性验证。 |
| `review-aw-plugin` | 只读评价插件 source/materialized Skill 的质量；显式请求时运行机器发布检查。 |

`author-aw-plugin` 使用 `AWAuthoringContext` v3。一个非空 `components[]` 可以同时描述 manifest、多个 Skill、MCP/App、extension、脚本、README 和 Eval assets 变更。确定性插件脚手架和开发状态直接调用已安装的 `aw plugin` 命令。该 Skill 不分发这些命令的本地副本。任意兼容工作区布局通过 `--repo-root <workspace-root> --plugin-root <plugin-root>` 传给 `init`、`add-skill` 和单插件 `status`；`--all` 只扫描标准 `plugins/` 布局。

普通 Review 使用轻量流程：AW 确定性验证、目标发现、按 digest 去重的通用 Skill Review，以及简洁人类报告。它不把 package inspection、profile matrix、Eval stage 和发布状态复制成模型 handoff。

旧 `ReviewInputBundle`、`ReviewResult v4`、`AWReviewTargetPlan` 和 `AWReviewSummary` 工具暂时保留在 source-only compatibility 区，供迁移期 publication 使用；它们不进入新的 Review Skill 运行包，也不是新增功能的接口。
