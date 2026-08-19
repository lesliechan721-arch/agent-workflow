# plugin.json 完整规范

`plugins/<name>/.agents-plugin/plugin.json` 是唯一需要手动维护的 manifest。运行时平台 manifest（`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`）和 marketplace manifest 由 `pnpm build` 生成，不要手改。所有插件的 bundle 都保留 `.agents-plugin/plugin.json`；平台 manifest 和 runtime 目录只在插件支持的平台上存在。

## 顶层字段

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `name` | string | 是 | 小写短横线格式，必须与目录名一致 |
| `version` | string | 是 | 严格 SemVer，例如 `0.1.0`；插件内容身份变化时必须递增 |
| `description` | string | 是 | 非空字符串 |
| `compatibility` | object | 是 | 目前只支持 `compatibility.aw.minVersion`，声明插件 artifact 需要的最低 `@lesliechan721/aw` CLI 版本；不要声明最低 Codex 或 Claude Code 版本 |
| `skills` | string | 否 | 单个路径，`./` 开头，指向 skills 目录 |
| `slashCommands` | string | 否 | 单个路径，`./` 开头，指向公共 slash command 源目录；首版只接受根目录直属 `*.md` 和保留 `assets/` |
| `mcpServers` | string | 否 | 单个路径，`./` 开头，指向 `.mcp.json` |
| `apps` | string | 否 | 单个路径，`./` 开头，指向 `.app.json` |
| `marketplace` | object | 是 | 见下方 marketplace block |
| `interface` | object | 否 | 见下方 interface block |
| `extensions` | object | 否 | 详见 `references/extensions-spec.md` |
| `buildConfig` | object | 否 | 详见 `references/build-config-spec.md` |
| `scripts` | object | 否 | AW 管理的 lifecycle、config helper、Node package 和测试入口声明 |
| `config` | object | 否 | AW 自管配置 schema，供 `aw config`、lifecycle context 和标准 helper 使用 |
| `artifacts` | object | 否 | 动态 artifact 静态能力声明，用于 Codex/Claude Skill、developer instructions 和 agent role |

不允许出现上表以外的顶层字段。
插件 manifest 不支持 `dependencies`；每个插件必须独立声明自己的平台能力。

## version / compatibility block

AW 版本管理里有三套身份，不能混用：

- CLI version：`@lesliechan721/aw` 自身的版本，代表命令和运行时能力。
- Source snapshot version：schema 3 `catalog-manifest.json` 的版本，代表一次 source 快照。
- Plugin version：单个插件 manifest 的 `version`，代表该插件 artifact 的不可变身份。

插件更新通过 schema 3 source snapshot 分发，不要求同步发布 CLI。`pnpm build` 在 `packages/cli/plugins-dist/` 生成可验证的本地 schema 3 snapshot；开发态 snapshot version 使用 CLI package version。`make stage-catalog CATALOG_VERSION=<version>` 在 `.release/catalog-staging/catalog/` 生成带 release ledger 的发布交接目录。Phase 4B Git publisher 尚未实现；不要在插件脚本或文档中假设 remote refs、tags 或 push 已可用。

最小示例：

```json
{
  "name": "code-review",
  "version": "0.2.0",
  "compatibility": {
    "aw": {
      "minVersion": "0.8.0"
    }
  }
}
```

规则：

- 源码 `version` 必须是没有 prerelease 或 build metadata 的稳定 SemVer；`compatibility.aw.minVersion` 必须是严格 SemVer。不能写 `v1.2.3`、`1.2`、`latest`、`^1.2.3` 或其它宽松写法。
- 插件 manifest 不声明 per-plugin 宿主 agent 版本。Codex `>= 0.145.0`、Claude Code `>= 2.1.88` 是 AW CLI 内置写命令门槛，作者不需要添加 `compatibility.codex`、`compatibility.claude`、`minimumCodexVersion` 或类似字段。
- 插件最低 CLI 版本不能高于 catalog 级 `compatibility.aw.minVersion`。catalog 级门槛是整包门槛，必须覆盖包内所有插件的真实运行时要求。
- schema 3 snapshot 中每个插件都必须提供 `artifactDigest`、`manifestDigest` 和 `contentDigest`，并声明不高于 snapshot 级门槛的最低 CLI 版本。作者改变 manifest、runtime 文件、脚本、静态资源、最低 CLI 版本或平台能力时，应发布新的插件 `version`。

