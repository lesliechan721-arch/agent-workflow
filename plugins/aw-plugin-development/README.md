# aw-plugin-development

在兼容工作区中创建、维护和只读评审 AW 插件。目标插件由其 `.agents-plugin/plugin.json` 标识，不要求位于某个固定的 `plugins/<name>/` 目录。

## Manual dependencies

当前要求人工同时安装：

- `agent-content-toolkit >= 0.2.0`
- `agent-skill-toolkit >= 0.2.0`

运行时若找不到必需的通用 Skill，适配器停止并报告缺失，不复制或内置下层标准。

## Skills

| Skill | 什么时候使用 |
| --- | --- |
| `author-aw-plugin` | 创建或维护 AW 插件源码、README、manifest、构建和确定性验证。 |
| `review-aw-plugin` | 只读评审 AW 插件源码、materialized final artifacts 和 Eval evidence。 |

Author 不给自己的结果出独立发布结论；Reviewer 不修改生产源码。正式报告发布需要授权，README 或 manifest 的后续写入交回 Author 或目标工作区的 release 工具。

## Workspace boundary

- 插件根可以位于 `plugins/`、`packages/`、`tools/` 或用户明确提供的其它目录。
- 插件与 Skill README 的作者规范随本插件分发，不依赖宿主仓库的 `docs/`。
- 构建、测试、物化和发布命令从目标工作区发现；没有对应命令时明确标记未验证。

## Maintainer validation

```bash
node scripts/validate-contract-assets.mjs
pnpm plugin:test aw-plugin-development
```

真实模型证据的首版范围只包括 Codex。Claude 只做确定性验证和 materialization。
