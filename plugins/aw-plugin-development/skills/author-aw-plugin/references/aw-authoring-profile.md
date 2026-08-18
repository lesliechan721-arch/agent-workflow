# AW authoring profile

## Source truth

- 显式提供的 `<plugin-root>/.agents-plugin/plugin.json` 和该插件根下源码是人工维护入口；`plugins/<name>/` 只是可能的工作区布局之一。
- 平台 manifest、staging/runtime bundle、catalog 和本地 runtime view 由目标工作区的 CLI 或 renderer 生成。
- 插件名和 Skill 名使用小写短横线，并与各自目录一致。
- 插件与 Skill README 按同目录的 `aw-readme-authoring.md` 维护，不读取宿主仓库的 README 规范作为运行时合同。

## Component selection

- Skills：模型判断和可独立调用工作流。
- Extensions：常驻规则、权限、hooks、agents。
- Public slash commands：显式快捷入口。
- MCP / Apps：连接外部工具或应用。
- Dynamic artifacts：配置驱动的 Codex/Claude 产物。

一个用户请求只创建必要能力，不预生成其它表面。
