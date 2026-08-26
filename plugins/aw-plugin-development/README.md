# aw-plugin-development

在任意兼容的 Workspace v1 中创建或维护 AW 插件，并分别评审单个插件或有界的跨插件工作流。

这是 Agent-facing Developer Assistant。它依赖已经安装的 `aw` CLI 来执行公开作者命令；它不是 SDK，也不是 AW manifest、Catalog 或发布合同的规范真值。不需要 clone `agent-workflows`，也不要求目标 workspace 有本仓库的 `packages/cli` 或 `node_modules`。

## 安装

需要 Node.js 22+、已安装并可执行的 `aw` CLI，以及目标工作区依赖。先安装两个通用工具插件：

```bash
aw install agent-content-toolkit -p both
aw install agent-skill-toolkit -p both
aw install aw-plugin-development -p both
```

## 包含的 Skill

| Skill | 用途 |
| --- | --- |
| `author-aw-plugin` | 创建或维护一个 AW plugin。 |
| `review-aw-plugin` | 只读评审一个 AW plugin 及 materialized profiles。 |
| `review-aw-workflow` | 只读评审一个有界的跨 AW plugin 工作流。 |

## 典型用法

```text
在 plugins/example 中新增一个支持 Codex 和 Claude Code 的静态 Skill，并完成构建和验证。
只读评审 plugins/example 的 manifest、组件组合和 source/materialized 差异。
评审 plugin-a 到 plugin-b 的交接工作流；入口是 plugin-a，排除真实发布。
```

## 边界

- `author-aw-plugin` 会发现或创建 Workspace v1，并只调用公开 `aw catalog` / `aw plugin` 命令写入目标插件源码、执行 build、validation 和 tests；它不手改生成目录、catalog 或 runtime cache。
- 两个 Reviewer 保持只读，不修改插件或 materialized 产物，也不输出发布资格。
- 单 Skill 质量由 `review-agent-skill` 负责；通用跨 Skill 组合由 `review-agent-workflow` 负责。
- Author 不自动 Review、Audit、运行模型 Eval 或 publish。真实模型 Eval 和 `aw catalog publish` 都需要单独请求及相应授权。
