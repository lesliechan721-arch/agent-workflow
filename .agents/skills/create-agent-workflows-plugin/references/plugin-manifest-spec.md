# plugin.json 完整规范

`plugins/<name>/.agents-plugin/plugin.json` 是唯一需要手动维护的 manifest。运行时平台 manifest（`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`）和 marketplace manifest 由 `pnpm build` 生成，不要手改。所有插件的 bundle 都保留 `.agents-plugin/plugin.json`；平台 manifest 和 runtime 目录只在插件支持的平台上存在。

## 顶层字段

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `name` | string | 是 | 小写短横线格式，必须与目录名一致 |
| `version` | string | 是 | semver，例如 `0.1.0` |
| `description` | string | 是 | 非空字符串 |
| `skills` | string | 否 | 单个路径，`./` 开头，指向 skills 目录 |
| `slashCommands` | string | 否 | 单个路径，`./` 开头，指向公共 slash command 源目录；首版只接受根目录直属 `*.md` 和保留 `assets/` |
| `skillTriggers` | object | 否 | 按 skill 声明是否允许安装时覆盖触发策略 |
| `mcpServers` | string | 否 | 单个路径，`./` 开头，指向 `.mcp.json` |
| `apps` | string | 否 | 单个路径，`./` 开头，指向 `.app.json` |
| `marketplace` | object | 是 | 见下方 marketplace block |
| `interface` | object | 否 | 见下方 interface block |
| `extensions` | object | 否 | 详见 `references/extensions-spec.md` |
| `buildConfig` | object | 否 | 详见 `references/build-config-spec.md` |
| `scripts` | object | 否 | AW 管理的 lifecycle、config helper、Node package 和测试入口声明 |
| `config` | object | 否 | AW 自管配置 schema，供 `aw config`、lifecycle context 和标准 helper 使用 |
| `artifacts` | object | 否 | 动态 artifact 静态能力声明，首版用于 Codex developer instructions / agent role |

不允许出现上表以外的顶层字段。

## scripts / config block

`scripts`、`config` 和 `artifacts` 是 AW CLI 自己管理的插件运行时合同，不会写入 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。插件脚本测试通过仓库包脚本 `pnpm plugin:test <plugin>` 运行，不通过 `aw` 客户端子命令。

本节只定义 manifest 字段合同。`aw config` 命令、标准 `aw-config.mjs` helper、lifecycle context、动态 artifact renderer、运行时环境、幂等要求和 `pnpm plugin:test` 写法见 `references/aw-scripts-config-lifecycle.md`。

最小配置 helper 示例：

```json
{
  "scripts": {
    "helpers": {
      "config": "./scripts/aw-config.mjs"
    },
    "tests": {
      "node": ["./scripts/**/*.test.mjs"]
    }
  },
  "config": {
    "schema": {
      "apiKey": {
        "type": "string",
        "required": true,
        "sensitive": true
      }
    }
  }
}
```

规则：

