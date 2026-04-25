# plugin.json 字段规范

`plugins/<name>/.agents-plugin/plugin.json` 是唯一需要手动维护的 manifest。运行时平台 manifest（`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`）和 marketplace manifest 由 `pnpm build` 生成，不要手改。

## 顶层字段

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `name` | string | 是 | 小写短横线，建议与目录名一致 |
| `version` | string | 是 | semver，例如 `0.1.0` |
| `description` | string | 是 | 非空 |
| `skills` | string | 否 | 单个路径，`./` 开头 |
| `mcpServers` | string | 否 | 单个路径，`./` 开头 |
| `apps` | string | 否 | 单个路径，`./` 开头 |
| `marketplace` | object | 是 | 见下方 marketplace block |
| `interface` | object | 否 | 见下方 interface block |
| `extensions` | object | 否 | 详见 `references/extensions-and-buildconfig.md` |
| `buildConfig` | object | 否 | 详见 `references/extensions-and-buildconfig.md` |

不允许出现上表以外的顶层字段。

## 路径约定

- `skills`、`mcpServers`、`apps` 只能写成单个字符串路径，不能写数组或对象。
- 路径必须以 `./` 开头，不能是绝对路径，不能逃出插件根目录。
- 插件目录里出现标准入口文件时必须声明对应字段：有 `skills/` → 声明 `skills`，有 `.mcp.json` → 声明 `mcpServers`，有 `.app.json` → 声明 `apps`。

## marketplace block

插件条目元数据，写在 `.agents-plugin/plugin.json` 的 `marketplace` 字段：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `category` | string | 是 | 非空，例如 `workflow` |
| `tags` | string[] | 否 | 会 trim、去空、去重 |
| `strict` | boolean | 是 | |
| `policy.installation` | string | 是 | 非空 |
| `policy.authentication` | string | 是 | 非空 |
| `policy.products` | string[] | 否 | 会 trim、去空、去重 |

## interface block

只放展示信息，不是运行时能力开关：

| 子字段 | 类型 | 说明 |
|--------|------|------|
| `displayName` | string | 人类可读插件名 |
| `shortDescription` | string | 简短描述 |
| `capabilities` | string[] | 能力标签，例如 `["Skills"]` |

## marketplace-source.json

`plugins/marketplace-source.json` 是 marketplace 根级构建输入，只接受 `owner` 和 `interface.displayName`。它不是运行时 marketplace manifest。创建单个插件时通常不要改它。

`pnpm build` 会把根级元数据和各插件的 marketplace 条目合成两份 runtime marketplace manifest：`.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json`。

## 三层分发模型

1. **源码层**：`plugins/<name>/.agents-plugin/plugin.json` + 关联文件 → 作者维护
2. **Embedded Runtime Bundle**：`packages/cli/plugins-dist/` → `pnpm build` 生成，npm 包内唯一运行时真值
3. **本地 Marketplace 镜像**：`~/.aw/` → `aw init` 或安装流程复制和校验

三层各有职责，排查问题时先确认问题在哪一层。

## 禁止手改的文件

- 仓库根目录 `.claude-plugin/marketplace.json`
- 仓库根目录 `.agents/plugins/marketplace.json`
- `plugins/<name>/.claude-plugin/plugin.json`
- `plugins/<name>/.codex-plugin/plugin.json`
- `packages/cli/plugins-dist/**`
- `~/.aw/**`

## 完整示例

以 `plugins/git-commit/` 为参考：

```json
{
  "name": "git-commit",
  "version": "0.1.0",
  "description": "在用户要求提交当前改动时自动触发 skill，引导 agent 按 Conventional Commits 规范完成 git 提交。",
  "skills": "./skills",
  "marketplace": {
    "category": "workflow",
    "tags": ["git", "commit"],
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "ON_INSTALL",
      "products": ["CODEX"]
    }
  },
  "interface": {
    "displayName": "Git Commit",
    "shortDescription": "自动触发的 Conventional Commits 提交流程",
    "capabilities": ["Skills"]
  },
  "extensions": {
    "instructions": [ ... ],
    "permissions": [ ... ],
    "hooks": [ ... ],
    "agents": [ ... ]
  }
}
```

extensions 和 buildConfig 的字段详见 `references/extensions-and-buildconfig.md`。
