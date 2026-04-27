# Hooks 公共层与 Agent 独享能力扩展计划

## 结论

当前 `agent-workflows` 把 `extensions.hooks` 定义成最小跨平台公共 contract，这个边界本身是合理的；问题在于源码层没有给 Claude / Codex 的原生 hooks 留出正式入口，导致插件作者遇到 `PermissionRequest`、`Notification`、`StopFailure`、`UserPromptSubmit`、`SubagentStart` 这类平台原生事件时，只能在公共层里等事件被纳入，或者绕过 CLI 管理的生成链路。

本次改造目标是保留公共 hooks，同时新增 agent 独享 hooks：

- `extensions.hooks` 继续表示可移植的公共 hook，保持跨平台语义稳定；首版只保留 `before_tool`、`after_tool`、`session_start`，其中公共 `session_start` 只覆盖 `startup / resume / clear` 这三个两端共有 source。
- `session_stop` 不再作为公共 `HookEvent`。Claude 的 `Stop` / `SessionEnd` 和 Codex 的 `Stop` 语义不等价，统一放到 `nativeHooks.<agent>`。
- 新增 `extensions.nativeHooks`，按 `claude` / `codex` 分平台声明原生事件。
- 渲染时把公共 hooks 和目标平台 native hooks 合并成同一个原生 hooks artifact。
- 校验、bundle source manifest、bundle、install、tracking、status、uninstall 都以“目标平台最终生效视图”为准，不能只看公共层。

首版不把 Claude / Codex 的原生 schema 全量复制成公共 API。公共层只收语义已经确认一致的事件；其余事件进入 `nativeHooks.<agent>`，由平台自己的 allowlist 控制。

## Review 复核结论

- review 中关于 `session_stop` 的问题成立：Claude `SessionEnd` 是 shutdown / clear 阶段的会话收尾 hook，Claude `Stop` 才是单轮结束 hook；Codex `Stop` 是 turn 级事件，输入带 `turn_id`，执行结果还能阻断或续接当前 turn。首版直接移除公共 `session_stop`，不新增兼容别名。
- review 中关于 bundle source manifest 的问题成立：`createBundleSourceManifest()` 当前只复制 `instructions / permissions / hooks / agents`，如果不显式复制 `nativeHooks`，embedded bundle 通过 catalog 模式读取时会静默丢字段。实现计划和测试矩阵必须覆盖 source -> bundle source manifest -> catalog 这条链路。
- 本轮 review 中关于公共 `session_start` 的问题成立：Claude `SessionStart` 的 source 包含 `startup / resume / clear / compact`，Codex 只有 `startup / resume / clear`。公共层必须只暴露共有子集；Claude `compact` 只能通过 `nativeHooks.claude[].event = "SessionStart"` 声明。
- 本轮 review 中关于 matcherless 原生事件的问题成立：Codex `UserPromptSubmit` / `Stop` 在 discovery 和 runtime 里都会丢弃 matcher，Claude `UserPromptSubmit` / `Stop` 运行时也不会构造 match query。计划需要用事件级 matcher 能力表收口 source、重复检测、tracking 和 rendered artifact，不能再把所有 native event 都当成 `{ event, matcher?, command }` 语义相同的事件。
- 本轮 review 中关于 Codex hooks 内部数据模型的问题成立：当前 `CodexHookGroup.matcher` 是必填字段，generator、tracking、drift、uninstall 和 generated artifact merge 都直接依赖这个旧 shape。实现时必须先拆开 rendered hook group 和 tracking identity，不能用 `matcher: ""` 或 `matcher: "*"` 伪装 matcherless 事件。
- 本轮 review 中关于 historical fallback / Claude capability snapshot 测试不足的问题成立：当前 Claude ledger 只记录 `instructions / permissions`，历史占位也只从这两类快照恢复能力。首版继续复用 `capabilitySnapshot.managedExtensions`，但必须把 `hooks` 纳入同一条状态链路和测试。
- 本轮 review 中关于 historical fallback 平台边界不清的问题成立：`CodexCapabilitySnapshot` 当前只有 `requiresNativePlugin / hasRepoManagedArtifacts` 两个布尔值，无法在 ledger-only 场景区分 repo-managed artifact 是 instruction、permission、hook 还是 agent。首版不扩展 Codex snapshot；“只有 ledger snapshot 也能恢复 hook 能力”的验收只覆盖 Claude。Codex 侧 historical fallback 恢复 hook kind 仍依赖 tracking artifact 或当前 catalog。
- 本轮 review 中关于 Claude native allowlist 测试锚点不足的问题成立：计划不能只写“至少覆盖”或只测代表事件，必须把当前上游 `HOOK_EVENTS` 的完整 command hook 事件集合和事件级 matcher 能力表写进计划，并用 source/rendered validator 测试锁住完整集合。
- 本轮 review 中关于 Codex shared hooks 读路径的问题成立：source manifest 和 CLI 自己生成的 rendered artifact 仍应严格拒绝 matcherless 事件中的 `matcher`，但读取现有 `.codex/hooks.json` 时不能比 Codex 运行时更苛刻。`UserPromptSubmit` / `Stop` 上已有的 inert matcher 应被 read-mode parser 接受并在 canonical identity 中丢弃，不能让 status、uninstall 或共享 hooks 重建被外部 runtime-valid 配置卡住。
- 本轮 review 中关于 Claude historical fallback 信息源的问题成立。首版不新增 Claude `kind: "hook"` tracking artifact；Claude hook kind 来自 current catalog 的目标平台生效视图或 ledger `capabilitySnapshot.managedExtensions`，Claude native runtime evidence 只作为已启用证据参与状态判断。tracking-based hook fallback 首版只承诺 Codex，未来若要让 Claude 也走 tracking，需要另起实现项。
- 本次复核中关于 Codex shared read mode matcher 接受面仍偏窄的问题成立：Codex `MatcherGroup.matcher` 在运行时是 `Option<String>`，字段缺省和 `null` 都合法；`PreToolUse` / `PermissionRequest` / `PostToolUse` / `SessionStart` 上的缺省、`null`、`""`、`"*"` 都是 match-all；`UserPromptSubmit` / `Stop` 会直接丢弃 matcher。计划必须按运行时有效形态做 read-mode canonicalization，而不能只接受 string matcher。
- 本次复核中关于 CLI 命令级 `nativeHooks` 回归缺口的问题成立：现有集成测试已经覆盖 hook-only 插件和 Codex shared hooks historical rebuild，但仍围绕公共 hooks；`nativeHooks` 会穿过 source manifest、bundle source manifest、embedded catalog、命令解析和 adapter install / uninstall / status，必须补命令级回归，不能只靠 unit 测试兜底。
- 本次 review 中关于 Codex 共享 `hooks.json` 不是 AW 独占文件的问题成立：当前 `syncCodexHooks()` 会按 AW 当前插件和 tracking 插件重建整份 `.codex/hooks.json`，install / upgrade / historical rebuild 都可能覆盖手工配置或其它工具写入的 hook groups。计划必须把 shared file raw groups 和 AW tracking identity 分开，写回时只替换 AW 管理的 groups，保留非 AW groups。
- 本次 review 中关于 Codex shared read-mode handler shape 收得过窄的问题成立：Codex schema 允许 `command` handler 带 `timeout`、`async`、`statusMessage`，也允许 `prompt` / `agent` handler；当前 runtime 只执行同步 command，保留 `timeout` 和 `statusMessage`，并跳过 `async` / `prompt` / `agent`。source contract 和 CLI 生成物仍只产出同步 command，但 shared read/write 链路必须把这些 runtime-valid 外部 groups 当作 opaque foreign groups 原样保留，不能因为 AW 首版不管理它们就拒绝整份共享文件。
- 本次复审中关于 Codex install / upgrade 主链路仍假设“其它 tracked hook 插件都能解析”的问题成立。共享 `.codex/hooks.json` 里的 group 不能只分成“当前可重渲染 AW group”和“外部 foreign group”，还必须单独处理“已被 AW tracking 记录、但对应插件当前不在 catalog / active local bundle 中”的历史 AW hook groups。首版明确选择保留策略：安装或升级插件 A 时，如果插件 B 的 tracking 仍在、hooks 文件里也还有 B 的既有 raw groups，但 B 当前不可解析，命令不能失败，也不能删掉 B 的 groups；这些 groups 按历史 AW raw groups 原样带过，等 B 后续显式 uninstall、重新可解析后 upgrade，或 hooks 文件自身 drift 处理时再变化。
- 本次复审中关于 Codex current catalog 缺失后的 status / drift 真值来源问题成立。`createHistoricalPluginMeta()` 只能生成“曾经有 hooks 能力”的占位 manifest，不能还原 `nativeHooks.codex` 的原始事件和 matcher；Codex status / drift 在 current catalog 缺失时必须改用 tracking artifact 中的 canonical hook identities 作为 expected groups。historical placeholder 只用于恢复能力和命令目标，不能参与 native hook group 明细比对。
- 本次复审中关于 Codex shared matcher group 的所有权边界问题成立。Codex 原生 schema 允许一个 matcher group 内包含多个 handlers，discovery 也是逐 handler 处理；但 AW 首版没有组内部分所有权模型。只有整个 raw matcher group 精确等于 AW 生成的单 handler、最小同步 `command` 形状时，才进入 AW managed identity。任何多 handler group，或“AW-looking command + 其它 handler / 额外 runtime 字段”的 mixed group，都按 opaque foreign raw group 原样保留，不参与 AW 去重、扣减或 drift 满足性判断。