- `scripts.helpers.config` 必须显式声明，且指向插件内 Node 可运行文件（`.js` / `.mjs` / `.cjs`）；CLI 不会按固定文件名隐式扫描 `./scripts/aw-config.mjs`。
- 标准 helper 有 `AW_PLUGIN_CONTEXT` 时读取 context 中的 `config.values`、`config.sources`、`config.schema` 和 `paths.configStores`；没有 context 时只读取当前 bundle 邻近的 `.agents-plugin/plugin.json`，再按该 schema/default/redaction 读取 AW config store。这个 bundle 视图可能和 `aw config get/list` 的 current catalog 视图短暂不同；helper 找不到 bundle manifest 时必须失败，不能回退到 schema-less raw store。
- lifecycle 事件只支持 `install`、`upgrade`、`uninstall`；脚本路径必须在插件根内。字符串简写等价于 `{ "default": { "runner": "auto", "path": "./..." } }`，结构化声明支持 `default`、`unix`、`windows`、`linux`、`darwin`、`win32`。解析顺序为 Linux: `linux -> unix -> default`，macOS: `darwin -> unix -> default`，Windows: `win32 -> windows -> default`。
- lifecycle runner 支持 `node`、`sh`、`bash`、`pwsh`、`powershell`、`cmd`、`auto`。`auto` 按扩展名解析：`.js` / `.mjs` / `.cjs` 为 Node，`.sh` 为 `sh`，`.ps1` 为 PowerShell，`.cmd` / `.bat` 为 Windows cmd。首版不支持内联 shell 命令；Windows lifecycle 请提供 Node 入口或 `.ps1` / `.cmd`。
- `scripts.timeoutMs` 是脚本默认超时，单位毫秒，合法范围 `1000..300000`，默认 `30000`。`aw install` / `aw upgrade` / `aw uninstall --script-timeout <ms>` 可覆盖 manifest 值。
- `scripts.node.packageRoot` 声明第三方 Node 依赖时，目录内必须提交 `package.json` 和 `pnpm-lock.yaml`。依赖 specifier 必须来自 registry，不支持 `workspace:`、`file:`、`link:`、`portal:`、本地路径、git/GitHub shortcut、HTTP(S) URL 或 tarball URL；也不支持把 `optionalDependencies` / `bundledDependencies` 当作 runtime 依赖入口。
- `scripts.node.build` 是唯一支持的 manifest build 入口，格式为 `{ "runner": "node", "path": "./...", "args": [] }`。build 在隔离 staging 目录运行，允许改写 staging manifest 和 packageRoot；build 后 staging manifest 是发布真值，源码树不会被修改。`package.json` scripts、`preinstall`、`postinstall`、`prepare` 等 npm lifecycle 不会被 AW 自动执行。
- `scripts.artifacts.render` 是动态 artifact renderer 入口，格式为 `{ "runner": "node", "path": "./...", "args": [] }`。首版只支持 Node runner，路径必须在插件根内。renderer stdout 必须是 JSON `ArtifactPlan`；stderr 只作为诊断摘要。
- 发布 bundle 只复制 lifecycle/helper 入口、这些 Node 入口可静态识别的相对依赖闭包，以及 `scripts.node.packageRoot` 的 production 依赖。运行时安装/升级/卸载离线执行，不联网安装依赖，也不借用宿主或仓库根 `node_modules`。
- `scripts.tests.node` 是开发期 Node 测试 glob，只由 `pnpm plugin:test` 使用。无匹配测试时是 skipped/no-op；test-only helper 可通过静态相对 import/require 递归复制到临时 bundle，但不会进入发布 runtime bundle。
- `config.schema` 是 AW config 的唯一真值。`string`、`number`、`boolean`、`enum`、`file`、`directory` 为首版支持类型；字段可声明 `title`、`description`、`default`、`required`、`sensitive`，`enum` 用 `values`，`number` 可用 `min` / `max`。未知 key 不进入 helper、lifecycle context 或 effective config，只能作为脱敏诊断出现。
- `file` / `directory` 配置值写入时按 AW project root 解析相对路径，并以 canonical absolute realpath 落盘；每次读取 effective config 都会重校验路径存在且类型正确。
- AW config 分 `user` 和 `project` store，effective 读取顺序是 manifest default < user < project。配置可先于安装写入；`aw uninstall` 默认保留配置，清理用 `aw config reset <plugin>`。

完整 lifecycle + config 示例：

```json
{
  "scripts": {
    "timeoutMs": 30000,
    "lifecycle": {
      "install": "./scripts/lifecycle.mjs",
      "upgrade": {
        "default": { "runner": "node", "path": "./scripts/lifecycle.mjs" }
      },
      "uninstall": {
        "unix": { "runner": "sh", "path": "./scripts/uninstall.sh" },
        "windows": { "runner": "powershell", "path": "./scripts/uninstall.ps1" }
      }
    },
    "helpers": {
      "config": "./scripts/aw-config.mjs"
    },
    "node": {
      "packageRoot": "./scripts",
      "build": {
        "runner": "node",
        "path": "./scripts/build.mjs",
        "args": []
      }
    },
    "tests": {
      "node": ["./scripts/**/*.test.mjs"]
    }
  },
  "config": {
    "schema": {
      "apiKey": {
        "type": "string",
        "title": "API key",
        "required": true,
        "sensitive": true
      },
      "workspaceDir": {
        "type": "directory",
        "description": "Directory used by lifecycle scripts"
      }
    }
  }
}
```

