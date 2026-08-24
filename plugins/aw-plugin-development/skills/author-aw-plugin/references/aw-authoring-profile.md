# AW 作者 profile

## 源码真值

- 显式提供的 `<plugin-root>/.agents-plugin/plugin.json` 和该插件根下源码是人工维护入口；`plugins/<name>/` 只是可能的工作区布局之一。
- `aw plugin build` 生成一个插件 bundle，`aw catalog build` 生成本地 schema 4 snapshot；published Catalog 由 `aw catalog publish` 生成。publisher 内部 staging、digest、marketplace 和历史恢复不是插件作者手改入口。
- 插件名和 Skill 名使用小写短横线，并与各自目录一致。
- 插件与 Skill README 按同目录的 `aw-readme-authoring.md` 维护，不读取宿主仓库的 README 规范作为运行时合同。

## 组件选择

- Skills：模型判断和可独立调用工作流。
- Extensions：常驻规则、权限、hooks、agents。
- Public slash commands：显式快捷入口。
- MCP / Apps：连接外部工具或应用。
- Dynamic artifacts：配置驱动的 Codex/Claude 产物。

一个用户请求只创建必要能力，不预生成其它表面。

## 复合作者上下文

`AWAuthoringContext` v3 用非空 `components[]` 表示一次请求中的全部变更面。release target 不属于作者上下文字段；release 请求由目标 workspace 的 release workflow 设置 target，避免与 manifest 形成双真值。组件包含：

- `id`：请求内唯一标识；
- `type`：manifest、Skill、extension、slash command、MCP/App、dynamic artifact、config/helper、lifecycle、Node/build、README 或 Eval assets；
- `operation`：`create`、`change` 或 `remove`；
- `paths`：组件拥有的一个或多个源码路径；
- `profiles`：该组件适用的 `CODEX`、`CLAUDE` profile；
- `skillInvocation`：只用于 Skill，值为 `model`、`manual` 或 `claude-model-only`。

`claude-model-only` Skill 的 `profiles` 必须只包含 `CLAUDE`。非 Skill 组件省略 `skillInvocation` 或设为 `null`。旧的单组件 `--component-type` 和 `--skill-invocation` 不再接受；先创建组件数组文件，再通过 `--components` 传入。

## 脚本组件概览

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

只读取当前组件对应的 branch reference；同一插件组合多个组件时可以读取多个 reference，但不要为单一 config 或 lifecycle 修改加载全部脚本协议。