## 设计边界

### 目标

- 支持“公共 hooks + Claude 独享 hooks + Codex 独享 hooks”共存。
- 公共 hooks 继续提供稳定的跨平台事件名和映射。
- 原生 hooks 使用平台原生事件名，减少额外映射层造成的误解。
- 最终产物继续对齐 Claude / Codex 当前真实消费的 `{ hooks: { <Event>: [...] } }` 结构。
- Codex 侧首版只支持当前运行时真正保留的同步 `command` hook handler。
- Codex 共享 `.codex/hooks.json` 按共享注册表处理。CLI 只能管理 AW 自己生成和 tracking 到的 hook groups，不能把整份文件视为 AW 独占产物。
- Codex shared hooks 的所有权单位是 raw matcher group，不是 group 内单个 handler。首版不支持组内部分所有权；只有整组精确匹配 AW 生成形状时才可认领。
- Codex install / upgrade / historical rebuild 不要求同一共享文件里的所有 tracked hook 插件都能从 current catalog 或 active local bundle 解析出来。当前不可解析但已有 tracking 和 raw group 的历史 AW hook groups 必须保留，不能被当成 foreign group 丢进无约束扣减，也不能阻断另一个插件的安装或升级。
- 所有新增能力都进入 CLI 管理的源码校验、构建、安装、卸载、状态和测试链路。

### 非目标

- 不把所有 Claude-only hooks 升级成公共 `HookEvent`。
- 不在 source manifest 或 `nativeHooks.codex` 中支持 Codex 当前会被 discovery 跳过的 `prompt` / `agent` handler，也不生成 `async` command hook。已有共享文件中的这些 runtime-valid 外部 handler 只做原样保留。
- 不新增顶层 `claude` / `codex` manifest block。
- 不允许通过 `buildConfig.manifestOverrides.claude.hooks` 写第二套 hooks 来源。
- 不支持 Codex shared matcher group 内的部分 handler 所有权。多 handler group 和 mixed handler group 都作为外部 raw group 保留，后续若要支持组内部分所有权，需要单独设计 raw group 到 identity 的映射与写回算法。
- 不为旧的非法 hooks artifact 设计兼容迁移；当前项目仍按开发阶段的新 contract 直接收口。

## Source Contract

### 1. 公共 hooks 收口为稳定入口

`extensions.hooks` 继续使用当前结构：

```json
{
  "event": "before_tool",
  "matcher": "Write",
  "command": "echo write"
}
```

首版公共事件集合只保留已经确认语义一致的 3 个事件：

| 公共事件 | Claude 渲染 | Codex 渲染 | 公共 matcher 语义 |
| --- | --- | --- | --- |
| `before_tool` | `PreToolUse` | `PreToolUse` | 工具名 matcher，沿用现有规则 |
| `after_tool` | `PostToolUse` | `PostToolUse` | 工具名 matcher，沿用现有规则 |
| `session_start` | `SessionStart` | `SessionStart` | 只允许 `startup`、`resume`、`clear` 或它们的 `|` 联合；不允许 `compact`、`*` 或正则 |

公共 `session_start` 的默认 matcher 不是平台原生 match-all，而是“全部可移植 source”。如果 source 中没有写 `matcher`，渲染 Claude / Codex artifact 时必须显式写成 `startup|resume|clear`，不能省略 matcher，也不能写 `*`。这样 Claude 在 conversation compact 后不会额外触发公共 hook；需要响应 Claude compact 的插件应改写：

```json
{
  "extensions": {
    "nativeHooks": {
      "claude": [
        {
          "event": "SessionStart",
          "matcher": "compact",
          "command": "echo claude compact session start"
        }
      ]
    }
  }
}
```

`session_stop` 从公共层移除，source manifest 校验阶段应直接拒绝 `extensions.hooks[].event = "session_stop"`，并在错误信息里指向 `extensions.nativeHooks.claude[].event = "Stop" / "SessionEnd"` 或 `extensions.nativeHooks.codex[].event = "Stop"`。

本轮不新增 `turn_stop` 这样的公共事件。若未来要把“单轮结束”提升成公共语义，需要单独复核 Claude `Stop` 与 Codex `Stop` 的输入、输出、阻断和续接语义，再以新公共事件名进入 `HookEvent`，不能复用 `session_stop`。

`PermissionRequest` 虽然两端都有原生事件，但需要先复核两端 matcher 语义、输入 payload 和命令返回处理是否足够一致。若确认一致，再单独把 `permission_request` 提升为公共事件；在提升前，插件作者可以分别写入 `nativeHooks.claude` 和 `nativeHooks.codex`。

### 2. 新增 `extensions.nativeHooks`

新增字段：

```json
{
  "extensions": {
    "hooks": [
      {
        "event": "before_tool",
        "matcher": "Write",
        "command": "echo shared write check"
      }
    ],
    "nativeHooks": {
      "claude": [
        {
          "event": "Notification",
          "matcher": "*",
          "command": "echo claude notification"
        },
        {
          "event": "SessionEnd",
          "matcher": "*",
          "command": "echo claude session end"
        }
      ],
      "codex": [
        {
          "event": "UserPromptSubmit",
          "command": "echo codex prompt submitted"
        },
        {
          "event": "Stop",
          "command": "echo codex turn stopped"
        }
      ]
    }
  }
}
```

字段规则：

- `nativeHooks` 只允许 `claude` 和 `codex` 两个 key。
- `nativeHooks.<agent>[]` 中的 `event` 使用该平台原生事件名，例如 `Notification`、`StopFailure`、`UserPromptSubmit`。
- 每条 native hook 首版只支持 `command` handler，source 结构仍是 `{ event, matcher?, command }`，但 `matcher` 是否允许由事件级能力表决定。
- 对 matcherless 原生事件，source manifest 直接拒绝 `matcher` 字段，不做静默忽略。Claude 按下方完整 matcherless 集合处理，Codex 首版覆盖 `UserPromptSubmit` 和 `Stop`。
- `nativeHooks.<agent>[]` 不再支持 `agentOverrides`。它已经是目标平台专属声明，继续嵌套覆盖会让来源难以解释。
- 公共 hooks 仍可使用 `agentOverrides` 做目标平台排除或字段覆盖。
- 同一目标平台最终合并后，如果出现 canonical form 相同的原生 `event + effectiveMatcher + command`，校验阶段应报错，避免同一 hook 被公共层和 native 层重复触发。matcherless 事件的 `effectiveMatcher` 固定为空；公共 `session_start` 未写 matcher 时的 `effectiveMatcher` 固定为 `startup|resume|clear`。

### 3. 原生事件 allowlist

在代码中集中维护 allowlist，不散落到 validator、generator 和 rendered validator 中。

Claude 首版允许当前上游 SDK / plugin schema 中可配置为 command hook 的完整事件集合。事件清单以 2026-04-27 复核的 Claude Code `src/entrypoints/sdk/coreSchemas.ts` 中 `HOOK_EVENTS` 为准；matcher 能力以 `src/utils/hooks/hooksConfigManager.ts` 的 `HookEventMetadata.matcherMetadata` 和 `src/utils/hooks.ts` 的 runtime `matchQuery` 为准。实现代码中的 allowlist 必须标明这些来源文件和核对日期，测试也要锁住完整集合，不能只测代表事件。

Claude native allowlist 首版完整事件集合：

- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `Notification`
- `UserPromptSubmit`
- `SessionStart`
- `SessionEnd`
- `Stop`
- `StopFailure`
- `SubagentStart`
- `SubagentStop`
- `PreCompact`
- `PostCompact`
- `PermissionRequest`
- `PermissionDenied`
- `Setup`
- `TeammateIdle`
- `TaskCreated`
- `TaskCompleted`
- `Elicitation`
- `ElicitationResult`
- `ConfigChange`
- `WorktreeCreate`
- `WorktreeRemove`
- `InstructionsLoaded`
- `CwdChanged`
- `FileChanged`

Claude 事件级 matcher 能力表：