作者版本门禁：

```bash
node .agents/skills/create-aw-plugin/scripts/check_plugin_versions.mjs \
  --all --base <git-ref>
```

新插件保留 manifest 中的初始稳定 version，脚手架默认使用 `0.1.0`。已有插件的 production bundle 变化时，作者在同一改动中直接提高 manifest version，并按兼容性影响选择 major、minor 或 patch。源码 manifest 是目标稳定版本的唯一真值；不使用独立 change 文件、聚合步骤或版本写入脚本。build metadata 不提高 SemVer precedence，因此源码 version 禁止 prerelease 和 build metadata。

`check_plugin_versions.mjs` 用当前已构建 CLI 的 staging bundler 分别物化 Git 基线插件和工作树插件，再忽略 plugin version 字段本身比较 production bundle。production 变化但 version 未提高、版本下降或 SemVer precedence 未提高时失败；只有 version 提高时成功并警告。Skill `evals/**`、插件 `reports/**` 和 test-only 文件由 bundler 排除；随 bundle 发布的 README、Skill、manifest 和 runtime 脚本变化要求提高 version。JSON 输出使用 schema 2。该门禁只判断插件源码变化，不判断 CLI bundler 自身变化造成的产物差异。

`contentDigest` 排除生成 manifest 的 version 字段，用于核对插件内容身份。schema 3 snapshot、release staging 和源码 manifest 是当前已锁定的作者边界；不要提前实现 Phase 4B publisher、remote refs、tags 或 push。

## scripts / config block

`scripts`、`config` 和 `artifacts` 是 AW CLI 自己管理的插件运行时合同，不会写入 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。插件脚本测试通过仓库包脚本 `pnpm plugin:test <plugin>` 运行，不通过 `aw` 客户端子命令。

