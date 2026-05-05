# Extensions 规范

`extensions` 是 `.agents-plugin/plugin.json` 中的高级能力声明，用于在安装或构建时派生出跨平台能力。包含 `instructions`（指令）、`permissions`（权限）、公共 `hooks`（跨平台事件钩子）、平台独享 `nativeHooks` 和 `agents`（子 Agent）。

不要新增顶层 `claude` block，也不要把 hooks / agents 塞进 `buildConfig.manifestOverrides.claude`。

`extensions.*` 适合简单静态产物：内容固定，或只需要通过 `buildConfig.templates` 做平台差异渲染。需要根据 AW config 动态开启/关闭、刷新内容、诊断 stale / failed refresh，或管理 Codex role registration 时，不要把逻辑塞进 lifecycle；改用 `artifacts.targets` + `scripts.artifacts.render`，详见 `references/plugin-manifest-spec.md` 和 `references/aw-scripts-config-lifecycle.md`。

对 Codex 来说，extensions 是 project scope 的 repo-managed surface：安装到 `--scope project` 时会写当前仓库的 `.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/`、`.codex/agents/` 和 tracking manifest，不会调用 Codex native marketplace 或 app-server RPC。只包含 extensions 的插件可以作为 Codex project 安装候选；包含 `apps` 或纯 native-only 的插件不能 project 安装。

## 整体结构

```json
{
  "extensions": {
    "instructions": [],
    "permissions": [],
    "hooks": [],
    "nativeHooks": {
      "claude": [],
      "codex": []
    },
    "agents": []
  }
}
```

每个数组可以为空。`instructions`、`permissions`、公共 `hooks` 和 `agents` 的条目可以附加 `agentOverrides` 做平台特定覆盖（见末尾）。`nativeHooks` 已经按平台分组，不再支持 `agentOverrides`。

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

公共层只接受普通空格分隔的命令 token 前缀，例如 `"git status"`、`"git commit"`、`"git push --force"`。该语义是 token 级前缀匹配：`"git status"` 会覆盖 `git status --short`。`"git *"`、引号和转义当前不属于公共 contract，manifest 读取阶段会直接拒绝。

### 平台生成行为

| 平台 | 输出 | 格式 |
|------|------|------|
| Claude | 合并到 `settings.awGenerated.permissions` | `Bash(<token prefix>)` 这类带工具作用域的原生规则 |
| Codex | `rules/aw-<plugin>-<name>.rules` | `prefix_rule(pattern = [...], decision = "...")` |

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

公共事件钩子，在两个平台语义一致的生命周期事件发生时执行 shell 命令。`extensions.hooks` 不是 Claude Code / Codex 原生 hook 事件全集；只有已经确认可移植的事件会放在这里。

### 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | string | 是 | 事件类型（见下方事件列表） |
| `matcher` | string | 否 | 事件匹配模式，缩小触发范围 |
| `command` | string | 是 | 触发时执行的 shell 命令 |
| `agentOverrides` | object | 否 | 平台特定覆盖 |

### 公共事件类型

| 事件 | 说明 | matcher 用途 |
|------|------|-------------|
| `before_tool` | 工具使用前 | 匹配工具名称 |
| `after_tool` | 工具使用后 | 匹配工具名称 |
| `session_start` | 会话开始 | 只能写 `startup`、`resume`、`clear`，或这些值用 `|` 连接 |

公共 `session_start` 只覆盖 `startup / resume / clear`。省略 `matcher` 时，CLI 会在最终 artifact 中显式写成 `startup|resume|clear`；这不会匹配 Claude 的 `compact`。如果需要响应 Claude compact，应使用 `extensions.nativeHooks.claude[]` 声明原生 `SessionStart`，并写 `matcher: "compact"`。

`session_stop` 已从公共 hook 中移除。Claude 的 `Stop` / `SessionEnd` 与 Codex 的 `Stop` 语义不同，应写到对应平台的 `nativeHooks`。

`command` 是公共 hook contract 的必填字段，表示触发 hook 时执行的 shell 命令。`description` 不属于公共 hook 字段；需要解释 hook 用途时，把说明放在插件文档或相邻注释里。

### 平台生成行为

| 平台 | 输出 | 说明 |
|------|------|------|
| Claude | `hooks/hooks.json` | `{ hooks: { PreToolUse/PostToolUse/SessionStart: [...] } }` |
| Codex | `hooks.json` | `{ hooks: { PreToolUse/PostToolUse/SessionStart: [...] } }` |

### 示例

```json
{
  "event": "before_tool",
  "matcher": "Write",
  "command": "echo 'File write detected'"
}
```

```json
{
  "event": "session_start",
  "command": "cat .project-context.md 2>/dev/null || true"
}
```

```json
{
  "event": "session_start",
  "matcher": "startup|resume",
  "command": "cat .project-context.md 2>/dev/null || true"
}
```

---

## nativeHooks

平台原生 hook 入口，用于声明只有 Claude 或只有 Codex 才有明确语义的事件。事件名写平台原生名，不做公共事件映射。

### 字段

```json
{
  "extensions": {
    "nativeHooks": {
      "claude": [
        {
          "event": "SessionStart",
          "matcher": "compact",
          "command": "echo claude compact"
        },
        {
          "event": "Stop",
          "command": "echo claude turn stopped"
        }
      ],
      "codex": [
        {
          "event": "UserPromptSubmit",
          "command": "echo codex prompt submitted"
        },
        {
          "event": "Stop",
          "command": "echo codex turn stopped"
        }
      ]
    }
  }
}
```

`nativeHooks` 只允许 `claude` 和 `codex` 两个 key。每条 native hook 首版只支持同步 `command` handler，结构是 `{ "event": "...", "matcher"?: "...", "command": "..." }`。

`matcher` 不是所有原生事件都有语义。matcherless 事件不要写 `matcher`；CLI 会在 source manifest 校验阶段拒绝这类字段。例如 Codex `UserPromptSubmit` / `Stop` 以及 Claude `UserPromptSubmit` / `Stop` 都不接受 matcher。

`agentOverrides` 不用于 `nativeHooks`。如果一个 hook 是平台独享事件，直接写在对应平台数组里；如果是可移植公共事件，写在 `extensions.hooks`，再用 `agentOverrides` 做平台排除或字段覆盖。

常见迁移：

| 旧写法 / 需求 | 新写法 |
|------|------|
| 公共 `session_stop` | Claude 写 `nativeHooks.claude[].event = "Stop"` 或 `"SessionEnd"`；Codex 写 `nativeHooks.codex[].event = "Stop"` |
| Claude compact 时触发 | `nativeHooks.claude[]` 中写 `event: "SessionStart"`、`matcher: "compact"` |
| Codex prompt 提交时触发 | `nativeHooks.codex[]` 中写 `event: "UserPromptSubmit"`，不要写 matcher |

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

- 某个公共 hook 只在 Claude 上有意义 → Codex 侧设为 `null`
- 某个原生 hook 只在 Claude 或 Codex 上有意义 → 写入 `extensions.nativeHooks.<agent>`，不要使用 `agentOverrides`
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