- 允许 `matcher`：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`PermissionDenied`、`Notification`、`SessionStart`、`SessionEnd`、`StopFailure`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PostCompact`、`Setup`、`Elicitation`、`ElicitationResult`、`ConfigChange`、`InstructionsLoaded`、`FileChanged`。
- 拒绝 `matcher`：`UserPromptSubmit`、`Stop`、`TeammateIdle`、`TaskCreated`、`TaskCompleted`、`WorktreeCreate`、`WorktreeRemove`、`CwdChanged`。

`FileChanged` 是特例：上游 UI metadata 没有显式 `matcherMetadata`，但说明文档写明 matcher 用于文件名匹配，runtime 也用 `basename(file_path)` 构造 `matchQuery`。首版按 runtime 行为允许 `matcher`，并在代码注释里注明这个来源。

Codex 首版允许配置 schema 中声明且 command handler 可被运行时保留的事件，并按运行时 matcher 行为分两类：

- 允许 matcher：`PreToolUse`、`PermissionRequest`、`PostToolUse`、`SessionStart`
- 拒绝 matcher：`UserPromptSubmit`、`Stop`

如果后续 Codex discovery 开始真正执行 `prompt` 或 `agent` handler，再扩展 source / generated handler schema；这次不要提前暴露。已有共享文件里的 `prompt` / `agent` 只按外部 runtime-valid 配置保留。

## 实现计划

### 1. 收口 hook contract 常量

新增或整理 `packages/cli/src/utils/hooks-contract.ts`：

- `PUBLIC_HOOK_EVENTS`：只包含 `before_tool`、`after_tool`、`session_start`
- `PUBLIC_SESSION_START_SOURCES`：只包含 `startup`、`resume`、`clear`
- `PUBLIC_HOOK_EVENT_RENDER_MAP`：只维护上述 3 个公共事件的 Claude / Codex 映射
- `CLAUDE_NATIVE_HOOK_EVENTS`：完整列出 2026-04-27 复核的 Claude `HOOK_EVENTS`，不要用“其余事件”动态兜底
- `CODEX_NATIVE_HOOK_EVENTS`
- `NATIVE_HOOK_EVENT_CONTRACTS` 或同等结构：记录每个平台每个原生事件是否允许 matcher，以及可选的 matcher 枚举值；Claude 表必须覆盖 `CLAUDE_NATIVE_HOOK_EVENTS` 的每个事件且不能有缺口
- `renderPublicHookEvent(event, platform)`
- `assertNativeHookEvent(event, platform, fieldName)`
- `assertHookMatcherAllowed(...)`：按公共事件或 native 事件校验 matcher 能力
- `normalizeRenderedHookGroupIdentity(...)`：生成重复检测、tracking、status 共用的 canonical identity
- `resolveCodexExpectedHookIdentitiesForStatus(...)` 或同等 helper：统一决定 Codex status / drift 的 expected groups 来源。current catalog 可用且插件可解析时，从目标平台最终生效视图渲染 canonical identities；current catalog 缺失但 tracking artifact 有 hook identities 时，直接使用 tracking 中记录的 canonical identities；只有 historical placeholder 而没有可比较 tracking identities 时，不允许从 placeholder `extensions.hooks` 反推 expected groups。
- `normalizeCodexSharedHookGroupForRead(...)` 或同等 read-mode helper：读取外部 `.codex/hooks.json` 时接受 Codex 运行时有效 matcher 形态，并且只在整个 raw matcher group 精确等于 AW 生成形状时，才转成 tracking / status / drift 共用的 canonical identity
- `parseCodexSharedHooksFile(...)` 或同等 shared-file parser：读取整份共享 `hooks.json`，同时返回 raw groups、可参与 AW 比较的 managed identity multiset，以及 runtime-valid 但 AW 首版不管理的 opaque raw groups。这个 helper 不能把 shared 文件降级成 AW-only 的 `CodexHookGroup[]`，最终“本次重渲染 / 历史 AW 保留 / foreign 保留”的分类交给写回计划决定。
- `planCodexSharedHooksUpdate(...)` 或同等 helper：把共享文件中的 raw groups 按本次写回意图区分为三类：
  - 本次确定会重渲染的 AW groups：当前插件，以及当前仍能从 current catalog 或 active local bundle 解析的其它 tracked hook 插件。
  - 当前不可解析的历史 AW groups：tracking 中记录了 hook identity，但插件当前不能解析成 `PluginMeta`，且共享文件里仍存在可按 tracking identity 命中的 raw groups；写回时必须原样保留。
  - 非 AW foreign raw groups：不属于 AW tracking identity，或属于 runtime-valid 但 AW 首版不管理的 handler shape；写回时也必须原样保留。
  只有第一类可以从 raw groups 中扣掉后用新渲染结果替换；第二类和第三类都不能被扣减、格式化或重渲染。

`types.ts` 中新增：

- `NativeHookDefinition`
- `NativeHooksByPlatform`
- `PluginExtensions.nativeHooks?: NativeHooksByPlatform`
- `RenderedHookGroup` 或同等类型：表示最终 artifact 中的 hook group，`matcher` 必须是可选字段；matcherless 事件不写 `matcher`
- `TrackedHookGroupIdentity` 或同等类型：表示 tracking / drift / uninstall 使用的 canonical identity，不能直接复用 rendered artifact 类型；matcherless 事件同样不记录伪 matcher
- `CodexSharedHookGroup` 或同等类型：表示从共享 `.codex/hooks.json` 读出的 raw group，保留 `matcher` 字段是否缺省、`null`、字符串以及 handler 上的 `timeout`、`async`、`statusMessage`、`prompt`、`agent` 等 runtime-valid 原始字段，用于无损写回外部 groups。

同时保留 `HookDefinition` 的公共语义，不把 native event 混进 `HookEvent`。`HookEvent` 中移除 `session_stop`，所有旧 fixture、测试断言和文档示例同步改掉。

这一层要明确处理 Codex hooks 的旧模型：

- `CodexHookGroup` 不能继续同时代表“准备渲染到 hooks.json 的结构”和“tracking 中的稳定 identity”。即使最终字段相近，也要用独立类型表达两种语义。
- `normalizeRenderedHookGroupIdentity(...)` 是唯一的 identity 入口，负责把事件名、事件级 matcher 能力和 command handler 规整成可比较形态。
- Codex shared read mode 要覆盖 6 个 Codex 事件的运行时 matcher 语义：`PreToolUse`、`PermissionRequest`、`PostToolUse`、`SessionStart` 是 matcher-capable；`UserPromptSubmit`、`Stop` 是 matcherless runtime event。
- 对 Codex matcher-capable 事件，read-mode identity 必须把 `matcher` 缺省、`null`、`""`、`"*"` 规整成同一个 match-all identity。这个 identity 是内部比较语义，不应把 `""` 或 `*` 当成唯一真值写进 tracking。
- 对 Codex `UserPromptSubmit` / `Stop`，read-mode identity 必须把缺省、`null` 或任意 string matcher 都规整成“无 matcher”；其它 JSON 类型仍不是 Codex runtime-valid `Option<String>`，应报错。
- 对 matcherless 事件，identity 中的 matcher 应保持缺省或 `null` 这类“无 matcher”语义；不要把空字符串、`*` 或其它运行时会忽略的值写入 `matcher` 字段。
- 对 Codex shared 文件中的 raw matcher group，只有“整组精确等于 CLI 自己生成的最小同步 command shape”才进入 AW tracking identity：`hooks` 数组长度必须为 1，唯一 handler 必须是 `{ type: "command", command: string }`，且 group 和 handler 上都不能带 AW 不理解但可能影响运行时语义的额外字段。带 `timeout` / `statusMessage` 的 command、显式 `async` command、`prompt` 和 `agent` 都按 foreign raw group 保留，不参与 AW 去重、扣减和漂移判断。
- 单个 raw matcher group 里只要出现多个 handlers，无论它们是否都是最小同步 command，整组都视为 opaque foreign raw group；如果一个 group 里同时包含 AW-looking command 和 `prompt` / `agent` / `timeout` / `statusMessage` / `async` handler，也不能只认领其中一部分。
- 同一 `event + matcher + command` 但 handler runtime 字段不同的外部 group 不能被 canonical identity 合并；尤其不能因为 AW tracking identity 忽略 `timeout` / `statusMessage` 而误删或覆盖外部配置。
- 如果 AW 期望的 identity 只出现在 multi-handler 或 mixed foreign group 内，status / drift 不能把它当成已满足；应报告 drift / missing，必要时附带 unmanaged overlap 诊断，提示该 handler 存在于 AW 不可安全管理的 raw group 中。
- 当前不可解析的历史 AW hook groups 与普通 foreign groups 要分开建模：它们仍是 AW 曾经管理过的 groups，但本次 install / upgrade 没有足够 source 信息重渲染。它们只能通过 tracking identity 在现有 shared 文件中定位并原样保留，不能因为 `resolveTrackedPlugin()` 失败就让整个命令失败，也不能因为“已被 AW tracking 记录”就被无条件扣掉。
- Codex historical placeholder 不能进入 hook group identity 计算。它只表示命令层能把插件当作 hook-capable 历史目标处理；只要 status / drift 需要比较 `.codex/hooks.json`，expected identities 必须来自 current catalog 的目标平台生效视图或 Codex tracking artifact。否则要返回明确诊断或 `unknown` 状态，不能拿 placeholder 的 `session_start` 占位去误报 native groups 缺失。
- `compareCodexHookGroups()`、`serializeCodexHookGroup()`、`normalizeCodexHookGroups()`、`codexHookGroupsContainAll()`、`subtractCodexHookGroups()` 都要迁移到新的 canonical identity helper，不能继续直接读 `group.matcher`。
- `GeneratedArtifact.hookGroups` 改为保存 tracking identity；`mergeGeneratedArtifacts()` 的去重 key 也必须走 canonical identity，避免 optional matcher 因原始 JSON shape 差异产生重复记录。

### 2. 更新 source manifest 读取与校验

修改 `packages/cli/src/utils/manifest.ts`：

- 从 `PUBLIC_HOOK_EVENTS` 中移除 `session_stop`，并在 source 校验阶段拒绝公共 `event: "session_stop"`。
- 对公共 `session_start.matcher` 做事件级约束：只能省略，或写 `startup` / `resume` / `clear` / 这些值的 `|` 联合；拒绝 `compact`、`*` 和正则。`agentOverrides.<platform>.matcher` 覆盖后也要重新校验。
- 校验 `extensions.nativeHooks` 的对象形状和合法 key。
- 对 `nativeHooks.claude[].event` 使用 Claude allowlist。
- 对 `nativeHooks.codex[].event` 使用 Codex allowlist。
- 校验 native hook 的 `command` 与公共 hook 一致；`matcher` 依据事件级能力表处理，matcherless 事件直接拒绝 `matcher`。
- 拒绝 `nativeHooks.*[].agentOverrides`、`description` 等非 contract 字段。
- 在同一目标平台生效视图中检查公共 hook 与 native hook 的 canonical 重复；重复判断不能依赖原始 `matcher` 字符串是否存在。
- 更新 `createBundleSourceManifest()`，深拷贝 `extensions.nativeHooks.claude` / `extensions.nativeHooks.codex`，确保 embedded bundle 的 `.agents-plugin/plugin.json` 不会丢失新增 source contract 字段。

这里要继续区分 source contract 和 rendered contract：source 层负责声明语义合法，rendered 层负责最终 artifact 形状合法。

### 3. 改造 hooks generator

修改 `packages/cli/src/generators/hooks.ts`：

- 保留公共 hook 事件映射函数。
- 新增 native hook 到原生 hook group 的转换函数，不再做事件名映射。
- 新增 `resolvePlatformHookDefinitions(plugin, platform)` 或同等 helper：
  - 先取 `resolvePlatformEntries(plugin.manifest.extensions?.hooks, platform)`
  - 再追加 `plugin.manifest.extensions?.nativeHooks?.[platform]`
  - 输出统一的 rendered hook groups，并已完成 matcher canonicalization
- 生成器不再接受或映射公共 `session_stop`；Claude / Codex 的 stop 类事件只能来自目标平台 native hooks。
- 公共 `session_start` 未写 matcher 时，渲染为 `matcher: "startup|resume|clear"`；写了 matcher 时必须已经通过 source validator 的公共子集校验。
- matcherless native 事件渲染时不写 `matcher` 字段；tracking identity 中也表达为“无 matcher”，不写伪 matcher。
- 合并后稳定排序，保持构建产物可复现。
- 对 Codex `renderCodexHooks(...)` 继续支持多插件聚合，聚合输入必须包含公共 hooks 和 Codex native hooks。

### 4. 更新 rendered contract

修改 `packages/cli/src/utils/rendered-contract.ts`：

- `validateRenderedClaudeHooksContent(...)` 的允许事件扩展为 Claude native allowlist。
- `validateRenderedCodexHooksContent(...)` 的允许事件扩展为 Codex native allowlist。
- rendered contract 分成两种模式：
  - strict generated mode：用于 CLI 自己生成的 artifact、bundle preflight 和写入前校验。它使用同一份事件级 matcher 能力表，matcherless 事件中出现 `matcher` 直接报错，保证公共层和 native 层生成的 artifact 不会留下被运行时忽略的伪 matcher。
  - Codex shared read/write mode：用于读取和写回现有 `.codex/hooks.json`。它仍校验顶层结构和事件 allowlist，但 matcher 按 Codex 运行时的 `Option<String>` 语义读取：字段缺省、`null` 或 string 合法，number / boolean / array / object 仍报错。对 `PreToolUse` / `PermissionRequest` / `PostToolUse` / `SessionStart`，缺省、`null`、`""`、`"*"` 统一规整成 match-all identity，其余 string 保留为 matcher identity；对 `UserPromptSubmit` / `Stop`，缺省、`null` 或任意 string matcher 都视为 inert，并在 canonical identity 中丢弃。这个模式不用于 source manifest，也不用于 CLI 生成物写入。
- strict generated mode 中，handler 首版只接受 `{ "type": "command", "command": string }`。
- Codex shared read/write mode 中，handler shape 要对齐当前 Codex schema：只有整组恰好包含一个最小同步 `command` handler 时才可进入 AW identity；带 `timeout`、`statusMessage` 或显式 `async` 字段的 command 都按 foreign raw group 原样保留，其中 `async: true` 是 runtime 会跳过的外部 handler。`prompt` 和 `agent` 也作为 foreign raw groups 保留。`async` 不是 boolean、`timeout` 不是非负整数、`statusMessage` 不是 string，或 handler `type` 不在当前 schema 中时仍应报错。
- shared read/write mode 产出的 canonical identity 只覆盖 AW 可管理的单 handler、最小同步 command raw groups；任何多 handler 或 mixed raw group 都不拆分，不参与 AW 的 identity、dedupe、subtract 或 drift 满足性判断，也不能被 renderer 重新格式化后丢字段。
- 保持顶层 `{ hooks: { <Event>: [groups] } }` 校验，避免回退到旧 `{ commands: [...] }`。

### 5. 接入 bundle 与安装主链路

修改 `packages/cli/src/utils/manifest.ts`：

- `createBundleSourceManifest(plugin)` 必须复制 `extensions.nativeHooks`，并保持深拷贝语义，避免 bundle source manifest 被测试修改时污染原 manifest。
- `resolvePluginsFromCatalog()` 读取 embedded bundle 时，返回的 `PluginMeta.manifest.extensions.nativeHooks` 应与 source manifest 一致。

修改 `packages/cli/src/generators/local-plugin.ts`：

- Claude bundle 生成 `claude/hooks/hooks.json` 时合并公共 hooks 和 `nativeHooks.claude`。
- `.claude-plugin/plugin.json.hooks` 继续只指向 `./claude/hooks/hooks.json`。

修改 `packages/cli/src/adapters/codex.ts`：

- `hasRepoManagedArtifacts(...)` 要把 `nativeHooks.codex` 也算作 hooks artifact。
- install / upgrade 写 `.codex/hooks.json` 或 user hooks 时，聚合公共 hooks 和 `nativeHooks.codex`。
- install / upgrade 写 `.codex/hooks.json` 前必须先读取现有共享文件，并生成一次 shared hooks 写回计划：
  - 当前目标插件一定进入本次重渲染集合。
  - 其它 tracked hook 插件要逐个解析；能从 current catalog 或 active local bundle 解析的，进入本次重渲染集合。
  - 解析不到的其它 tracked hook 插件进入“历史 AW raw groups 保留集合”。只要现有共享文件里能用 tracking identity 命中它们的 raw groups，就按原始 JSON shape 保留；如果共享文件里已经缺失，只记录 drift / missing 风险，不阻断当前目标插件的 install / upgrade。
  - 非 AW foreign raw groups 继续原样保留。
  写回时只能从 raw groups 中扣除“本次重渲染集合”的旧 AW identities，再追加这些插件的新渲染结果；不可解析历史 AW groups 和 foreign groups 都不能被扣掉。没有任何本次可写入的 AW hook groups 时，也只能移除本次明确管理的 groups，不能删除仍包含历史 AW raw groups 或 foreign groups 的共享文件。
- install / upgrade / uninstall 的扣减只能命中整组 AW-managed raw group。若 tracking identity 对应的 `event + matcher + command` 只作为 multi-handler 或 mixed foreign group 里的某个 handler 出现，当前命令不能拆组删除或改写它；status / drift 再报告该 expected group 未由 AW-managed group 满足。
- `resolveTrackedPlugins()` 不能继续作为 install / upgrade 的硬前提。需要拆成“尽力解析其它 tracked 插件”的 helper，返回可重渲染插件、不可解析但有 hook tracking 的历史记录，以及真实异常。只有读取 tracking manifest、解析 shared hooks 文件或当前目标插件自身非法这类会导致写坏文件的问题才应失败；无关历史插件不可解析不是失败条件。
- tracking manifest 中的 hook groups 必须记录最终渲染后的事件名、事件级 canonical matcher 和 handler；matcherless 事件不记录伪 matcher，也不能为了兼容旧类型写 `matcher: ""` 或 `matcher: "*"`。
- uninstall 根据 tracking 中的最终 hook groups 精确移除，不重新猜 source。
- status / drift 检测要核对当前共享 hooks 文件是否仍包含当前插件自己的公共和 native hook groups；expected groups 的来源必须按优先级处理：
  - 当前 catalog 或 active local bundle 能解析插件时，从公共 hooks 与 `nativeHooks.codex` 合并后的目标平台生效视图生成 canonical identities。
  - current catalog 缺失但 tracking artifact 记录了 hook identities 时，以 tracking 中的 canonical identities 为准，不能再从 historical placeholder 的 `extensions.hooks` 生成 expected groups。
  - 如果 tracking artifact 只能说明 `kind: "hook"`，但没有可比较 hook identities，status / drift 应返回清晰诊断或 `unknown` 语义，提示无法核对历史 Codex hook groups；不能把 placeholder `session_start` 当成 expected groups 后误报 drift。
- historical rebuild 的 fallback 分支同样不能按 AW-only 视角重建整份共享文件；即使当前 catalog 缺失，也要使用同一套三类分流：只替换本次能恢复或重渲染的 AW groups，保留当前不可解析的历史 AW raw groups 和 foreign raw groups，再写回恢复出的 AW groups。
- 读取现有 `.codex/hooks.json` 时，不能直接复用 strict generated validator 作为第一道门。应使用 Codex shared read/write mode：所有事件上的 `matcher` 字段缺省、`null` 或 string 都按 Codex runtime-valid 输入处理；`PreToolUse` / `PermissionRequest` / `PostToolUse` / `SessionStart` 上的缺省、`null`、`""`、`"*"` 进入 tracking identity、multiset compare 和重建输入前统一规整为 match-all；`UserPromptSubmit` / `Stop` 上的缺省、`null` 或 string matcher 统一丢弃。unknown event、非法 matcher JSON 类型、非法 handler 字段仍应报错。
- 扣减、包含性判断和共享 hooks 重建都使用 AW tracking identity 做 multiset 比较，但 identity 只能来自整组 AW-managed raw group；写回时把 preserved historical AW raw groups、preserved foreign raw groups 和新渲染的 AW groups 合并，不能把需要原样保留的 raw groups 送进 strict generated renderer 后丢字段。

Claude adapter 若有基于 capability snapshot 或 status 的 hooks 判断，也必须使用同一套目标平台生效视图。

### 6. 更新 historical fallback 与状态视图

检查并更新：

- `packages/cli/src/commands/common.ts`
- Claude adapter 的 ledger `capabilitySnapshot`
- Codex adapter 的 status / tracking / current catalog 生效视图
- `createHistoricalExtensionKinds(...)`
- `createHistoricalPluginMeta(...)`

原则是：只要目标平台最终存在任意公共 hook 或 native hook，都应被视为该平台有 hooks 能力；但状态说明里不需要把公共和 native 分成两个用户可见能力。

historical fallback 要分清信息来源：

- 当前 catalog 可用时，Claude / Codex 都从目标平台生效视图识别公共 hooks 和 native hooks。
- Codex tracking artifact 可用时，可以从 `artifact.kind === "hook"` 恢复历史 hook kind；如果 artifact 同时记录了 hook identities，Codex status / drift 在 current catalog 缺失时也必须用这些 identities 作为 expected groups。
- Claude 首版不新增 `kind: "hook"` tracking artifact，也不把 tracking manifest 作为 hooks 能力信息源。Claude hook-only 能力由 current catalog、Claude native runtime evidence 和 ledger snapshot 三条链路覆盖；其中 runtime evidence 只证明插件在目标 scope 已启用，hook kind 仍来自 current catalog 或 ledger snapshot。
- 只有 Claude ledger snapshot、没有当前 catalog、也没有 hook tracking artifact 时，首版仍要求 Claude 能恢复 hook-only 能力。
- Codex 首版不从 `CodexCapabilitySnapshot.hasRepoManagedArtifacts` 合成 hook placeholder。这个布尔值只能说明曾经有 repo-managed artifact，无法判断 artifact kind；误合成 hook 会把 instruction / permission / agent-only 插件错误恢复成 hook 插件。

Claude 侧首版继续复用 `capabilitySnapshot.managedExtensions`，新增 `hooks` 作为 managed extension kind：

- `getClaudeManagedExtensions(plugin)` 必须把公共 hooks 和 `nativeHooks.claude` 合并后的 Claude 生效视图计入 `hooks`。
- `applyClaudeInstallLedger()` 写入 snapshot 时要包含 `hooks`，hook-only 插件不能得到空的 `managedExtensions`。
- `resolveClaudeCatalogCompatibility()` 比较当前能力和已安装 snapshot 时要把 `hooks` 当成普通 managed extension 处理，catalog 缺失或能力变化时不能把 hooks 误判成不存在。
- `createHistoricalPluginMeta()` 从 Claude ledger snapshot 恢复历史占位时，要能把 `managedExtensions: ["hooks"]` 还原成带平台 override 的 `extensions.hooks` placeholder。
- `loadPluginTargetsForCommand(..., allowHistoricalFallback: true)` 在当前 catalog 缺失时，也要保留历史 hooks 能力，供 status、uninstall 和后续 rebuild 使用。
- `installExtensions()` 首版不因为 Claude hooks 额外产出 `GeneratedArtifact.kind = "hook"`。Claude hooks 来自 Claude 插件 bundle，不是 CLI 额外写入的 repo-managed hook artifact；`repoManagedSessionState.hooks` 仍按这个边界处理，不用 tracking artifact 表示它。

Codex 侧本轮只做当前能力识别和 tracking 恢复，不扩展 ledger snapshot 表达力：

- `hasRepoManagedArtifacts(plugin)` 必须把公共 hooks 和 `nativeHooks.codex` 都计入 repo-managed artifact evidence，保证安装后状态判断知道这类插件写过 repo artifact。
- `createHistoricalPluginMeta()` 只能在 Codex tracking artifact 明确记录 `kind: "hook"` 时恢复 Codex hook placeholder，不能仅凭 `hasRepoManagedArtifacts: true` 恢复 hook。
- Codex historical placeholder 的 `extensions.hooks` 只服务于“有 hook 能力”的命令目标恢复，不是 status / drift 的 expected hook group 来源。特别是历史插件原本只声明 `nativeHooks.codex`，或公共 hooks 与 native hooks 混合声明时，current catalog 缺失后仍应以 tracking identities 和现有 shared hooks 文件为准判断可见性。
- 如果历史 Codex hook tracking 缺少 identities，`loadPluginTargetsForCommand(..., allowHistoricalFallback: true)` 仍可返回 hook-capable placeholder，但 adapter status 必须给出“无法核对历史 hook 明细”的诊断或 `unknown`，不能退回到 placeholder hook 声明做错误比对。
- 如果未来要支持 Codex ledger-only hook-only 恢复，必须先扩展 `CodexCapabilitySnapshot`，至少记录 repo-managed extension kinds，再同步更新 `applyCodexInstallLedger()`、`createHistoricalPluginMeta()` 和 `loadPluginTargetsForCommand()`；这不纳入首版。

### 7. 更新作者工具与文档

需要同步改动：

- `.agents/skills/create-agent-workflows-plugin/SKILL.md`
- `.agents/skills/create-agent-workflows-plugin/references/extensions-spec.md`
- `.agents/skills/create-agent-workflows-plugin/references/comprehensive-example.md`
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`
- `docs/coding-conventions.md`
- `docs/plugin-authoring.md`
- `docs/plugin-installation.md`

