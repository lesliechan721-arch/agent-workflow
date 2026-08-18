# Author AW Plugin

在 `agent-workflow` 仓库中创建或维护 AW 插件，并遵守项目的 manifest、构建、materialization、版本和验证约定。

## 适合使用

- 新建 `plugins/<name>/`。
- 为现有插件增加或修改 Skill、Extension、Slash Command、配置或动态产物。
- 修复构建、bundle 或作者门禁问题。

## 边界

该 Skill 拥有生产源码写入和确定性验证，但不为自己的修改生成独立评审结论。通用 Skill 编写规则由 `agent-content-toolkit` 提供；独立评审使用 `review-aw-plugin`。

主要指令见 [`SKILL.md`](SKILL.md)。
