# 托管命令合同 v2

插件可在同一 `AW_HOME` 下发布一个以 `来源/插件` 调用的命令包。多个平台、User 和 Project 部署共用该包。用户也可以用 `aw command install` 注册自己的单入口命令，使用 `cmdu_` ID 调用。

作者在 Plugin Manifest v4 的 `requires.aw.capabilities` 声明 `aw.managed-commands.v2`。用 `aw dev plugin capabilities --surface managed-commands --json` 查询字段和限制，用 `aw command --help` 查询本机 CLI。Guide 的业务参数和适配器协议见 [Guide 运行生命周期](../../plugins/agent-subagent/skills/spawn-subagent/docs/runtime.md)及[适配器协议](../../plugins/agent-subagent/skills/spawn-subagent/docs/protocol.md)。

## 调用与路由

```text
aw command run <来源/插件> [--no-fallback] -- [args...]
aw command run <cmdu-id> -- [args...]
```

插件选择器由来源 ID（`[a-z][a-z0-9-]{0,31}`）和插件名（`[a-z0-9]+(?:-[a-z0-9]+)*`）组成。必须提供字面分隔符 `--`，即使业务参数为空。缺少分隔符、裸插件名、分隔符前存在未知选项，或对 `cmdu_` / 空参数使用 `--no-fallback`，均在启动前以 `invalidArguments` 和退出码 `2` 停止。帮助选项放在分隔符前。

AW 以 `--` 后第一个完整 argv 元素区分大小写地匹配子命令。匹配时消费该元素，再把剩余参数接到路由的固定 `args` 后面。通用入口 `fallback` 收到完整的业务 argv。空字符串、空格、Unicode 和其后的字面 `--` 均原样保留。

| 调用 `aw command run office/plugin-a -- …` | 路由（声明了 `export`、`message` 和 `fallback`） | 固定 `args` 后的参数 |
| --- | --- | --- |
| `export report.csv` | `export` | `["report.csv"]` |
| `export` | `export` | `[]` |
| `message send hello` | `message` | `["send", "hello"]` |
| `export-all report.csv` | `fallback` | `["export-all", "report.csv"]` |
| `--help` | `fallback` | `["--help"]` |
| 空参数 | `fallback` | `[]` |

程序已选定命名路由时，可将 `--no-fallback` 放在分隔符前。即使命名路由随后被移除，调用也只会尝试精确匹配。经过正常匹配仍无可用入口时，AW 写 stderr，返回 `commandRouteNotFound` 和退出码 `2`，并列出当前可用子命令。入口一旦选定，缺文件、启动失败和非零退出都直接返回该结果。用户命令的单入口收到全部业务参数。

## Manifest 声明

以下是静态命令包的 Manifest 字段片段。将相应脚本放入 `./commands`，并按插件需要补齐基础声明。

```json
{
  "requires": { "aw": { "capabilities": ["aw.managed-commands.v2"] } },
  "command": {
    "sourceDir": "./commands",
    "platforms": ["codex", "claude"],
    "mode": "static",
    "routes": {
      "subcommands": [
        { "name": "export", "runner": "node", "entry": "export.mjs" },
        { "name": "message", "runner": "node", "entry": "message.mjs" }
      ],
      "fallback": { "runner": "node", "entry": "main.mjs" }
    }
  },
  "extensions": {
    "permissions": [{ "name": "exports", "allow": [{ "argsPrefix": ["export"] }] }]
  }
}
```