## artifacts.targets block

`artifacts.targets` 声明动态 artifact 的安装前能力真值。installability、discovery、status current catalog、Codex project write safety preflight 和 ledger capability snapshot 都读这个静态声明，不能等 renderer 执行后再推断插件能力。首版 target 只支持 Codex，因此声明动态 target 的插件必须支持 Codex；可以是 `products=["CODEX"]` 的 Codex-only 插件，也可以是省略 `products` 或显式声明双产品的双平台插件。Claude-only 插件声明任何 `artifacts.targets` 都会失败。

最小示例：

```json
{
  "marketplace": {
    "category": "workflow",
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "NONE",
      "products": ["CODEX"]
    }
  },
  "scripts": {
    "artifacts": {
      "render": {
        "runner": "node",
        "path": "./scripts/render-artifacts.mjs"
      }
    }
  },
  "config": {
    "schema": {
      "enableInstruction": { "type": "boolean", "default": true },
      "explorerModel": { "type": "string", "default": "gpt-5.4-mini" }
    }
  },
  "artifacts": {
    "targets": [
      {
        "id": "lightweight-instruction",
        "platform": "codex",
        "scopes": ["user", "project"],
        "target": "codex.developerInstructionsBlock",
        "projectManagedKind": "instruction",
        "states": ["present", "disabled"],
        "refreshKeys": ["enableInstruction", "explorerModel"],
        "requiresCodexProjectConfig": true
      },
      {
        "id": "codex-explorer-role",
        "platform": "codex",
        "scopes": ["user", "project"],
        "target": "codex.agentRole",
        "projectManagedKind": "agent",
        "states": ["present"],
        "refreshKeys": ["explorerModel"],
        "requiresCodexProjectConfig": true,
        "roleKey": "codex-explorer"
      }
    ]
  }
}
```

字段规则：

- `id + target` 在同一插件内必须唯一，`id` 只能使用字母、数字、`.`、`_`、`-`，并以字母开头。
- `platform` 首版只能是 `codex`；`scopes` 只能包含 `user`、`project`。
- `target` 首版支持 `codex.developerInstructionsBlock` 和 `codex.agentRole`。
- `states` 首版支持 `present`、`disabled`。renderer 当前 platform/scope 已声明的 artifact 必须返回其中一种状态，不能漏返回。
- `refreshKeys` 必须全部存在于 `config.schema`。config 写命令只有命中这些 key 时才刷新对应 artifact。
- `requiresCodexProjectConfig: true` 表示 project scope 写路径需要进入 Codex project write safety preflight。
- `codex.developerInstructionsBlock` 的 `projectManagedKind` 必须是 `instruction`，renderer `present` content 是 instruction 字符串。一个插件可以声明多个 instruction artifact；AW 会按 `artifact.id` 稳定排序后合成为同一个 managed block。`disabled` 只省略该 artifact 的 fragment；只有同一插件没有任何 present instruction artifact 时，AW 才移除或跳过 managed block。
- `codex.agentRole` 的 `projectManagedKind` 必须是 `agent`，且必须静态声明合法 `roleKey`。renderer plan 里的 `roleKey` 和 `roleFile.name` 必须与静态 metadata 完全一致；`registration.config_file` 由 AW 生成，renderer 不能提供。

`ArtifactPlan` 顶层固定为 `{ "version": 1, "artifacts": [...] }`。artifact 至少包含 `id`、`platform`、`target`、`kind`、`state`、`refreshKeys`；`disabled` 可带 `disabledReason: "config"` 并省略 content，`present` 必须按 target 提供 content。renderer 只能返回 plan，不能直接写 `.codex/config.toml`、`.codex/agents/*.toml`、`.agent-workflows-manifest.json`、ledger 或其它 AW 受管文件。

