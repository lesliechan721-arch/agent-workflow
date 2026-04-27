# Skills 能力与触发配置

Skills 是插件向用户或模型暴露的可调用工作流。每个 skill 是一组 Markdown 指令 + 平台元数据，由 CLI 按平台分发到对应目录。

## Skill 目录结构

```text
plugins/<name>/skills/
└── <skill-name>/
    ├── SKILL.md                 # 必需：skill 定义（frontmatter + 正文）
    ├── agents/
    │   └── openai.yaml          # 面向 Codex 时必需：Codex 平台元数据
    ├── references/              # 可选：按需加载的参考文档
    │   └── *.md
    └── scripts/                 # 可选：辅助脚本
        └── *.js | *.sh
```

一个插件可以包含多个 skill 子目录，每个子目录名即 skill 标识（小写短横线格式）。

## SKILL.md 规范

### Frontmatter 字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | — | 必填。skill 标识，小写短横线，≤64 字符 |
| `description` | string | — | 必填。说明"做什么"和"什么时候用"；影响平台 skill 发现和匹配质量，≤1024 字符 |
| `when_to_use` | string | — | Claude Code：可选但建议自动发现型 skill 提供。写清楚模型什么时候应自动调用，可包含触发短语和用户说法示例 |
| `user-invocable` | boolean | `true` | Claude Code：是否允许用户手动调用 |
| `disable-model-invocation` | boolean | `false` | Claude Code：是否禁止模型自动调用 |
| `metadata.short-description` | string | — | 可选。简短描述，用于 UI 展示，≤1024 字符 |
| `allowed-tools` | string[] | — | Claude Code：声明 shell 插值中允许执行的命令模式（如 `Bash(git *)` ） |
| `shell` | string | `bash` | Claude Code：shell 插值使用的解释器，仅支持 `bash` 和 `powershell` |

示例：

```yaml
---
name: repo-check
description: 当用户要求检查仓库状态或执行仓库诊断时，执行完整的仓库健康检查工作流。
user-invocable: true
disable-model-invocation: true
metadata:
  short-description: 仓库状态诊断
---
```

### 正文组织建议

正文是 skill 触发后加载的工作指令（不是给用户的文档，而是给 agent 的指令）。建议结构：

1. **标题 + 一句话概述**
2. **执行步骤**：编号列表，按顺序描述 agent 应执行的操作
3. **边界约束**：不要做的事情、遇到异常时的处理方式
4. **输出格式**（如有要求）

保持简洁，避免重复 frontmatter 中已有的信息。大段参考资料放 `references/` 目录，按需加载。

SKILL.md 和 `references/` 下的 Markdown 文件均支持模板渲染（`{{var}}`、`{{#if}}`、`{{#unless}}`），可按平台生成不同内容。需在 `buildConfig.templates` 中配置 include glob 和变量，详见 `references/build-config-spec.md`。

### 命令结果填充（Claude Code 专属）

SKILL.md 正文和 `references/` 下的 Markdown 文件支持 `` !`command` `` 行内语法和 `` ```! `` 代码块语法，在加载时执行 shell 命令并将输出内联到 prompt。**此能力为 Claude Code 专属，Codex 不支持。**

使用此功能时需在 frontmatter 中声明 `allowed-tools` 和（可选的）`shell` 字段。完整语法规范、支持范围和 frontmatter 配置见 `references/claude-only-capabilities.md` § 命令结果填充。

## agents/openai.yaml 规范

此文件只给 Codex 平台读取，Claude Code 不读取。只要插件没有通过 `marketplace.policy.products` 明确限制为非 Codex 产品，就把 skill 视为面向 Codex：必须提供 `agents/openai.yaml`，并显式写出 `policy.allow_implicit_invocation`。Claude-only skill 可以省略此文件，但需要在 manifest 的 `products` 中清楚收窄平台。

### 完整字段

```yaml
interface:
  display_name: "Repo Check"              # UI 显示名称
  short_description: "检查仓库状态"        # 推荐 25-64 字符
  icon_small: "./assets/icon-small.png"    # 可选：小图标路径
  icon_large: "./assets/icon-large.svg"    # 可选：大图标路径
  brand_color: "#3B82F6"                   # 可选：品牌主色
  default_prompt: "Use $repo-check to check the repository status."

