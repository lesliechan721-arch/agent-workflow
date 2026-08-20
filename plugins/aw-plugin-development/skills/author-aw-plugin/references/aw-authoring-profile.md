# AW authoring profile

## Source truth

- 显式提供的 `<plugin-root>/.agents-plugin/plugin.json`
  和该插件根下源码是人工维护入口；`plugins/<name>/` 只是可能的工作区布局之一。
- 当前 `pnpm build` 生成平台 manifest 和本地 schema 3 snapshot；release staging 使用显式 catalog
  version 和 ledger。Git publish 与首次 official
  bootstrap 属于维护者发布合同，不是插件作者手改入口。
- 插件名和 Skill 名使用小写短横线，并与各自目录一致。
- 插件与 Skill README 按同目录的 `aw-readme-authoring.md`
  维护，不读取宿主仓库的 README 规范作为运行时合同。

## Component selection

- Skills：模型判断和可独立调用工作流。
- Extensions：常驻规则、权限、hooks、agents。
- Public slash commands：显式快捷入口。
- MCP / Apps：连接外部工具或应用。
- Dynamic artifacts：配置驱动的 Codex/Claude 产物。

一个用户请求只创建必要能力，不预生成其它表面。

## Script component overview

插件脚本通常位于：

```text
<plugin-root>/
├── .agents-plugin/
│   └── plugin.json
└── scripts/
    ├── aw-config.mjs
    ├── render-artifacts.mjs
    ├── lifecycle.mjs
    └── *.test.mjs
```

文件名不会触发自动发现。使用的能力必须在 manifest 中显式声明：

- config/helper：`config.schema` 与 `scripts.helpers.config`
- dynamic artifacts：`scripts.artifacts.render` 与 `artifacts.targets`
- lifecycle：`scripts.lifecycle`
- Node package/build：`scripts.node.packageRoot` / `scripts.node.build`
- tests：`scripts.tests.node`

只读取当前组件对应的 branch
reference；同一插件组合多个组件时可以读取多个 reference，但不要为单一 config 或 lifecycle 修改加载全部脚本协议。
