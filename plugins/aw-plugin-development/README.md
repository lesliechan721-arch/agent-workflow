# aw-plugin-development

在既有合法 AW Catalog Workspace 中创建或维护单个 AW 插件，并分别评审单个插件或有界的跨插件工作流。

这是 Agent-facing Developer Assistant。它依赖当前 PATH 中已安装的 `aw` CLI 来执行公开作者命令；它不是 SDK，也不是 AW manifest、Catalog 或发布合同的规范真值。

## 安装

需要 Node.js 22+、已安装并可执行的 `aw` CLI，以及目标工作区依赖。安装会解析两个通用工具插件依赖：

```bash
aw install aw-plugin-development -p both
```

## 包含的 Skill

| Skill | 用途 |
| --- | --- |
| `author-aw-plugin` | 在既有 Catalog Workspace 中创建或维护一个 AW Plugin Source；只处理 Catalog Author 交接的安全删除。 |
| `review-aw-plugin` | 只读评审一个 AW plugin 及 materialized profiles。 |
| `review-aw-workflow` | 只读评审一个有界的跨 AW plugin 工作流。 |

## 典型用法

```text
在 plugins/example 中新增一个支持 Codex 和 Claude Code 的静态 Skill，并完成构建和验证。
在 Catalog Author 已确认 Workspace、插件名和依赖后，安全删除 plugins/old-plugin，并返回删除 receipt。
只读评审 plugins/example 的 manifest、组件组合和 source/materialized 差异。
评审 plugin-a 到 plugin-b 的交接工作流；入口是 plugin-a，排除真实发布。
```

## 边界

- 所有会调用 `aw` 的 Skill 都先从自己的实际 Skill 根运行 `aw self check --from <skill-root> --json`。检查不通过时停止并报告 receipt 中的缺失能力。
- `author-aw-plugin` 依次从用户明确的 Workspace root、canonical plugin target 或上游 handoff 确定 Workspace，并只调用公开 `aw plugin` 命令写入或验证一个 Plugin Source。只有明确的 current Workspace 请求可让 plugin 命令从 target 或 cwd 自动发现 root。普通用户删除请求必须使用 `author-aw-catalog`；只有 Catalog Author 明确交接插件名后才执行删除。成功后只返回 receipt，不验证已删除插件，也不改 Catalog metadata、commit、build 或 publish。缺少 Workspace 或删除 handoff 时它停止，并要求使用 `author-aw-catalog`。
- 两个 Reviewer 从明确 root、canonical plugin target 或上游 handoff 确定同一 Workspace，保持只读，不运行 Catalog 命令，不修改插件或 materialized 产物，也不输出发布资格。
- 单 Skill 质量由 `review-agent-skill` 负责；通用跨 Skill 组合由 `review-agent-workflow` 负责。
- Author 不拥有 Catalog metadata、inventory、聚合 build/validate 或 publication。`review-aw-workflow` 仍只评审跨插件业务 workflow；workflow 不等于 Catalog composition。
