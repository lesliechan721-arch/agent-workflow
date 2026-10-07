# Codex Enhance 外部适配器实现

本文件供插件维护者和外部适配器作者参考，记录现有实现、扩展接口和验证边界。日常委派只需使用 Guide 的[外部调用说明](../plugins/codex-enhance/skills/codex-subagent-guide/references/external-delegation.md)，不需要读取本文件。这里的版本号和限制描述当前源码，不表示已经验证所有宿主、模型或服务。

## 职责与源码入口

```text
调用方选择 profile、指令文件、任务和材料
  → subagent.mjs 读取安装生效配置
  → selectExecution 解析所选配置与能力
  → prepareRun 读取本次输入
  → runForeground 启动一个前台适配器
  → 适配器调用后端并写入本次结果文件
  → runner 核对程序终态、返回结果并清理自有资源
```

| 入口 | 责任 |
| --- | --- |
| [subagent.mjs](../plugins/codex-enhance/skills/codex-subagent-guide/scripts/subagent.mjs) | 公开参数、安装 reader、调用和退出码 |
| [plan.mjs](../plugins/codex-enhance/skills/codex-subagent-guide/scripts/runtime/plan.mjs) | 选择调用方指定的 profile，校验 mode、访问权限和能力声明 |
| [files.mjs](../plugins/codex-enhance/skills/codex-subagent-guide/scripts/runtime/files.mjs) | 安全路径、UTF-8、有界读取、明确材料和私有结果文件 |
| [runner.mjs](../plugins/codex-enhance/skills/codex-subagent-guide/scripts/runtime/runner.mjs) | 输入副本、前台执行、结果分类和临时资源 |
| [processes.mjs](../plugins/codex-enhance/skills/codex-subagent-guide/scripts/runtime/processes.mjs) | 本次进程树观察、归属判断和停止 |
| [contracts.mjs](../plugins/codex-enhance/skills/codex-subagent-guide/scripts/runtime/contracts.mjs) | 输入输出限值、状态、错误与脱敏 |
| [codex-v3.mjs](../plugins/codex-enhance/skills/codex-subagent-guide/scripts/adapters/codex-v3.mjs) | 附带 Codex 后端的参数、指令通道、工具限制和事件映射 |

Guide 负责通用调用，不解释咨询类型或调查方法。profile 只含 `executor`、`model`、`reasoningEffort`；角色来自原生角色或本次指令文件，目标与材料来自任务。runner 不实现咨询类型选择，不补齐专属 profile，也不根据指令文件名判断角色。只读顾问、事实调查等业务边界由调用方及相应角色指令承担。

## 配置和分发

配置字段由[插件 manifest](../plugins/codex-enhance/.agents-plugin/plugin.json)定义。`subagentCommands` 是独立顶层数组；每项包含大小写敏感且唯一的 `key`、`title`、`mode`、绝对 `command`、可选绝对 `entrypoint` 和实际能力声明。`native` 是保留 key。

以下是配置字段示例，不是完整 store 文件。路径、模型和推理强度须替换为当前环境实际支持的值：

```json
{
  "generalTaskProfile": {
    "executor": "codex-bundle",
    "model": "your-supported-model",
    "reasoningEffort": "high"
  },
  "subagentCommands": [
    {
      "key": "codex-bundle",
      "title": "Codex 明确材料",
      "mode": "bundle",
      "command": "/absolute/path/to/node",
      "entrypoint": "/absolute/installed/guide/scripts/adapters/codex-v3.mjs",
      "supportsSystemInstructions": true,
      "supportsReadOnly": true,
      "supportsWorkspaceWrite": false
    }
  ]
}
```

同一适配器可以分别注册 workspace 和 bundle 入口。`supportsSystemInstructions` 表示支持独立 system、developer 或等价配置通道，不能用普通 user 消息前缀代替。能力声明只是准入条件，不证明后端真实支持。

Guide 的 renderer 从本次已验证的 `subagentCommands` 在 `references/external-delegation.md` 生成执行器表，列出全部已配置项的 key、名称、mode、独立指令和读写能力。未声明的能力显示为 false，bundle 的 workspace-write 始终为 false；空注册表只说明未配置，不生成占位行。所有配置文本按数据转义。表格不进入 native 正文、其它 Skill 或角色，`subagentCommands` 沿用 Guide 现有 refreshKeys，无需额外查询或强制 preview。command 和 entrypoint 仍由 runner 解析，不要求调用方复述或拼接。

