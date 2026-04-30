# Codex 探索插件执行计划

## 结论

`codex-explore` 首版不是单纯新增一个插件目录。它依赖一条新的 Codex custom role 受管产物主链路：AW 必须能从 manifest 里的 `extensions.agents[].codexRole` 生成、安装、跟踪、刷新和卸载同一个逻辑 role 的两类文件：

- `.codex/config.toml` 里的 `[agents.<roleKey>]` 注册项。
- `.codex/agents/<generated-file>.toml` role layer 文件。

因此实现顺序要先补基础设施，再落插件内容：

1. 扩展 manifest/type contract，允许 agent 声明 Codex-only `codexRole`、模型/reasoning 配置绑定和 prompt 合成规则。
2. 补齐 Codex role TOML 注册、最终 role 名解析、冲突检测、tracking、status 和 uninstall。
3. 把 `aw config set/configure/unset/reset` 命中 `codexRole` 绑定时的自动刷新接进现有配置命令。
4. 新增 `plugins/codex-explore`，包含 Codex-only policy、默认自动触发且可安装覆盖的 skill、专用 `codex-explorer` role 和配置 schema。
5. 补文档、作者工具校验和测试矩阵。

这条路线避免用 lifecycle 脚本绕开受管 artifact，也不改变 Codex 内建 `explorer` role。主 agent 最终只需要调用 `spawn_agent(agent_type="codex-explorer")`，模型、reasoning 和提示词都由 AW 管理的 role artifact 决定。

## 当前基线

当前代码里已有几块可直接复用的能力：

- `packages/cli/src/types.ts` 已有 `AgentDefinition`、`GeneratedArtifact`、`TrackingManifest` 和 AW 自管 `config` 类型，但 agent 只有 `name / description / prompt / tools`，没有 `codexRole`、`roleKey`、模型配置或 refresh 元数据。
- `packages/cli/src/utils/manifest.ts` 会严格校验 `extensions.agents`，目前只允许 `name / description / prompt / tools / agentOverrides`。
- `packages/cli/src/generators/agents.ts` 现在给 Codex 只生成单个 `agents/<generated>.toml` 文件，内容只有 `name`、`description` 和 `developer_instructions`。
- `packages/cli/src/adapters/codex.ts` 的 `installExtensions()` / `uninstallExtensions()` / `status()` 已经能处理 instructions、permissions、hooks、agents，但 agent 仍按单文件 artifact 处理，身份用 `buildGeneratedName(plugin, agent.name)` 推导。
- `packages/cli/src/utils/codex-config.ts` 已经有 TOML AST 读写能力，适合扩展 `[agents.<roleKey>]` 的 upsert/remove 和 snapshot 解析。
- `packages/cli/src/utils/plugin-config.ts` 和 `packages/cli/src/index.ts` 已经实现 `aw config` 读写、effective config 合并、schema 校验和交互式配置，但写入后不会刷新 generated artifact。
- `aw config reset <plugin> --yes` 是 store 级清理能力；即使 current catalog 已经找不到插件，只要 raw store 存在，当前实现仍会删除残留配置，后续 refresh 接入不能破坏这条降级路径。
- `packages/cli/src/utils/detect.ts` 目前用 `agents/*.toml` 文件 basename 判断 Codex role 名，不符合 Codex 上游“声明项 + role 文件最终 name”的解析规则。
- current catalog 缺失时，`commands/discovery.ts` 会回退到 historical placeholder；当前 agent placeholder 只有通用 `historical-agent`，没有从 tracking 恢复真实 role 身份。
- `skillTriggers`、`marketplace.policy.products`、本地 marketplace 重建和 status 矩阵已经存在，插件侧可以直接使用这些 contract。

## 设计边界

首版坚持这些边界：

- 插件名使用 `codex-explore`，专用 roleKey 使用 `codex-explorer`。
- 不复用、不覆盖 Codex 内建 `explorer` role。
- 不支持 `spawn_agent(..., model=..., reasoning_effort=...)` 对本插件 explorer 做单次覆盖；模型和 reasoning 写进 role layer。
- 不新增 `aw config apply` 或 `sync` 命令；配置写入命中 role artifact binding 后自动刷新当前可定位的安装目标。
- 不把所有 config 写入都当成 artifact refresh；refresh keys 只从 `codexRole` binding 推导。
- Codex role artifact 的配置真值按安装 scope 固定：`scope=user` 只使用 `manifest default + user store`，不读取 project store；`scope=project` 使用 `manifest default + user store + 当前 project store`。project 覆盖如果要影响 role 文件，必须刷新或安装 project scope artifact，不能改写全局 user artifact。
- `promptOverride` 只能替换默认工作流正文，不能移除只读安全前导。
- 只读边界首版靠 role prompt、skill workflow 和主 agent 派发约束，不声明工具级隔离。
- explorer 是一次性只读探索 agent；skill 必须要求主 agent 汇总后调用 `close_agent`。

## Source Contract

### 1. 扩展 AgentDefinition