## 路径约定

- `skills`、`slashCommands`、`mcpServers`、`apps` 只能写成单个字符串路径，不能写数组或对象。
- 路径必须以 `./` 开头，不能是绝对路径，不能逃出插件根目录。
- 插件目录里出现标准入口文件时必须声明对应字段：有 `skills/` → 声明 `skills`，有 `slash-commands/` → 声明 `slashCommands`，有 `.mcp.json` → 声明 `mcpServers`，有 `.app.json` → 声明 `apps`。
- `slashCommands` 目录只能包含根目录直属 `*.md` 命令文件和保留 `assets/` 资源目录；`assets/` 下的 Markdown 不生成命令，其它子目录直接失败。
- 声明的路径必须实际存在，构建和验证时都会检查。

## slashCommands block

公共 `slashCommands` 是唯一的跨平台手动命令作者入口。

本节只记录 manifest 侧字段约束；命令文件格式、分平台 frontmatter、模板渲染和生成产物细节见 `references/slash-commands.md`。

目录示例：

```text
slash-commands/
├── review.md
└── assets/
    ├── review-16.svg
    └── review-64.svg
```

每个根目录直属 `*.md` 是一个命令，文件名就是命令名，必须使用小写短横线格式，最长 64 字符。首版不支持 `debug/start.md` 这类命名空间；`assets/` 是唯一允许的子目录，里面的 Markdown 不会生成命令。

命令文件必须包含 YAML frontmatter，顶层只允许 `description`、`claude`、`codex`：

```markdown
---
description: 执行代码审查
claude:
  description: 使用 Claude Code 工具执行代码审查。
  allowed-tools:
    - Bash
    - Read
  argument-hint: "[file-path]"
codex:
  description: 在 Codex 中手动执行代码审查工作流。
  interface:
    display_name: "Review Command"
    short_description: "手动代码审查命令"
    icon_small: ./assets/review-16.svg
    icon_large: ./assets/review-64.svg
    brand_color: "#2563EB"
    default_prompt: "Use $review to review current changes."
---

{{#if supportsCommands}}
如果用户传入 $ARGUMENTS，只审查指定路径。
{{/if}}
{{#unless supportsCommands}}
先询问用户审查范围，再继续。
{{/unless}}
```

字段规则：

