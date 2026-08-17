# author-aw-plugin

在 `agent-workflows` 仓库中创建或维护 AW 插件，并完成版本、构建和作者验证。

## 什么时候使用

- 你要修改 `plugins/<name>/` 下的 Skill、extension、MCP/App、slash command、dynamic artifact 或配置。
- 现有插件的 production bundle 变化，需要提高版本并验证最终制品。

不要用于仓库外的通用 Skill，也不要用作者自检代替独立质量评审。

## 怎样调用

本 Skill 只支持显式调用：`$author-aw-plugin`。

示例请求：

- “使用 `$author-aw-plugin` 给 `plugins/git` 新增一个手动调用的发布说明 Skill。”
- “使用 `$author-aw-plugin` 更新插件 renderer，并验证 Codex project 制品。”

## 会发生什么

1. Agent 检查 manifest、现有源码、项目规则和允许修改范围。
2. Agent 组合已安装的通用作者能力，修改源码并管理稳定版本。
3. Agent 构建、materialize 并运行适用的确定性作者验证。

## 权限和边界

- 可以修改目标插件源码、运行构建和确定性测试。
- 需要预先安装 `agent-content-toolkit >= 0.1.0`；缺少依赖时停止。
- 不给自己的结果出独立 Review score 或 release verdict。