dependencies:                              # 可选：工具依赖
  tools:
    - type: "mcp"
      value: "tool-name"
      description: "Tool description"
      transport: "streamable_http"         # streamable_http | stdio
      url: "https://..."                   # streamable_http 用
      command: "tool-server"               # stdio 用

policy:
  allow_implicit_invocation: false         # 是否允许自动注入
```

### interface 块

- `display_name`：建议直接写人类可读的 Title Case 名称，如 `Repo Check`。Codex 只清洗单行和校验长度，不会把 `repo-check` 自动转换成 `Repo Check`
- `short_description`：推荐 25-64 字符，便于 UI 快速扫读；Codex loader 实际校验为非空且 ≤ 1024 字符
- `default_prompt`：示例触发语句，建议使用 `$skill-name` 引用

### dependencies.tools[] 块

- `type` / `value` / `description`：声明工具依赖的类型、标识和说明
- `transport`：可选，当前 Codex 支持 `streamable_http` 和 `stdio`
- `url`：`streamable_http` 场景下的远端服务地址
- `command`：`stdio` 场景下启动本地 MCP server 的命令

### policy 块

- `allow_implicit_invocation: true`：允许 Codex 自动注入和隐式识别
- `allow_implicit_invocation: false`：关闭自动注入，但仍可通过 `$skill-name` 显式触发

---

## 双平台触发配置

两个平台的触发开关完全独立，互不读取。

### 触发开关对照

| 平台 | 自动触发控制 | 手动触发控制 | 配置位置 |
|------|-------------|-------------|----------|
| Codex | `allow_implicit_invocation` | 始终可 `$skill-name` | `agents/openai.yaml` |
| Claude Code | `disable-model-invocation` | `user-invocable` | `SKILL.md` frontmatter |

### 配方 1：保守手动触发

适合 `commit`、`deploy`、`release` 等有副作用的流程。

```yaml
# SKILL.md
---
name: your-skill
description: 当用户明确要求执行某个流程时，完成该流程。
user-invocable: true
disable-model-invocation: true
---
```

```yaml
# agents/openai.yaml
policy:
  allow_implicit_invocation: false
```

### 配方 2：允许自动发现

适合低风险、辅助型、说明型 skill。

```yaml
# SKILL.md（使用默认值，可省略触发字段）
---
name: your-skill
description: 当用户需要某类低风险辅助工作时，执行对应工作流。
when_to_use: Use when the user asks for this low-risk helper workflow, including phrases like "check this setup" or "summarize this state".
---
```

允许 Claude Code 自动发现时，建议显式写 `when_to_use`。`description` 仍是公共字段；`when_to_use` 是 Claude 自动匹配质量优化项，不会被 Codex 读取。

```yaml
# agents/openai.yaml
policy:
  allow_implicit_invocation: true
```

### 配方 3：Claude 隐藏用户入口

适合只希望 Claude Code 模型在特定场景下调用的 skill。

```yaml
# SKILL.md
---
name: your-skill
description: 在特定场景下由模型调用。
user-invocable: false
---
```

Codex 没有完全等价的"隐藏手动入口"字段；即使 `allow_implicit_invocation: false`，显式 `$skill-name` 仍可触发。

---

## 调试检查点

- 自动触发不符合预期 → 先检查 `description` 是否足够具体，再看 `allow_implicit_invocation`。
- 有副作用的流程 → 默认关掉 Codex 隐式调用和 Claude 模型调用。
- 不要把 Claude slash command 当作双端公共协议。
- `disable-model-invocation: true` 不等于 Claude 不能手动调用（用户仍可调用）。

## 多 Skill 插件

一个插件可以包含多个 skill：

```text
plugins/<name>/skills/
├── check/
│   ├── SKILL.md
│   └── agents/openai.yaml
├── fix/
│   ├── SKILL.md
│   └── agents/openai.yaml
└── report/
    ├── SKILL.md
    └── agents/openai.yaml
```

每个 skill 子目录完全独立，各自有独立的触发策略和工作流。manifest 的 `skills` 字段指向父目录（`"./skills"`），CLI 会自动发现所有子目录。