- 顶层 `description` 必填。
- Claude block 可写 `description`、`allowed-tools`、`model`、`argument-hint`、`shell`；Claude-only 字段不能放在顶层。`shell` 只接受 `bash` 或 `powershell`。
- Codex block 只允许 `description` 和 `interface`。`interface` 可写 `display_name`、`short_description`、`icon_small`、`icon_large`、`brand_color`、`default_prompt`。
- `codex.interface.icon_small` / `icon_large` 只能写 `./assets/...`；源文件必须位于 `slashCommands` 根目录下的 `assets/`，不能是绝对路径、`../`、反斜杠、其它目录或非普通文件。build 只复制被引用资源到对应 generated skill 的 `assets/`。
- Codex generated skill 固定 manual-only：`policy.allow_implicit_invocation: false`。`codex.policy` 不可配置，写了会失败。
- Codex 渲染结果不能残留 `$ARGUMENTS`、`$1`、`` !`command` `` 或 ```! 这类 Claude-only 参数 / 命令结果填充语法；这项校验只在插件支持 Codex、需要生成 Codex manual-only skill 时执行。需要差异内容时，用 `buildConfig.templates` 按平台渲染。

构建后只为支持平台生成命令产物：支持 Claude 时得到 generated `claude/commands/<name>.md`；支持 Codex 时得到 generated `codex/skills/<name>/SKILL.md`、`agents/openai.yaml` 和被引用的 `assets/`。Codex project scope 安装这些命令时，会把 generated skill 复制到当前仓库 `.agents/skills/<name>`，仍按 `kind: "skill"` + `artifactKey: "<name>"` tracking。

## skillTriggers block

`skillTriggers` 是 agent-workflows 的安装时覆盖许可，不是平台默认触发策略。默认策略仍由 skill 文件自己定义：

- Codex：`skills/<skill>/agents/openai.yaml` 的 `policy.allow_implicit_invocation`
- Claude Code：`skills/<skill>/SKILL.md` frontmatter 的 `disable-model-invocation` 和 `user-invocable`

示例：

```json
{
  "skills": "./skills",
  "skillTriggers": {
    "review": {
      "allowInstallOverride": true
    }
  }
}
```

规则：

- 只有声明了 `skills` 的插件才能声明 `skillTriggers`。
- `skillTriggers` 的 key 必须对应 source `skills` 目录下真实存在的 skill 子目录。
- 每个 entry 只允许 `allowInstallOverride`，且必须是 boolean。
- `allowInstallOverride: true` 表示用户可用 `aw install --skill-trigger manual|auto|default` 或显式 `aw upgrade --skill-trigger ...` 覆盖该 skill 的本地 runtime 触发策略。
- `allowInstallOverride: false` 或省略 `skillTriggers` 表示安装时不可覆盖，始终使用 skill 默认策略。

## marketplace block

插件条目元数据，写在 `.agents-plugin/plugin.json` 的 `marketplace` 字段：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `category` | string | 是 | 非空，例如 `workflow`、`productivity` |
| `tags` | string[] | 否 | 搜索标签，会 trim、去空、去重 |
| `strict` | boolean | 是 | 是否要求 plugin.json 存在 |
| `policy.installation` | string | 是 | `"AVAILABLE"` 或 `"NOT_AVAILABLE"` 或 `"INSTALLED_BY_DEFAULT"` |
| `policy.authentication` | string | 是 | `"NONE"` 或 `"ON_INSTALL"` 或 `"ON_USE"` |
| `policy.products` | string[] | 否 | 产品限制，例如 `["CODEX"]` 或 `["CLAUDE"]`，会 trim、去空、去重 |

### policy 字段说明

- `installation`：
  - `"AVAILABLE"`：用户可在 marketplace 中发现和安装
  - `"NOT_AVAILABLE"`：不在 marketplace 中显示
  - `"INSTALLED_BY_DEFAULT"`：默认安装
- `authentication`：
  - `"NONE"`：无需认证
  - `"ON_INSTALL"`：安装时认证
  - `"ON_USE"`：使用时认证
- `products`：省略或空数组时表示同时支持 Claude 和 Codex；声明后只支持指定产品。这个字段不只是安装门禁，还参与 `pnpm build` 的 platform manifest/runtime 裁剪、平台 marketplace entries 过滤和 `pnpm plugin:test` 平台选择。`aw install` / 显式 `aw upgrade` 会拦截不匹配的平台，`--platform auto` 会先过滤不匹配的平台再推断目标。脚手架默认省略该字段，让插件保持双平台；只有明确要限制平台时才添加。

Codex scope 对作者的影响：

- `--scope user` 走 Codex native plugin 平面。AW 会注册本地 marketplace，并通过 `codex app-server` 的 `plugin/install` / `plugin/uninstall` RPC 让 Codex 写用户级 enabled config 和 materialized cache；没有只写 config 的 fallback。`aw status --json` 中 `native.pluginInstalled` 指 cache installed，`native.pluginEnabled` 指 config enabled。
- `--scope project` 只写 repo-managed artifacts，不调用 native marketplace add / app-server RPC，不写用户级 `[marketplaces]` 或 `[plugins]`。缺少 `codex` 可执行文件时，repo-managed project 安装仍可进行。
- `apps` 是 Codex 能力，`products=["CLAUDE"] + apps` 是矛盾配置，会在 manifest/build 校验时报错。
- 纯 native-only 插件不能以 Codex project scope 安装；声明 `apps` 的插件在 Codex project scope 会 fail fast。若希望插件可提交到仓库，请提供 skills、MCP、slashCommands、extensions 这类 repo-managed surface，或把 app/native-only 能力拆到 user-scope 插件。

## interface block

只放展示信息，不是运行时能力开关：

| 子字段 | 类型 | 说明 |
|--------|------|------|
| `displayName` | string | 人类可读插件名 |
| `shortDescription` | string | 简短描述 |
| `capabilities` | string[] | 能力标签，例如 `["Skills"]`、`["Skills", "MCP Servers"]` |

`capabilities` 仅用于 UI 展示，不影响运行时行为。常用值：`Skills`、`MCP Servers`、`Apps`。

## marketplace-source.json

`plugins/marketplace-source.json` 是 marketplace 根级构建输入，只接受 `owner` 和 `interface.displayName`。它不是运行时 marketplace manifest。创建单个插件时通常不要改它。

`pnpm build` 会把根级元数据和各插件的 marketplace 条目合成两份 runtime marketplace manifest：`.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json`。两份 marketplace 共享根级元数据，但 entries 按插件最终支持平台过滤；Claude marketplace 不包含 Codex-only 插件，Codex marketplace 不包含 Claude-only 插件。AW current catalog 仍扫描每个插件的 `.agents-plugin/plugin.json`，不会把某个平台 marketplace 当作全部插件清单。

## 三层分发模型

```text
源码层（作者维护）
  plugins/<name>/.agents-plugin/plugin.json + 关联文件
           │
           │  pnpm build（bundle-plugins.ts 打包）
           ▼
