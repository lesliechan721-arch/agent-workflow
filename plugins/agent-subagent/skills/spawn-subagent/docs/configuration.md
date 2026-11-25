# 适配器配置与接入

[适配器文档索引](README.md)

## 职责与源码入口

`subagent.mjs` 固定安装配置和输入，启动一个长期 worker；worker 持续管理一个 v6 adapter、父侧队列、快照、停止及最终结果。adapter 拥有后端会话、子侧工具及收件调度。一个执行连接不自动重连或重放。已结束的 run 可通过 send 显式恢复原 session；同一用户可跨父会话凭原句柄串行操作，恢复始终绑定原执行配置。

| 入口 | 责任 |
| --- | --- |
| `commands/scripts/subagent.mjs` | `start`/`send`/`wait`/`result`/`stop`/`inspect` 参数、安装 reader、英文文字输出和退出码。 |
| `commands/scripts/worker.mjs` | 本次持续执行和收尾；宿主须允许 `start` 返回后存活。 |
| `commands/scripts/runtime/plan.mjs` / `commands/scripts/runtime/runner.mjs` | 精确选择 executor、入口、输入和环境。 |
| `commands/scripts/runtime/managed-host.mjs` | 核验受保护 AW 主机，查询已安装命令及固定通信绑定。 |
| `commands/scripts/runtime/protocol.mjs` | 严格 v6 JSONL、大小及状态合同。 |
| `commands/scripts/runtime/adapter-channel.mjs` | 子侧发送、显式收件和自动输入共用调度。 |
| `commands/scripts/message.mjs` / `commands/scripts/message-mcp.mjs` | 脚本与 MCP 工具包装，不拥有另一份队列。 |
| `commands/scripts/runtime/processes.mjs` / `commands/scripts/runtime/platform.mjs` | 本机安全启动、私有资源、进程归属和停止；Windows 使用同产物的 `commands/scripts/runtime/windows-native.mjs` 和当前架构的 `aw-windows-job.exe` 持有本次 Job。 |
| `commands/scripts/runtime/contracts.mjs` / `commands/scripts/runtime/files.mjs` | 限值、路径、原子文件及安全诊断。 |
| `commands/scripts/introspection/*.mjs` | 三态 `effortSupport` 模型目录自省、`inspect` 渲染与内建探针。 |
| `scripts/config-suggestions.mjs` | Config Suggestions v2（`executor-model-profile` / `executor-models` / `executor-efforts`）、三平台确定性 `hint` 规则与配置期 Claude 逻辑别名 `builtin` 兜底。 |
| 内建 `adapters/*-v6.mjs` | Codex、Claude Code、Antigravity 后端映射；真实支持范围分别验证。 |

`agent-subagent` 保留调用方角色和任务约束。调用方先选定 `executor`/`model`/`reasoningEffort`，运行层只消费传入值；省略指令文件时使用命令包内的中性默认角色，传入 `--instructions-file <path>` 时由父侧读取一次并前置拼入外部 prompt。

## 配置、呈现与生效

