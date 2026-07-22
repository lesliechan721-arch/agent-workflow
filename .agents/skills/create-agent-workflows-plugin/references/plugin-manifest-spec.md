# plugin.json 完整规范

`plugins/<name>/.agents-plugin/plugin.json` 是唯一需要手动维护的 manifest。运行时平台 manifest（`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`）和 marketplace manifest 由 `pnpm build` 生成，不要手改。所有插件的 bundle 都保留 `.agents-plugin/plugin.json`；平台 manifest 和 runtime 目录只在插件支持的平台上存在。

## 顶层字段

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `name` | string | 是 | 小写短横线格式，必须与目录名一致 |
| `version` | string | 是 | 严格 SemVer，例如 `0.1.0`；插件内容身份变化时必须递增 |
| `description` | string | 是 | 非空字符串 |
| `compatibility` | object | 是 | 目前只支持 `compatibility.aw.minVersion`，声明插件 artifact 需要的最低 `@yiliang/aw` CLI 版本；不要声明最低 Codex 或 Claude Code 版本 |
| `skills` | string | 否 | 单个路径，`./` 开头，指向 skills 目录 |
| `slashCommands` | string | 否 | 单个路径，`./` 开头，指向公共 slash command 源目录；首版只接受根目录直属 `*.md` 和保留 `assets/` |
| `skillTriggers` | object | 否 | 按 skill 声明是否允许安装时覆盖触发策略 |
| `mcpServers` | string | 否 | 单个路径，`./` 开头，指向 `.mcp.json` |
| `apps` | string | 否 | 单个路径，`./` 开头，指向 `.app.json` |
| `marketplace` | object | 是 | 见下方 marketplace block |
| `interface` | object | 否 | 见下方 interface block |
| `dependencies` | object | 否 | AW 自管插件依赖声明，只允许 `dependencies.plugins` |
| `extensions` | object | 否 | 详见 `references/extensions-spec.md` |
| `buildConfig` | object | 否 | 详见 `references/build-config-spec.md` |
| `scripts` | object | 否 | AW 管理的 lifecycle、config helper、Node package 和测试入口声明 |
| `config` | object | 否 | AW 自管配置 schema，供 `aw config`、lifecycle context 和标准 helper 使用 |
| `artifacts` | object | 否 | 动态 artifact 静态能力声明，用于 Codex skill / developer instructions / agent role |

不允许出现上表以外的顶层字段。

## version / compatibility block

AW 版本管理里有三套身份，不能混用：

- CLI version：`@yiliang/aw` 自身的版本，代表命令和运行时能力。
- Catalog version：`@yiliang/aw-plugins-manifest` 与 `@yiliang/aw-plugins` 的共同 package version，代表一次官方 catalog 快照。
- Plugin version：单个插件 manifest 的 `version`，代表该插件 artifact 的不可变身份。

插件更新通过 catalog 包独立发布，不要求同步发布 CLI。只要用户当前 CLI 满足 catalog 和插件的 `compatibility.aw.minVersion`，用户就可以看到并安装新的插件版本。

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

- `version` 和 `compatibility.aw.minVersion` 都必须是严格 SemVer，不能写 `v1.2.3`、`1.2`、`latest`、`^1.2.3` 或其它宽松写法。
- 插件 manifest 不声明 per-plugin 宿主 agent 版本。Codex `>= 0.145.0`、Claude Code `>= 2.1.88` 是 AW CLI 内置写命令门槛，作者不需要添加 `compatibility.codex`、`compatibility.claude`、`minimumCodexVersion` 或类似字段。
- 发布到 `latest` catalog 的插件 `version` 必须是 stable SemVer；prerelease 插件只能通过 `beta` catalog 分发。
- `beta` catalog 的 catalog version 必须是 prerelease；同一快照内可以混合 stable 和 prerelease 插件 version。
- 同一个 catalog version 只能属于一个发布轨道，不能把已发布到 `beta` 的 catalog version 后续改挂到 `latest`。
- 插件最低 CLI 版本不能高于 catalog 级 `compatibility.aw.minVersion`。catalog 级门槛是整包门槛，必须覆盖包内所有插件的真实运行时要求。
- 同一 `plugin@version` 发布后不可变。只要 manifest、runtime 文件、脚本、静态资源、依赖声明、最低 CLI 版本或平台能力会改变 artifact 身份，就必须发布新的插件 `version`。
- 只改 build metadata 不是合法替代版本。官方 catalog 会拒绝用 SemVer 优先级相同但 build metadata 不同的版本替换同一插件。

