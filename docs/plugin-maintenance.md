# 插件维护指南

仅在创建或修改插件，或改动插件基础设施、作者合同和分发行为时读取本文件。

## 同步规则

改动插件基础架构、manifest/schema、adapter 行为、scope 语义、分发或安装流程，或任何影响插件作者使用方式的能力时，必须同时检查 [create-aw-plugin](../.agents/skills/create-aw-plugin/SKILL.md)。如果该 Skill 的模板、示例、参考资料或测试夹具不再准确，必须在同一轮改动中更新。

## 权威入口

- 创建或维护 `plugins/<name>/` 时，遵循 [create-aw-plugin](../.agents/skills/create-aw-plugin/SKILL.md)。
- 只读评审静态 Skill 或插件 Skill 时，遵循 [skill-review](../.agents/skills/skill-review/SKILL.md)。
- 插件源码位于 `plugins/`。catalog staging 是构建产物，不要直接修改。

## 验证与版本

- 使用 `pnpm plugin:test <plugin>` 运行单个插件的确定性脚本测试，失败时返回非零。使用 `pnpm plugin:test --all` 检查全部插件；任一插件失败时整轮返回非零。
- 插件版本、release intent 和作者门禁命令以 [create-aw-plugin 的创建与维护工作流](../.agents/skills/create-aw-plugin/SKILL.md#创建与维护工作流)及[验证入口](../.agents/skills/create-aw-plugin/SKILL.md#验证入口)为准。
- 模型 eval、报告发布和测试分层见[测试指南](testing.md#plugin-eval)。
- 稳定发布时应用 release intent 和检查版本的流程见 README 的[正式版发布](../README.md#3-正式版发布)。
