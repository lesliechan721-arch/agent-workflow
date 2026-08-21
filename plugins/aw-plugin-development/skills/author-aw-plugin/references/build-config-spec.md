# BuildConfig 规范

`buildConfig` 是 `.agents-plugin/plugin.json` 中的构建阶段配置，控制 `pnpm build` 时如何生成平台 bundle。它包含模板、平台文件规则、平台 manifest 覆盖、runtime export、build import 和 Skill runtime 文件投影。

`buildConfig` 只描述构建阶段行为，不是给平台私有字段开的通用出口。`marketplace.policy.products` 会先解析出插件最终支持平台；`fileRules.<platform>` 和 `manifestOverrides.<platform>` 只能用于支持的平台。比如 `products=["CODEX"]` 的插件不能声明 `buildConfig.fileRules.claude` 或 `buildConfig.manifestOverrides.claude`，即使对应内容看起来只是额外文件或空覆盖也会 fail fast。

动态 Skill 的 `artifacts.targets[].sourceDirs` 不属于 `buildConfig.templates` 或 `fileRules`。构建会把每个 source directory 暂存到 artifact 专用隐藏目录，并按字节保留文件。不要对同一动态源目录再配置模板渲染；动态 UTF-8 内容由 ArtifactPlan V2 `content.files` 提供。

`buildConfig` 会影响 artifact 的内容身份：模板输出、额外文件选择、平台 manifest override 或支持平台变化都会进入 schema 3 snapshot digest。日常开发保持当前稳定 target，并用 `aw plugin status` 报告 production 变化；release train 开始时由 workspace release workflow 一次设置新 target。Git publisher 和 bootstrap 不属于插件作者合同。

## Runtime export 和 Skill 文件投影

共享 schema、validator 和规则必须由 provider 的 canonical source 投影。consumer 不读取 sibling plugin 路径，也不把共享文件副本提交到 Skill source。

- `runtimeExports[]` 用 `{ "name", "source" }` 发布稳定 export。`source` 是 provider 插件内的 `./` 相对 regular-file 路径。
- `skillRuntimeFiles[]` 用 `{ "skill", "target", "source" }` 投影本插件 canonical source，或用 `{ "skill", "target", "import": { "plugin", "export" } }` 投影 catalog 中另一个插件的 runtime export。`source` 和 `import` 必须二选一。
- `target` 位于目标 Skill 内。可选 `platforms` 只允许 `codex`、`claude`。省略时投影到插件支持的全部平台。
- source Skill 中不能已有同名 target。构建不会覆盖作者文件。

转换型文件使用 `scripts.node.build`。`buildImports[]` 用 `{ "plugin", "export", "env" }` 把 canonical regular file 的只读绝对路径注入 build 子进程。`env` 必须是 `AW_PLUGIN_IMPORT_[A-Z0-9_]+`，build script 必须直接读取该输入，不能从仓库 cwd 或 sibling plugin 路径推断 source。

确定性 build 可以声明 `cacheable: true`。该 build 只能依赖插件 canonical files、声明的 catalog `buildImports` 和固定 CLI virtual import；不能读取时间、随机值、网络、未声明环境变量或仓库 cwd。省略该字段时，构建器不复用 build output cache。

CLI 自有的 Skill frontmatter registry 只允许通过 reserved build import `{ "plugin": "@aw/cli", "export": "skill-frontmatter-capabilities" }` 使用。它不能作为 runtime export 或 `skillRuntimeFiles` import。

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

`fileRules` 用来把没有被 manifest 路径字段声明的额外文件加入某个平台 bundle。`skills`、`slashCommands` 生成产物、`mcpServers`、`apps`、`outputStyles` 和字符串形式的 `lspServers` 等声明路径会由构建器按平台自动复制，不需要再用 `fileRules` 包一层。

### 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `fileRules.claude` | object | Claude bundle 的文件规则 |
| `fileRules.codex` | object | Codex bundle 的文件规则 |
| `*.include` | string[] | 额外包含的源码文件 glob |
| `*.exclude` | string[] | 从本组额外包含结果中排除的 glob |

### 行为

- `include` 和 `exclude` 都是相对于插件根目录的 glob
- `exclude` 优先于 `include`
- 未声明 `fileRules` 时，只复制 manifest 声明的能力路径、生成产物和 AW runtime 脚本依赖闭包
- `exclude` 只影响同一个 `fileRules` 规则组选出的额外文件，不会排除 manifest 已声明的能力路径
- 原始 `slash-commands/` 源目录只作为生成输入，即使被 `fileRules` 命中也不会原样进入平台 bundle
- 只能声明插件支持平台的规则；unsupported platform 的 `fileRules` 会在 build/校验阶段失败

### 典型用法

按平台补充额外参考文件：

```json
{
  "fileRules": {
    "claude": {
      "include": ["references/claude-only/**"],
      "exclude": []
    },
    "codex": {
      "include": ["references/codex-only/**"],
      "exclude": []
    }
  }
}
```

---

## manifestOverrides

向特定平台的 runtime manifest 注入额外字段。这些字段不在源码 manifest 的顶层，而是通过 `manifestOverrides` 间接声明。

只能覆盖插件支持平台的 runtime manifest。Claude-only 能力必须放在 `manifestOverrides.claude`，但插件也必须支持 Claude；Codex-only 或 Claude-only 的不匹配覆盖都会在 build/校验阶段失败。

### 允许的键

| 平台 | 允许的键 | 说明 |
|------|---------|------|
| `claude` | `outputStyles`、`lspServers`、`userConfig`、`channels` | 详见 `references/claude-only-capabilities.md` |
| `codex` | — | 当前只允许空对象 `{}` |

手动触发命令必须使用顶层公共 `slashCommands`，由 build 生成 Claude `commands/*.md` 和 Codex manual-only skills。

### 路径 vs 对象

- `outputStyles` 和字符串形式的 `lspServers`：必须是插件内 `./` 相对路径
- 对象形式的 `lspServers`、`userConfig`、`channels`：原样进入 Claude runtime manifest

### 示例

```json
{
  "buildConfig": {
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
      "claude": { "include": ["references/claude-only/**"], "exclude": [] },
      "codex": { "include": ["references/codex-only/**"], "exclude": [] }
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
3. 额外参考文件按平台进入对应 bundle；manifest 已声明的能力路径不依赖 `fileRules`
4. `output-styles/` 只进入 Claude bundle，Claude runtime manifest 中声明 `outputStyles` 路径
