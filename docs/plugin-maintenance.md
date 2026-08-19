# 插件维护指南

本文件面向人类维护者，负责插件源码边界、维护入口和仓库级验证。它不保存完整 Agent 工作流、字段规范或模型 Eval 运行手册。

## 源码与生成物

- 插件源码位于 `plugins/`，`plugins/<name>/.agents-plugin/plugin.json` 是源码 manifest 真值。
- catalog staging 和 runtime bundle 是构建产物，不要直接修改。
- 作者只维护 plugin source 和稳定 plugin version。不要手改 Git catalog refs、release ledger 或 source cache。
- 创建或修改插件能力时只维护源码层；平台产物由 CLI、adapter 和发布流程生成。
- 插件和 Skill 的 production README 使用[插件与 Skill README 规范](readme-standard.md)。

## 同步规则

改动插件基础架构、manifest/schema、adapter 行为、scope 语义、分发或安装流程，或任何影响插件作者使用方式的能力时，必须同时检查旧的 `create-aw-plugin` 工作流和新的 `aw-plugin-development` 适配器。迁移期间两个入口都必须保持准确。

## 维护入口

- 旧默认路由仍使用 [create-aw-plugin](../.agents/skills/create-aw-plugin/README.md) 和 [skill-review](../.agents/skills/skill-review/README.md)。
- `agent-content-toolkit` 提供 `write-agent-content` 与 `review-agent-content`。
- `agent-skill-toolkit` 提供 Skill author/review 与 Eval design/audit，人工依赖 `agent-content-toolkit >= 0.2.0`。
- `aw-plugin-development` 提供显式调用的 AW Author/Reviewer，人工依赖 `agent-skill-toolkit >= 0.1.0` 和 `agent-content-toolkit >= 0.2.0`。
- 新 AW Reviewer 只处理 `plugins/<name>/`，repo-local 或 portable Skill 使用通用 `review-agent-skill`。
- 迁移期间新工作流不得静默替代旧入口；完成固定行为对照后再切换默认路由。
- 模型 Eval 和报告发布属于专用工作流，不在通用测试指南中重复定义。Reviewer 发布报告不修改 production README；登记由 Author 或 release 工具执行。

## 验证与版本

- 使用 `pnpm plugin:test <plugin>` 运行单插件确定性测试；使用 `pnpm plugin:test --all` 检查全部插件。
- 新工作流的 generated standards、schemas 和 handoff contracts 必须通过 check-only contract test；CI 不自动改写生成文件。
- 三层插件应分别验证，并增加同时安装三个插件的组合测试。
- 通用确定性测试的分层、价值门禁和验证选择见[测试指南](testing.md)。
- 稳定发布时检查源码 manifest version 的流程见 README 的正式版发布说明。
