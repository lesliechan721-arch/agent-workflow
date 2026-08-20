# aw-plugin-development

在兼容工作区中创建、维护和只读评审 AW 插件。目标插件由 `.agents-plugin/plugin.json`
标识，不要求固定目录。

Required: `agent-content-toolkit >= 0.4.0`, `agent-skill-toolkit >= 0.5.0`. Optional for real model
Eval: `agent-skill-eval-runner >= 0.2.0` or another compatible provider.

| Skill              | 用途                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `author-aw-plugin` | 创建或维护 AW 插件源码、README、manifest、构建和确定性验证。          |
| `review-aw-plugin` | 只读评审 AW 插件源码、materialized final artifacts 和 Eval evidence。 |

`author-aw-plugin` 使用 `AWAuthoringContext` v2。一个非空 `components[]` 可以同时描述 manifest、多个 Skill、MCP/App、extension、脚本、README 和 Eval assets 变更。

旧 repo-local static Skill 按通用 Agent Skill 处理，不由本插件 Review
adapter 接管。项目报告 publish/release、README 登记和旧 static
batch/currentness 不迁移到新通用评审链路。
