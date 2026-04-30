# Claude 专属能力

以下能力只进入 Claude runtime manifest，通过 `buildConfig.manifestOverrides.claude` 声明，并配合 `buildConfig.fileRules` 控制文件打包。Codex 平台不支持这些能力。公共 `slashCommands` 会额外生成 Claude `commands/*.md`，但源码层不再手写 `commands/` 目录；旧顶层 `commands`、`manifestOverrides.claude.commands` 和 `commands/**` fileRules 都会被 validate / build 拒绝。

## 使用模式

Claude 专属能力的声明需要 `buildConfig` 中两个子系统配合：

1. **fileRules**：把能力文件（如 `output-styles/`）打包进 Claude bundle
2. **manifestOverrides**：在 Claude runtime manifest 中声明对应字段

此外，公共 `slashCommands/*.md` 和 `output-styles/*.md` 等文本文件支持模板渲染（`{{var}}`、`{{#if}}`），可按平台生成不同内容。需在 `buildConfig.templates` 中配置，详见 `references/build-config-spec.md`。

```json
{
  "buildConfig": {
    "fileRules": {
      "claude": { "include": ["output-styles/**"], "exclude": [] },
      "codex": { "include": [], "exclude": ["output-styles/**"] }
    },
    "manifestOverrides": {
      "claude": {
        "outputStyles": "./output-styles"
      }
    }
  }
}
```

---

## 命令结果填充（Claude Code 专属）

**此能力为 Claude Code 运行时专属，Codex 不支持。** Claude Code 在加载 generated `commands` 和 `skills` 的 Markdown prompt 文件时，可执行嵌入的 shell 命令并将输出内联到最终 prompt。

### 支持范围

| 扩展类型 | 支持 | 说明 |
|----------|:----:|------|
| generated `commands/*.md` | ✓ | 用户触发斜杠命令时执行 |
| `skills/*/SKILL.md` | ✓ | skill 被触发加载时执行 |
| `skills/*/references/*.md` | ✓ | 随 skill 加载时执行 |
| `extensions.agents` | ✗ | 仅支持 `${CLAUDE_PLUGIN_ROOT}` 和 `${user_config.X}` 变量替换 |
| MCP skills | ✗ | 框架显式禁用 |
| `output-styles/*.md` | ✗ | 未接入 prompt shell 预处理链路 |
| Hooks | ✗ | 未接入 prompt shell 预处理链路 |

### 语法

**行内形式**——反引号包裹、前缀 `!`：

```text
当前分支：!`git branch --show-current`
当前变更：!`git diff --cached --name-only`
```

**代码块形式**——围栏语言标记写 `!`（三个反引号后紧跟 `!`）：

    ```!
    git diff --cached --stat
    ```

两种形式在文件加载时执行，命令输出替换原始语法后成为最终 prompt 的一部分。

### Frontmatter 配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `allowed-tools` | `string` \| `string[]` | — | 放行命令执行的工具模式（如 `Bash(git *)`），未声明则可能被权限系统拦截 |
| `shell` | string | `bash` | 使用的 shell 解释器，仅支持 `bash` 和 `powershell` |

`allowed-tools` 可写单个字符串，也可写字符串数组；多条规则建议用数组写法，便于阅读和 diff。

公共 `slashCommands` 的 `claude` frontmatter block，以及 `skills` 的 frontmatter，均支持这两个字段。

---

## 公共 slashCommands → Claude commands

源码层使用公共 `slashCommands` 目录维护一份命令 Markdown；构建后 Claude bundle 会生成原生 `commands/*.md`。用户最终仍通过 `/command-name` 触发。

### 目录结构

```text
plugins/<name>/
└── slash-commands/
    ├── review.md
    ├── deploy.md
    └── assets/
        └── review-16.svg
```

命令文件是 Markdown 格式，文件名即命令名。首版不支持子目录命名空间；`assets/` 目录只放图标等资源，里面的 Markdown 不生成命令。

### 命令文件格式

```markdown
---
description: 执行代码审查
claude:
  allowed-tools:
    - Bash
    - Read
    - Write
  model: inherit
  argument-hint: "[file-path]"
codex:
  description: 在 Codex 中手动执行代码审查工作流。
---

对 $ARGUMENTS 指定的文件执行代码审查。

1. 读取目标文件
2. 分析代码质量
3. 输出审查报告
```

### Frontmatter 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| 顶层 `description` | string | 公共描述，Claude/Codex 默认共用 |
| `claude.description` | string | Claude 命令描述覆盖 |
| `claude.allowed-tools` | `string` \| `string[]` | 命令执行期间允许使用的工具 |
| `claude.model` | string | 指定模型（`inherit` 继承当前模型） |
| `claude.argument-hint` | string | 参数提示（如 `[file]`、`[branch]`） |
| `claude.shell` | string | shell 插值使用的解释器（默认 `bash`，可选 `powershell`） |
| `codex.description` | string | Codex generated skill 的描述覆盖 |
| `codex.interface.display_name` | string | Codex generated skill 展示名 |
| `codex.interface.short_description` | string | Codex generated skill 简短描述 |
| `codex.interface.icon_small` / `icon_large` | string | 只能写 `./assets/...`，源文件位于 `slash-commands/assets/` |
| `codex.interface.brand_color` | string | `#RRGGBB` |
| `codex.interface.default_prompt` | string | Codex skill 默认提示 |

构建时，Claude generated command 会固定写入 `disable-model-invocation: true`。命令文件里的 `allowed-tools` 同样兼容单个字符串；多条规则建议写成数组。

