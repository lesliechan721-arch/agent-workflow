# AW authoring profile

## Source truth

- `.agents-plugin/plugin.json` 和 `plugins/<name>/` 下源码是人工维护入口。
- 平台 manifest、staging/runtime bundle、catalog 和本地 runtime view 由 CLI 生成。
- 插件名和 Skill 名使用小写短横线，并与目录一致。

## Component selection

- Skills：模型判断和可独立调用工作流。
- Extensions：常驻规则、权限、hooks、agents。
- Public slash commands：显式快捷入口。
- MCP / Apps：连接外部工具或应用。
- Dynamic artifacts：配置驱动的 Codex/Claude 产物。

一个用户请求只创建必要能力，不预生成其它表面。
