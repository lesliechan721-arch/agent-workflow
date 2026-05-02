# Claude 专属能力

本文只记录源码层公共 contract 中会落到 Claude 侧、且 Codex 不支持的能力：命令结果填充，以及 `buildConfig.manifestOverrides.claude` 下的 `outputStyles`、`lspServers`、`userConfig`、`channels`。公共 `slashCommands` 不是 Claude 专属能力，完整作者合同见 `references/slash-commands.md`；本文件只说明它的 Claude 渲染结果可以使用哪些 Claude-only 语法。

## 使用模式

Claude runtime manifest 专属字段通过 `buildConfig.manifestOverrides.claude` 声明。`outputStyles` 和字符串形式的 `lspServers` 这类路径字段会自动把声明路径复制到 Claude bundle；只有额外辅助文件没有被任何 manifest 路径声明时，才需要再用 `buildConfig.fileRules.claude.include` 补充打包。

命令结果填充不通过 `manifestOverrides` 声明；它写在 Claude 会加载的 Markdown prompt 文件中，并通过 frontmatter 的 `allowed-tools` / `shell` 配置运行约束。

`output-styles/*.md` 等文本文件支持模板渲染（`{{var}}`、`{{#if}}`），可按平台生成不同内容。需在 `buildConfig.templates` 中配置，详见 `references/build-config-spec.md`。

```json
{
  "buildConfig": {
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

公共 `slashCommands` 的 `claude` frontmatter block，以及 `skills` 的 frontmatter，均支持这两个字段。`slashCommands` 的完整公共格式见 `references/slash-commands.md`。

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
  "buildConfig": {
    "manifestOverrides": {
      "claude": {
        "lspServers": "./lsp.json"
      }
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
  "buildConfig": {
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

如果配置需要同时被 Claude Code 和 Codex 使用，优先使用 AW `config.schema` 和 `aw config`，详见 `references/aw-scripts-config-lifecycle.md`。`userConfig` 只适合 Claude Code 原生能力专用的配置，例如只在 Claude runtime manifest、Claude-only MCP 替换或 Claude prompt 变量中消费的值。

### 配置项定义格式

```json
{
  "buildConfig": {
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

配置值可在 Claude runtime 的 MCP/LSP 配置和 hook 命令中通过 `${user_config.KEY}` 引用：

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

`${user_config.KEY}` 是 Claude runtime 占位符。共享给 Codex 的 `.mcp.json` 不应直接使用它；跨平台 MCP 配置请优先使用环境变量占位符（如 `${API_TOKEN}`），或用 `buildConfig.templates` 做平台分支。

---

## channels

助手模式频道定义，将 MCP 服务器作为消息通道。

### 格式

```json
{
  "buildConfig": {
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
}
```

### 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `server` | string | 是 | 关联的 MCP 服务器名称 |
| `displayName` | string | 否 | UI 显示名称 |
| `userConfig` | object | 否 | 频道级用户配置项 |

channels 数组或对象形式均可，原样进入 Claude runtime manifest。