文档需要讲清楚这些事：

- `extensions.hooks` 是公共 hook，不等于 Claude / Codex 原生全集。
- 公共 `session_start` 只表示 `startup / resume / clear`，Claude compact 场景要写 `nativeHooks.claude.SessionStart`。
- `extensions.nativeHooks.<agent>` 是平台独享 hook 入口，事件名写原生名。
- `matcher` 不是所有事件都有语义；matcherless 事件不要写 `matcher`。
- `agentOverrides` 用于公共条目的平台排除或字段覆盖，不用于新增原生事件。
- `session_stop` 已从公共 hook 中移除；Claude `Stop` / `SessionEnd`、Codex `Stop` 应写到对应平台的 `nativeHooks`。

### 8. 测试矩阵

新增或更新测试：

- `packages/cli/tests/unit/manifest.test.ts`
  - 接受合法 `nativeHooks.claude` / `nativeHooks.codex`
  - 拒绝未知 agent key
  - 拒绝目标平台不支持的原生事件
  - 接受完整 Claude native allowlist 中的每个事件，不只覆盖代表事件
  - Claude matcher 能力表覆盖完整 allowlist：允许 matcher 的事件都能通过，拒绝 matcher 的事件都必须报错
  - 拒绝 native hook 中的 `agentOverrides`
  - 拒绝公共 `event: "session_stop"`，并覆盖 `agentOverrides.<platform>.event = "session_stop"` 的负例
  - 拒绝公共 `session_start.matcher = "compact"`、`"*"` 和会匹配 compact 的正则
  - 接受公共 `session_start.matcher = "startup"`、`"resume"`、`"clear"`、`"startup|resume|clear"`
  - 拒绝 matcherless native 事件携带 `matcher`，Claude 覆盖完整 matcherless 集合，Codex 覆盖 `UserPromptSubmit` / `Stop`
  - 拒绝同一目标平台公共 + native 的 canonical 重复 hook
  - 对 matcherless 事件，重复检测 helper 用 canonical identity 覆盖“运行时等价但 source 字符串不同”的情况，避免以后改成宽松策略时漏掉重复触发