配置声明由 [plugin manifest](https://github.com/lesliechan721-arch/agent-workflow/blob/main/plugins/agent-subagent/.agents-plugin/plugin.json) 拥有：

- **平台专属执行档位（`platformOnly: true`）**：`generalTaskProfile`、`simpleTaskProfile`、`complexTaskProfile`、`advancedTaskProfile` 与 `taskCustomProfiles` 仅属于各活跃平台层，严禁在 `common` 写入或兜底：
  - 仅 `generalTaskProfile` 为必填基线（`generic` 平台保留默认 `{ "executor": "native" }` 豁免）；
  - `simple` / `complex` / `advanced` 为可选覆盖，省略时自动继承 `generalTaskProfile`；`taskCustomProfiles` 省略按 `[]` 处理；
  - `agentExecutor` 声明 `clearsOnChange: ["model", "reasoningEffort"]`，在 TUI 切换执行器时自动清理旧值并合并进确认预览。
- **跨平台共享外部执行器注册表**：`subagentCommands` 与 `subagentRetentionHours` 保持非 `platformOnly`，支持在 `common` 共享配置并按平台覆盖。`subagentCommands` 每项具有 `key`、`adapter`；`key` 大小写敏感、唯一，`native` 为保留值。配置中的 `executor` 精确引用 `key`；运行入口必须显式传入 `executor`；`key` 只在 `agent-subagent` 自身的安装配置中查找，其他插件（如 `agent-explore`、`agent-advisor`）经跨插件 `valueRef` 引用该注册表但不扩大来源。

| adapter | 用户配置入口 |
| --- | --- |
| `codex` | `permissionMode`、`codexProfile`、`codexCliSource`、`codexBypassHookTrust`，以及 `args`、`env`、`envFrom`。 |
| `claude-code` | `permissionMode`、`args`、`env`、`envFrom`。 |
| `antigravity` | PATH 中的 `agy`；`permissionMode`、`args`、`env`、`envFrom`。 |
| `custom` | 绝对 `command`、可选绝对 `entrypoint`，以及 `args`、`env`、`envFrom`。 |
| `custom-managed` | `commandId` 选择插件命令或用户命令，`subcommand` 可选择插件的精确子命令。执行 Adapter v6，支持 `args`、`env` 和 `envFrom`。 |

所有执行器基于工作区运行。`command`/`entrypoint` 属于 `custom` 分支。切换 `adapter` 只修改草稿，不适用字段的移除须在保存前可见，取消保留原配置。`args` 是实际服务 argv 数组，`env` 是普通字符串 KV，`envFrom` 是宿主变量引用 KV，不把容器塞成 JSON 字符串。

所有分支均可设置独立的布尔 `communication` 和 `resume`，两者缺省均为 `true`。`resume` 请求恢复能力，实际由适配器确认；关闭通信但启用恢复合法，不增加每次命令的恢复覆盖参数。`communication` 表达用户意图，不证明后端支持通讯。关闭后仍检查环境并应用权限模式，保留 `start`/`wait`/`result`/`stop` 和最终结果缓存，只跳过 AW 桥、工具绑定、通讯说明及父输入自动调度；用户已有 MCP、插件和工具继续由后端管理。不增加每次 `start` 的通讯开关。

Codex 的 `codexCliSource` 为 `auto`/`cli`/`app`，缺省 `auto`；`codexBypassHookTrust` 为布尔值，缺省 `false`。后者使本次线程已启用但未信任或内容已修改的普通 hook 可执行，范围包括所选 profile 之外的适用 hooks；仍保留禁用状态与管理策略，不授予审批或沙箱绕过权限。两个字段在其它 adapter 上均拒绝，错误类型或枚举同样拒绝。它们与 `codexProfile`、`communication` 独立组合，固定读取本产物已安装配置。

```json
{
  "subagentRetentionHours": 24,
  "generalTaskProfile": { "executor": "codex-local" },
  "subagentCommands": [
    { "key": "codex-local", "adapter": "codex", "codexProfile": "advanced", "codexCliSource": "auto", "codexBypassHookTrust": false, "communication": true, "resume": true },
    { "key": "claude-local", "adapter": "claude-code" },
    { "key": "agy-task", "adapter": "antigravity", "communication": false },
    {
      "key": "custom-review",
      "adapter": "custom",
      "command": "/absolute/path/to/node",
      "entrypoint": "/absolute/path/to/custom-adapter.mjs",
      "args": ["--region", "example-region"]
    }
  ]
}
```

这是平台生效字段值示例，不是完整 Config Store v6 文档（`generalTaskProfile` 仅存储于具体 `platforms.<platform>` 层）。外部 profile 的 `model`/`reasoningEffort` 可省略，调用方按本次显式要求、已选配置、自省或后端默认确定参数，再传给脚本；运行层不查找 profile 或继承其模型参数；省略不生成空参数。通用 `native` profile 的 `model` 和 `reasoningEffort` 也可省略，表示不主动覆盖宿主选择。非法配置或不可用执行器不触发换后端或近似模型替换。

Config Definition v5 的有限对象分支、`platformOnly`、标量 `const`、对象级 Suggestions v2、`clearsOnChange` 与叶级数组/KV 由 Core 统一实现，CLI、TUI、生效值与物化共用。正式字段合同见 [Plugin Manifest 与配置声明合同](https://github.com/lesliechan721-arch/agent-workflow/blob/main/docs/reference/manifest-and-config.md)。

`references/executor-selection.md` 展示宿主原生能力、已配置的外部执行器、静态模型提示、生效档位与选型规则。仅在需要选型时阅读；当当前平台没有外部执行器、没有 `taskCustomProfiles` 且 4 个难度档位共用同一原生基线时，渲染器直接将该基线内联于 `SKILL.md` 并省略选型与外部执行参考。探索与第二意见等可选上层基础能力由独立插件（如 `agent-explore`、`agent-advisor`）维护，其 `executor` 引用同 source 的 `agent-subagent` 注册表并共享 Suggestions v2 建议提供方。

八个原生目标使用同一个 `<来源>/agent-subagent` 命令包。AW 在包内注入 `.aw/command-runtime-config.mjs` 和 `.aw/runtime-config/<platform>.json`。运行时使用 `aw command run <来源>/agent-subagent/<平台> -- <子命令>`，读取选定平台的已应用快照。只保存配置时仍使用已应用快照。同一 `AW_HOME` 下的各安装可共享相同平台快照。缺失或损坏可通过 `aw plugin sync` 或 `aw command package sync <来源>/agent-subagent` 恢复。

本插件为共享包声明 Windows 下必需的 Job 工具。AW 在命令启动前校验当前 Node 架构的工具，后台 worker、adapter 和扫描器继承准备好的上下文。缓存有效时可离线运行。工具取得失败时，命令在业务副作用前停止，可通过 AW 的离线导入或显式预取恢复。`generic` 通用目标仅交付 Skill。更新、重装或删除命令包前，先结束活跃任务。

## 资料保留与恢复配置

`subagentRetentionHours` 是独立配置，单位小时，默认 24；允许 `0` 至 `floor(Number.MAX_SAFE_INTEGER / 3,600,000)` 的整数，`0` 表示永不过期且不扫描，负数、非整数和非法数值拒绝。命令开始读取一次最新物化生效值，前台过期判断和后台扫描共用；仅保存未 apply 不改变生效值。它是资料管理设置，不冻结在 run 的执行配置中。

run 资料放在用户 home 下的 `~/.aw-subagent`。恢复只保留最新执行，先导出所需旧结果；执行记录按 `terminalAt` 计算当前 TTL，入口元数据另用严格超过 `max(2 × TTL, 24 小时)` 的 mtime 间隔。扫描是静默的独立子进程，同 run 分轮清理，不影响调度。完整目录、恢复提交与清理边界见 [用户目录、恢复与过期](runtime.md#1-用户目录恢复与过期)。

首次 `start` 保存 `executor`、`adapter`、来源、插件版本、内容摘要、平台及本次执行配置，包括 `workspace`、显式 `model`/`effort`、`args`、权限和 Codex 设置、通信与恢复开关、`env`/`envFrom` 和执行期限。恢复复用这些配置和原后端 session。配置快照切换后，只要来源和代码一致，恢复会重新绑定当前包中的 worker、内建 adapter 和通信入口；版本或内容摘要变化时返回 `resumeExecutionChanged`。恢复时重新解析 `envFrom` 引用的宿主值，并按原 `deadlineMs` 计算本次时限。

## 托管 custom adapter

`custom-managed` 沿用 Adapter v6。`commandId` 填已安装的 `<来源>/<插件>` 或 `aw command install` 返回的用户命令 `cmdu_…`。插件命令可用 `subcommand` 选择精确命名入口，省略时要求该包有 `fallback`。用户命令使用自身入口，必须省略 `subcommand`。使用平台快照的插件命令填 `<来源>/<插件>/<平台>`，其余插件命令填 `<来源>/<插件>`。保存核对语法，启动时核对实际入口。

运行器用经过校验的 `AW_COMMAND_HOST` 和固定的 `AW_HOME` 执行嵌套 AW。缺少或无效的主机分别返回 `managedCommandHostMissing` 或 `managedCommandHostInvalid`。命名子命令使用 `aw command run <绑定 ID> --no-fallback -- <子命令>`。插件 fallback 和用户命令使用 `aw command run <名称或ID> --`。入口的固定参数进入 adapter argv，executor 的 `args` 进入 Adapter v6 start 帧。

运行器先应用 executor `env`/`envFrom`，再启动嵌套 AW，所选路由的 `env`/`envFrom` 随后覆盖。AW 控制项由受保护的主机上下文注入。`AW_COMMAND_HOST` 由 worker 和嵌套 AW 使用。路由可声明 `cwd: resource`，v6 workspace 仍使用任务值。主机、环境和 runner 见 [托管命令合同](https://github.com/lesliechan721-arch/agent-workflow/blob/main/docs/reference/managed-commands.md)。

启动和恢复均通过同一主机的 `aw command show <包选择器或用户命令 ID> --json` 核对入口。包选择器使用两段。恢复要求 owner、所选路由和启动配置一致。用户命令还核对资源 revision，插件命令核对插件版本和内容摘要。执行相关信息发生变化时返回 `resumeExecutionChanged`。

## 执行器权限模式

Codex、Claude Code、Antigravity 的 `permissionMode` 可选 `default` / `auto` / `full-access`，缺省 `default`，显示名为“默认”“自动”“完整权限”。`custom`/`custom-managed` 显式携带时拒绝；`native` 使用宿主权限。它读取本产物已安装配置，不增加每次 `start` 开关，不改变 execution 的 `executor`/`model`/`reasoningEffort` 含义。

| 模式 | Codex app-server | Claude Code | Antigravity |
| --- | --- | --- | --- |
| `default` | 保留全局权限配置 | 保留原权限模式 | 保留原权限模式 |
| `auto` | 首次 `thread/start.config` 设置 `approval_policy=on-request`、`approvals_reviewer=auto_review`，保留有效沙箱和网络限制 | `--permission-mode auto` | `--mode auto` |
| `full-access` | 首次 `thread/start.config` 设置 `approval_policy=never`、`sandbox_mode=danger-full-access`，等价 `--dangerously-bypass-approvals-and-sandbox` | `--dangerously-skip-permissions` | `--dangerously-skip-permissions` |

`default` 保留用户 `args`、`profile` 及后端正常加载的用户、项目和管理配置；用户显式 `full-access` 不会被撤销。这是保留用户选择，不是 AW 默认提权。`auto`/`full-access` 高于 Codex profile 同类默认值，其它字段保留；后续轮次沿用同一线程配置，不写用户 Codex config。Codex `--full-auto` 的 `on-request + workspace-write` 不等于 `auto_review`；Claude `--allow-dangerously-skip-permissions` 只允许以后切换，不能证明启动时已进入完整权限。

通信专用许可独立于全局模式：非完整权限时，Codex 为本次两个私有 MCP 工具注入 `approval_mode=approve`，Claude 合并精确工具 `--allowedTools`，`agy` 通过本次 `--settings` 注入精确到 `-- message` 的 allow，保留原 allow，不写用户 settings。`communication=false` 跳过专属许可；已从正常参数、profile 或可可靠取得的生效信息确认完整权限时，跳过额外授权和专属冲突预检，仍建立当前 bridge、提示及绑定校验。不能可靠确认时保留原模式并使用精确许可，不猜测完整权限。`agy` 每次启动/恢复另行校验稳定版本 `>=1.4.10`；版本不可用时在建桥前返回环境不可用，通信关闭和 `full-access` 也不跳过。各后端的识别来源、恢复限制与真实验收见 [Codex](codex.md)、[Claude Code](claude-code.md) 和 [Antigravity](antigravity.md)。

非 `default` 时，`args` 中重复控制本模式的显式参数在后端启动或授权准备前返回 `adapterArgumentConflict`，即使值相同也拒绝。Codex 包括审批策略、reviewer、`full-auto`、完整 bypass；`full-access` 另包括沙箱模式及别名，`auto` 可保留显式沙箱限制。短选项、`--name=value`、分离值及 `-c` 同类叶子都检查。Claude 包括 `--permission-mode` 和主动跳过审批入口；`agy` 包括 `--mode`、`--dangerously-skip-permissions`。原 `model`/`effort` 冲突规则不变。

权限模式、`communication` 和 `codexBypassHookTrust` 独立。关闭通讯仍应用权限模式；`full-access` 不启用 hook bypass，`auto` 不改变 hook 信任或禁用记录。Claude/`agy` 不额外关闭用户终端沙箱。完整权限不取得 OS 管理员权限；后端仍执行不可覆盖的管理限制、显式 Ask/Deny 和关键路径保护，拒绝时报告实际失败。

参数可解析不证明模式生效。用已知版本合同及有界、无模型的公开信息检查可提前取得的限制；明确不可用返回 `permissionModeUnavailable`，不改用其它模式。仅在启动后出现 `auto` 不可用或回退信号时立即停止，保存真实提交/停止证据，不重发；已提交输入不能写 `generationStarted=false`。不为账户或模型资格增加每次模型探针。本机 `agy 1.4.7` 已有账户不能使用 `auto`、回退 `default` 的真实证据，不能将该路径算作 `auto` 通过。

## 任务和指令

CLI 必填 `--executor`，且必须只提供 `--prompt TEXT` 或 `--prompt-file PATH` 中的一项。父侧 `send` 和子侧 `send` 同理使用 `--text TEXT` 或 `--text-file PATH`。命令不读取 stdin；缺参、互斥、重复单值参数、未知或跨命令参数，以及 `--prompt -`、`--text -` 和文件参数值 `-` 均在创建/提交前返回参数错误，父侧为 `argumentsInvalid`，子侧为 `invalidArguments`，退出 2。需要单字符 `-` 使用内容为 `-` 的普通文件；名为 `-` 的文件使用 `./-` 或绝对路径。

相对输入/输出路径按 caller cwd 解析，不相对 `--workspace` 或 producer root。输入只读取一次，必须为普通文件且最后一段不是 symlink，按严格 UTF-8 校验，不去 BOM、不 trim，拒绝全空白和 NUL。`prompt-file` 与 `instructions-file` 各最多 256 KiB，`text-file` 最多 24 KiB（24,576 UTF-8 字节）；长消息通过文件写入能力创建后使用 `--text-file`，argv 仍受宿主命令行限制；合成 prompt 最多 524352 bytes。文件错误、大小及输出合同见 [文件输入与输出](runtime.md#文件输入与输出)。`--instructions-file PATH` 可选；`native`、未知 key、重复 key 和无效配置在后端启动前报错，通过 config、sync 或 reinstall 修复。

省略 `--instructions-file` 时读取命令包内的中性默认角色。传入显式空字符串时保留任务原文。传入非空路径时读取一次该文件，并将指令与任务合成为一个 prompt。显式坏文件报错；指令正文和任务正文各限 256 KiB。通信就绪时 adapter 可另行追加通信说明。外部适配器消费单一 prompt，指令和任务仍受实际任务授权与宿主权限约束。

工作区仅提供执行目录，关注的文件或目录写入任务提示。未知参数会在创建运行或启动适配器之前报错。

## 自省和模型建议（Suggestions v2 与三态 `effortSupport`）

`aw command run <来源>/agent-subagent/<平台> -- inspect --executor <key>` 返回该执行器的环境、模型、三态推理强度（`separate` / `none` / `unknown`）和来源。无参调用离线列出执行器，加 `--json` 读取指定执行器的结构化输出（含每模型 `effortSupport`）。只读探针的时限为 10 秒。模型目录超过 32 KiB 时，输出会省略部分条目，保留主要诊断并标示截断。后端入口缺失时，环境显示 `unavailable`，仍可查看已配置的静态模型；**`inspect` 严禁注入配置期 `builtin` 别名**。登录、额度、账户策略和模型生成以实际任务的反馈为准。

执行器可配置 `description`、`modelsPolicy` 与 `models[]`。模型项包含 `id`，可提供 `description`、`efforts`、`defaultEffort` 与 `default`。显式配置 `efforts: []` 表示该模型不支持独立推理强度（`effortSupport: "none"`），在 `merge` 模式下覆盖动态结果；省略 `efforts` 才继承动态值或标记 `unknown`。同一执行器只能将一项标为 `default: true`，否则查询返回 `executorInvalid`。默认 `merge` 将静态配置与探针合并；`override` 使用静态模型清单作为白名单。

配置编辑器通过 Suggestions v2（`schemaVersion: 2`）提供三类建议提供方：对象级两级复合 `executor-model-profile`（支持可选 `hint` 与 `recommendedHints` 单次探针多档复用）、标量 `executor-models` 与标量 `executor-efforts`（按三态返回 `ok` / `not-applicable` / `no-probe` / `unavailable`），并在配置期为 Claude 逻辑别名（`haiku`/`sonnet`/`opus`/`fable`）提供 `source: "builtin"` 离线兜底（在线探针成功时不追加在线目录缺失的内置别名）。探针使用 AW 为该次查询提供的时限，并预留时间返回已配置或内置候选项。自定义值仍可按字段合同填写。

## 参数和环境

`args` 中每项是一个真实后端 argv 值，不执行 shell split、变量插值或 shell。空字符串 argv 合法，NUL 非法。后端入口按最终 PATH 解析；不自动下载，不使用 Codex 专属 binary 环境变量替代通用配置。

内建 wrapper 拥有启动子命令、prompt stdin、工作目录、结构化输出和等待参数。`args` 与这些控制项冲突时明确拒绝，包括公开别名；不得让 `args` 把调用变成帮助、预览、仅入队、续接其它会话或多次生成。

CLI 已传入 `model` 或 `effort` 时，`args` 不能再次设置同一后端控制项；没有解析值时，`args` 可以设置或沿用后端默认。检查只覆盖 wrapper 拥有的参数，不复制完整后端 parser 或建立通用功能黑名单。显式不支持的参数报告真实错误，不忽略或重试其它模型。

保留后端正常配置、权限、项目指令、hooks、插件、MCP 和工具。wrapper 不自动设置只读或关闭工具；权限仅按明确选择的 `permissionMode` 或用户 `args` 配置，仍必须在本次授权内。后端自己的权限与任务授权不是一回事。

环境处理顺序：捕获原宿主环境，排除 AW 内部上下文和本次控制项；从原宿主快照解析 `envFrom`；合并 `env` 与 `envFrom`；最后注入 runner 控制值。同一目标键同时出现在 `env` 和 `envFrom` 时拒绝。来源不存在时报错，存在但为空保留空值；不支持链式引用或 `${...}` 替换。

变量名为 `[A-Za-z_][A-Za-z0-9_]*`，值不得包含 NUL。`env` 只保存普通字面值，不能保存密钥。`envFrom` 只存来源名；解析后的秘密不进入安装资源、stdin JSON、执行器表。继承其余普通宿主环境及后端认证设置，最终环境通过 `spawn.env` 交给 adapter，再按实际后端接口使用。

`AW_PLUGIN_CONTEXT`、`AW_PLUGIN_*` 作者上下文、`AW_SUBAGENT_*` 运行控制项和 `AW_NATIVE_*` 原生工具上下文不能借 `env`/`envFrom` 注入。`AW_NATIVE_*` 的目标和来源名在全部 adapter 中按 ASCII 大小写不敏感检查。`custom-managed` 还拒绝 `AW_COMMAND_*`、`AW_AGENT_SKILL_EVAL_PROCESS_MARKER` 和 `AW_HOME`/`AW_CODEX_HOME`/`AW_CLAUDE_HOME` 的目标或来源名，跨 OS 按 ASCII 大小写不敏感检查；普通 `command`/`entrypoint` `custom` 保留既有校验范围。本次私有目录、工具绑定与进程归属标记由运行层设置；现有 Eval 进程标记按原合同继承但不可覆盖。诊断脱敏已解析 `envFrom` 值及可识别凭据，不输出完整 `env` 或请求。受信任适配器可能读取宿主凭据，环境过滤不构成隔离。

## 内建后端的共同要求

通信仅在本次工具与调度配置就绪后报告 enabled。恢复独立协商，真实 session 可用时及时发送 session 帧，不能只依赖最终 `result.sessionId`。不能可靠恢复原 session 和当前工具绑定时报告 unsupported 或实际失败，不降级新会话；详见 [session 合同](protocol.md#session恢复绑定)。普通父输入不隐含强制 interrupt；轮次边界和提交竞态由 adapter 处理。

保留 `cwd`、模型、推理强度、配置、`args`、`env`/`envFrom`、认证、项目指令、hooks、插件、MCP、工具权限及审批。显式 `args`、`model`、`effort` 无法映射时在首次模型提交前报错；Codex profile 省略已列明的界面和废弃设置，其余完整透传，已知无效或与 AW 控制冲突的配置报错；省略清单、阶段路由、路径和非严格校验边界见 [Codex 实现](codex.md#codex-profile-转换)。不复制 Eval 的权限配置，不自动关闭工具；权限提升只按明确选择的 `permissionMode` 或 `args`，受后端管理策略及本次授权约束。

后端缺失、必要接口不支持、认证或模型错误按真实结果报告。实际版本可供诊断，精确版本字符串不证明资格。所有首版支持路径须有本次独立后端进程的实际退出证据；不以 adapter 退出代替。