作者期模型评估不增加 plugin manifest 顶层字段。每个 owner Skill 使用 `skills/<skill>/evals/manifest.json`，由 `pnpm plugin:eval <plugin> --skill <skill> --batch-name <name>` 读取；Skill 根 `evals/**` 和插件根 `reports/**` 不进入 production runtime bundle。完整 schema、Codex-only 范围、临时批次、正式报告和 materialization 规则见 `references/skill-evaluation.md`。

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
- 标准 helper 有 `AW_PLUGIN_CONTEXT` 时读取 context 中的 source identity、`config.values`、`config.sources`、`config.schema` 和 `paths.configStores`；没有 context 时必须从 `<AW_HOME>/marketplaces/<sourceId>/config.json` 验证 schema 2 source identity，再读取 namespaced schema 2 config envelope。helper 找不到或不能验证 bundle、marketplace identity 或 config envelope 时必须失败，不能回退到裸 plugin name、current catalog 或 schema-less raw store。
- lifecycle 事件只支持 `install`、`upgrade`、`uninstall`；脚本路径必须在插件根内。字符串简写等价于 `{ "default": { "runner": "auto", "path": "./..." } }`，结构化声明支持 `default`、`unix`、`windows`、`linux`、`darwin`、`win32`。解析顺序为 Linux: `linux -> unix -> default`，macOS: `darwin -> unix -> default`，Windows: `win32 -> windows -> default`。
- lifecycle runner 支持 `node`、`sh`、`bash`、`pwsh`、`powershell`、`cmd`、`auto`。`auto` 按扩展名解析：`.js` / `.mjs` / `.cjs` 为 Node，`.sh` 为 `sh`，`.ps1` 为 PowerShell，`.cmd` / `.bat` 为 Windows cmd。首版不支持内联 shell 命令；Windows lifecycle 请提供 Node 入口或 `.ps1` / `.cmd`。
- `scripts.timeoutMs` 是脚本默认超时，单位毫秒，合法范围 `1000..300000`，默认 `30000`。`aw install` / `aw upgrade` / `aw uninstall --script-timeout <ms>` 可覆盖 manifest 值。
- `scripts.node.packageRoot` 声明第三方 Node 依赖时，目录内必须提交 `package.json` 和 `pnpm-lock.yaml`。依赖 specifier 必须来自 registry，不支持 `workspace:`、`file:`、`link:`、`portal:`、本地路径、git/GitHub shortcut、HTTP(S) URL 或 tarball URL；也不支持把 `optionalDependencies` / `bundledDependencies` 当作 runtime 依赖入口。
- `scripts.node.build` 是唯一支持的 manifest build 入口，格式为 `{ "runner": "node", "path": "./...", "args": [] }`。build 在隔离 staging 目录运行，允许改写 staging manifest 和 packageRoot；build 后 staging manifest 是发布真值，源码树不会被修改。`package.json` scripts、`preinstall`、`postinstall`、`prepare` 等 npm lifecycle 不会被 AW 自动执行。
- `scripts.artifacts.render` 是动态 artifact renderer 入口，格式为 `{ "runner": "node", "path": "./...", "args": [] }`。首版只支持 Node runner，路径必须在插件根内。renderer stdout 必须是 JSON `ArtifactPlan`；stderr 只作为诊断摘要。
- 发布 bundle 只复制 lifecycle/helper 入口、这些 Node 入口可静态识别的相对依赖闭包，以及 `scripts.node.packageRoot` 的 production 依赖。运行时安装/升级/卸载离线执行，不联网安装依赖，也不借用宿主或仓库根 `node_modules`。
- `scripts.tests.node` 是开发期 Node 测试 glob，只由 `pnpm plugin:test` 使用。无匹配测试时是 skipped/no-op；test-only helper 可通过静态相对 import/require 递归复制到临时 bundle，但不会进入发布 runtime bundle。
- `config.schema` 是 AW config 的唯一真值。`string`、`number`、`boolean`、`enum`、`file`、`directory` 为首版支持类型；字段可声明 `title`、`description`、`default`、`required`、`sensitive`，`enum` 用 `values`，`number` 可用 `min` / `max`。未知 key 不进入 helper、lifecycle context 或 effective config，只能作为脱敏诊断出现。
- `file` / `directory` 配置值写入时按 AW project root 解析相对路径，并以 canonical absolute realpath 落盘；每次读取本机 effective config 都会重校验路径存在且类型正确。这类 key 不能写入 project shared config，也不能成为 project-scope repo-visible artifact 的 render config、digest、stale 判断或 refresh 输入；需要本机路径时用 user store 或 `--scope project --local`。
- AW config 分 user store、project shared store 和 project local store。路径固定为 `plugin-config/<sourceId>/<pluginName>/config.json` 或 `plugin-config.local/<sourceId>/<pluginName>/config.json`，内容是绑定 `sourceId`、`sourceIdentity` 和 `pluginName` 的 schema 2 envelope。配置只由 `aw config set/unset/reset` 管理，写命令不删除配置。

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

`artifacts.targets` 声明动态 artifact 的安装前能力真值。rebuild、status 和 ownership inspection 都读这个静态声明，不能等 renderer 执行后再推断插件能力。

最小示例：

```json
{
  "marketplace": {
    "category": "workflow",
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "ON_INSTALL",
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
      "explorerModel": { "type": "string", "default": "gpt-5.6-terra" },
      "modelReasoningEffort": {
        "type": "enum",
        "values": ["low", "medium", "high", "xhigh", "max"],
        "default": "low"
      }
    }
  },
  "artifacts": {
    "targets": [
      {
        "id": "codex-explore-skill",
        "platform": "codex",
        "scopes": ["user", "project"],
        "target": "codex.skill",
        "kind": "skill",
        "projectManagedKind": "skill",
        "states": ["present"],
        "refreshKeys": ["explorerModel", "modelReasoningEffort"],
        "skillKey": "codex-explore",
        "sourceDirs": ["./skills/codex-explore"]
      }
    ]
  }
}
```

