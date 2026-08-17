# create-aw-plugin

本文件面向人类维护者，说明 `create-aw-plugin` Agent 工作流的用途和阅读入口。仓库级插件边界和发布入口见[插件维护指南](../../../docs/plugin-maintenance.md)。

该 Skill 为本仓库创建或维护同时支持 Codex 和 Claude Code 的插件。它管理源码 manifest、静态 Skill 增量脚手架、manifest-first 稳定版本、动态 artifact、作者校验和 bundle 验证。

## 阅读入口

- Agent 执行完整工作流时读取 [`SKILL.md`](SKILL.md)，并按其中的阅读路由选择 reference。
- 插件字段和能力规范位于 `references/`。
- Production README 使用[插件与 Skill README 规范](../../../docs/readme-standard.md)。
- 插件 Skill 的 Eval 作者合同位于 [`references/skill-evaluation.md`](references/skill-evaluation.md)。
- `evals/` 是 `create-aw-plugin` 自身的静态模型评估语料，不是插件 Skill Eval 的通用说明。

## 最近验证

- 最近正式报告：暂无。
