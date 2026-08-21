# aw-plugin-development

在兼容工作区中创建、维护和只读评审 AW 插件。目标插件由 `.agents-plugin/plugin.json` 标识，不要求固定目录。

必需：`agent-content-toolkit`、`agent-skill-toolkit`。真实模型 Eval 可选使用 `agent-skill-eval-runner` 或其它兼容 provider。

| Skill              | 用途                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `author-aw-plugin` | 创建或维护 AW 插件源码、README、manifest、构建和确定性验证。          |
| `review-aw-plugin` | 只读评审 AW 插件源码、materialized final artifacts 和 Eval evidence。 |

`author-aw-plugin` 使用 `AWAuthoringContext` v3。一个非空 `components[]` 可以同时描述 manifest、多个 Skill、MCP/App、extension、脚本、README 和 Eval assets 变更。确定性插件脚手架和开发状态直接调用已安装的 `aw plugin` 命令。该 Skill 不分发这些命令的本地副本。任意兼容工作区布局通过 `--repo-root <workspace-root> --plugin-root <plugin-root>` 传给 `init`、`add-skill` 和单插件 `status`；`--all` 只扫描标准 `plugins/` 布局。

ReviewInputBundle 模板中的 `/workspace`、artifact path、mode 和 digest 只是 schema-valid 占位值。调用方必须用真实的绝对 workspace root 和已验证的 production artifact 实体替换。

release-quality Review 先生成 `AWReviewTargetPlan`。默认计划从 marketplace 产品推导 Codex/Claude 的 user/project profile；用户可以显式收窄发布范围。Summary validator 会从当前 manifest 和 Skill 根重算完整 source×profile target universe。`AWReviewSummary` v2 必须绑定 plan digest，并且实际 review target 集合必须与 expected target 集合完全相同。每个 coverage row 必须绑定通过 validator 的 ReviewResult 和 ReviewInputBundle。每个 Skill target 还必须包含 `SkillInspectionResult` stage；inspection error 不能由 Reviewer 忽略。

旧 repo-local static Skill 按通用 Agent Skill 处理，不由本插件 Review adapter 接管。项目报告 publish/release、README 登记和旧 static batch/currentness 不迁移到新通用评审链路。
