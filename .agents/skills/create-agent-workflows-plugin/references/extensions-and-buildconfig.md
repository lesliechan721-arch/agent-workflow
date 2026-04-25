# extensions 与 buildConfig 规范

这两个 block 是 `plugins/<name>/.agents-plugin/plugin.json` 中的高级能力声明。`extensions` 描述安装或构建时派生出的跨平台能力；`buildConfig` 控制构建阶段如何生成 bundle。

## extensions 概述

`extensions` 用来声明 CLI 在安装或生成 bundle 时派生出的能力。不要新增顶层 `claude` block，也不要把 `hooks` / `agents` 塞进 `buildConfig.manifestOverrides.claude`。

### extensions.instructions[]

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 唯一标识 |
| `title` | string | 是 | 人类可读标题 |
| `content` | string | 是 | 指令正文 |
| `paths` | string[] | 否 | 生效的路径 glob |

平台生成行为：
- **Codex**：安装时写入受管 `developer_instructions` block
- **Claude**：安装时写入 `rules/<generated>.md`

### extensions.permissions[]

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 唯一标识 |
| `allow` | string[] | 否 | 允许的命令模式 |
| `ask` | string[] | 否 | 需确认的命令模式 |
| `deny` | string[] | 否 | 拒绝的命令模式 |

平台生成行为：
- **Codex**：安装时生成 `.rules` 文件
- **Claude**：安装时合并到 `settings.awGenerated.permissions`

### extensions.hooks[]

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | string | 是 | 只能是 `before_tool`、`after_tool`、`session_start`、`session_stop`、`command` |
| `matcher` | string | 否 | 事件匹配模式 |
| `command` | string | 是 | 执行的命令 |
| `description` | string | 否 | 人类可读说明 |

平台生成行为：
- **Claude**：build 时生成 `./claude/hooks/hooks.json`，写进 Claude runtime manifest
- **Codex**：安装时只聚合 `event: "command"` 的 hook 到 `hooks.json`

### extensions.agents[]

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | agent 标识 |
| `description` | string | 是 | agent 说明 |
| `prompt` | string | 是 | agent 提示词 |
| `tools` | string[] | 否 | 当前只用于 Claude agent markdown |

平台生成行为：
- **Claude**：build 时生成 agent Markdown，写入 `.claude-plugin/plugin.json.agents`
- **Codex**：安装时生成 role TOML；`tools` 当前不写入

### agentOverrides

`agentOverrides` 出现在 schema 中，但各平台生成链路还不完全对称。只有确认目标生成路径会读取它时再使用。要让某个 hook/agent 不进入 Claude runtime bundle，可以在对应条目的 `agentOverrides.claude` 写 `null`。

### 完整 extensions 示例

以 `plugins/git-commit/` 为参考：

```json
{
  "extensions": {
    "instructions": [
      {
        "name": "commit-policy",
        "title": "提交规范",
        "content": "所有提交都必须遵守 Conventional Commits，并在必要时补充 body 说明原因。",
        "paths": ["src/**"]
      }
    ],
    "permissions": [
      {
        "name": "git-ops",
        "allow": ["git status", "git diff"],
        "ask": ["git commit"]
      }
    ],
    "hooks": [
      {
        "event": "command",
        "matcher": "git *",
        "command": "echo git hook",
        "description": "观察 git 命令"
      }
    ],
    "agents": [
      {
        "name": "commit-reviewer",
        "description": "检查提交范围和信息是否匹配。",
        "prompt": "请检查这次提交是否符合提交规范，并指出 scope 是否准确。",
        "tools": ["shell"]
      }
    ]
  }
}
```

---

## buildConfig 概述

`buildConfig` 只描述构建阶段如何生成 bundle，不是给平台私有字段开的通用出口。

### templates

| 字段 | 类型 | 说明 |
|------|------|------|
| `templates.include` | string[] | 需要渲染的文本文件 glob |
| `templates.vars` | object | 每个变量必须同时给出 `{ "claude": string\|boolean, "codex": string\|boolean }` |

只渲染文本文件：`.md`、`.markdown`、`.txt`、`.json`、`.yaml`、`.yml`、`.toml`、`.rules`。

模板语法：`{{var}}`、`{{#if var}}...{{/if}}`、`{{#unless var}}...{{/unless}}`。

### fileRules

| 字段 | 类型 | 说明 |
|------|------|------|
| `fileRules.claude` | `{ include: string[], exclude: string[] }` | 额外复制到 Claude bundle 的 glob |
| `fileRules.codex` | `{ include: string[], exclude: string[] }` | 额外复制到 Codex bundle 的 glob |

### manifestOverrides

| 字段 | 允许的键 |
|------|---------|
| `manifestOverrides.claude` | `commands`、`outputStyles`、`lspServers`、`userConfig`、`channels` |
| `manifestOverrides.codex` | 当前只允许空对象 |

`commands`、`outputStyles` 和字符串形式的 `lspServers` 都必须是插件内 `./` 相对路径；对象形式的 `lspServers`、`userConfig`、`channels` 会原样进入 Claude runtime manifest。

### buildConfig 示例

```json
{
  "buildConfig": {
    "templates": {
      "include": ["skills/**/*.md"],
      "vars": {
        "platformName": { "claude": "Claude Code", "codex": "Codex" }
      }
    },
    "fileRules": {
      "claude": { "include": ["commands/**"], "exclude": [] }
    },
    "manifestOverrides": {
      "claude": {
        "commands": "./commands"
      }
    }
  }
}
```