字段规则：

- `id + target` 在同一插件内必须唯一，`id` 只能使用字母、数字、`.`、`_`、`-`，并以字母开头。
- `platform` 支持 `codex`、`claude`；`scopes` 只能包含 `user`、`project`。
- `target` 支持 `codex.skill`、`claude.skill`、`codex.developerInstructionsBlock` 和 `codex.agentRole`。`claude.skill` 只能配 `platform: "claude"`；其它 target 只能配 `platform: "codex"`。
- `states` 支持 `present`、`disabled`。renderer 当前 platform/scope 已声明的 artifact 必须返回其中一种状态，不能漏返回。
- `refreshKeys` 必须全部存在于 `config.schema`。config 写命令只有命中这些 key 时才刷新对应 artifact。
- 配置写入后，AW 对当前可见 target 运行完整 reinstall。`config set/unset/reset --json` 返回 receipt schema 4、canonical `sourceId/pluginName` 和各 target 的 reinstall 结果。
- 对包含 `project` scope 的 repo-visible dynamic artifact，`refreshKeys` 不能引用 `file` / `directory` 类型配置。project artifact render config 只来自 manifest default 和 project shared config 中可共享的非路径 key；user store、project local store 和路径型 key 只影响本机 effective config、lifecycle 或 helper。
- `requiresCodexProjectConfig: true` 表示 project scope 写路径需要进入 Codex project config safety preflight。`codex.skill` 不需要该字段，因为它写 `.agents/skills/<skillKey>`，不依赖 `.codex/config.toml`。
- `codex.skill` 和 `claude.skill` 必须静态声明合法 `skillKey`，并可声明 `sourceDirs`。每个 source directory 必须是插件内存在的 `./` 相对目录，不能重复。声明 source 时必须包含规范根 `./skills/<skillKey>`；其它 source 只能位于该根内，且不能进入 Skill 根的直接子目录 `evals/` 或 `reports/`。更深层的同名领域目录不是作者专用目录。AW 按数组顺序合并完整目录；后面的源覆盖前面的同名文件。静态文件按字节复制，符号链接和非普通文件失败。最终动态 Skill 必须保留非空 `README.md`。
- Skill artifact 的 V2 `present` content 只能包含 `files`。`files` 是 POSIX 相对路径到 UTF-8 字符串的映射，并在所有 `sourceDirs` 之后覆盖同名文件。path 不能是绝对路径，不能含反斜杠、`.`、`..`，也不能产生文件/目录前缀冲突。
- 最终 `codex.skill` 必须包含 `SKILL.md` 和 `agents/openai.yaml`，且 `policy.allow_implicit_invocation` 必须是 boolean。project target 的 `projectManagedKind` 必须是 `skill`，且不需要 `requiresCodexProjectConfig`。最终 `claude.skill` 必须包含带合法 YAML frontmatter 的 `SKILL.md`；`disable-model-invocation` 和 `user-invocable` 出现时必须使用目标 profile 支持的原生 boolean token，具体类型、值和大小写规则见 `references/skill-frontmatter-capabilities.generated.md`。推荐使用规范 YAML boolean `true` / `false`。AW 校验并原样写入这些原生字段。Claude target 不接受 `projectManagedKind` 或 `requiresCodexProjectConfig`。
- `codex.developerInstructionsBlock` 的 `projectManagedKind` 必须是 `instruction`，renderer `present` content 是 instruction 字符串。一个插件可以声明多个 instruction artifact；AW 会按 `artifact.id` 稳定排序后合成为同一个 managed block。`disabled` 只省略该 artifact 的 fragment；只有同一插件没有任何 present instruction artifact 时，AW 才移除或跳过 managed block。
- `codex.agentRole` 的 `projectManagedKind` 必须是 `agent`，且必须静态声明合法 `roleKey`。renderer plan 里的 `roleKey` 和 `roleFile.name` 必须与静态 metadata 完全一致；`registration.config_file` 由 AW 生成，renderer 不能提供。

