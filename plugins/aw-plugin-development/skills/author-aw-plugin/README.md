# Author AW Plugin

在任意兼容工作区中创建或维护 AW 插件，并保持 manifest、源码、README、构建、materialization、版本和验证结果一致。

## 适合使用

- 创建新的 AW 插件根及 `.agents-plugin/plugin.json`。
- 为现有插件增加或修改 Skill、Extension、Slash Command、MCP/App、配置或动态产物。
- 修复构建、bundle、README 或作者门禁问题。

## 工作方式

目标插件根由用户或工作区显式提供，可以位于 `plugins/`、`packages/`、`tools/` 等任意目录。插件与 Skill README 按本 Skill 自带的 `references/aw-readme-authoring.md` 维护，不依赖宿主仓库文档。

一次请求可以包含多个组件。先把组件写入 JSON 数组，再准备 v2 上下文：

```bash
node scripts/prepare-aw-authoring-context.mjs <plugin-root> \
  --repo-root <workspace-root> \
  --components <json-file>
```

数组中每项声明 `id`、`type`、`operation`、`paths` 和 `profiles`。Skill 项还声明 `skillInvocation`。完整字段和组合规则见 `references/aw-authoring-profile.md`。

## 边界

该 Skill 拥有生产源码写入和确定性验证，但不为自己的修改生成独立评审结论。通用 Agent Skill 编写规则由 `agent-skill-toolkit` 提供；独立评审使用 `review-aw-plugin`。

主要指令见 [`SKILL.md`](SKILL.md)。