Embedded Runtime Bundle（npm 包内唯一运行时真值）
  packages/cli/plugins-dist/plugins/<name>/
  ├── .agents-plugin/plugin.json     源 manifest 副本
  ├── .claude-plugin/plugin.json     支持 Claude 时存在
  ├── .codex-plugin/plugin.json      支持 Codex 时存在
  ├── claude/                        支持 Claude 时存在
  └── codex/                         支持 Codex 时存在
           │
           │  aw init / 安装流程
           ▼
本地 Marketplace 镜像
  ~/.aw/                             含 installed.json 账本
```

三层各有职责，排查问题时先确认问题在哪一层。

## 禁止手改的文件

- 仓库根目录 `.claude-plugin/marketplace.json`
- 仓库根目录 `.agents/plugins/marketplace.json`
- `plugins/<name>/.claude-plugin/plugin.json`
- `plugins/<name>/.codex-plugin/plugin.json`
- `packages/cli/plugins-dist/**`
- `~/.aw/**`

## 最小 manifest 示例

只有 extensions 的插件（无 skill、无 MCP）：

```json
{
  "name": "coding-standards",
  "version": "0.1.0",
  "description": "统一项目的编码规范和权限策略。",
  "marketplace": {
    "category": "workflow",
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "NONE"
    }
  },
  "extensions": {
    "instructions": [
      {
        "name": "style-guide",
        "title": "编码风格",
        "content": "使用 TypeScript strict mode，2 空格缩进，文件名 kebab-case。"
      }
    ],
    "permissions": [
      {
        "name": "lint",
        "allow": ["npx eslint", "npx prettier"]
      }
    ]
  }
}
```

## 完整 manifest 示例

包含 skills、MCP 和 extensions 的插件：

```json
{
  "name": "code-review",
  "version": "0.2.0",
  "description": "自动化代码审查插件。",
  "skills": "./skills",
  "skillTriggers": {
    "review-workflow": {
      "allowInstallOverride": true
    }
  },
  "mcpServers": "./.mcp.json",
  "marketplace": {
    "category": "workflow",
    "tags": ["code-review", "quality"],
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "ON_INSTALL"
    }
  },
  "interface": {
    "displayName": "Code Review",
    "shortDescription": "自动化代码审查与质量报告",
    "capabilities": ["Skills", "MCP Servers"]
  },
  "slashCommands": "./slash-commands",
  "extensions": {
    "instructions": [],
    "permissions": [],
    "hooks": [],
    "nativeHooks": {
      "claude": [],
      "codex": []
    },
    "agents": []
  },
  "buildConfig": {
    "manifestOverrides": {
      "claude": { "outputStyles": "./output-styles" }
    }
  }
}
```

完整的 extensions 和 buildConfig 字段规范见各自的参考文档。