- `packages/cli/tests/unit/hooks-contract.test.ts` 或同等覆盖
  - `CLAUDE_NATIVE_HOOK_EVENTS` 与 2026-04-27 复核的 Claude `HOOK_EVENTS` 快照完全一致
  - `NATIVE_HOOK_EVENT_CONTRACTS.claude` 对每个 Claude allowlist 事件都有 matcher 能力定义，没有 missing / extra event
  - Claude matcher / matcherless 两组事件互斥且并集等于完整 allowlist，`FileChanged` 特例有单独断言
- `packages/cli/tests/unit/manifest-coverage.test.ts`
  - `createBundleSourceManifest()` 深拷贝 `extensions.nativeHooks`
  - 修改 bundle source manifest 的 `nativeHooks` 不会污染原始 plugin manifest
  - `resolvePluginsFromCatalog()` 或同等 build-free catalog fixture 能从 synthetic embedded root 读回 `nativeHooks`
- `packages/cli/tests/unit/generators.test.ts`
  - Claude hooks artifact 同时包含公共事件和 Claude native 事件
  - Codex hooks artifact 同时包含公共事件和 Codex native 事件
  - 公共事件映射测试只断言 `before_tool`、`after_tool`、`session_start`；stop 类输出改用 native hook 用例覆盖
  - 公共 `session_start` 未写 matcher 时，Claude / Codex artifact 都渲染为 `matcher: "startup|resume|clear"`，不会渲染成 `*` 或省略 matcher
  - matcherless native 事件生成的 hook group 不带 `matcher`
  - 排序稳定