Codex generated skill 会固定写入 `policy.allow_implicit_invocation: false`，因此它只能由用户显式 `$command-name` 或结构化 skill mention 调用。作者不能在 `codex.policy` 覆盖这个策略。Codex 渲染结果不能包含 `$ARGUMENTS`、`$1`、`` !`command` `` 或 ```! 这类 Claude-only 语法；需要平台差异时，用 `buildConfig.templates` 包住 Claude-only 段落。

### 动态参数

- `$ARGUMENTS`：用户在命令名后输入的全部参数
- `$1`、`$2`、`$3`：按空格分割的第 1、2、3 个参数

命令文件正文支持命令结果填充语法（`` !`command` `` 和 `` ```! ``），详见上方 § 命令结果填充。

这些动态参数和命令结果填充只允许出现在 Claude 渲染结果中。Codex 侧请改写成自然语言步骤，例如“先询问用户参数”或“使用工具读取当前 diff”。

### manifest 声明

```json
{
  "slashCommands": "./slash-commands"
}
```

---

## output-styles/

Claude Code 的输出样式定制，控制回复的格式和风格。

### 目录结构

```text
plugins/<name>/
└── output-styles/
    ├── concise.md
    └── detailed.md
```

### 文件格式

输出样式文件是 Markdown 格式，内容描述该样式的格式化规则：

```markdown
---
description: 简洁输出模式
---

以简洁模式输出：
- 每个回复不超过 3 句
- 不使用 Markdown 标题
- 不使用代码块，除非展示代码
- 优先使用列表而非段落
```

### manifest 声明

```json
{
  "buildConfig": {
    "fileRules": {
      "claude": { "include": ["output-styles/**"], "exclude": [] }
    },
    "manifestOverrides": {
      "claude": { "outputStyles": "./output-styles" }
    }
  }
}
```

---

## lspServers

Language Server Protocol 服务器配置，为 Claude Code 提供代码智能能力。

### 字符串路径形式

指向一个 JSON 配置文件：

```json
{
  "manifestOverrides": {
    "claude": {
      "lspServers": "./lsp.json"
    }
  }
}
```

`lsp.json` 格式：

```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensionToLanguage": {
      ".ts": "typescript",
      ".tsx": "typescriptreact"
    },
    "transport": "stdio"
  }
}
```

### 对象形式

直接在 manifestOverrides 中内联定义：

```json
{
  "manifestOverrides": {
    "claude": {
      "lspServers": {
        "python": {
          "command": "pylsp",
          "transport": "stdio",
          "extensionToLanguage": {
            ".py": "python"
          }
        }
      }
    }
  }
}
```

### LSP 配置字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | 是 | LSP 服务器可执行文件 |
| `args` | string[] | 否 | 命令行参数 |
| `transport` | string | 否 | 传输方式：`stdio` 或 `socket` |
| `extensionToLanguage` | object | 否 | 文件扩展名到语言 ID 的映射 |
| `env` | object | 否 | 环境变量 |
| `settings` | object | 否 | LSP 服务器设置 |

---

## userConfig

用户配置项声明，安装插件时提示用户填写。敏感值存入 keychain。

### 配置项定义格式

```json
{
  "manifestOverrides": {
    "claude": {
      "userConfig": {
        "apiKey": {
          "type": "string",
          "title": "API Key",
          "description": "外部审查服务的 API 密钥",
          "required": true,
          "sensitive": true
        },
        "maxFiles": {
          "type": "number",
          "title": "最大文件数",
          "description": "单次审查的最大文件数量",
          "default": 10,
          "min": 1,
          "max": 100
        },
        "autoFix": {
          "type": "boolean",
          "title": "自动修复",
          "description": "是否自动修复可修复的问题",
          "default": false
        },
        "outputDir": {
          "type": "directory",
          "title": "输出目录",
          "description": "审查报告输出路径"
        }
      }
    }
  }
}
```

### 类型系统

| 类型 | 说明 | 额外字段 |
|------|------|---------|
| `string` | 字符串 | `sensitive`、`multiple` |
| `number` | 数字 | `min`、`max` |
| `boolean` | 布尔值 | — |
| `directory` | 目录路径 | — |
| `file` | 文件路径 | — |

### 配置项字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 值类型 |
| `title` | string | UI 标签 |
| `description` | string | 帮助文本 |
| `required` | boolean | 是否必填 |
| `default` | any | 默认值 |
| `sensitive` | boolean | 是否为敏感信息（存入 keychain） |
| `multiple` | boolean | 是否允许多值（仅 string 类型） |
| `min` / `max` | number | 数值范围（仅 number 类型） |

### 值的引用

配置值可在 MCP/LSP 配置和 hook 命令中通过 `${user_config.KEY}` 引用：

```json
{
  "mcpServers": {
    "review": {
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${user_config.apiKey}"
      }
    }
  }
}
```

---

## channels

助手模式频道定义，将 MCP 服务器作为消息通道。

### 格式

```json
{
  "manifestOverrides": {
    "claude": {
      "channels": [
        {
          "server": "slack-mcp",
          "displayName": "Slack 频道",
          "userConfig": {
            "workspace": {
              "type": "string",
              "title": "工作区",
              "description": "Slack 工作区名称",
              "required": true
            }
          }
        }
      ]
    }
  }
}
```

### 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `server` | string | 是 | 关联的 MCP 服务器名称 |
| `displayName` | string | 否 | UI 显示名称 |
| `userConfig` | object | 否 | 频道级用户配置项 |

channels 数组或对象形式均可，原样进入 Claude runtime manifest。
