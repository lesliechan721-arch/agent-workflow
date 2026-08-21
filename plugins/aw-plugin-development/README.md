# aw-plugin-development

在兼容工作区中创建、维护和只读评审 AW 插件。目标插件由 `.agents-plugin/plugin.json`
标识，不要求固定目录。

Required: `agent-content-toolkit >= 0.5.0`, `agent-skill-toolkit >= 0.7.1`. Optional for real model
Eval: `agent-skill-eval-runner >= 0.3.0` or another compatible provider.

| Skill              | 用途                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `author-aw-plugin` | 创建或维护 AW 插件源码、README、manifest、构建和确定性验证。          |
| `review-aw-plugin` | 只读评审 AW 插件源码、materialized final artifacts 和 Eval evidence。 |

`author-aw-plugin` 使用 `AWAuthoringContext` v2。一个非空 `components[]` 可以同时描述 manifest、多个 Skill、MCP/App、extension、脚本、README 和 Eval assets 变更。
确定性插件脚手架和作者门禁直接调用已安装的 `aw plugin` 命令。该 Skill 不分发这些命令的本地副本。
任意兼容工作区布局通过 `--repo-root <workspace-root> --plugin-root <plugin-root>` 传给
`init`、`add-skill` 和单插件 `check-versions`；`--all` 只扫描标准 `plugins/` 布局。

ReviewInputBundle 模板中的 `/workspace`、artifact path、mode 和 digest 只是 schema-valid
占位值。调用方必须用真实的绝对 workspace root 和已验证的 production artifact 实体替换。

旧 repo-local static Skill 按通用 Agent Skill 处理，不由本插件 Review
adapter 接管。项目报告 publish/release、README 登记和旧 static
batch/currentness 不迁移到新通用评审链路。