在 `extensions.agents[]` 中新增 Codex-only sibling block：

```json
{
  "name": "codex-explorer",
  "description": "Read-only codebase exploration role for Codex Explore.",
  "prompt": "...默认工作流正文...",
  "agentOverrides": {
    "claude": null
  },
  "codexRole": {
    "roleKey": "codex-explorer",
    "model": {
      "configKey": "explorerModel"
    },
    "modelReasoningEffort": {
      "configKey": "modelReasoningEffort"
    },
    "promptConfig": {
      "safetyPrefix": "...不可覆写只读安全前导...",
      "appendKey": "promptAppend",
      "overrideKey": "promptOverride"
    }
  }
}
```

类型建议：

- `CodexAgentRoleDefinition.roleKey: string`
- `CodexRoleConfigBinding<T>.configKey: string`
- `CodexRolePromptConfig.safetyPrefix: string`
- `CodexRolePromptConfig.appendKey?: string`
- `CodexRolePromptConfig.overrideKey?: string`

校验规则：

- `codexRole` 只允许出现在 `extensions.agents[]`，不写入 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json` 原生 manifest。
- `roleKey` 必须是稳定、非空、单段 key。首版建议允许 `/^[A-Za-z][A-Za-z0-9_-]*$/`。
- 同一插件内 `codexRole.roleKey` 必须唯一。
- 声明 `codexRole` 的 agent 必须满足 `agent.name === codexRole.roleKey`。这类 agent 不允许声明 `agentOverrides.codex.name`，即使覆盖后的值仍等于 `roleKey` 也要拒绝，避免 source identity 和 Codex resolved identity 出现两套命名入口。role layer 的 generated name 也按 `roleKey` 推导，即 `buildGeneratedName(pluginName, roleKey)`；不能再让逻辑身份使用 `roleKey`、文件身份使用另一个 `agent.name`。
- 生成器必须始终写 `name = "<roleKey>"`，便于 status 解释。
- `model.configKey`、`modelReasoningEffort.configKey`、`promptConfig.appendKey`、`promptConfig.overrideKey` 必须指向 `config.schema` 中存在的 key。
- `model` 和 `modelReasoningEffort` 绑定的 schema 类型必须是 `string` 或 `enum`；`promptAppend` / `promptOverride` 必须是 `string`。
- `codexRole.model` 和 `codexRole.modelReasoningEffort` 不允许携带 `default` 字段。默认值唯一来自 `config.schema[configKey].default`；role 渲染、config digest、status stale 判断和 `aw config` effective summary 都必须读取同一套由 schema default、user store 和 project store 合成出的渲染配置。
- `model` 和 `modelReasoningEffort` 绑定的 schema key 必须声明 default，且 default 必须能通过对应 schema 校验。
- `promptConfig.safetyPrefix` 必须是非空字符串；即使 `promptOverride` 为空，也要始终写入 role layer。
- 如果插件声明 `codexRole`，但 `marketplace.policy.products` 没有限制到 Codex，manifest 校验应给出清晰错误或至少在作者校验里报错。首版插件本身必须写 `["CODEX"]`。

### 2. 平台过滤语义

`resolvePlatformEntries()` 需要保留现有 `agentOverrides` 语义：

- `agentOverrides.claude = null` 时，Claude 不生成该 agent。
- Codex 侧拿到 platform-resolved agent 后，再读取同一 entry 上的 `codexRole`。
- 声明 `codexRole` 的 agent 可以继续用 `agentOverrides.codex` 覆盖 prompt、description、tools 等平台字段，但不能覆盖 `name`；Codex resolved agent 的身份必须由 `roleKey` 唯一决定。
- 没有 `codexRole` 的 Codex agent 继续走旧的单文件 role 生成路径，避免破坏已有插件。

## Codex Role Artifact Contract

### 1. 受管文件形态

安装 `codex-explore` 后，AW 生成：

```toml
# .codex/config.toml
[agents.codex-explorer]
description = "Read-only codebase exploration role for Codex Explore."
config_file = "./agents/aw-codex-explore-codex-explorer.toml"
```

```toml
# .codex/agents/aw-codex-explore-codex-explorer.toml
name = "codex-explorer"
description = "Read-only codebase exploration role for Codex Explore."
model = "gpt-5.4-mini"
model_reasoning_effort = "medium"
developer_instructions = """
...
"""
```

文件规则：

- `config_file` 使用相对 `.codex/config.toml` 的路径。
- role layer path 继续使用 AW generated name，并且 item name 固定取 `roleKey`，建议为 `agents/aw-codex-explore-codex-explorer.toml`。
- 注册项和 role layer 的 `description` 保持一致。
- `developer_instructions` 按 `safetyPrefix + workflowBody + promptAppend` 合成；有 `promptOverride` 时只替换 `workflowBody`。
- TOML 字符串渲染复用或扩展 `generators/agents.ts` 的安全渲染逻辑。

### 2. GeneratedArtifact 和 tracking

扩展 `GeneratedArtifact`，让 agent artifact 能表达逻辑 role：

```ts
interface GeneratedArtifact {
  path: string;
  kind: 'instruction' | 'permission' | 'hook' | 'agent';
  platform: PlatformName;
  hookGroups?: TrackedHookGroupIdentity[];
  agentRole?: {
    roleKey: string;
    registrationPath: string;
    roleLayerPath: string;
    configFile: string;
    configSource: 'default+user' | 'default+user+project';
  };
}
```

tracking 里保存同一个逻辑 role 的稳定身份：

- `roleKey`
- registry config path
- role layer path
- artifact 渲染使用的 config source：user scope 为 `default+user`，project scope 为 `default+user+project`
- rendered config digest
- 上一次 refresh 结果

建议给 `TrackingPluginRecord` 增加：

```ts
artifactRefresh?: {
  codexRoles?: Record<string, {
    configSource: 'default+user' | 'default+user+project';
    lastRenderedConfigDigest: string;
    lastRenderedAt: string;
    lastArtifactRefresh?: {
      status: 'succeeded' | 'failed';
      at: string;
      triggerKeys: string[];
      platform: 'codex';
      scope: Scope;
      roleKey: string;
      paths: string[];
      message?: string;
    };
    refreshReach?: {
      at: string;
      refreshedTargets: Array<{ platform: 'codex'; scope: Scope; roleKey: string; paths: string[] }>;
      possiblyStaleTargets?: string[];
    };
  }>;
}
```

具体字段名可以在实现时收口，但 status 至少要能回答：

- 当前 role artifact 是否使用对应安装 scope 的最新渲染配置：user scope 对比 `default+user`，project scope 对比 `default+user+project`。
- 最近一次 config-triggered refresh 是否失败。
- 本次命令实际刷新了哪些 target。
- 当前 project 是否存在命中 `codexRole` binding 的 project 覆盖；这些覆盖不会影响 user scope artifact，若用户希望覆盖进入 role 文件，需要安装或刷新 project scope artifact。

historical fallback 也必须保留 role 身份：

- discovery 和按插件名直达的命令入口都要在 current catalog 缺失时，从 tracking 的 `GeneratedArtifact.agentRole` metadata 恢复至少 `roleKey`、registration path、role layer path 和 config source。按插件名直达包括 `loadPluginTargetsForCommand()` 走 `commands/common.ts` historical fallback 后执行的 `aw uninstall <plugin>` / `aw upgrade <plugin>`。
- historical placeholder 不能再把 Codex role 退回成固定的 `historical-agent`。如果 tracking 只证明“有 agent artifact”但没有 `agentRole` metadata，可以继续使用保守 placeholder；如果 tracking 已记录 `agentRole.roleKey`，discovery candidate、direct command target、status 和 JSON 输出都要暴露真实 `roleKey`。
- 优先把 discovery 和 direct command 使用的 historical manifest 组装收口到共享 helper，避免 `commands/discovery.ts` 和 `commands/common.ts` 分别维护两套 placeholder 恢复逻辑。
- 依赖 current manifest 或 source manifest 才能安全计算的字段，在 `source=historical` 下如果无法恢复，要标记为 `unavailable` 或给出 degraded 诊断，不能用假名或猜测值补齐。

### 3. Codex config TOML helper

在 `packages/cli/src/utils/codex-config.ts` 增加：

- `CodexAgentRegistrationSnapshot`
- `parseCodexConfig()` 解析 `[agents.*]`，记录 `description`、`config_file` 和原始 table key。
- `upsertCodexAgentRegistration(content, roleKey, { description, configFile })`
- `removeCodexAgentRegistration(content, roleKey, expectedConfigFile?)`
- `upsertCodexAgentRegistrationFile(...)`
- `removeCodexAgentRegistrationFile(...)`

删除时必须谨慎：

- 如果 `[agents.<roleKey>]` 已不存在，视为无需删除。
- 如果注册项存在但 `config_file` 不再指向 AW tracking 里的 role layer，不删除对方文件，只删除或保留注册项的策略要保守。建议首版不删除被用户改写的注册项，只在 status 报 degraded，并删除 tracking 中仍确认属于 AW 的 role layer。

### 4. 最终 role 名解析

新增 Codex role namespace 解析工具，位置可放在 `utils/codex-roles.ts` 或 `utils/detect.ts`：

- 读取当前 config layer 的 `[agents.*]`。
- 对带 `config_file` 的声明项，读取对应 role layer TOML；如果文件有 `name`，最终 role 名用文件里的 `name`，否则用 table key。
- 对同层 `agents/**/*.toml` 中未被声明项引用的文件，读取文件里的 `name`；没有 `name` 时可用文件 basename 作为 best-effort 诊断，但不要把它当成可覆盖依据。
- 输出每个最终 role 的来源、table key、config path、role layer path、是否 AW managed。

安装前冲突检测使用这份结果：

- 只要同层已经存在非 AW 管理且最终 role 名为 `codex-explorer` 的 role，就拒绝安装。
- 冲突包括 `[agents.foo] config_file = "./agents/foo.toml"` 且文件内 `name = "codex-explorer"`，也包括手写 `agents/*.toml` 直接声明 `name = "codex-explorer"`。
- 不把 Codex 内建 `explorer` 视为冲突，因为本插件 roleKey 是 `codex-explorer`。

## 生成器与 Adapter 实现

### 1. Generator

重构 `packages/cli/src/generators/agents.ts`：

- 保留 Claude `.md` 生成路径。
- 保留没有 `codexRole` 的 Codex `.toml` 旧路径。
- 新增 `generateCodexRoleArtifacts(pluginName, agent, roleRenderConfig)`，返回：
  - registration entry data
  - role layer relative path
  - role layer content
  - rendered config digest
  - roleKey metadata

prompt 合成函数单独测试：

```text
safetyPrefix

workflowBody 或 promptOverride

promptAppend
```

合成时忽略空白 append；`promptOverride` 为空字符串时按 schema 允许与否处理，建议校验阶段禁止空 override，避免生成只有安全前导的弱工作流。

### 2. Codex installExtensions

在 `packages/cli/src/adapters/codex.ts`：

1. 读取 tracking，并按目标安装 scope 解析 role render config：user scope 只合并 `manifest default + user store`，project scope 合并 `manifest default + user store + project store`。
2. 对普通 agent 继续写单文件 artifact。
3. 对 `codexRole` agent：
   - 解析当前 scope layer 的最终 role namespace。
   - 检查非 AW 管理同名最终 role 冲突。
   - 写 role layer 文件。
   - upsert `[agents.<roleKey>]` 注册项。
   - tracking 记录 `agentRole` metadata 和 rendered config digest。
4. 如果写入中途失败，沿用 `attachGeneratedArtifactsToError()`，确保 install 回滚能拿到已经写出的路径。

安装顺序建议先做所有冲突检测，再写任何文件，减少半完成状态。

### 3. Codex uninstallExtensions

卸载时：

- 对旧普通 agent artifact，继续删除文件。
- 对 `agentRole` artifact：
  - 如果 tracking 里的 role layer path 仍存在，删除该 role layer。
  - 如果 `[agents.<roleKey>]` 仍指向 tracking 里的 `config_file`，删除注册项。
  - 如果注册项被用户改成别的 `config_file`，不删除对方文件，status/report warning 说明注册项已经 drift。
- 清理 tracking 中对应 artifact 和 refresh metadata。

### 4. Codex status

status 需要新增诊断：

- 注册项是否存在。
- `config_file` 是否仍指向 AW 管理的 role layer。
- role layer 是否存在。
- role layer `name` 是否等于 `roleKey`。
- role layer `description` 是否和注册项一致。
- 同层是否存在非 AW 管理的同名最终 role。
- user scope 安装时，更高优先级 trusted project layer 是否遮蔽 `roleKey`。
- `lastRenderedConfigDigest` 是否等于该安装 scope 当前应使用的 render config digest。
- 当前 project 是否有命中 `codexRole` binding 的 project 覆盖但只有 user scope artifact；这种情况下 project 覆盖不会进入全局 role 文件，status 应提示需要 project scope install/refresh 才会生效。
- 最近一次 refresh 是否失败。
- current catalog 缺失但 tracking 里仍有 `agentRole` metadata 时，status 继续按 `roleKey` 展示受管 role，并在 verbose/json 中标出 `source=historical`；无法安全计算的 manifest-derived 诊断标为 unavailable，而不是退回 generated filename 或 `historical-agent`。

`detectCodexSessionState()` 目前按 `agentRoleNames` 做遮蔽判断，后续要改成最终 role 名集合，而不是文件 basename。

## Config-triggered Artifact Refresh

### 1. Refresh effect 推导

新增工具模块，建议 `packages/cli/src/utils/artifact-refresh.ts`：

- `collectCodexRoleRefreshEffects(manifest)`：从 `extensions.agents[].codexRole` 推导 refresh keys 和 target roleKey。
- refresh keys 固定为：
  - `codexRole.model.configKey`
  - `codexRole.modelReasoningEffort.configKey`
  - `codexRole.promptConfig.appendKey`
  - `codexRole.promptConfig.overrideKey`
- `shouldRefreshForConfigChange(changedKeys, effects, operation)`：
  - `set/configure/unset` 只看本次 changed/removed keys。
  - `reset` 视为该层所有 refresh keys 可能变化。

没有命中 refresh keys 的 config 写入保持现状，只更新 config store。

配置刷新不能直接复用通用 effective config 作为所有 artifact 的真值。`scope=user` 的 Codex role artifact 是全局文件，必须只绑定 `default+user`；`scope=project` 的 Codex role artifact 是当前 repo 文件，才读取当前 project 覆盖。这里的 default 只指 `config.schema` default，不存在 `codexRole` 自己的 default。这样同一份 user artifact 在不同 repo 下不会被轮流改写，tracking digest 也有稳定含义。

### 2. Config 命令接入点

在 `packages/cli/src/index.ts` 的四类写命令后接入：

- `config set`
- `config configure`
- `config unset`
- `config reset`

流程：

1. 读取 manifest 和本次写入前的 config store 快照。
2. 写 config store。
3. 如果命中 refresh effect，定位当前上下文可刷新的已安装 target。
4. 对每个 target 按安装 scope 解析 role render config，并重渲染受管 Codex role artifact。
5. 写入成功后更新 tracking refresh metadata。
6. 如果刷新失败，优先回滚本次 config store 修改和已写 artifact；回滚失败或仍无法恢复时，写入 `lastArtifactRefresh.status = "failed"`，让 status 可见。

`config reset` 还要保住现有 raw-store cleanup contract：

- reset 先按当前实现完成安全插件名校验、确认提示和 raw store 删除；这一步不依赖 current catalog 或 manifest。
- 只有 current manifest 可用时，才根据 `codexRole` binding 计算 refresh effect，并按上面的 target 规则刷新 artifact。
- 如果 current manifest 不可用，reset 仍然成功删除 store，但跳过 refresh；普通输出给出确定性诊断，JSON receipt 暴露 `artifactRefresh: { skipped: true, reason: "manifest-unavailable" }` 或等价机器字段。
- 如果 manifest 不可用但 tracking 显示仍有已安装 role artifact，status 后续负责以 historical source 展示可能 stale 的 role，不由 reset 命令猜测或重建 artifact。

定位 target 的首版范围：

- user scope config 写入：刷新当前用户 scope 已安装的 `codex-explore`，使用 `default+user` 渲染；如果当前 cwd 对应 project scope 也安装了该插件，也刷新当前 project，使用 `default+user+project` 渲染。
- project scope config 写入：只刷新当前 repo/project scope 已安装的 `codex-explore`。即使 user scope 也安装了该插件，也不改写全局 user artifact，因为 user artifact 不读取 project store。
- 如果 project scope 写入命中 refresh key 但当前 repo 没有 project scope 安装，只保存配置；status 在看到“project 覆盖存在但只有 user scope artifact”时提示该覆盖不会影响全局 role 文件。
- 不扫描所有历史 project。project scope artifact 只存在于对应 repo，用户需要在对应目录运行 config/upgrade/reinstall 才能刷新该 repo 的受管 role。

### 3. Refresh 写入策略

refresh 只重渲染 AW 管理的 artifact：

- 必须先从 tracking 找到 `agentRole.roleKey` 和 role layer path。
- 如果 tracking 不存在或 role layer/registration 已被外部接管，不创建新 artifact；记录 failed/stale 诊断，让用户通过 reinstall/upgrade 修复。
- 不执行 lifecycle 脚本。
- 不改用户手写 role 文件。

config digest 建议用 canonical JSON 计算：

```json
{
  "roleKey": "codex-explorer",
  "configSource": "default+user | default+user+project",
  "values": {
    "explorerModel": "...",
    "modelReasoningEffort": "...",
    "promptAppend": "...",
    "promptOverride": "..."
  }
}
```

只纳入 `codexRole` 推导出的 refresh keys，避免无关 config 改动让 artifact 看起来 stale。

## 插件内容

新增目录：

```text
plugins/codex-explore/
├── .agents-plugin/plugin.json
└── skills/codex-explore/
    ├── SKILL.md
    └── agents/openai.yaml
```

manifest 要点：

- `name = "codex-explore"`
- `marketplace.policy.products = ["CODEX"]`
- `skills = "./skills"`
- `skillTriggers.codex-explore.allowInstallOverride = true`
- `extensions.agents[]` 声明 `name = "codex-explorer"` 且 `codexRole.roleKey = "codex-explorer"`；`codexRole` 只绑定 config key，不声明 default。
- `config.schema` 声明：
  - `explorerModel`：string 或 enum，默认 `gpt-5.4-mini`
  - `modelReasoningEffort`：enum，默认 `medium`
  - `promptAppend`：string，默认空
  - `promptOverride`：string，可选

`skills/codex-explore/agents/openai.yaml`：

- 默认 `policy.allow_implicit_invocation: true`
- 描述匹配代码库探索、架构梳理、实现边界、跨模块影响面等场景。

`SKILL.md`：

- 自动触发代表用户授权本 workflow 在匹配探索场景里使用 explorer。
- 主 agent 先判断是否真的需要 explorer；小范围搜索留在本地完成。
- 默认 1 个 explorer；范围不清或跨模块时 2 到 3 个；极复杂最多 4 个。
- 委派 prompt 必须包含范围、具体问题、探索深度、输出格式和只读要求。
- explorer 运行时主 agent 继续做不重叠的本地调查。
- 汇总后只补读少量关键证据。
- 使用完本 workflow 启动的 explorer 后必须调用 `close_agent`。
- 调用 `spawn_agent` 时只传 `agent_type = "codex-explorer"`，不传 model/reasoning override。

默认 explorer role prompt：

- 安全前导固定在 manifest 或源码常量里。
- 工作流正文可直接采用 spec 中的中文草案。
- 输出结构固定为“结论 / 证据 / 不确定点 / 建议主 agent 下一步查看”。

## 文档与作者工具

需要更新：

- `docs/plugin-authoring.md`：新增 `extensions.agents[].codexRole`、roleKey 唯一性、`agent.name === roleKey`、禁止 `agentOverrides.codex.name`、config binding、默认值唯一来自 `config.schema`、prompt 合成和安全前导不可覆写规则。
- `docs/plugin-installation.md`：说明 Codex role artifact、config 写入自动刷新、status 诊断和卸载行为。
- `docs/architecture.md`：补充 Codex custom role 受管产物模型和 tracking/status 关系。
- `.agents/skills/create-agent-workflows-plugin/references/*`：让脚手架/校验文档知道 `codexRole`、Codex-only 插件和 `agents/openai.yaml` 要求。
- `.agents/skills/create-agent-workflows-plugin` 的校验脚本：检查缺失 `agents/openai.yaml`、非法 config schema、非法 `codexRole` binding、空/重复 `roleKey`、`agent.name !== roleKey`、`agentOverrides.codex.name`、`codexRole` default 字段、schema key 不存在、字段类型不匹配、model / reasoning schema default 缺失等。

## 测试计划

### Unit

- manifest normalize：
  - 接受合法 `codexRole`。
  - 接受同一插件内多个不同 `roleKey` 的 Codex role。
  - 拒绝未知字段、空 roleKey、非法 roleKey、重复 roleKey、`agent.name !== roleKey`、`agentOverrides.codex.name`、缺失 config schema key、字段类型不匹配。
  - 即使 source `agent.name === roleKey`，只要声明了 `agentOverrides.codex.name`，也要明确报错。
  - 拒绝 `codexRole.model.default` / `codexRole.modelReasoningEffort.default`，并拒绝 model / reasoning 绑定 key 缺失 schema default。
  - `agentOverrides.claude = null` 不影响 Codex `codexRole`。
- generator：
  - 生成 `[agents.<roleKey>]` 注册数据和 role layer。
  - role layer path 使用 `buildGeneratedName(pluginName, roleKey)` 推导。
  - role file 写入 `name = roleKey`、`model`、`model_reasoning_effort`、`developer_instructions`。
  - prompt 合成始终保留安全前导，override 只替换正文，append 追加在末尾。
  - model / reasoning 默认值只从 `config.schema` default 读取，不从 `codexRole` 读取第二份默认值。
  - config digest 只包含 refresh keys，并把 user scope 的 `default+user` 与 project scope 的 `default+user+project` 区分开。
- codex config helper：
  - upsert/remove `[agents.<roleKey>]` 保留其它 TOML。
  - 解析 `config_file` 相对路径。
  - 删除时发现 config_file drift 不误删。
- role namespace：
  - `[agents.foo] config_file` 指向文件内 `name = "codex-explorer"` 能检测冲突。
  - 未被声明引用的 `agents/*.toml` 同名 role 能检测冲突。
  - AW tracking 管理的同名 role 不被误判为外部冲突。
- refresh effect：
  - 只命中 `codexRole` binding keys。
  - 非 artifact config key 写入不触发 refresh。
  - `reset` 按可能变化处理。
  - project scope config 变化不触发 user scope artifact 重渲染。

### Integration

- `aw install codex-explore -p codex -s user`：
  - native plugin enabled。
  - 生成 `[agents.codex-explorer]` 和 role layer。
  - tracking 记录 roleKey、registration path、role layer path、config source 和 config digest。
- `aw install codex-explore -p codex -s project`：
  - role layer 使用 `default+user+project` 渲染。
  - 同 repo project config 覆盖能进入 role layer，但不会改写 user scope artifact。
- `aw install codex-explore -p claude` 被 `marketplace.policy.products` 拦截。
- 安装时存在非 AW 管理最终 role 名 `codex-explorer`，命令失败且不写半成品。
- `aw uninstall codex-explore -p codex` 同时清理注册项和 role layer，不删除用户手写 role 文件。
- `aw upgrade codex-explore -p codex`：
  - 普通升级保留 `roleKey` tracking、registration path、role layer path 和 config source。
  - capabilityChanged/重装路径仍按 `roleKey` 清理旧 artifact 并写入新 artifact。
- `aw status`：
  - 正常显示 initialized。
  - role layer 缺失、注册项缺失、config_file drift、同名外部 role、higher-priority project layer 遮蔽都能给 warning。
  - digest stale 和最近 refresh failed 能给诊断。
  - project 覆盖存在但只有 user scope artifact 时，提示该覆盖不会进入全局 role 文件。
- `aw status --json`、`aw status --json --verbose`：
  - 输出保持纯 JSON，不把 warning/debug 文本混入 stdout。
  - JSON 中暴露 roleKey、registration path、role layer path、config source、digest stale、refresh failed 等机器可读字段。
- current catalog 缺失但 tracking 仍有 `agentRole` artifact：
  - discovery 从 tracking metadata 恢复真实 `roleKey`，不退回 `historical-agent`。
  - `aw status` / `aw status --json --verbose` 显示 `source=historical` 和 role identity；无法从 historical evidence 安全计算的 role-specific 诊断标为 unavailable。
  - 交互式 `aw uninstall` / `aw upgrade` 候选仍能识别对应 plugin、platform、scope 和 roleKey。
  - 按插件名直达执行 `aw uninstall codex-explore -p codex` 时，`commands/common.ts` 的 historical fallback 也能恢复真实 `roleKey`。
  - 按插件名直达执行 `aw upgrade codex-explore -p codex` 时，`commands/common.ts` 的 historical fallback 也能恢复真实 `roleKey`，不会退回 `historical-agent`。
- `aw config set codex-explore explorerModel <value>`：
  - 自动刷新当前可定位 installed role layer。
  - 更新 tracking digest 和 refresh metadata。
  - 不需要额外 apply/sync。
- `aw config configure/unset/reset codex-explore` 命中 refresh key：
  - 和 `set` 一样刷新当前可定位 installed role layer。
  - user scope 写入刷新 user artifact，并刷新当前 repo 内已安装的 project artifact。
  - project scope 写入只刷新当前 repo 的 project artifact，不刷新 user artifact。
- current catalog 缺失时 `aw config reset codex-explore -s user --yes --json`：
  - 仍能删除 raw config store。
  - 不要求 manifest 存在，不尝试重渲染 artifact。
  - JSON receipt 能说明 refresh 被跳过，且 stdout 保持纯 JSON。
- refresh 失败：
  - 回滚 config store 和已写 artifact。
  - 回滚失败或无法完全恢复时写入 `lastArtifactRefresh.status = "failed"`，status 能诊断。
- `aw config set codex-explore unrelatedKey ...` 或其它插件 config 写入不刷新 role artifact。
- `promptOverride` / `promptAppend` 写入后 role layer 中安全前导仍在最前。
- skill trigger：
  - 默认自动触发。
  - `--skill-trigger manual` 能把 Codex `allow_implicit_invocation` 改成 false。
- authoring tools：
  - `authoring-tools.test.ts` 或等价用例覆盖 `codexRole`、Codex-only 插件、`agents/openai.yaml` 必填。
  - 校验非法 roleKey、重复 roleKey、`agent.name !== roleKey`、`codexRole` default 字段、缺失 schema key、字段类型不匹配、model / reasoning schema default 缺失和 Codex-only policy 缺失时给清晰错误。

### Smoke

- `pnpm build` 生成 `packages/cli/plugins-dist/codex-explore`。
- `pnpm test:smoke:build` 覆盖 Codex-only marketplace entry、platform manifest、skill 文件和 role source manifest。
- source manifest / bundle layout 断言：`codexRole` 保留在 `.agents-plugin/plugin.json`，但不会漏进 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json` 原生 manifest。
- `pnpm pack:cli` tarball 包含新插件 runtime bundle。

## 实现步骤

### 阶段 1：类型和 manifest contract

- 更新 `packages/cli/src/types.ts`，新增 `CodexAgentRoleDefinition`、config binding、prompt config、agent artifact role metadata、refresh metadata 类型。
- 更新 `packages/cli/src/utils/manifest.ts`，校验 `extensions.agents[].codexRole`，拒绝重复 `roleKey`、`agent.name !== roleKey` 和 `codexRole` 内的 default 字段。
- 更新 bundle source manifest 保留逻辑，确保 `codexRole` 留在 `.agents-plugin/plugin.json`，但不进入平台原生 manifest。
- 补 manifest 单测。

交付标准：合法 spec 形态能被 build/manifest normalizer 接受，非法 binding、重复 role 身份和默认值双真值都有明确错误。

### 阶段 2：Codex role TOML 和 namespace 基础设施

- 扩展 `utils/codex-config.ts`，支持 `[agents.*]` 解析、upsert 和 remove。
- 新增 role layer TOML 解析 helper，读取 `name`、`description`、`model`、`model_reasoning_effort`。
- 新增最终 role namespace 收集器。
- 更新 `utils/detect.ts`，让 project layer agent evidence 使用最终 role 名，而不是文件 basename。
- 补 TOML 和冲突检测单测。

交付标准：能准确识别同层声明项、role 文件和最终 role 名冲突。

### 阶段 3：生成器、install/uninstall/status

- 重构 `generators/agents.ts`，新增 Codex role artifact 生成。
- 更新 `adapters/codex.ts`：
  - install 前检查最终 role 名冲突。
  - 写 role layer 和注册项。
  - tracking 保存 roleKey 和 paths。
  - uninstall 清理注册项和 role layer。
  - status 增加 role-specific diagnostics。
- 更新 historical placeholder 组装：current catalog 缺失时，从 tracking 的 `agentRole` metadata 恢复 roleKey 和 paths；恢复不了的 role-specific 诊断显式标为 unavailable。discovery 和 `commands/common.ts` 的 direct command historical fallback 要复用同一套恢复逻辑。
- 更新 `GeneratedArtifactStatus` 和 status report 输出字段。
- 补 install/uninstall/status 集成测试，包含 current catalog 缺失但 tracking 仍有 `agentRole` 的 historical status/discovery 回归，以及按插件名直达的 uninstall / upgrade historical fallback 回归。

交付标准：不涉及 config refresh 时，Codex custom role 已经是 AW 一等受管 artifact。

### 阶段 4：config-triggered refresh

- 新增 refresh effect 推导和 config digest 工具。
- 在 `aw config set/configure/unset/reset` 写命令后接入 refresh。
- 保留 `config reset` current catalog 缺失时的 raw-store cleanup 降级路径；manifest 不可用时跳过 refresh 并输出稳定诊断。
- 实现 refresh rollback 和 failed metadata 记录。
- status 对比当前 digest 和 tracking digest。
- 补 config refresh 集成测试，包含 current catalog 缺失时 `reset --yes` 仍成功清理 raw store 且不污染 JSON stdout。

交付标准：改 `explorerModel`、`modelReasoningEffort`、`promptAppend` 或 `promptOverride` 后，当前可定位安装目标的 role layer 按 scope 对应配置真值自动更新；project scope 写入不改写 user artifact；失败能被 status 看见。

### 阶段 5：新增 `codex-explore` 插件

- 创建 `plugins/codex-explore`。
- 写 `.agents-plugin/plugin.json`、`SKILL.md`、`agents/openai.yaml`。
- 确认 `allowInstallOverride` 和默认自动触发行为。
- 跑 build，检查 `plugins-dist` 产物。
- 补插件 smoke 断言。

交付标准：用户安装后能看到 `$codex-explore`，主 agent workflow 指向 `agent_type = "codex-explorer"`，role artifact 使用默认模型和 reasoning。

### 阶段 6：文档、作者工具和回归

- 更新公开文档和作者工具 reference。
- 更新校验脚本。
- 跑：
  - `pnpm test:unit`
  - `pnpm test:integration`
  - `pnpm build`
  - `pnpm test:smoke:build`

交付标准：文档、作者校验、CLI 产物和测试矩阵都覆盖新 contract。

## 风险与回退

- `aw config` 写入后的 refresh 失败最容易留下半完成状态。实现时要先把 config store 快照、tracking 快照和 artifact 内容快照准备好，再进入写入；失败时尽量回滚，并把无法回滚的状态写入 refresh metadata。
- 最终 role 名解析需要容忍用户手写 TOML 损坏。安装时遇到目标冲突解析失败应 fail fast；status 可以 degraded warning。
- user scope role artifact 不读取 project store，因此同一份全局 role 文件不会因不同 repo 的 project 覆盖而被轮流改写。风险转为产品解释：如果用户希望某个 repo 的 project 覆盖影响 explorer role，必须安装或刷新 project scope artifact；status 要把“project 覆盖存在但只有 user artifact”说清楚。
- 只读安全前导不能靠自然语言语义校验 `promptOverride`。生成器必须以结构保证它永远排在最前，不能被用户配置覆盖或清空。
- 现有旧式 Codex agent 单文件 artifact 要保持兼容。没有 `codexRole` 的插件不应被迫迁移到注册项模型。

## 首版验收清单

- `pnpm build` 能生成 Codex-only `codex-explore` marketplace entry。
- `aw install codex-explore -p codex -s user` 成功生成 `[agents.codex-explorer]` 和 role layer。
- `aw install codex-explore -p claude` 被 product policy 拦截。
- skill 默认允许隐式触发，并可通过安装触发偏好改为手动。
- role 文件包含 `model = "gpt-5.4-mini"`、`model_reasoning_effort = "medium"` 和带安全前导的 `developer_instructions`。
- 安装不会覆盖任何非 AW 管理且最终 role 名为 `codex-explorer` 的自定义 role。
- tracking/status/uninstall/upgrade/refresh 都按 `roleKey` 处理。
- `aw config set/configure/unset/reset` 命中 `codexRole` refresh keys 后自动刷新当前可定位 artifact；user artifact 使用 `default+user`，project artifact 使用 `default+user+project`。
- `config reset` 在 current catalog 缺失时仍可删除 raw store，并清楚说明 refresh 被跳过。
- status 能报告 role 缺失、注册项 drift、role 遮蔽、config stale 和 refresh failed。
- current catalog 缺失但 tracking 仍有 `agentRole` 时，status/discovery 仍保留真实 `roleKey`，无法恢复的 role 诊断标为 unavailable。
- status JSON 保持机器可读，包含 role 诊断字段且不会混入人类可读 warning。
- upgrade、作者工具校验和 source manifest / bundle layout 都有测试覆盖。
- uninstall 清理 AW 管理的注册项和 role layer，不影响用户手写文件。
- 单元、集成和 smoke 测试覆盖 manifest、生成器、Codex adapter、config refresh 和插件 bundle。