- `packages/cli/tests/unit/rendered-contract.test.ts`
  - Claude validator 接受完整 Claude native allowlist 中的每个事件
  - Claude validator 拒绝 allowlist 之外的事件
  - Codex validator 接受 6 个 Codex native 事件
  - strict generated validator 在两端都拒绝 matcherless 事件中的 `matcher`；Claude 覆盖完整 matcherless 集合
  - strict generated validator 在两端都拒绝非最小同步 command handler；Codex generated mode 也拒绝 `timeout`、`async`、`statusMessage`、`prompt`、`agent`
  - Codex shared read mode 接受 `matcher` 缺省和 `matcher: null`，覆盖 6 个 Codex 事件
  - Codex shared read mode 对 `PreToolUse` / `PermissionRequest` / `PostToolUse` / `SessionStart` 把缺省、`null`、`""`、`"*"` 统一规整成 match-all identity
  - Codex shared read mode 接受 `UserPromptSubmit` / `Stop` 携带 inert matcher，并把缺省、`null` 和 string matcher 都规整为“无 matcher”
  - Codex shared read mode 拒绝 number / boolean / array / object matcher，确认 read-mode 只放宽到 Codex runtime-valid `Option<String>`
  - Codex shared read/write mode 接受并原样保留外部 command handler 的 `timeout` 和 `statusMessage`
  - Codex shared read/write mode 把 `async: true` command、`prompt` 和 `agent` handler 分类为 opaque foreign groups，不参与 AW canonical identity
  - Codex shared read/write mode 中，同一 `event + matcher + command` 但 `timeout` / `statusMessage` 不同的外部 groups 不会被合并成同一个 AW identity
  - Codex shared read/write mode 中，单个 raw group 包含两个最小同步 command handlers 时，整组分类为 opaque foreign group，不拆成两个 AW identities
  - Codex shared read/write mode 中，单个 raw group 同时包含 AW-looking command 和 `prompt` / `agent` / `timeout` / `statusMessage` / `async` handler 时，整组分类为 opaque foreign group，不允许组内部分认领
- `packages/cli/tests/unit/tracking.test.ts`
  - tracking record 可以 round-trip 不带 `matcher` 的 hook group identity
  - tracking identity 对 Codex matcher-capable 事件上的 match-all 形态只记录一种 canonical identity，不把缺省、`null`、`""`、`"*"` 当成不同 handler
  - `hasTrackingArtifacts(record, "hook")` 对 matcherless hook group 仍然返回正确结果
  - 历史 tracking 中的 hook identity 不需要伪 matcher 就能参与恢复
- `packages/cli/tests/unit/generated-artifacts.test.ts` 或同等覆盖
  - `mergeGeneratedArtifacts()` 对 hook groups 使用 canonical identity 去重
  - Codex matcher-capable 事件不会因为 match-all 形态是缺省、`null`、`""` 或 `"*"` 产生重复 artifact
  - matcherless hook group 不会因为 `matcher` 缺省、`null` 或旧输入清洗后的 shape 差异产生重复 artifact
  - 带 matcher 与 matcherless 事件的去重 key 不会互相碰撞
- `packages/cli/tests/unit/codex-adapter.test.ts`
  - install 聚合多个插件的公共 hooks 和 Codex native hooks
  - install 前 `.codex/hooks.json` 已存在外部 group 时，安装 hook-only / nativeHooks-only 插件后外部 group 仍保留
  - upgrade 前 `.codex/hooks.json` 已存在外部 group 时，升级 AW 插件只替换 AW 自己的 groups，不覆盖外部 group
  - historical rebuild fallback 前 `.codex/hooks.json` 已存在外部 group 时，重建 AW groups 后外部 group 仍保留
  - uninstall 只移除当前插件 tracked hook groups
  - 公共 hooks、`nativeHooks.codex` 和外部 groups 三者混合共存时，卸载其中一个 AW 插件只移除自己的 groups
  - status 在共享 hooks 文件缺少 native group 时报告 drift / missing
  - current catalog 缺失时，tracked `nativeHooks.codex` 插件的 status expected groups 来自 tracking artifact，而不是 historical placeholder 的 `session_start` 占位
  - current catalog 缺失时，tracked 公共 hooks + `nativeHooks.codex` 混合插件的 status 能按 tracking identities 确认 shared hooks 文件仍可见，不会因为 placeholder 视图不完整误报 drift
  - current catalog 缺失且 tracking artifact 只有 `kind: "hook"`、没有 hook identities 时，status 返回明确诊断或 `unknown`，不把 placeholder hook group 当作 expected group
  - 读取现有 Codex hooks 文件时接受 `UserPromptSubmit` / `Stop` 不带 `matcher` 的 group
  - 读取外部 runtime-valid shared hooks 时接受 `UserPromptSubmit` / `Stop` 携带 inert matcher，status / uninstall / 共享 hooks 重建都不因此失败
  - 读取外部 runtime-valid shared hooks 时接受 matcher-capable 事件上的缺省、`null`、`""`、`"*"` match-all 形态，并在 status / uninstall / drift 中视为同一 group
  - 读取外部 runtime-valid shared hooks 时保留 command handler 的 `timeout` / `statusMessage`，status / uninstall / 共享 hooks 重建不会洗掉这些字段
  - 读取外部 shared hooks 中的 `prompt` / `agent` / `async` command group 时，install / uninstall / status 不会失败，也不会把它们纳入 AW 扣减
  - 同一 `event + matcher + command` 但 handler `timeout` / `statusMessage` 不同的外部 group，不会在 multiset compare 或重建时被错误合并、扣减或覆盖
  - 读取外部 shared hooks 中的 multi-handler group 时，install / upgrade / uninstall 不会拆组、重排组内 handlers、误删整组，或把组内单个 handler 计入 AW managed identity
  - shared hooks 中只有 mixed foreign group 包含当前插件 expected command 时，status 报告 drift / missing 或 unmanaged overlap，而不是把它当作 AW 正常管理的 group
  - install / upgrade 当前插件 A 时，另一个 tracked hook 插件 B 已从 current catalog 和 active local bundle 消失，但 B 的 tracking 与 raw groups 仍在；命令不失败，B 的 raw groups 原样保留，A 的 groups 正常替换或追加
  - install / upgrade 当前插件 A 时，只扣除 A 和其它本次可重渲染 tracked 插件的旧 AW identities，不会扣除不可解析历史 AW 插件的 identities
  - 不可解析历史 AW 插件的 tracking 仍在但 shared hooks 文件中对应 raw group 已缺失时，安装 / 升级另一个插件不合成 B 的 group，也不因此删除其它 groups；状态或 drift 评估负责暴露缺失
  - uninstall / status / drift 对 matcherless native group 使用 canonical identity，而不是旧的必填 `matcher`
- `packages/cli/tests/unit/claude-adapter.test.ts`
  - Claude hook-only 插件会把 `hooks` 写入 ledger `capabilitySnapshot.managedExtensions`
  - `resolveClaudeCatalogCompatibility()` 比较 current / installed managed extensions 时包含 `hooks`
  - 当前 catalog 缺失或 capability changed 时，Claude 状态判断不会把历史 hooks 能力当成不存在
  - Claude hook-only 插件的 `installExtensions()` 不额外产出 `kind: "hook"` tracking artifact，historical fallback 仍能通过 ledger snapshot 保留 hook 能力
- `packages/cli/tests/unit/adapter-status.test.ts`
  - `loadPluginTargetsForCommand(..., allowHistoricalFallback: true)` 能从 Claude ledger 恢复 hook-only 历史插件
  - historical placeholder 的 hook `agentOverrides` 仍按原始平台收窄，不把 Claude-only hooks 泄漏给 Codex
  - Claude 只有 ledger snapshot、没有当前 catalog 和 hook tracking artifact 时，也能恢复 hooks 能力
  - Codex 只有 ledger snapshot 且只有 `hasRepoManagedArtifacts: true` 时，不合成 hook placeholder；只有 tracking artifact 记录 `kind: "hook"` 时才恢复 Codex hook 能力
  - Codex historical hook placeholder 只恢复 hook kind，不承诺还原 native event 明细；status / drift 需要的 expected groups 必须由 tracking artifact 提供
  - `loadPluginTargetsForCommand(..., allowHistoricalFallback: true)` 返回 Codex historical hook 插件后，adapter status 不会用 placeholder 的 `extensions.hooks` 去覆盖 tracking identities