`ArtifactPlan` 顶层固定为 `{ "version": 2, "artifacts": [...] }`。renderer 只能返回 plan，不能直接写平台 Skill 目录、Codex config 或其它 AW 受管文件。

status 和控制台直接检查 live ownership。写动作必须先明确 platform、scope 和 project root。

## 路径约定

- `skills`、`slashCommands`、`mcpServers`、`apps` 只能写成单个字符串路径，不能写数组或对象。
- 路径必须以 `./` 开头，不能是绝对路径，不能逃出插件根目录。
- `skills/` 是所有静态和动态 Skill 的固定源码根。manifest `skills` 字段只声明静态 Skill 集合；仅含动态 Skill 的插件可以省略该字段。混合插件声明静态集合时，同一平台的动态 `skillKey` 不会再作为静态 Skill 打包。
- 插件目录里出现其它标准入口文件时必须声明对应字段：有 `slash-commands/` → 声明 `slashCommands`，有 `.mcp.json` → 声明 `mcpServers`，有 `.app.json` → 声明 `apps`。
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
    short_description: "显式启动代码审查、证据核验、风险分级与可执行报告生成工作流"
    icon_small: ./assets/review-16.svg
    icon_large: ./assets/review-64.svg
    brand_color: "#2563EB"
    default_prompt: "使用 $review 审查当前改动。"
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
- Codex block 只允许 `description` 和 `interface`。`interface` 可写 `display_name`、`short_description`、`icon_small`、`icon_large`、`brand_color`、`default_prompt`。`default_prompt` 是用户/UI 起手句，必须包含 `$command-name`，不是 generated skill 的正文。
- `codex.interface.icon_small` / `icon_large` 只能写 `./assets/...`；源文件必须位于 `slashCommands` 根目录下的 `assets/`，不能是绝对路径、`../`、反斜杠、其它目录或非普通文件。build 只复制被引用资源到对应 generated skill 的 `assets/`。
- Codex generated skill 固定 manual-only：`policy.allow_implicit_invocation: false`。`codex.policy` 不可配置，写了会失败。
- Codex 渲染结果不能残留 `$ARGUMENTS`、`$1`、`` !`command` `` 或 ```! 这类 Claude-only 参数 / 命令结果填充语法；这项校验只在插件支持 Codex、需要生成 Codex manual-only skill 时执行。需要差异内容时，用 `buildConfig.templates` 按平台渲染。

构建后只为支持平台生成命令产物。Codex project scope 会把 generated skill 复制到当前仓库 `.agents/skills/<name>`，并写入 AW ownership marker。

## Skill 原生调用元数据

平台原生元数据是唯一真值。Skill 的调用行为不在插件 manifest 中重复声明，也不由 AW 配置覆盖：

- Codex 使用 `skills/<skill>/agents/openai.yaml` 的 `policy.allow_implicit_invocation`。
- Claude Code 使用 `skills/<skill>/SKILL.md` frontmatter 的 `disable-model-invocation` 与 `user-invocable`。

面向 Codex 的静态或动态 Skill 必须提供 `agents/openai.yaml`，并把 `policy.allow_implicit_invocation` 写成 boolean。Claude 字段出现时必须使用目标 profile 支持的原生 boolean token；推荐写规范 YAML boolean `true` / `false`，其它可接受值见 `references/skill-frontmatter-capabilities.generated.md`。AW 在 build、materialization、安装、升级和配置刷新中校验并保留这些字段，不改变其值。显式调用仍按平台原生规则工作。

公共 `slashCommands` 生成的 Codex 入口 Skill 固定写入 `policy.allow_implicit_invocation: false`，因为它本身是显式命令入口。要改变其它 Skill 的调用行为，作者必须修改 Skill 源码或动态 renderer 输出，并发布新的插件版本。

## marketplace block

插件条目元数据，写在 `.agents-plugin/plugin.json` 的 `marketplace` 字段：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `category` | string | 是 | 非空，例如 `workflow`、`productivity` |
| `tags` | string[] | 否 | 搜索标签，会 trim、去空、去重 |
| `strict` | boolean | 是 | 是否要求 plugin.json 存在 |
| `policy.installation` | string | 是 | `"AVAILABLE"` 或 `"NOT_AVAILABLE"` 或 `"INSTALLED_BY_DEFAULT"` |
| `policy.authentication` | string | 是 | `"ON_INSTALL"` 或 `"ON_USE"` |
| `policy.products` | string[] | 否 | 产品限制，例如 `["CODEX"]` 或 `["CLAUDE"]`，会 trim、去空、去重 |

### policy 字段说明

- `installation`：
  - `"AVAILABLE"`：用户可在 marketplace 中发现和安装
  - `"NOT_AVAILABLE"`：不在 marketplace 中显示
  - `"INSTALLED_BY_DEFAULT"`：默认安装
- `authentication`：
  - `"ON_INSTALL"`：安装时认证
  - `"ON_USE"`：使用时认证
- `products`：省略或空数组时表示同时支持 Claude 和 Codex；声明后只支持指定产品。这个字段不只是安装门禁，还参与 `pnpm build` 的 platform manifest/runtime 裁剪、平台 marketplace entries 过滤和 `pnpm plugin:test` 平台选择。`aw install` / 显式 `aw upgrade` 会拦截不匹配的平台；写入口必须显式传 `--platform codex|claude|both`。脚手架默认省略该字段，让插件保持双平台；只有明确要限制平台时才添加。

Codex scope 对作者的影响：

- `--scope user` 走 Codex native plugin 平面。primary source 的本地 marketplace 名为 `aw`，secondary source 固定为 `aw-<sourceId>`。AW 用 native marketplace/plugin 命令管理原生状态；`aw status` 直接检查 live 原生状态。
- `--scope project` 只写 repo-managed artifacts，不调用 Codex native CLI / app-server RPC，不写用户级 `[marketplaces]` 或 `[plugins]`；写入前仍要求本机 Codex `>= 0.145.0`。
- `apps` 是 Codex 能力，`products=["CLAUDE"] + apps` 是矛盾配置，会在 manifest/build 校验时报错。
- 纯 native-only 插件不能以 Codex project scope 安装；声明 `apps` 的插件在 Codex project scope 会 fail fast。若希望插件可提交到仓库，请提供 skills、MCP、slashCommands、extensions 这类 repo-managed surface，或把 app/native-only 能力拆到 user-scope 插件。

CLI 入口和输出对作者的影响：

- `aw` 主命令是唯一交互入口；配置向导只存在于主控制台。脚本化配置请使用 `aw config set/unset/reset`，读配置使用 `aw config list/get`；不要把 `aw config configure` 写进 README、测试或脚本。
- 子命令面向脚本调用；写命令加 `--json` 时 stdout 是单一 JSON receipt，默认输出只展示友好完成状态和下一步。需要诊断时使用 `--verbose`、`--debug` 或 `status --json`。
- 旧恢复命令和旧 cleanup flags 已移除。检查 live 输出使用 `aw status`；清理 AW-owned 输出使用 `aw cleanup`；按当前 multi-source resolution 删除后重建使用 `aw reinstall`。
- 插件 README、示例和测试断言不要依赖默认输出里的内部词，也不要把默认输出当机器协议解析。

## interface block

只放展示信息，不是运行时能力开关：

| 子字段 | 类型 | 说明 |
|--------|------|------|
| `displayName` | string | 人类可读插件名 |
| `shortDescription` | string | 简短描述 |
| `capabilities` | string[] | 能力标签，例如 `["Skills"]`、`["Skills", "MCP Servers"]` |

`capabilities` 仅用于 UI 展示，不影响运行时行为。常用值：`Skills`、`MCP Servers`、`Apps`。

## marketplace-source.json

`plugins/marketplace-source.json` 是 marketplace 根级构建输入，只接受 `owner` 和 `interface.displayName`。它不是运行时 source identity。创建单个插件时通常不要改它。

`pnpm build` 会把根级元数据和各插件的 marketplace 条目合成两份本地 runtime marketplace manifest：`.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json`。两份 marketplace 共享根级元数据，但 entries 按插件最终支持平台过滤；Claude marketplace 不包含 Codex-only 插件，Codex marketplace 不包含 Claude-only 插件。schema 3 manifest 必须从完整 build bundle 重建插件清单，不能把某个平台 marketplace 当作全部插件清单。

## 分发模型

```text
源码层（作者维护）
  plugins/<name>/.agents-plugin/plugin.json + 关联文件
           │
           │  pnpm build
           ▼