通过 AW 正常配置流程保存并 apply。Guide 的 `runtimeConfig.keys` 覆盖共享外部 runner 所需输入；其它 Skill 只渲染各自配置，不运行配置 reader。AW 使用 `aw.installed-runtime-config.v2` 生成 `.aw-runtime-config.json` 和 `scripts/aw-runtime-config.mjs`。插件不能自建或覆盖这两个保留文件。

公开 reader 使用 `readRuntimeConfig({ from, keys })`，返回 `installedIdentity`、获准的 `effectiveValues` 和 `resourceRoot`。它读取当前安装产物，不读最新 store 或同名 sibling；只 save 未 apply 时，新调用继续使用旧生效值。来源、作用域与字段边界由 AW reader 校验，runner 继续校验实际消费的配置与输入。完整公共合同见[已安装运行配置](architecture.md#已安装运行配置)。

## Adapter v3 输入

runner 以 `shell:false`、`detached:false` 启动注册的绝对程序，只把可选 entrypoint 作为程序参数。适配器从 stdin 接收一次 JSON：

```json
{
  "protocolVersion": 3,
  "execution": {
    "profile": "generalTaskProfile",
    "executor": "codex-bundle",
    "model": "your-supported-model",
    "reasoningEffort": "high"
  },
  "mode": "bundle",
  "access": "read-only",
  "workspace": null,
  "instructions": "本次执行者的完整指令",
  "task": "本次目标、范围、约束、验收和输出要求",
  "materials": [
    {
      "source": "src/example.ts",
      "originalPath": "/original/project/src/example.ts",
      "startLine": 1,
      "endLine": 1,
      "content": "export const retryLimit = 3;\n"
    }
  ]
}
```

`instructions` 必须完整进入后端真实支持的独立指令通道。`task` 和 `materials` 保持任务数据身份，不能成为 executable、entrypoint 或 shell 参数片段。

workspace 模式提供绝对工作目录；后续工具读取真实工作区。bundle 模式使用 `workspace:null`，在本次私有目录启动，只发送明确选择的材料副本；`originalPath` 仅用于引用，不授予原路径访问能力。材料保留当前内容和原始行号，包含未提交修改。空材料集合法，不触发仓库扫描。

配置、指令、任务和材料在本次启动时读取，随后交付已读内容；适配器不为替换这些输入而重新打开源文件。不同文件的读取不构成全工作区一致快照。preview 与 run 各自读取，preview 不签发输入凭据，也不是启动前置条件。

### 输入边界

| 对象 | 当前限制 |
| --- | --- |
| 明确材料 | 最多 128 个文件，每个 1 MiB，总计 8 MiB |
| 指令和任务 | 各最多 256 KiB，非空 UTF-8 |
| 最终正文 | 最多 4 MiB |
| 诊断输出 | 最多 8 MiB |
| 适配器结果 JSON | 最多 32 MiB |
| 前台执行 deadline | 30 分钟；宿主工具的等待窗口不是该 deadline |

材料拒绝路径穿越、符号链接、重复项、二进制和非法 UTF-8。默认排除 `.git`、依赖目录、生成目录及已知凭据文件；也检查部分可识别的凭据内容。具体规则由 `materialSource` 和 `inspectMaterials` 拥有，不能把该检查解释为完整秘密检测。指令和任务是调用方显式选择，允许可读符号链接，但最终目标必须是普通 UTF-8 文件。超限或不支持的输入报错，不静默丢文件或截断。

权限取本次授权、mode、后端真实能力和环境权限的交集。bundle 不开放原项目写入；workspace 写请求必须显式使用 `workspace-write`，且注册项声明并实际支持写入。自定义指令不能提高权限。

### 环境与认证

runner 只转发 `PATH`、`HOME`、`USER`、`LOGNAME`、`LANG`、`LC_ALL`、`TMPDIR`、`CODEX_HOME`、`OPENAI_API_KEY`、`AW_SUBAGENT_CODEX_BINARY` 和已有 `AW_AGENT_SKILL_EVAL_PROCESS_MARKER`，再加入本次进程标记和临时路径。

不转发完整 AW context、store 路径或任意环境变量。其它认证由适配器使用自己的明确安全来源取得。注册程序仍是受信任的本地代码；环境白名单不证明它无法读取本机其它文件，也不构成 OS 强隔离。

## Adapter v3 输出

runner 创建 mode 0700 的本次私有目录，并设置 `AW_SUBAGENT_TEMP_DIR`、`AW_SUBAGENT_RESULT_FILE`。适配器将 mode 0600 的普通 JSON 文件写入指定结果路径；先写同目录临时文件再 rename。stdout/stderr 仅为有界诊断，不能替代该结果。

下面是 completed 结果的形状。事件、session 和正文必须来自本次实际服务，不能照抄示例伪造成功：

```json
{
  "protocolVersion": 3,
  "state": "completed",
  "generationStarted": true,
  "instructionChannel": "developer",
  "service": {
    "state": "completed",
    "event": "turn.completed",
    "sessionId": "actual-service-session"
  },
  "access": { "mode": "read-only", "restrictions": [] },
  "text": "本次完整回答",
  "localExitCode": 0
}
```

`state` 与 `service.state` 使用 `completed`、`failed`、`cancelled`、`unknown`。`instructionChannel` 使用 `system`、`developer` 或 `configuration`。`access.mode` 必须等于请求，限制写入字符串数组 `access.restrictions`。`localExitCode` 记录后端本地退出结果；runner 单独观察适配器退出码。

已知时才提供 `service.sessionId` 和 `service.model`。错误可提供稳定 `code`；停止尝试可提供 `remoteStopConfirmed`。提交前失败使用 `generationStarted:false` 和两个 `failed` 状态。已可能提交但终态未知时，不能伪装成零生成失败。

### 分类与公开结果

`classifyResult` 核对协议结构、指令通道、访问、服务终态及本地进程结果。主要条件如下：

| 结果 | 必要依据 |
| --- | --- |
| completed | 本地树已确认停止，两个状态相同，服务终态事件存在，完整正文非空，已启动生成，后端及适配器退出均为 0，且未被中断 |
| failed | 相容的失败结果，且提交前未生成，或取得服务失败事件；本地收尾已确认 |
| cancelled | 本次停止已请求，两个状态均为 cancelled，本地树停止已确认，且适用远端停止已确认 |
| unknown | 输入结果无效、通道不支持、证据缺失或冲突、本地停止未确认、输出超限，或远端停止未知等 |

退出码、非空正文或通道自述都不能单独证明完成。结构校验也不能证明任意适配器的自述真实；真实注入、权限和服务事件映射需要独立的接口及运行证据。

runner 最终 stdout JSON 交付 `state`、`text`、`service`、`access` 等结果，加入 `localTreeStopped`、`adapterExitCode`、脱敏 `diagnostics` 和 `restrictions`。必要时保留 `stopRequested`、`temporaryDirectory`。业务回答仍为自然语言或 Markdown，不要求领域业务 JSON。

公开 CLI 退出码：0 用于 completed、preview 或 help；1 用于其它运行结果；2 用于无效或不支持的输入。启动前错误通过安全 stderr JSON 返回。调用方必须读取结果状态，不能只看退出码。

## 前台生命周期与清理

一次 run 只启动一个前台适配器，由宿主工具持有长任务 session。等待窗口结束后继续同一 session，不重新解析配置、改换后端或提交第二次生成。外部追问是新的有界调用，不是原任务的跨会话恢复。

runner 在启动前检查进程观察能力，并在执行中观察本次进程树。停止只作用于直接 child 和可确认归属的后代；PID、启动身份与本次进程标记用于归属检查，不是 worker 注册或内容版本证明。无法观察或无法确认归属时，不扩大信号范围。

直接 child 的 exit 和输出管道 close 分别观察。后代继续持有管道时，有界结束管道等待，返回 unknown 与诊断限制；关闭本地管道不能证明后代或远端已停止。

正常收尾且本地执行停止已确认后，清理本次拥有的临时文件。清理未确认时可保留私有目录并报告位置。宿主崩溃、退出或 session 丢失后，不保证继续、取回、恢复或远端停止。遗留目录不是可恢复 run，不自动扫描或删除无法证明归属的文件。

## 附带 Codex 适配器

当前 `codex-v3.mjs` 将 CLI 固定为 **0.160.1**，并检查 `--version` 精确输出。`AW_SUBAGENT_CODEX_BINARY` 必须指向可信绝对可执行文件。源码只接纳 macOS 或 Linux 的 read-only workspace/bundle 调用；这不等于两个 OS 均已有实机支持证据。

### 参数和指令通道

`codexArguments` 使用 `codex exec --ephemeral --json`、read-only sandbox、`approval_policy="never"` 和 `--output-last-message`。完整 `instructions` 进入 `developer_instructions` 配置；stdin 只接收 `codexUserPayload` 生成的 task/materials JSON。模型与 effort 使用本次解析值，不自动重试其它配置。

适配器关闭子代理、插件、外部连接、hooks、网页、浏览器、计算机和图像等工具入口。bundle 另外关闭 shell、unified exec、JS/code mode 与 patch 等工作区工具。实际参数以 `codexArguments` 为准；这些设置不应在 Guide 正文复制。

`project_doc_max_bytes=0` 关闭自动项目 `AGENTS.md` 加载，调用任务须明确携带必要项目约束。Codex home 的用户指令仍可能加载，用户配置和 execution-policy rules 继续生效，不能据此宣称空白环境或强隔离。

### 配置和事件检查

`verifyLocalToolConfiguration` 检查 Codex home、系统和工作目录祖先中的相关配置，拒绝不能验证只读边界的 MCP、hooks、外部环境或远端执行设置。这个小型边界 reader 不是完整 TOML parser；多行字符串、inline table、转义 key 等不支持的语法在提交前拒绝，不能静默忽略。

适配器读取 JSONL 事件和 last-message。成功需要一个服务 session、唯一且相容的 `turn.completed`、退出码 0、完整非空回答，以及没有观察到禁止的工具行为。`turn.failed` 可以支持失败结论；终态缺失或冲突、非法事件、输出超限、权限违规或中断保留 unknown。它不伪造实际模型，也不确认远端取消。

本地事件文件和最终文本位于本次私有目录中，随本地清理处理。它们不是持久运行账本。

## 新增适配器与验证

实现新的外部后端时，先确认真实接口能分离指令与任务，提供所声明的访问限制，并在本次前台调用内取得真实服务终态。只有后台受理而没有持续等待和终态的接口不满足 completed 合同。

然后实现上述 stdin/result-file 协议，通过已有 `subagentCommands` 注册；不新增 worker 白名单、执行 revision、请求摘要链或 Guide 业务分支。认证、模型覆盖和停止能力只声明实际支持范围。自定义 workspace 写能力须单独取得实际授权和验证，不能从附带只读适配器外推。

确定性验证使用 `pnpm plugin:test codex-enhance`。重点源码为 [runtime tests](../plugins/codex-enhance/scripts/subagent-runtime.test.mjs)、[role-boundary provider tests](../plugins/codex-enhance/skills/codex-subagent-guide/evals/role-boundary-provider.test.mjs) 和 [qualification harness tests](../scripts/qualification/codex-enhance-external.test.mjs)。检查真实参数与输入、缺失或冲突终态、一次生成、输入更新后的原句柄、权限拒绝、明确材料及自有进程清理。

真实服务验证使用[外部 qualification 入口](../scripts/qualification/codex-enhance-external.mjs)和[现有角色及组合 Eval](../plugins/codex-enhance/skills/codex-subagent-guide/evals/ROLE-BOUNDARY.md)，遵守当时实际模型、费用、凭据、资料和进程许可。模型 Eval 的准备、独立 Oracle 审核与运行继续由[插件维护流程](plugin-maintenance.md)管理。

fake backend 只证明本地传输、参数、事件映射和清理；不能证明真实指令注入、只读范围、模型支持或服务终态。native 宿主、真实 workspace/bundle、其它 OS、远端取消和自定义写能力必须分别报告实际证据，未运行时保持未验证。

## 兼容与维护边界

当前实现仅接纳 installed-runtime-config v2 和 adapter v3。旧 v1 runtime 声明及 v2 adapter 请求/结果需要更新；不保留双轨调度实现。通过正常 build、sync 或 reinstall 更新安装资源，源码修改不会自动替换已安装 helper。

旧 `resolve`、`status`、`collect`、`cancel` 及 `--worker`、`--expected-revision`、`--require-isolation`、`--allow-model-cost`、`--allow-material-transfer`、`--runs-dir` 在生成前报不支持，也没有公开 resume。升级前用原工具完成或处理已知旧后台任务；新版不接管、删除其记录或根据遗留记录重新生成。

协议、能力声明或适配器实现变化时，同步本文件、相应配置说明和真实边界测试。调用参数、输入限制或结果含义变化时，再同步外部调用 reference；不把实现历史、后端开发流程或验证报告重新放回运行 Skill。