| 字段 | 要求 |
| --- | --- |
| `sourceDir` | 必填的 `./` 插件相对目录，内含独立运行所需的文件和依赖。只允许普通文件和目录，链接、受保护或仅供作者使用的路径、顶层 `codex`、`claude`、`agent-skills` 产物根及自带 `.aw/` 均拒绝。AW 保留 `.aw/` 用于注入运行时资源。 |
| `platforms` | 插件所支持 Native 平台的非空、无重复子集。缺省为该插件全部 Native 平台。具体目标为 `codex`、`claude`、`antigravity`、`cursor`、`opencode`、`pi`、`copilot`、`grok`。选择集合外的平台或 `generic` 安装时，跳过命令包及它的原生工具依赖。 |
| `mode` | `"static"` 或 `"dynamic"`，必填。 |
| `routes` | 仅静态模式必填，包含可选 `subcommands`（默认 `[]`）和至多一个 `fallback`。空表合法。子命令 `name` 在包内唯一，匹配 `[A-Za-z][A-Za-z0-9_.-]{0,63}`。 |
| `refreshKeys` | 仅动态模式必填，可为 `[]`。使用顶层 `config.fields` 中非敏感公共键，且校验依赖也须非敏感。平台专属键只可用于相应平台的配置快照。 |
| `runtimeConfig.keys` | 可选的非空、无重复配置键数组。每个键及其校验依赖在所有 `command.platforms` 的编译配置中均须存在且非敏感。见[运行配置快照](#运行配置快照)。 |

路由定义和用户命令的 `launch` 共享下列字段。未知字段、`null`、非法 Unicode 和 NUL 均拒绝。标识、参数与环境值按原始值校验。

| 启动字段 | 要求 |
| --- | --- |
| `runner` | 必填，`node` 或 `executable`。 |
| `entry` | 必填，资源根内的普通文件路径。使用 `/` 分段，拒绝绝对路径、盘符、空段、`.`、`..`、反斜杠和控制字符。文件及路径层级必须保持在核验过的资源树内。 |
| `args` | 固定 argv，默认 `[]`。最多 128 项，每项最多 4096 个 Unicode code point。 |
| `env` / `envFrom` | 默认 `{}`。名称匹配 `[A-Za-z_][A-Za-z0-9_]*`。前者提供字面值（上限 4096 个 Unicode code point），后者引用宿主环境名。见[运行环境与退出状态](#运行环境与退出状态)。 |
| `cwd` | 默认 `caller`，使用调用目录。选择 `resource` 时使用已安装资源根。 |

原生工具通过至多一条 `{ "kind": "plugin-command", "tools": […] }` 消费者声明绑定到这个包。使用能力 `aw.native-tools.v3`。详见[原生工具合同](native-tools.md)。

## 动态路由渲染

动态模式使用 `scripts.artifacts.render`。AW 运行同一个 Node renderer 的独立请求，`AW_PLUGIN_SURFACE=managed-commands`。该 surface 使用 [Artifact renderer 的隔离、超时和输出校验](plugin-runtime.md#3-动态-renderer-与-platformcomponentplan-合同)。只有动态命令需要 renderer 的插件可省略 `artifacts`，作者验证和安装会单独校验所选入口的资源闭包。

| 请求字段 | 值 |
| --- | --- |
| `event` | `install`、`refresh` 或 `materialize`。 |
| `surface` / `scope` | `{ "kind": "aw", "name": "managed-commands" }` 和 `"user"`。没有 platform、distribution、platformCapabilities 或项目字段。 |
| `plugin` | `name`、`version`、已核验的 `rootDir`。 |
| `config` | `mode: "artifact-render"`、`targetScope: "user"`，以及 `schema`、`values`、`sources`、`issues`。配置来自公共默认值和 User `common`，限于 `refreshKeys` 及非敏感校验依赖。 |
| `changedConfigKeys` | `config apply` 刷新路由时，相比上次发布发生变化的已选公共输入键，包括非敏感校验依赖。`install`、`materialize` 以及旧包缺少逐键记录时提供 `[]`。始终返回完整路由表。 |
| `requestedArtifactIds` | `["command-routes"]`。 |
| `previousArtifacts` | 当前已安装动态路由的上次产物，含当时的 `refreshKeys` 和完整 `routes`。没有旧动态产物时为 `[]`。 |
| `commandSources` | 单元素数组 `[{ "sourceDir": "<已核验命令源目录>" }]`。 |
| `artifactSources` / `runtimeImports` | 均为 `[]`，组件 renderer 使用自己的请求和资源。 |

例如，声明 `"mode": "dynamic", "refreshKeys": ["exportMode"]` 时，renderer 可以返回下列一个 ArtifactPlan v2 对象。

```json
{
  "version": 2,
  "artifacts": [
    {
      "id": "command-routes",
      "target": "aw.command-routes",
      "kind": "commandRoutes",
      "refreshKeys": ["exportMode"],
      "routes": {
        "subcommands": [{ "name": "export", "runner": "node", "entry": "export-fast.mjs" }],
        "fallback": { "runner": "node", "entry": "main.mjs" }
      }
    }
  ]
}
```

响应精确包含所请求的一条产物，`id`、`target`、`kind` 和 `refreshKeys` 必须匹配。返回的是本次完整路由表。省略 `fallback` 会撤销通用入口，空 `routes` 会撤销全部路由，使包进入 `empty`。路由只能选择 `sourceDir` 内已有文件。来源、归属、权限和原生工具由 AW 按 manifest 确定。非法响应、重复子命令、资源闭包错误、脚本失败或取消均停止发布，原有效包保留。动态命令 renderer 计入有作者脚本的安装预览路径。

## Skill 引用与宿主权限

在最终 Skill 的 Markdown 中，`{{aw.command}}` 展开为 `aw command run <已核验来源/插件> --`，包括代码块在内。引用只适用于同一插件有可运行命令且当前目标属于 `command.platforms` 的 Native Skill。空路由导致引用该命令的 Skill 不可用，独立组件继续。Portable 分发需提供独立可用正文和资源。[Portable 合同](plugin-runtime.md)

`extensions.permissions[].allow/ask/deny` 可使用原有的字符串命令前缀或结构化 `{ "argsPrefix": ["export"] }`。结构化项要求 `aw.managed-commands.v2`、本插件有 `command` 且目标属于 `command.platforms`。每个 token 必须匹配 `[A-Za-z0-9_./:@%+=,-]+`。`argsPrefix` 必填。`[]` 明确匹配插件入口的所有直接调用，按实际需要缩小为命名路由或其参数前缀。

- AW 生成的结构化权限前缀是逐项 argv `["aw", "command", "run", "<来源/插件>", "--", ...argsPrefix]`。它匹配字面 `--` 紧随选择器的调用。带 `--no-fallback` 的调用使用不同前缀，审批由宿主自身策略决定。
- Codex 将前缀写入 `prefix_rule`，对应 `allow`、`prompt`、`forbidden`。Claude Code 将普通和托管命令的前缀以空格连接，在尾部加 ` *` 生成 `Bash(...)` 规则，覆盖零个或多个附加参数。Claude Code 匹配前可能移除 `timeout`、`time` 等已知包装，Review 会提示内部命令匹配的影响。AW 内部执行仍按实际 argv 路由。[Claude Code Bash 匹配](https://code.claude.com/docs/en/permissions#bash)
- Claude 的沙箱排除声明在 `extensions.permissions[].agentOverrides.claude.sandbox.excludedCommands`，每项为同样的结构化对象。插件同时声明 `aw.managed-commands.v2` 与 `aw.claude.sandbox-exclusions.v1`。排除规则生成同样的前缀和尾部 ` *`，位置在 Claude 沙箱设置中。沙箱排除和 Bash 审批各自生效。
- 宿主规则安装情况以本次回执为准。不能完整施加的动作报告 `invocationPolicyNotApplied`。实际会话证据见[宿主审批验证范围](#宿主审批验证范围)。

Skill 与命令权限使用同一冻结路由表。非空 `argsPrefix` 的首词须命中子命令或存在通用入口才可达。空前缀只要求有至少一个路由。部署操作会跳过不可达的 `allow` 和 Claude 沙箱排除，并在本次可触达的部署中按归属撤回对应的旧规则。仍可投影的 `ask` 和 `deny` 会保留，即使当前没有处理程序，以便其他部署恢复路由时限制继续生效。跳过动作与原因见 [CLI 诊断合同](cli.md#4-业务-payload-的边界)。

权限匹配调用文字。专用路由改为通用处理、新增子命令接走通用调用、入口或固定参数变化，都可能让已放行的调用执行不同代码。安装、同步、重建、命令包同步和配置应用的 Review 展示旧、新入口及可见权限影响，指出未检查的其他项目。OpenCode 的某个配置文件损坏时，Review 会标出该路径，并继续展示其他可读取层中的匹配规则。已审阅的候选或现场证据发生变化时以 `operationReviewStale` 停止相应发布。来源 ID 改绑后，旧包不可再按名称调用。安装新来源的同名插件时，残留的同文字宿主规则仍可能匹配，Review 会提示这一点。通过相应部署的同步或卸载更新其归属规则。

Codex Review 检查 User 和当前项目的规则文件，识别单行或多行的独立顶层字面 `prefix_rule`，包括参数备选项。Review 会标明无法读取或含无法判定表达式的文件。同一文件中的可判定规则仍会展示。Codex 0.171.0 的目录规则加载器跳过符号链接，Review 将链接列为未检查项。确认后的现场复核使用规则文件原始内容和符号链接的指向。

Grok Review 检查 User 的 `config.toml`、`managed_config.toml` 和已授信当前项目的 `.grok/config.toml`。Review 列出可能匹配的 Bash 规则和无法读取的配置文件。

### 宿主审批验证范围

AW 优先投影能覆盖声明命令的宿主规则。已知宿主匹配还会放宽或收紧其他命令时，Review 会说明受影响的动作、原生规则及匹配差异，确认写入后回执保留同一提示。实际审批仍取决于客户端、会话使用的配置和运行模式。[CLI 回执](cli.md#4-业务-payload-的边界)

| 宿主 | AW 规则投影 | 已验证的审批范围 |
| --- | --- | --- |
| Codex、Claude Code | Codex 命令前缀，Claude Bash 规则及独立沙箱排除。 | 按客户端的实际配置和会话结果核对。 |
| OpenCode V2 | `shell` 规则按标准书写的命令前缀投影到 User 或 Project 的 `permissions` 数组。Windows 会折叠大小写并统一斜杠，Review 提示这些额外匹配。 | OpenCode v2.2.6，macOS 26.3.1 arm64，`opencode mini --standalone` 的 Build agent 交互新会话。22 个会话覆盖 User 和 Project 三动作、项目隔离、确认与拒绝询问，以及跨项目收紧与恢复。桌面端、热重载、Linux、Windows 和其他模式待验证。[会话和规则读回](../../scripts/qualification/evidence/native-opencode-command-permissions-2.2.6-darwin-arm64-review.json) |
| Antigravity | CLI Global 使用 `command(词前缀)`，在已知宿主需要整行匹配时追加有边界的原文规则。可识别包装的规则也会匹配内部命令的直接调用。其他范围按动作报告跳过。 | Antigravity CLI 1.5.14，macOS 26.3.1 arm64。已验证旧安装升级、保留手工规则、冲突处理、strict 模式下的投影、原生配置读回及撤回。交互会话停在登录页，三动作审批和正则或包装的实际匹配待验证。[升级、配置读回与撤回](../../scripts/qualification/evidence/native-antigravity-command-permissions-1.5.14-darwin-arm64-review.json) |
| Grok Build | 普通和托管命令按 `allow`、`ask`、`deny` 写入 User 或已授权 Project `config.toml` 的 `[permission].rules`。Review 显示实际 Bash pattern 和额外匹配范围。拼接后的文本会混合引号内和参数之间的空格。已知命令包装、词尾延长和通配符也可能匹配其他命令。 | Grok Build 1.0.77（构建 `50ca579fa996`），macOS 26.3.1 arm64，交互默认权限模式。58 个会话覆盖普通与托管命令、User 与已授信 Project 三动作、Claude 配置兼容与显式导入，以及按项目记住的批准。已记住的批准可满足后续 `ask`，显式 `deny` 仍会阻止执行。其他包装及内联脚本只有源码与定向回归证据。[58 个会话](../../scripts/qualification/evidence/native-grok-command-permissions-1.0.77-darwin-arm64-review.json) · [交互复验和状态修复](../../scripts/qualification/evidence/native-grok-command-permissions-1.0.77-darwin-arm64.json) · [规则手册](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md#rule-matching-reference) |
| Cursor、Copilot CLI、Pi、`generic` | 当前没有通用命令权限投影。 | `generic` 无固定审批宿主。 |

OpenCode Project `allow` 的执行结果与空白基线相同。客户端 API 读回 AW 写入的规则，确认其排在默认允许之后。该版本按最后匹配的规则决定动作，规则命中由这两项证据推断。[原配置读回](../../scripts/qualification/evidence/native-opencode-command-permissions-2.2.6-darwin-arm64.json) · [OpenCode v2.2.6 匹配实现](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/core/src/permission.ts#L84-L93)

OpenCode 匹配命令文本。标准书写使用未加引号的字面词，以单个 ASCII 空格分隔，例如 `aw command run official/demo -- export`。生成规则在前缀后加 ` *`，覆盖该写法的零个或多个附加参数。普通命令前缀中的 `?` 会匹配一个字符，包括空格。方括号、花括号和 `~` 可由 Shell 在规则匹配后展开。Review 会提示这些差异。引号、转义或不同空白写法的审批依 OpenCode 自身规则处理。OpenCode 自己保存的允许记录可满足后续 `ask`，生效的 `deny` 仍由宿主阻止。[OpenCode 匹配与审批](https://opencode.ai/docs/permissions/#approvals)

调整 OpenCode User 限制如果需要更新 AW 已知项目，Review 会逐个列出项目配置路径和待增删的规则，经确认后一起更新。规则路径、可表达的前缀范围和恢复见[平台权限投影](../maintainers/architecture/platforms.md#平台权限投影)。

## 运行配置快照

`command.runtimeConfig.keys` 为每个已发布平台声明同一组可读键。AW 在不可变命令包 revision 中注入 `.aw/command-runtime-config.mjs` 和各平台的 `.aw/runtime-config/<platform>.json`。调用脚本显式传入正确的平台，例如在命令包根的模块中调用：

```js
import { readCommandRuntimeConfig } from './.aw/command-runtime-config.mjs';

const { values, platform, installedIdentity, resourceRoot } =
  await readCommandRuntimeConfig({
    from: import.meta.url,
    platform: 'codex',
    keys: ['exportDirectory'],
  });
```

`from` 必须是同一 revision 内的普通文件。读取器按自身位置核对独立 owner、producer 记录和快照。平台必须是合法 Native 目标，所求键非空、唯一且在声明的允许列表内。快照是 schema 1 的 `aw-command-runtime-config`，含 `producer`、`pluginVersion`、`sourceContentDigest`、`platform`、`allowedKeys` 与 `effectiveValues`。读取器只返回所请求且有值的键，另附平台、当前 revision 根和 `installedIdentity`（`sourceId`、`sourceIdentity`、`pluginId`、`pluginName`、`pluginVersion`、`sourceContentDigest`、`platform`）。

读取使用已应用值，缺失、越权键或损坏分别返回 `commandRuntimeConfigMissing`、`commandRuntimeConfigKeyDenied`、`commandRuntimeConfigInvalid`。先核对调用平台和请求键，必要时通过 `aw plugin sync` 或 `aw command package sync` 修复。同一个 `AW_HOME` 下，同平台多个配置根共享一份快照。不同平台分别记录已应用值。Skill 目录内的已安装配置读取器及其能力见[插件运行时合同](plugin-runtime.md)。

## 包身份与发布

命令包固定在 `<AW_HOME>/commands/packages/<pkg-id>/`。pkg-id 为 `pkg_` 加规范序列化 `{schemaVersion: 2, sourceId, sourceIdentity, pluginName}` 的 UTF-8 SHA-256 完整小写 hex。规范序列化按 ECMAScript 默认字符串顺序递归排序对象键、保持数组顺序、用 `JSON.stringify` 序列化 primitive，然后无空白拼接。来源 identity 为 `sha256:` 加 64 位小写 hex。当前项目和宿主配置根均不参与命令包身份。

- `run` 和 `show` 读本机 `catalog-sources.json` 派生身份。文件缺失时按内置 `official` 来源处理，损坏时停止。两个入口均为离线读取，使用当前已核验包和 revision。
- 独立 `owner.json` 为 `{schemaVersion: 2, owner: "agent-workflows", kind: "plugin-command-package", producer: {sourceId, sourceIdentity, pluginName}}`。它证明目录归属，适用于恢复损坏包。
- `revisions/<uuid>/` 包含完整自足资源树、`.aw-command-producer.json` 和按需注入的 reader。producer 记录使用 `schemaVersion: 2`，含 `producer`、`pluginVersion`、`sourceContentDigest`、`routes` 和 `runtimeConfigPlatforms`。按声明保存 `nativeTools`、`dynamicRefreshKeys`、`routeConfigDigest`、逐键的 `routeConfigKeyDigests`、`runtimeConfigKeys` 和按平台的 `runtimeConfigCommonDigests`。来源内容摘要涵盖 manifest、命令源目录与 renderer 闭包。只更新配置快照时摘要保持相同。
- 完整准备和复核后，AW 在单一 `AW_HOME` 写锁内原子替换 `current.json`（`{schemaVersion: 2, revision: "<uuid>"}`）。一次读取固定在同一个 revision，路由、入口和读取器来自同一版本。渲染或暂存失败时，旧版本继续可用。切换后尽力清理旧目录，仍被进程占用的旧目录可后续回收。更新或移除前先结束活跃任务。

## 包维护与配置应用

| 操作 | 共享命令包效果 |
| --- | --- |
| `aw plugin install` / `aw plugin sync` / `aw plugin sync --rebuild` | 命中 `command.platforms` 时发布一次共享包，并重新计算本次目标平台的快照。其他平台沿用已应用值。新版配置不再接受的旧值会重算并在 Review 展示，已排除的平台会移出快照。 |
| 平台卸载或清理 | 撤回本次所选部署中可确认归属的 Skill 和权限。共享包及快照保留，包含最后一处卸载的情况。需要删除整包时，按回执执行 `aw command package remove`。 |
| `aw source sync` | 刷新 Active Catalog。已安装命令包继续使用当前 revision。 |
| 确认更新到不含 `command` 的插件版本 | 在写锁内按 owner 撤销共享包，包括本次只选择 Portable 部署的更新。撤销后按名查询或执行会报 `commandNotFound`。需要清理损坏残留时，使用回执中的精确 `pkg-id`。 |
| 来源移除或改绑 | 原名称失去旧包定位。用 `aw command list` 查找孤立包的 `pkg-id`，据此精确移除。 |
| `aw command package sync <来源/插件>` | 通过本机 Active Catalog 单独同步命令包。首次同步为所有声明平台生成所需快照，后续重算原已发布且仍受支持的平台。Review 列出已知权限影响供参考，宿主规则由相应平台的生命周期命令更新。Active 插件已无 `command` 时返回 `commandPackageDeclarationMissing`，可用显式移除或插件同步。 |
| `aw command package remove <来源/插件 \| pkg-id>` | 按 owner 移除整包，所有该包调用失效。宿主规则和插件配置各由自身入口维护。按 `pkg-id` 移除可用旧来源 owner 证据，适用于来源已变化或损坏。 |

保存配置只写 Config Store。命令读取上次应用的 snapshot 和路由。配置应用只刷新已安装且存在受影响输入的包，一次最多发布一个新 revision。配置存储分为 `common` 与 `platforms.<target>`。`--context user` 检查 User 部署，`--context project` 可检查 User 与当前项目，其他项目保留未检查。

- `config apply --platform <target>` 可以刷新该目标的快照。共享动态路由和其他平台的已应用值保持原状。
- 没有 `--platform` 时，公共 `refreshKeys` 的变化触发一次动态重渲染，并在本次可见部署中刷新受影响的 Skill 和权限。公共运行配置键变化时，重算已发布且受影响的平台快照。Review 逐平台列出变化，包括本次将随快照生效的已保存覆盖值。
- 刷新前先核对当前 Active Catalog，按顺序处理 `sourceActiveUnavailable` 或 `pluginUnavailable`、原生工具闭包变更 `nativeToolSyncRequired`、版本或来源内容差异 `configApplyVersionMismatch`。历史快照不参与选择。核验失败时保留旧包和已保存配置。按诊断同步来源或先更新插件/共享包，再重试应用。[配置写入与回执](../maintainers/architecture/config-and-status.md)

## 命令管理与 JSON

```text
aw command install <directory> --name <name> --runner node|executable --entry <relative-file>
  [--args-json <json>] [--env-json <json>] [--env-from-json <json>]
  [--cwd caller|resource] [--yes] [--json]
aw command update <cmdu-id> --from <directory>
  [--name <name>] [--runner node|executable] [--entry <relative-file>]
  [--args-json <json>] [--env-json <json>] [--env-from-json <json>]
  [--cwd caller|resource] [--yes] [--json]
aw command remove <cmdu-id> [--force] [--yes] [--json]
aw command list [--json]
aw command show <来源/插件 | cmdu-id> [--json]
aw command package sync <来源/插件> [--yes] [--json]
aw command package remove <来源/插件 | pkg-id> [--force] [--yes] [--json]
```

`install` 创建 `cmdu_` 加小写 UUID v4，更新时保持 ID，移除后重新安装会创建新 ID。`name` 是 1–128 个 Unicode code point 的非全空白展示名，可重复且不可含控制字符。`update` 保留省略的字段，数组和字典整体替换，`[]` / `{}` 清空。相对源目录从调用位置解析。AW 读取并复制普通资源树，拒绝包含受保护目录、AW_HOME、安装目标或仓库 `.git` 的复制范围。

用户定义为 `<AW_HOME>/commands/users/<cmdu-id>/definition.json`，包含 `schemaVersion: 1`、`id`、`name`、`packageRevision` 和 `launch`。资源根固定在同目录的 `packages/<packageRevision>/`。更新先准备新目录，再原子替换定义。独立 `owner.json` 为 `{schemaVersion: 1, owner: "agent-workflows", kind: "user-command", id}`。定义损坏时，可按 owner 精确移除并重装。owner 无法核验时保留现场。命令包的 `--force` 同样只处理可核验归属的专属资源，不能用于删除外来或共享配置。

管理命令使用 [CLI 统一结果 schema 2](cli.md#2-统一结果结构)。以下字段位于 `data`。写操作的确认见 `data.confirmation`，需要确认的非交互写入须显式传 `--yes`。进程退出码遵循 CLI 统一合同。

| 入口 | 公开数据 |
| --- | --- |
| `list` | `commands` 为用户命令，`packages` 为当前配置来源的插件包，`orphanedPackages` 为来源缺失、损坏或失配的插件包。包摘要含 `selector`、`packageId`、`availability`、`subcommands`（名称数组）、`hasFallback`。 |
| `show` | `commands[0]` 为已查询项。用户命令含 `owner.kind: "user"`、`id`、`name`、`launch`。插件命令含 `owner.kind: "plugin"`、`owner.producer`、`selector`、`packageId`、`pluginVersion`、`sourceContentDigest`、`routes`（`subcommands` 和可选 `fallback`）、`runtimeConfigPlatforms` 与 `nativeTools`。两类都含 `availability` 和 `resourceRoot`。无法安全解析的资源或启动信息可为 `null`。 |
| 命令或包写操作 | `changes` 列出变动项的 `kind`、`id`、`action`。变动后可查看的记录随 `commands` 或 `packages` 返回。包同步可返回 `packageReview` 与 `nativeToolChanges`。 |

可查询但不可用的记录同时附 `errors`、`blockerCodes` 和 `recoveryActions`，并在顶层 `diagnostics` 中报告问题。包的 `ready` 表示有可用路由，`empty` 表示有效空路由表，`unavailable` 表示不可用。找不到选择器时返回 `commandNotFound`。无法核验归属的包通过诊断报告，保留其内容。`run` 采用子程序透传协议。

插件生命周期的 `data.commandResults` 和配置应用的 `data.apply.commandResults` 记录共享包结果。每项含 `producer`、`packageId`、`selector`、`action`（`created`、`updated`、`unchanged`、`removed`）、`availability`（`ready`、`empty`、`unavailable`、`removed`）、`subcommands`、`hasFallback`、`state`（`completed`、`partial`、`failed`）、`blockerCodes` 和具体 `errors`。平台自己的权限结果保留在对应部署的回执。没有命令结果时省略该字段。通过顶层 `diagnostics` 和 `nextActions` 定位未完成事项。

## 运行环境与退出状态

Node runner 使用当前 `process.execPath` 启动已核验入口。executable runner 直接启动文件。POSIX 检查执行位，Windows 需要可直接启动的原生 `.exe`。两个 runner 都按数组传入固定参数及路由后的业务参数，使用 `shell: false`。

1. AW 快照宿主环境，从传给子进程的继承值中清除 `AW_PLUGIN_*`、`AW_COMMAND_*` 与 `AW_NATIVE_*`。现有 worker 的 `AW_SUBAGENT_*` 通信变量按原值继承。
2. `envFrom` 从原宿主快照取值，来源缺失报 `commandEnvironmentSourceMissing`，空值保留。显式 `env` 和 `envFrom` 覆盖普通宿主环境变量。两者的目标键必须互异，Windows 按不区分大小写处理。禁止把 `AW_PLUGIN_*`、`AW_SUBAGENT_*`、`AW_COMMAND_*`、`AW_NATIVE_*`、`AW_AGENT_SKILL_EVAL_PROCESS_MARKER`、`AW_HOME`、`AW_CODEX_HOME` 或 `AW_CLAUDE_HOME` 用作目标或来源，禁止名称统一按 ASCII 不区分大小写校验。
3. AW 注入已解析的 `AW_HOME`、当前 `AW_COMMAND_HOST` 和按需解析的 `AW_NATIVE_TOOL_CONTEXT`。必需的原生依赖在实际业务入口启动前解析。参见[原生工具合同](native-tools.md)。

`AW_COMMAND_HOST` 是 schema 1 JSON，含绝对路径 `nodeExecutable`（当前 Node）、`cliEntry`（当前 AW JS CLI）和 `awHome`（本次 AW_HOME）。嵌套 AW 调用经核验后以该 Node 和 CLI 入口启动，避免 PATH、npm shim 和环境切换选到另一份 AW。主机描述用于启动上下文，授权仍来自宿主和调用方的实际核验。Guide 还核对绝对路径、常规可读文件和受保护 AW_HOME，缺失报 `managedCommandHostMissing`，不合法报 `managedCommandHostInvalid`。[托管 adapter 配置](../../plugins/agent-subagent/skills/spawn-subagent/docs/configuration.md#托管-custom-adapter)

stdin、stdout、stderr 与正常数值退出码直接透传。POSIX 转发 SIGINT、SIGTERM、SIGHUP 至直接子进程，子进程因信号退出时转发器使用同一信号，无法自发同信号时用 `128 + signalNumber`。Windows 尽力转发 INT 和 TERM，转发器分别返回 130 和 143。停止整个进程树或远端会话由工具自己的协议负责。

AW 执行错误在 stderr 以 `aw: <stableCode>: <safeMessage>` 报告。启动失败为退出码 1，语法和路由错误为退出码 2。stderr 诊断可区分同数值的子程序退出。诊断不回显环境引用的解析值或完整环境。

| 错误码 | 恢复 |
| --- | --- |
| `commandNotFound` / `commandRouteNotFound` | 用 `list` 和 `show` 核对来源、命令包、子命令名称与通用入口。按包或平台同步。 |
| `commandDefinitionInvalid` / `commandBindingInvalid` | 核对定义或已安装包记录。用户定义损坏可精确移除后重装，插件包用 sync/rebuild/package sync 恢复。 |
| `commandIdentityConflict` / `commandOwnerMismatch` | 核对归属和身份，保留无法核验的资源。 |
| `commandResourceInvalid` / `commandRunnerUnsupported` | 修复缺失、不安全或无法直接启动的入口后更新包。 |
| `commandEnvironmentInvalid` / `commandEnvironmentSourceMissing` | 修复环境声明或提供缺失的宿主变量。 |
| `commandSpawnFailed` | 查看安全错误并解决宿主启动条件。 |
| `commandReferenceInvalid` / `managedCommandPortableUnsupported` | 检查 Skill、命令路由与目标，或提供独立 Portable 内容。 |