本地 schema 3 snapshot（当前生成产物，不手改）
  catalog-manifest.json              schema 3；开发版本使用 CLI package version
  .agents/
  .claude-plugin/
  plugins/<name>/
  ├── .agents-plugin/plugin.json     源 manifest 副本
  ├── .claude-plugin/plugin.json     支持 Claude 时存在
  ├── .codex-plugin/plugin.json      支持 Codex 时存在
  ├── claude/                        支持 Claude 时存在
  └── codex/                         支持 Codex 时存在
           │
           │  make stage-catalog CATALOG_VERSION=<version>
           ▼
发布 staging（`.release/catalog-staging/catalog/`）
  catalog-manifest.json              schema 3；使用显式发布版本
  plugin-release-ledger.json
  .agents/ + .claude-plugin/ + plugins/<name>/
           │
           │  Phase 4B Git publisher（尚未实现）
           ▼
Git catalog source
           │
           │  path/Git source resolution
           ▼
本地 AW runtime
  <AW_HOME>/catalog-cache/<sourceId>/...
  <AW_HOME>/marketplaces/<sourceId>/...
  <AW_HOME>/plugin-config/<sourceId>/<pluginName>/config.json
```

这些层各有职责。当前可验证真值止于本地 schema 3 snapshot 和 release staging。Phase 4B publisher 尚未实现，作者工具不得声称 remote refs、tags 或 push 已可用，也不得把旧 npm catalog、registry sidecar 或 full catalog tarball 当作分发真值。

project shared config 位于 `.agent-workflows/plugin-config/<sourceId>/<pluginName>/config.json`，可提交；project local 使用 `.agent-workflows/plugin-config.local/<sourceId>/<pluginName>/config.json`，默认应被 ignore。两者都使用 schema 2 source envelope。平台输出通过 owner schema 2 marker 保存 `sourceId` 和 qualified plugin identity。

## 禁止手改的文件

- 仓库根目录 `.claude-plugin/marketplace.json`
- 仓库根目录 `.agents/plugins/marketplace.json`
- `plugins/<name>/.claude-plugin/plugin.json`
- `plugins/<name>/.codex-plugin/plugin.json`
- catalog staging / `packages/cli/plugins-dist/**`
- `~/.aw/**`

## 最小 manifest 示例

只有 extensions 的插件（无 skill、无 MCP）：

```json
{
  "name": "coding-standards",
  "version": "0.1.0",
  "compatibility": {
    "aw": {
      "minVersion": "0.8.0"
    }
  },
  "description": "统一项目的编码规范和权限策略。",
  "marketplace": {
    "category": "workflow",
    "strict": true,
    "policy": {
      "installation": "AVAILABLE",
      "authentication": "ON_INSTALL"
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
  "compatibility": {
    "aw": {
      "minVersion": "0.8.0"
    }
  },
  "description": "自动化代码审查插件。",
  "skills": "./skills",
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
