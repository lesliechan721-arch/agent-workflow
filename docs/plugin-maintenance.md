# 插件维护指南

本文件面向人类维护者，负责插件源码边界、维护入口和仓库级验证。它不保存完整 Agent 工作流、字段规范或模型 Eval 运行手册。

## 源码与生成物

- 插件源码位于 `plugins/`，`plugins/<name>/.agents-plugin/plugin.json` 是源码 manifest 真值。
- catalog staging 和 runtime bundle 是构建产物，不要直接修改。
- 创建或修改插件能力时只维护源码层；平台产物由 CLI、adapter 和发布流程生成。

## 同步规则

改动插件基础架构、manifest/schema、adapter 行为、scope 语义、分发或安装流程，或任何影响插件作者使用方式的能力时，必须同时检查 [create-aw-plugin 工作流](../.agents/skills/create-aw-plugin/README.md)。如果该 Skill 的 `SKILL.md`、模板、示例、参考资料或测试夹具不再准确，必须在同一轮改动中更新。

## 维护入口

- 人类维护者通过 [create-aw-plugin README](../.agents/skills/create-aw-plugin/README.md) 了解插件创建和维护工作流；Agent 执行时读取对应 `SKILL.md` 和按任务选择的 reference。
- 人类维护者通过 [skill-review README](../.agents/skills/skill-review/README.md) 了解静态 Skill 和插件 Skill 评审；Agent 执行时读取对应 `SKILL.md`。
- 模型 Eval、报告发布和 README 登记属于上述专用工作流，不在通用测试指南中重复定义。

## 验证与版本

- 使用 `pnpm plugin:test <plugin>` 运行单个插件的确定性脚本测试，失败时返回非零。使用 `pnpm plugin:test --all` 检查全部插件；任一插件失败时整轮返回非零。
- 插件版本、release intent 和作者门禁命令以 [create-aw-plugin 工作流](../.agents/skills/create-aw-plugin/README.md)路由的 `SKILL.md` 和 reference 为准。
- 通用确定性测试的分层、价值门禁和验证选择见[测试指南](testing.md)。
- 稳定发布时应用 release intent 和检查版本的流程见 README 的[正式版发布](../README.md#3-正式版发布)。