- `packages/cli/tests/unit/marketplace.test.ts`
  - build 后的 Claude bundle hooks 通过 rendered validator
  - bundle layout 校验之外，单独断言 bundle source manifest 保留 `nativeHooks`
- `packages/cli/tests/integration/authoring-tools.test.ts`
  - 作者工具接受 native hooks 示例
  - 作者工具拒绝跨平台事件误写
- `packages/cli/tests/integration/cli.test.ts`
  - Codex `nativeHooks`-only 插件的 project-scope install 会写入 `.codex/hooks.json`，uninstall 会精确移除自己的 native hook group
  - Codex project-scope install / upgrade 遇到已有外部 `.codex/hooks.json` group 时，写入 AW groups 后外部 group 仍保留
  - current catalog 缺失后，剩余 tracked `nativeHooks.codex` hook 仍能被 historical rebuild 保留，不能因为当前 catalog 找不到 source manifest 而丢失
  - current catalog 缺失后，对历史 `nativeHooks.codex`-only 插件执行 `status`，仍能按 tracking identities 报告 hooks 可见，不把 historical placeholder 的公共 `session_start` 占位当成 expected group
  - current catalog 缺失后，对公共 hooks + `nativeHooks.codex` 混合插件执行 `status`，shared hooks 文件里的两类历史 groups 都能被 tracking identities 正确识别
  - current catalog 缺失后的 Codex historical rebuild 不会抹掉共享文件里已有的外部 group
  - 多插件共享 `.codex/hooks.json` 时，公共 hooks 与 `nativeHooks.codex` 混合聚合、混合扣减都正确；卸载其中一个插件后，其它插件的公共和 native hook group 都保留
  - 多插件共享 `.codex/hooks.json` 且存在外部 runtime-valid groups 时，卸载其中一个 AW 插件后，其它 AW groups 和外部 groups 都保留
  - 已有外部 multi-handler shared group 时，再安装或升级 AW hook 插件，不会拆组、重排组内 handlers，也不会误删外部 handler；若 AW expected command 只存在于该 mixed group 中，status 仍按 drift / unmanaged overlap 处理
  - marketplace 或 `init --force` 刷新后，插件 B 已从 current catalog 和 active local bundle 消失，但 tracking 与 `.codex/hooks.json` 中的 B hook groups 仍在；此时安装或升级插件 A，B 的历史 AW raw groups 仍保留，A 的写入结果正确
  - 上述 historical rebuild 和 status 场景需要同时覆盖 pure native hook 与公共/native 混合 hook，避免只验证旧公共 hooks 路径
  - 至少补一条 Claude 命令级回归，覆盖 `nativeHooks.claude` hook-only 插件能穿过 embedded catalog 和 ledger snapshot；可以用 `status` 或 current catalog 缺失后的 historical fallback 验证，不要求首版把 Claude 写成 tracking-based hook artifact
- `pnpm test:smoke:build`
  - embedded bundle 中存在 native hooks 的样例插件时仍能通过 bundle layout 校验
  - smoke 只兜 bundle 健康度，不替代上面的 source -> bundle -> catalog round-trip 单元测试

测试评估需要额外盯住 Codex shared hooks 的状态空间，不只看单条正向安装：

- 每条会写共享 hooks 文件的路径都要能说明三类 group 的处理结果：本次可重渲染 AW groups、不可解析历史 AW raw groups、非 AW foreign raw groups。
- 非 AW foreign raw groups 必须覆盖多 handler group 和 mixed handler group；测试要证明 AW 不会按 handler 粒度拆分、认领、扣减或满足 drift。
- install / upgrade / uninstall / historical rebuild / status 至少各有一条覆盖 shared hooks 不被整文件重建误伤的用例；其中 install / upgrade 必须覆盖“无关 tracked hook 插件不可解析”的回归。
- 单元测试负责锁住分类、canonical identity、multiset 扣减和 raw group 无损保留；集成测试负责模拟 catalog / local bundle 刷新后的真实命令流，防止实现只在 helper 层成立。
- 对“不可解析历史 AW groups 已从 shared 文件缺失”的情况，测试目标不是自动恢复，而是确认当前命令不误删其它 groups，并由 status / drift 路径报告缺失。
- 对 current catalog 缺失后的 Codex status，要单独断言 expected groups 的来源：有 tracking identities 时用 tracking；只有 placeholder 时给诊断或 `unknown`；任何情况下都不能从 placeholder `session_start` 占位推导 native hook group 明细。

## 推荐执行顺序

1. 先提交 hook contract 常量、类型和 source validator，移除公共 `session_stop`，收窄公共 `session_start` source 子集，落下 native 事件 matcher 能力表，并拆分 Codex rendered hook group 与 tracking identity。
2. 把 optional matcher 的 compare / serialize / normalize / merge 单元测试跑通，确保 matcherless 事件不再依赖伪 matcher。
3. 再改 generator 与 rendered contract，让公共和 native hooks 能渲染到同一个 artifact；同时拆出 strict generated validator 与 Codex shared read/write parser，并先把 Codex `null` / 缺省 / `""` / `"*"` matcher 形态、外部 handler raw 保留、multi-handler group 不拆分和 foreign group 分类的单元测试压住。
4. 补上 `createBundleSourceManifest()` 的 `nativeHooks` 复制和 build-free catalog round-trip 测试，避免后续 bundle 链路带病推进。
5. 接入 Codex adapter 的 install / upgrade / uninstall / status / tracking，先落下“读取现有共享文件 -> 只扣除本次可重渲染 AW identities -> 保留不可解析历史 AW raw groups 与 foreign raw groups -> 写回新 AW groups + preserved raw groups”的主链路，同时把 status / drift 的 expected groups 来源改成 current catalog 生效视图或 tracking identities，再接 historical rebuild fallback。
6. 接入 Claude bundle、capability snapshot、historical fallback 与 bundle layout 校验，明确 Claude 首版不新增 hook tracking artifact，同时补上 Codex ledger-only 不合成 hook placeholder 的边界测试。
7. 更新作者工具、参考文档和示例。
8. 补齐测试矩阵，尤其是 `nativeHooks` 的 CLI 命令级集成回归，最后跑 `pnpm test:unit`、`pnpm test:integration`、`pnpm build`、`pnpm test:smoke:build`。

## 风险与决策点

### 1. `PermissionRequest` 是否进入公共层

它是最值得提升为公共 hook 的候选事件，但不能只因为两端同名就直接纳入。需要先确认：

- matcher 字段在两端是否表示同一类对象；
- hook 输入 payload 是否能抽象成一致语义；
- 命令退出码、stdout / stderr 对权限决策的影响是否一致；
- Codex 当前 command hook 对该事件是否真实运行。

如果任一项不一致，首版应继续通过 `nativeHooks.claude` / `nativeHooks.codex` 支持，不放进 `HookEvent`。

### 2. Claude allowlist 不能只靠记忆维护

实现时需要把调研里的 Claude SDK 枚举重新核对一遍，补齐完整事件集合，并在代码注释中标明来源文件和核对日期。以后上游新增事件时，只改 allowlist 和测试，不改公共层。

### 3. Codex schema 与运行时支持不完全一致

Codex schema 声明了 `command` / `prompt` / `agent` 三类 handler，但当前 discovery 会跳过 `prompt` 和 `agent`。source contract 必须按运行时真实支持收口，不能只看 schema。

同时，Codex schema 接受 matcher group 形状，但 `UserPromptSubmit` / `Stop` 运行时不会消费 matcher。source contract 必须直接拒绝这些事件的 matcher，并在 strict rendered validator 中防止伪 matcher 漏进最终 artifact。

读取现有 Codex shared hooks 文件时要另开 read/write 入口。外部插件或手工配置可能省略 `matcher`、写入 `matcher: null`，或在 matcher-capable 事件上使用 `""` / `"*"` 表达 match-all；这些都是 Codex 运行时有效形态，应在 CLI 的 status、uninstall、drift 和重建链路中规整成同一 canonical identity。外部配置也可能已经在 `UserPromptSubmit` / `Stop` 上写入 matcher，Codex 运行时会保留 handler 并忽略 matcher；CLI 也应接受缺省、`null` 和 string matcher，再把 matcher 规整掉。严格拒绝 matcher 的规则只用于 source 和 CLI 自己生成的 artifact。

Codex shared 文件里的 handler shape 也要按共享文件处理，而不是按 AW 生成物处理。`timeout` / `statusMessage` 是同步 command 的运行时有效字段，重写时必须保留；`async` command、`prompt` 和 `agent` 当前会被 runtime discovery 跳过，但它们仍是 schema-valid 配置，shared read/write 不能因此判整份文件非法。首版只把最小同步 command group 纳入 AW identity，其它 runtime-valid groups 都作为 foreign raw groups 原样带过。

