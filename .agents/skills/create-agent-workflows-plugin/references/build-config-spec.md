# BuildConfig 规范

`buildConfig` 是 `.agents-plugin/plugin.json` 中的构建阶段配置，控制 `pnpm build` 时如何生成平台 bundle。包含三个子系统：`templates`（模板渲染）、`fileRules`（平台文件规则）和 `manifestOverrides`（平台 manifest 覆盖）。

`buildConfig` 只描述构建阶段行为，不是给平台私有字段开的通用出口。

## templates

按平台渲染文本文件中的模板变量，实现条件编译。适用于插件中任何需要区分平台内容的文本文件，典型场景：

- **Skill 文档**（`skills/**/*.md`）：在 SKILL.md 中按平台展示不同的工作流说明或功能提示
- **Reference 文档**（`references/**/*.md`）：按平台提供不同的 API 示例或配置说明
- **配置文件**（`.json`、`.yaml`、`.toml`）：按平台生成不同的默认配置
- **Rules 文件**（`.rules`）：按平台生成不同的权限规则

模板渲染发生在 `pnpm build` 阶段，只影响 bundle 产物，不修改源码文件。通过 `templates.include` glob 指定哪些文件参与渲染，未匹配的文件直接复制。

### 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `templates.include` | string[] | 需要渲染的文本文件 glob |
| `templates.vars` | object | 模板变量，每个必须同时给出 claude 和 codex 两个平台的值 |

### 变量定义

每个变量必须提供双平台值：

```json
{
  "vars": {
    "platformName": {
      "claude": "Claude Code",
      "codex": "Codex"
    },
    "hasStreaming": {
      "claude": true,
      "codex": false
    }
  }
}
```

值类型：`string` 或 `boolean`。boolean 值用于条件块。

### 模板语法

| 语法 | 说明 |
|------|------|
| `{{varName}}` | 替换为平台对应的字符串值 |
| `{{#if varName}}...{{/if}}` | 当值为 truthy 时保留内容 |
| `{{#unless varName}}...{{/unless}}` | 当值为 falsy 时保留内容 |

### 可渲染文件类型

只有以下扩展名的文本文件会被模板引擎处理：

`.md`、`.markdown`、`.txt`、`.json`、`.yaml`、`.yml`、`.toml`、`.rules`

二进制文件和其他扩展名的文件直接复制，不做渲染。

### 示例

`SKILL.md` 中使用模板变量：

```markdown
这个 skill 在 {{platformName}} 上执行代码审查。

{{#if hasStreaming}}
支持流式输出，审查结果实时展示。
{{/if}}

{{#unless hasStreaming}}
审查结果在完成后一次性展示。
{{/unless}}
```

构建时，Claude bundle 中渲染为：

```markdown
这个 skill 在 Claude Code 上执行代码审查。

支持流式输出，审查结果实时展示。
```

Codex bundle 中渲染为：

```markdown
这个 skill 在 Codex 上执行代码审查。

审查结果在完成后一次性展示。
```

---

## fileRules

控制哪些文件进入哪个平台的 bundle。默认行为是所有文件都进入两个平台；`fileRules` 用于按平台做差异化。

### 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `fileRules.claude` | object | Claude bundle 的文件规则 |
| `fileRules.codex` | object | Codex bundle 的文件规则 |
| `*.include` | string[] | 额外包含的文件 glob |
| `*.exclude` | string[] | 排除的文件 glob |

### 行为

- `include` 和 `exclude` 都是相对于插件根目录的 glob
- `exclude` 优先于 `include`
- 未声明 `fileRules` 的平台使用默认行为（所有文件）

### 典型用法

只把 `output-styles/` 目录打包给 Claude；公共 `slashCommands` 只作为生成输入，不原样进入任何平台 bundle：

```json
{
  "fileRules": {
    "claude": {
      "include": ["output-styles/**"],
      "exclude": []
    },
    "codex": {
      "include": [],
      "exclude": ["output-styles/**"]
    }
  }
}
```

---

## manifestOverrides

向特定平台的 runtime manifest 注入额外字段。这些字段不在源码 manifest 的顶层，而是通过 `manifestOverrides` 间接声明。

### 允许的键

| 平台 | 允许的键 | 说明 |
|------|---------|------|
| `claude` | `outputStyles`、`lspServers`、`userConfig`、`channels` | 详见 `references/claude-only-capabilities.md` |
| `codex` | — | 当前只允许空对象 `{}` |

`manifestOverrides.claude.commands` 已移除。手动触发命令必须使用顶层公共 `slashCommands`，由 build 生成 Claude `commands/*.md` 和 Codex manual-only skills。`fileRules` 也不能再 include / exclude 旧 `commands/**` 源目录。

### 路径 vs 对象

- `outputStyles` 和字符串形式的 `lspServers`：必须是插件内 `./` 相对路径
- 对象形式的 `lspServers`、`userConfig`、`channels`：原样进入 Claude runtime manifest

### 示例

```json
{
  "manifestOverrides": {
    "claude": {
      "outputStyles": "./output-styles",
      "lspServers": {
        "typescript": {
          "command": "typescript-language-server",
          "args": ["--stdio"]
        }
      },
      "userConfig": {
        "apiKey": {
          "type": "string",
          "title": "API Key",
          "description": "外部服务 API 密钥",
          "required": true,
          "sensitive": true
        }
      }
    }
  }
}
```

---

## 完整 buildConfig 示例

综合使用三个子系统：

```json
{
  "buildConfig": {
    "templates": {
      "include": ["skills/**/*.md", "slash-commands/*.md"],
      "vars": {
        "platformName": { "claude": "Claude Code", "codex": "Codex" },
        "supportsCommands": { "claude": true, "codex": false }
      }
    },
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

这个配置实现：
1. 所有 skill Markdown 文件按平台渲染模板变量
2. `slash-commands/*.md` 先按平台渲染，再分别生成 Claude `commands/*.md` 和 Codex manual-only skills
3. `output-styles/` 只进入 Claude bundle，Claude runtime manifest 中声明 `outputStyles` 路径
