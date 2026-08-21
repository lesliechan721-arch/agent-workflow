# aw-plugin-development

在兼容工作区中创建、维护和只读评价 AW 插件。目标插件由 `.agents-plugin/plugin.json` 标识，不要求固定目录。

当前插件合同版本：`0.10.0`。

必需：`agent-content-toolkit >= 0.5.0`、`agent-skill-toolkit >= 0.9.0`。真实模型 Eval 可选使用 `agent-skill-eval-runner >= 0.3.0`。

| Skill | 用途 |
| --- | --- |
| `author-aw-plugin` | 创建或维护 AW 插件源码、README、manifest、构建和确定性验证。 |
| `review-aw-plugin` | 只读评价插件 source/materialized Skill 的质量；显式请求时运行机器发布检查。 |

普通 Review 使用轻量流程：AW 确定性验证、目标发现、按 digest 去重的通用 Skill Review，以及简洁人类报告。它不把 package inspection、profile matrix、Eval stage 和发布状态复制成模型 handoff。

旧 `ReviewInputBundle`、`ReviewResult v4`、`AWReviewTargetPlan` 和 `AWReviewSummary` 工具暂时保留在 source-only compatibility 区，供迁移期 publication 使用；它们不进入新的 Review Skill 运行包，也不是新增功能的接口。