`@yiliang/aw-plugins-manifest` sidecar 包和 `@yiliang/aw-plugins` full catalog 包使用相同 catalog version、channel 和 catalog 级最低 CLI 版本。sidecar 只包含 `catalog-manifest.json` 和必要 package metadata；full 包包含同一份 manifest 以及当前 catalog 单版本快照的全部插件 artifact。catalog history 记录历史 catalog version、插件 version、插件最低 CLI 版本、`artifactDigest` 和 `manifestDigest`，用于兼容历史 catalog 查询和发布门禁；它不是可安装的历史多版本索引。

## dependencies block

`dependencies` 用来声明 AW 插件之间的直接依赖。它只保留在 source manifest 和运行时 bundle 的 `.agents-plugin/plugin.json` 中，不会写入 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 或 marketplace manifest。

示例：

```json
{
  "dependencies": {
    "plugins": [
      {
        "name": "git-commit",
        "minVersion": "0.3.0"
      },
      {
        "name": "codex-explore",
        "minVersion": "0.2.0",
        "target": {
          "scope": "user"
        },
        "when": {
          "platforms": ["codex"]
        },
        "inheritInstallOptions": true
      }
    ]
  }
}
```

规则：

- `dependencies` 存在时只允许 `plugins` 字段。
- `dependencies.plugins` 必须是数组。空数组等价于无依赖，但构建和作者工具会提示删除空 block。
- 每个 entry 只允许 `name`、`minVersion`、`target`、`inheritInstallOptions`、`when`。
- `name` 必须使用和 manifest `name` 一样的小写短横线格式，且不能依赖自己。
- `minVersion` 可选，表示依赖插件的最低可接受版本，必须是严格 SemVer。它不是 range，不支持上界、`^`、`~` 或比较器组合。
- 不支持旧式 `version`、`range`、`platform`、`marketplace`、`source`、`optional`、`dev`、`peer` 等字段；`target.platform` 也不允许。作者工具和发布门禁会拒绝这些字段，而不是忽略。
- `target` 存在时只允许 `scope`，值只能是 `user` 或 `project`。
- `when` 存在时只允许 `platforms`，值必须是非空数组，元素只能是 `codex` 或 `claude`，且不能重复。
- 省略 `when` 等价于依赖同时对 `codex` 和 `claude` 生效。
- `inheritInstallOptions` 只能是 boolean；省略时按 `false` 处理。
- 同一 manifest 内，同名直接依赖的平台条件不能重叠；例如一个 entry 省略 `when` 后，不能再为同名插件追加 `codex` 或 `claude` 条目。
- dependency `name` 必须能在当前 AW catalog 中解析到插件。这个检查发生在 catalog 解析完成后，不要求单个 manifest normalizer 持有全 catalog 上下文。

安装语义：

- 依赖永远跟随父插件本次已确定的 platform；`when.platforms` 只决定 entry 是否对当前 platform 生效，不能改写依赖安装 platform。
- `target.scope` 只约束依赖 location。父插件安装到 `user` scope 时，只能依赖同 platform 的 `user` scope 健康安装；如果生效 entry 写了 `target.scope: "project"`，命令会在写入前失败。
- 父插件安装到 `project` scope 且 entry 省略 `target.scope` 时，AW 优先选择当前 project scope；当前 project 缺失或不健康时，可复用健康的 user scope 安装。
- 显式 `target.scope: "user"` 只检查 / 安装 user scope；显式 `target.scope: "project"` 只检查 / 安装当前 project scope，不 fallback 到 user scope，也不会扫描其它历史 project。
- `inheritInstallOptions: true` 只用于自动安装依赖时继承父插件本次插件级安装选项，例如允许覆盖的 skill trigger 偏好；省略或 `false` 不继承。多个父插件给同一自动依赖传入冲突选项时，本次命令 fail fast。
- `aw install` 会自动安装缺失依赖；显式 `aw upgrade <plugin>` 会先安装缺失依赖、升级低于 `minVersion` 的已安装依赖，再升级父插件；`aw upgrade --all` 只以用户显式保留的安装为根；`aw uninstall` 会保护仍被依赖的插件，并在父插件卸载后自动清理引用归零且未显式保留的 auto dependency。
- `aw status --json` 中的 `dependencies` 是只读投影，展示 `declared`、`resolved`、`satisfied`、`missing`、`dependents`、`autoInstalled`、`autoRemovable`、`catalogDrift`、声明的 `minVersion`、已安装版本、current catalog 候选版本和版本比较结果。这些都是从 install record 的 `installSource` / `dependencyEdges`、全局 dependency index 和 current catalog 推导出来的诊断结果，不是 manifest 字段，也不会写进 install record。

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
- `file` / `directory` 配置值写入时按 AW project root 解析相对路径，并以 canonical absolute realpath 落盘；每次读取本机 effective config 都会重校验路径存在且类型正确。这类 key 不能写入 project shared config，也不能成为 project-scope repo-visible artifact 的 render config、digest、stale 判断或 refresh 输入；需要本机路径时用 user store 或 `--scope project --local`。
- AW config 分 user store、project shared store 和 project local store。`aw config set --scope project` 写 `.agent-workflows/plugin-config/<plugin>/config.json`，这是唯一会影响 repo-visible project artifacts 的项目配置输入；`aw config set --scope project --local` 写 `.agent-workflows/plugin-config.local/<plugin>/config.json`，默认忽略，只影响本机读命令、lifecycle 和 helper。project scope effective 读取顺序是 manifest default < user < project shared < project local。配置可先于安装写入；`aw uninstall` 默认保留配置，随主体成功删除当前 target 配置可用 `--remove-config`，只清配置用 `aw config reset <plugin>`。

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

