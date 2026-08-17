# review-aw-plugin

只读评审 `agent-workflows` 插件源码、最终制品、Eval 证据和发布条件。

## 什么时候使用

- 你要快速、完整、delta 或 release 评审一个 `plugins/<name>` 插件。
- 评审需要同时检查 manifest、renderer/config、source-final 一致性、profiles 和证据当前性。

不要用于修改生产源码，也不要用它代替通用 Skill 作者工作流。

## 怎样调用

本 Skill 只支持显式调用：`$review-aw-plugin`。

示例请求：

- “使用 `$review-aw-plugin` 快速评审 `plugins/ask-me`，不要运行模型。”
- “使用 `$review-aw-plugin` 检查当前 release 证据；未经我确认不要发布报告。”

## 会发生什么

1. Agent 准备源码、最终制品、profile 和 Eval evidence 的结构化输入。
2. Agent 组合通用只读 Reviewer，并增加 AW 项目专有门禁。
3. Agent 返回 finding、证据状态和发布就绪度；只有得到明确授权才发布正式报告并封存批次。

## 权限和边界

- 生产源码和 README 保持只读。
- 需要预先安装 `agent-content-toolkit >= 0.1.0`；缺少依赖时停止。
- 真实模型证据只覆盖 Codex；Claude Code 只做确定性验证和 materialization。