这里的“group”必须按 raw matcher group 理解，不能降到 handler 粒度。Codex schema 和 runtime 都允许一个 matcher group 下有多个 handlers，但 AW 首版只生成单 handler group，也只具备整组替换和扣减能力。多 handler group 或 mixed group 一律保留为 foreign raw group；即使其中某个 handler 看起来和 AW expected command 一样，也不能拆出来当作已管理 group。

### 4. 重复触发风险

公共 hooks 和 native hooks 最终会合并到同一个 artifact。若插件作者同时声明：

- `extensions.hooks[].event = "before_tool"`
- `extensions.nativeHooks.codex[].event = "PreToolUse"`

并且 matcher / command 相同，Codex 会得到重复 handler。validator 应直接报错；如果 command 不同，则允许它们作为两个有意声明的 hook 共存。

重复检测必须用 canonical form，而不是原始 source 字符串。尤其是 matcherless 事件，即使未来改成先 canonicalize 再告警的宽松策略，`Stop` 上两个相同 command 也应被视为重复；公共 `session_start` 未写 matcher 时应等价于 `startup|resume|clear`。

### 5. Codex 不可解析历史 AW hook groups 不能变成失败条件

这轮已经明确选择“保留既有 raw groups”，不是实现阶段再二选一的决策点。`resolveTrackedPlugins()` 这类全量解析 helper 不能继续作为 install / upgrade 的前置硬条件；无关 tracked hook 插件不可解析时，只要现有共享文件里还能按 tracking identity 命中它的 raw groups，就必须原样带过。

如果 tracking 里还有历史 hook identity，但 shared hooks 文件中已经没有对应 raw group，当前目标插件的安装或升级不负责凭空恢复它，也不能因此失败。这个缺失应交给 status / drift 评估暴露，避免一次无关操作既恢复不了历史插件，又误删其它 groups。

### 6. 状态面不能只看文件存在

Codex hooks 是共享文件，多插件会聚合到同一个 `hooks.json`。status 不能因为文件存在就认为当前插件 hook 可见，必须核对 tracking 中属于当前插件的最终 hook groups 仍在文件里。

current catalog 缺失时还要避免另一个误判：historical placeholder 只能说明插件曾经有 hooks 能力，不能说明它有哪些 native hook groups。status / drift 必须优先使用 tracking artifact 里的 canonical hook identities；如果没有 identities，只能给出无法核对的诊断或 `unknown`，不能把 placeholder 的公共 `session_start` 占位拿来和 shared hooks 文件比较。

同时，install / upgrade / historical rebuild 不能因为 AW 要重建自己的 groups 就覆盖整份共享文件。共享文件写回必须始终带着本次不可解析的历史 AW raw groups，以及未被 AW tracking identity 命中的 foreign raw groups，包括带 `timeout` / `statusMessage` 的 command、`prompt` / `agent` / `async` command，以及其它外部 runtime-valid groups。

### 7. Bundle source manifest 容易静默丢字段

`validateBundleLayout()` 只能证明 bundle source manifest 结构合法，不能证明可选字段都被复制。`nativeHooks` 是可选字段，如果 `createBundleSourceManifest()` 漏拷贝，bundle 仍可能通过结构校验。必须用单元测试直接断言 `nativeHooks` 能穿过 source -> bundle source manifest -> catalog 读取链路。

### 8. Codex ledger-only historical fallback 不恢复 hook kind

这是本轮有意收窄的边界，不是遗漏。当前 `CodexCapabilitySnapshot.hasRepoManagedArtifacts` 粒度太粗，只能说明插件曾写过 repo-managed artifact，不能说明具体 kind。首版如果强行从这个布尔值恢复 hook，会把非 hook 插件误报为 hook 插件。实现和测试都要守住这个边界；未来若要放开，应先扩展 snapshot 数据模型。

### 9. Claude 首版不引入 hook tracking artifact

Claude hooks 由 Claude 插件 bundle 自身提供，不是 CLI 在 repo 或 user config 中额外写入的 hook artifact。首版只把 `hooks` 写入 Claude ledger snapshot 的 `managedExtensions`，并通过 current catalog / runtime evidence / ledger snapshot 恢复状态；不要求 `installExtensions()` 产出 `GeneratedArtifact.kind = "hook"`。如果以后需要 tracking-based historical fallback，再补 Claude hook artifact 的安装、卸载、状态和测试落点。

## 验收标准

- 插件可以同时声明公共 hooks、Claude native hooks、Codex native hooks。
- 公共 hooks 只接受 `before_tool`、`after_tool`、`session_start`；`event: "session_stop"` 在 source manifest 校验阶段失败。
- 公共 `session_start` 只覆盖 `startup / resume / clear`；`compact`、`*` 或正则 matcher 在 source manifest 校验阶段失败。未写 matcher 时，最终 artifact 显式限制在 `startup|resume|clear`。
- Claude bundle 中的 `claude/hooks/hooks.json` 同时包含公共映射事件和 Claude 原生事件。
- Codex `.codex/hooks.json` 或 user hooks 文件同时包含公共映射事件和 Codex 原生事件。
- 非目标平台不会收到另一个平台的 native hooks。
- 非法原生事件在 source manifest 校验阶段失败。
- matcherless 原生事件写 `matcher` 会在 source manifest 校验阶段失败；strict generated rendered validator 也会拒绝 matcherless 事件中的 `matcher`。
- Codex shared hooks 读路径会接受外部 `.codex/hooks.json` 中所有事件的 `matcher` 缺省、`null` 或 string 运行时有效形态；matcher-capable 事件上的缺省、`null`、`""`、`"*"` 会规整成同一个 match-all identity，`UserPromptSubmit` / `Stop` 上的 matcher 会在 canonical identity 中丢弃；status、uninstall、drift 和共享 hooks 重建不因此失败。
- Codex shared hooks 写路径会保留现有非 AW hook groups；install、upgrade、uninstall 和 historical rebuild 只替换或扣减本次明确会重渲染的 AW groups，不会抹掉手工配置或其它工具写入的 runtime-valid groups。
- Codex install / upgrade 遇到同一 shared hooks 文件里的另一个 tracked hook 插件不可解析时不会失败；只要它的历史 AW raw groups 仍能从现有 `.codex/hooks.json` 中按 tracking identity 命中，就必须原样保留，且不能被当成本次可扣减 group。
- Codex current catalog 缺失后的 status / drift 使用 tracking artifact 中的 canonical hook identities 作为 expected groups；historical placeholder 只恢复 hook 能力，不参与 native hook group 明细比对。缺少可比较 identities 时，状态面给出诊断或 `unknown`，不误报 placeholder hook drift。
- Codex shared read/write mode 会原样保留外部 command handler 的 `timeout` / `statusMessage`，并把 `async` command、`prompt`、`agent` 作为 opaque foreign groups 带过；这些 groups 不参与 AW identity、去重、扣减或 drift 判断。
- Codex shared read/write mode 以 raw matcher group 为所有权单位；多 handler group 和 mixed group 会整组保留为 opaque foreign group，不会拆成多个 AW identities，也不会让其中某个 AW-looking handler 满足 status / drift。
- embedded bundle 的 `.agents-plugin/plugin.json` 保留 `extensions.nativeHooks`，catalog/bundle 模式读回后仍能参与安装和状态判断。
- CLI 自己生成的 rendered hooks artifact 中出现非法事件或非最小同步 command handler 时，bundle / install preflight 会失败；Codex 共享文件中的外部 runtime-valid handler 由 shared read/write mode 保留。
- install、upgrade、uninstall、status 都能识别 native hooks 带来的 hooks 能力；historical fallback 在当前 catalog 可用时两端都能识别 hook kind，Codex 在 tracking artifact 可用时也能恢复 hook kind。
- ledger-only historical fallback 首版只要求 Claude 从 `capabilitySnapshot.managedExtensions` 恢复 hook-only 能力；Codex 不凭 `hasRepoManagedArtifacts` 合成 hook placeholder。
- Claude native allowlist 与 2026-04-27 复核的上游 `HOOK_EVENTS` 完整一致，source validator 和 rendered validator 都用完整集合测试兜住事件名与 matcher 能力。
- Codex matcherless native hooks 在 artifact、tracking、drift、uninstall 和 generated artifact merge 中都不依赖伪 matcher。
- Claude hook-only 插件能把 `hooks` 写进 capability snapshot，且不会额外要求 `kind: "hook"` tracking artifact；current catalog 缺失时 historical fallback 能恢复 hooks 占位能力。
- CLI 集成测试覆盖 `nativeHooks` 的 source -> bundle source manifest -> embedded catalog -> command -> adapter 主链路，至少包括 Codex native hook-only 安装/卸载、Codex public/native/外部 hooks 混合共享文件保留、current catalog 缺失后的 Codex native hooks 和外部 groups 保留、current catalog 缺失后的 Codex native hook status 口径，以及一条 Claude native hook-only 的状态或 historical fallback 回归。
- 作者工具和参考文档给出的示例可以通过校验。