`artifacts.targets` 声明动态 artifact 的安装前能力真值。installability、discovery、status current catalog、Codex project write safety preflight、install record artifact identity 和 project artifact shared identity 都读这个静态声明，不能等 renderer 执行后再推断插件能力。首版 target 只支持 Codex，因此声明动态 target 的插件必须支持 Codex；可以是 `products=["CODEX"]` 的 Codex-only 插件，也可以是省略 `products` 或显式声明双产品的双平台插件。Claude-only 插件声明任何 `artifacts.targets` 都会失败。

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
      "explorerModel": { "type": "string", "default": "gpt-5.6-luna" },
      "modelReasoningEffort": {
        "type": "enum",
        "values": ["low", "medium", "high", "xhigh", "max"],
        "default": "medium"
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
        "skillKey": "codex-explore"
      }
    ]
  }
}
```

字段规则：

- `id + target` 在同一插件内必须唯一，`id` 只能使用字母、数字、`.`、`_`、`-`，并以字母开头。
- `platform` 首版只能是 `codex`；`scopes` 只能包含 `user`、`project`。
- `target` 支持 `codex.skill`、`codex.developerInstructionsBlock` 和 `codex.agentRole`。
- `states` 首版支持 `present`、`disabled`。renderer 当前 platform/scope 已声明的 artifact 必须返回其中一种状态，不能漏返回。
- `refreshKeys` 必须全部存在于 `config.schema`。config 写命令只有命中这些 key 时才刷新对应 artifact。
- 配置写入、主控制台配置向导和 refresh-only 动作共用同一条 dynamic artifact apply 路径。成功时 AW 更新必要 artifact identity、project artifact shared identity 和 dynamic diagnostic cache；失败摘要进入 diagnostic cache，不写入 install record。`config set/unset/reset --json` 会返回稳定的 `artifactRefresh`；refresh-only 不修改 config store，只重跑当前 location target 可定位的 dynamic artifact refresh。config refresh / refresh-only 会从 install record 的 historical bundle 执行 renderer，不从 current local marketplace 的可变 runtime 目录读取模板。
- 对包含 `project` scope 的 repo-visible dynamic artifact，`refreshKeys` 不能引用 `file` / `directory` 类型配置。project artifact render config 只来自 manifest default 和 project shared config 中可共享的非路径 key；user store、project local store 和路径型 key 只影响本机 effective config、lifecycle 或 helper。
- `requiresCodexProjectConfig: true` 表示 project scope 写路径需要进入 Codex project config safety preflight。`codex.skill` 不需要该字段，因为它写 `.agents/skills/<skillKey>`，不依赖 `.codex/config.toml`。
- `codex.skill` 的 `projectManagedKind` 必须是 `skill`，且必须静态声明合法 `skillKey`。renderer plan 里的 `skillKey` 必须完全一致，`present` content 只能包含 `skillFile` 和 `openaiYaml`，分别写成运行时 `SKILL.md` 和 `agents/openai.yaml`。renderer 不能提供任意路径，也不能直接写 `.agents/skills/**` 或用户级 Codex runtime。AW apply 阶段会按当前 effective SkillTrigger 内建配置 patch `openaiYaml`；`auto` 对应 `policy.allow_implicit_invocation: true`，`manual` 对应 `false`。
- `codex.developerInstructionsBlock` 的 `projectManagedKind` 必须是 `instruction`，renderer `present` content 是 instruction 字符串。一个插件可以声明多个 instruction artifact；AW 会按 `artifact.id` 稳定排序后合成为同一个 managed block。`disabled` 只省略该 artifact 的 fragment；只有同一插件没有任何 present instruction artifact 时，AW 才移除或跳过 managed block。
- `codex.agentRole` 的 `projectManagedKind` 必须是 `agent`，且必须静态声明合法 `roleKey`。renderer plan 里的 `roleKey` 和 `roleFile.name` 必须与静态 metadata 完全一致；`registration.config_file` 由 AW 生成，renderer 不能提供。

`ArtifactPlan` 顶层固定为 `{ "version": 1, "artifacts": [...] }`。artifact 至少包含 `id`、`platform`、`target`、`kind`、`state`、`refreshKeys`；`disabled` 可带 `disabledReason: "config"` 并省略 content，`present` 必须按 target 提供 content。renderer 只能返回 plan，不能直接写 `.agents/skills/**`、Codex user runtime、`.codex/config.toml`、`.codex/agents/*.toml`、project artifact identity、dynamic diagnostic cache、install record 或其它 AW 受管文件。

status 和控制台会把 dynamic artifact 的 refresh failed、drift、missing 投影成友好状态和下一步；disabled by config 不算问题。写动作必须基于明确的 location target：同一插件出现在多个位置时，可以汇总展示，但不能把“多个位置”当成隐式批量写目标。安装、升级、卸载、配置保存、refresh-only 和 cleanup 都必须先明确 platform / scope / project root。

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

构建后只为支持平台生成命令产物：支持 Claude 时得到 generated `claude/commands/<name>.md`；支持 Codex 时得到 generated `codex/skills/<name>/SKILL.md`、`agents/openai.yaml` 和被引用的 `assets/`。Codex project scope 安装这些命令时，会把 generated skill 复制到当前仓库 `.agents/skills/<name>`，并在 install record / project artifact shared identity 中以 `kind: "skill"` + `artifactKey: "<name>"` 记录最小 artifact identity。

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
      "defaultTrigger": "manual",
      "allowDynamicTrigger": true
    }
  }
}
```

规则：

- 静态 `skills/<skill>` 子目录和动态 `artifacts.targets[].target = "codex.skill"` 的 `skillKey` 必须有对应 `skillTriggers.<skill>` entry。
- `skillTriggers` 的 key 必须对应作者显式声明的受管 skill；未知 key、重复 key，或公共 `slashCommands` 生成 skill 的重复声明都会失败。
- 每个 entry 只允许 `defaultTrigger` 和 `allowDynamicTrigger`。
- `defaultTrigger` 必须是 `manual` 或 `auto`，表示未写入 AW 内建配置时的默认触发策略。
- `allowDynamicTrigger` 必须是 boolean；`true` 表示用户可以通过 `aw config` 或主控制台配置页修改 `aw.skillTriggers.<skill>.trigger`，`false` 表示 fixed 只读。
- 公共 `slashCommands` 生成的 Codex manual-only skill 不要求作者补 entry；AW 会注入 `defaultTrigger: "manual"`、`allowDynamicTrigger: false`。
- 旧的安装期覆盖字段不再是有效 manifest 合同；出现这类字段时 build/validate 必须失败。

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
- `products`：省略或空数组时表示同时支持 Claude 和 Codex；声明后只支持指定产品。这个字段不只是安装门禁，还参与 `pnpm build` 的 platform manifest/runtime 裁剪、平台 marketplace entries 过滤和 `pnpm plugin:test` 平台选择。`aw install` / 显式 `aw upgrade` 会拦截不匹配的平台；写入口必须显式传 `--platform codex|claude|both`。脚手架默认省略该字段，让插件保持双平台；只有明确要限制平台时才添加。

Codex scope 对作者的影响：

- `--scope user` 走 Codex native plugin 平面。AW 会用 `codex plugin marketplace add/list/remove` 管理本地 marketplace，并通过 `codex plugin add/remove` 写用户级 enabled config 和 materialized cache；没有只写 config 的 fallback。`codex app-server` 的 `plugin/list`、`plugin/installed`、`plugin/read` 只用于 verbose/native view 只读诊断。`aw status --json` 中 `native.pluginInstalled` 指 cache installed，`native.pluginEnabled` 指 config enabled。顶层状态只有在 enabled config、active cache 和 AW per-plugin record 都健康时才显示为 `installed`；enabled-only、cache-only 或 native transaction marker 残留不算已安装，只能作为 diagnostics、command blocker 或 `cleanupRequired` 细节。
- `--scope project` 只写 repo-managed artifacts，不调用 Codex native CLI / app-server RPC，不写用户级 `[marketplaces]` 或 `[plugins]`；写入前仍要求本机 Codex `>= 0.145.0`。
- `apps` 是 Codex 能力，`products=["CLAUDE"] + apps` 是矛盾配置，会在 manifest/build 校验时报错。
- 纯 native-only 插件不能以 Codex project scope 安装；声明 `apps` 的插件在 Codex project scope 会 fail fast。若希望插件可提交到仓库，请提供 skills、MCP、slashCommands、extensions 这类 repo-managed surface，或把 app/native-only 能力拆到 user-scope 插件。

CLI 入口和输出对作者的影响：

- `aw` 主命令是唯一交互入口；配置向导只存在于主控制台。脚本化配置请使用 `aw config set/unset/reset`，读配置使用 `aw config list/get`；不要把 `aw config configure` 写进 README、测试或脚本。
- 子命令面向脚本调用；写命令加 `--json` 时 stdout 是单一 JSON receipt，默认输出只展示友好完成状态和下一步。需要诊断时使用 `--verbose`、`--debug` 或 `status --json`。
- 旧恢复命令已移除，不再作为公开入口。project fresh clone 认领共享产物使用 `aw install --adopt-existing`；异常状态和 AW-owned 残留使用 `aw cleanup`；按 current catalog 删除后重建使用 `aw reinstall`；dependency index stale reference 只使用 `aw cleanup --dependency-index --prune-stale <token> --yes`。
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

`plugins/marketplace-source.json` 是 marketplace 根级构建输入，只接受 `owner` 和 `interface.displayName`。它不是运行时 marketplace manifest。创建单个插件时通常不要改它。

`pnpm build` 会把根级元数据和各插件的 marketplace 条目合成两份 runtime marketplace manifest：`.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json`。两份 marketplace 共享根级元数据，但 entries 按插件最终支持平台过滤；Claude marketplace 不包含 Codex-only 插件，Codex marketplace 不包含 Claude-only 插件。AW current catalog 以 catalog manifest 和每个插件的 `.agents-plugin/plugin.json` 为准，不会把某个平台 marketplace 当作全部插件清单。

## 分发模型

```text
源码层（作者维护）
  plugins/<name>/.agents-plugin/plugin.json + 关联文件
           │
           │  pnpm build / catalog staging
           ▼
Catalog staging（生成产物，不手改）
  staging/plugins/<name>/
  ├── .agents-plugin/plugin.json     源 manifest 副本
  ├── .claude-plugin/plugin.json     支持 Claude 时存在
  ├── .codex-plugin/plugin.json      支持 Codex 时存在
  ├── claude/                        支持 Claude 时存在
  └── codex/                         支持 Codex 时存在
           │
           │  catalog 发布
           ▼
远程 catalog（独立于 CLI 发布）
  @yiliang/aw-plugins-manifest       sidecar：catalog-manifest.json、history、digest 真值
  @yiliang/aw-plugins                full：同一份 manifest + 当前快照的全部插件 artifact
           │
           │  aw init / install / upgrade 解析 current catalog
           ▼
本地 AW runtime
  ~/.aw/                             catalog cache、active view、config、dependency index、historical runtime、records 等
```

这些层各有职责，排查问题时先确认问题在哪一层。`@yiliang/aw` CLI tarball 不再把 embedded catalog、`plugins-dist/` 或完整插件 artifact 作为正式分发真值；插件更新通过 catalog 包独立发布。

project scope 还会写两类项目共享文件：`.agent-workflows/plugin-config/` 是可提交的 project shared config，`.agent-workflows/project-artifacts/` 是可提交的 project artifact shared identity metadata。`.agent-workflows/plugin-config.local/` 以及平台 private state 是本机私有状态，默认应被 ignore。

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
  "compatibility": {
    "aw": {
      "minVersion": "0.8.0"
    }
  },
  "description": "自动化代码审查插件。",
  "skills": "./skills",
  "skillTriggers": {
    "review-workflow": {
      "defaultTrigger": "manual",
      "allowDynamicTrigger": true
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
