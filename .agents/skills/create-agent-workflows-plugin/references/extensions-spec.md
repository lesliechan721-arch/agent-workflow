# Extensions 规范

`extensions` 是 `.agents-plugin/plugin.json` 中的高级能力声明，用于在安装或构建时派生出跨平台能力。包含四种类型：`instructions`（指令）、`permissions`（权限）、`hooks`（事件钩子）和 `agents`（子 Agent）。

不要新增顶层 `claude` block，也不要把 hooks / agents 塞进 `buildConfig.manifestOverrides.claude`。

## 整体结构

```json
{
  "extensions": {
    "instructions": [],
    "permissions": [],
    "hooks": [],
    "agents": []
  }
}
```

每个数组可以为空。数组中的每个条目都可以附加 `agentOverrides` 做平台特定覆盖（见末尾）。

---

## instructions[]

向 agent 注入的指令规则，控制 agent 在特定场景下的行为。

### 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 唯一标识，同插件内不能重复 |
| `title` | string | 是 | 人类可读标题 |
| `content` | string | 是 | 指令正文（Markdown 格式） |
| `paths` | string[] | 否 | 生效的路径 glob，例如 `["src/**"]` |
| `agentOverrides` | object | 否 | 平台特定覆盖 |

### 平台生成行为

| 平台 | 输出路径 | 格式 |
|------|---------|------|
| Claude | `rules/aw-<plugin>-<name>.md` | Markdown 文件，含 paths frontmatter |
| Codex | `AGENTS.md` 中的段落 | 插件名级标题 + 指令子章节 |

### 使用场景

- 编码规范（"所有代码必须使用 TypeScript strict mode"）
- 提交规范（"提交必须遵守 Conventional Commits"）
- 安全策略（"不要在代码中硬编码密钥"）

### 示例

```json
{
  "name": "commit-policy",
  "title": "提交规范",
  "content": "所有提交都必须遵守 Conventional Commits，并在必要时补充 body 说明原因。",
  "paths": ["src/**"]
}
```

带路径限制的指令只在 agent 操作匹配路径下的文件时生效。

---

## permissions[]

命令级别的权限策略，控制哪些 shell 命令被允许、需要确认或被拒绝。

### 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 唯一标识 |
| `allow` | string[] | 否 | 允许的命令模式 |
| `ask` | string[] | 否 | 需要用户确认的命令模式 |
| `deny` | string[] | 否 | 拒绝的命令模式 |
| `agentOverrides` | object | 否 | 平台特定覆盖 |

### 命令模式语法

- 精确匹配：`"git status"`
- 前缀通配：`"git *"`
- 允许所有 git 子命令：`"git diff"`, `"git log"` 逐一列出或 `"git *"` 通配

### 平台生成行为

| 平台 | 输出 | 格式 |
|------|------|------|
| Claude | 合并到 `settings.awGenerated.permissions` | allow/ask/deny 数组去重合并 |
| Codex | `rules/aw-<plugin>-<name>.rules` | `allow <pattern>` / `ask <pattern>` / `deny <pattern>` |

### 示例

```json
{
  "name": "git-ops",
  "allow": ["git status", "git diff", "git log"],
  "ask": ["git commit", "git push"],
  "deny": ["git push --force"]
}
```

---

## hooks[]

事件驱动的自动化钩子，在特定生命周期事件发生时执行 shell 命令。

### 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | string | 是 | 事件类型（见下方事件列表） |
| `matcher` | string | 否 | 事件匹配模式，缩小触发范围 |
| `command` | string | 是 | 触发时执行的 shell 命令 |
| `description` | string | 否 | 人类可读说明 |
| `agentOverrides` | object | 否 | 平台特定覆盖 |

### 事件类型

| 事件 | 说明 | matcher 用途 |
|------|------|-------------|
| `before_tool` | 工具使用前 | 匹配工具名称 |
| `after_tool` | 工具使用后 | 匹配工具名称 |
| `session_start` | 会话开始 | — |
| `session_stop` | 会话结束 | — |
| `command` | 命令执行时 | 匹配命令模式 |

### 平台生成行为

| 平台 | 输出 | 说明 |
|------|------|------|
| Claude | `hooks/hooks.json` | 事件名映射：`before_tool` → `beforeToolUse`、`after_tool` → `afterToolUse`、`session_start` → `sessionStart`、`session_stop` → `sessionStop`、`command` → `command` |
| Codex | `hooks.json` | 只聚合 `event: "command"` 的 hook，其他事件类型不写入 |

### 示例

```json
{
  "event": "before_tool",
  "matcher": "Write",
  "command": "echo 'File write detected'",
  "description": "在文件写入前打印提示"
}
```

```json
{
  "event": "session_start",
  "command": "cat .project-context.md 2>/dev/null || true",
  "description": "会话开始时加载项目上下文"
}
```

---

## agents[]

子 Agent 定义，用于派生可被主 agent 调用的专项助手。

### 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | agent 标识，同插件内不能重复 |
| `description` | string | 是 | agent 说明，描述其职责和调用场景 |
| `prompt` | string | 是 | agent 系统提示词 |
| `tools` | string[] | 否 | 工具列表（当前只用于 Claude agent markdown） |
| `agentOverrides` | object | 否 | 平台特定覆盖 |

### 平台生成行为

| 平台 | 输出格式 | 路径 |
|------|---------|------|
| Claude | Agent Markdown（含 frontmatter） | `agents/aw-<plugin>-<name>.md` |
| Codex | Role TOML | `agents/aw-<plugin>-<name>.toml` |

### Claude Agent Markdown 格式

```markdown
---
name: "commit-reviewer"
description: "检查提交范围和信息是否匹配。"
tools:
  - shell
---

请检查这次提交是否符合提交规范，并指出 scope 是否准确。
```

### Codex Agent TOML 格式

```toml
name = "commit-reviewer"
description = "检查提交范围和信息是否匹配。"
developer_instructions = """请检查这次提交是否符合提交规范，并指出 scope 是否准确。"""
```

### 示例

```json
{
  "name": "commit-reviewer",
  "description": "检查提交范围和信息是否匹配。",
  "prompt": "请检查这次提交是否符合提交规范，并指出 scope 是否准确。",
  "tools": ["shell"]
}
```

---

## agentOverrides 机制

任何 extension 条目都可以附加 `agentOverrides`，为不同平台做差异化处理。

### 语法

```json
{
  "name": "some-instruction",
  "title": "标题",
  "content": "默认内容",
  "agentOverrides": {
    "claude": { "content": "Claude 专用内容" },
    "codex": null
  }
}
```

### 行为

| 值 | 效果 |
|----|------|
| `null` | 该条目不进入目标平台 |
| `{ ... }` | 用对象中的字段覆盖默认值，未出现的字段保持默认 |
| 省略 | 使用默认值 |

### 使用场景

- 某个 hook 只在 Claude 上有意义 → Codex 侧设为 `null`
- 同一 instruction 在两个平台用不同措辞 → 分别覆盖 `content`
- 某个 agent 的 `tools` 只有 Claude 支持 → Claude 侧覆盖 `tools`，Codex 侧省略

### 完整示例

```json
{
  "extensions": {
    "hooks": [
      {
        "event": "before_tool",
        "matcher": "Write",
        "command": "echo 'write check'",
        "agentOverrides": {
          "codex": null
        }
      }
    ],
    "agents": [
      {
        "name": "reviewer",
        "description": "代码审查助手",
        "prompt": "审查代码质量。",
        "tools": ["shell", "Read"],
        "agentOverrides": {
          "codex": { "prompt": "Review code quality and report issues." }
        }
      }
    ]
  }
}
```
