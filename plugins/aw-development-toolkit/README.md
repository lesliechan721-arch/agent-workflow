# AW Development Toolkit

开发和评审 AW Catalog 与插件，并通过显式用户宏发布 Catalog。依赖 `agent-content-toolkit` 和 `agent-skill-toolkit`。

```bash
aw install aw-development-toolkit -p codex
```

也支持 Claude，可将平台改为 `claude`。需要当前 PATH 中兼容的公开 AW CLI；不要求第三方项目具有本仓库的私有脚本目录。

| Skill | 适用任务 |
| --- | --- |
| `develop-aw` | 初始化和维护 Workspace、Plugin、组件、版本与本地产物 |
| `review-aw` | 只读评审 Plugin、Catalog、工作流或能力组合 |
| `publish-aw-catalog` | 显式宏生成发布计划，经具体摘要授权后发布 |

例如：“在当前 Workspace 增加插件并完成本地验证。”或“只读评审现有 Catalog，说明证据缺口。”发布时显式调用 `$publish-aw-catalog`；目标参数可使用 CLI 默认值，确认时展示解析后的完整计划。

开发可能写源码、执行目标脚本；本地激活只按请求执行。普通评审不 build、test 或发布，默认返回人读报告。独立 Release Check 仅在明确请求时检查逐对象证据和必需 Eval，结果不授权远端写入。发布计划会读取远端 refs 和构建产物，apply 才执行已授权的远端变更。
