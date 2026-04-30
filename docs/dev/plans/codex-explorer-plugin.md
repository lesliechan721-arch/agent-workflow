# Codex 探索插件执行计划

## 需求来源

本计划落实 `docs/dev/sepcs/codex-explorer-plugin-spec.md`。如果实现过程中发现本计划和 spec 不一致，先回到 spec 校准需求，再更新计划；不要让实现按过期计划继续推进。

本计划已保留前序 review 收口后的三个 contract：

- `codexRole` 默认值真值必须和 spec 保持一致：默认值只来自 `config.schema[configKey].default`，不允许在 `codexRole` 里再写一份 `default`。
- 同一个 `codexRole` 内的 config binding key 不能重复，作者工具和测试都要覆盖负例。
- 插件真正交付给模型的 `SKILL.md` 和默认 explorer prompt 要有内容级回归测试，避免丢掉 `close_agent`、探索深度、`agent_type = "codex-explorer"` 和输出结构。

本轮计划继续处理 `docs/dev/reviews/codex-explorer-plugin-plan-review.md` 指出的缺口：

- config-triggered refresh metadata 必须记录 `refreshReach`，说明本次命令实际刷新了 user / 当前 project 中哪些 target，并明确其它历史 project scope 没有被扫描、可能仍是旧 artifact。
- 空白或仅空格的 `promptOverride` 必须通过通用 config schema 能力声明为非法，`aw config set/configure` 在写入阶段直接拒绝，不能靠插件名或具体 key 做特判。
- 本次核对确认 `allowEmpty` 还需要落到 `config configure` 的 prompt/runtime 语义：选中字段后，空白输入是显式字符串值，不再被当作“跳过”；跳过只发生在字段选择阶段。

## 首版交付目标

首版要交付一个 Codex 独享插件 `codex-explore`。它不是只新增插件目录，而是要补齐 AW 对 Codex custom role 的受管产物链路，让插件能生成、安装、跟踪、刷新、诊断和卸载一个稳定 role：

- `.codex/config.toml` 中的 `[agents.codex-explorer]` 注册项。
- `.codex/agents/aw-codex-explore-codex-explorer.toml` role layer 文件。

用户安装后，主 agent 通过 `spawn_agent(agent_type="codex-explorer")` 调用专用 explorer。模型、reasoning effort 和 developer instructions 都来自 AW 管理的 role artifact，而不是每次委派时临时拼参数。

## 执行边界

首版必须坚持这些边界：

- 只面向 Codex，`marketplace.policy.products = ["CODEX"]`，Claude 安装路径要被拦截。
- 插件名固定为 `codex-explore`，专用 roleKey 固定为 `codex-explorer`。
- 不复用、不覆盖 Codex 内建 `explorer` role。
- 不改变 Codex 上游 `spawn_agent` 的全局授权规则；自动触发安装只代表这个探索 workflow 的插件层授权。
- 不支持对本插件 explorer 做单次 `model` 或 `reasoning_effort` 覆盖；调整默认值走 `aw config` 和 artifact refresh。
- 不新增 `aw config apply`、`sync` 或其它刷新命令；配置写入命中 `codexRole` binding 后自动刷新当前可定位 artifact。
- 不让所有插件配置写入都触发 artifact refresh；refresh keys 只从 `extensions.agents[].codexRole` 推导。
- user scope role artifact 使用 `config.schema default + user store`，不读取 project store；project scope artifact 才使用 `config.schema default + user store + 当前 project store`。
- `promptOverride` 只能替换默认工作流正文，不能替换不可覆写的只读安全前导。
- config schema 必须能区分“空”和“未设置”：显式写入 `""` 或纯空白字符串是一个配置值，只有字段允许空值时才合法；`unset/reset` 删除 key 才表示未设置。
- `promptOverride` 用通用 schema 声明不允许空值；`aw config set/configure` 必须失败且不写 config store，`unset/reset` 清除后按未设置处理并回退默认 workflow body。
- `aw config configure` 的交互语义必须和上面一致：未选中字段表示跳过；已经进入输入的 string 字段必须把空白输入作为显式写入值传给 config schema 校验；删除当前值不走 `configure`，只通过 `aw config unset/reset` 表达。
- explorer 首版只靠 role prompt、skill workflow 和主 agent 派发要求保持只读，不声明工具级 allowlist / denylist。
- explorer 是一次性只读探索 agent；skill 必须要求主 agent 读取并整合结果后调用 `close_agent`。

## 需求拆解

### 1. 探索 workflow

`codex-explore` skill 默认允许隐式触发，并允许安装时改成手动触发。自动触发场景包括代码库探索、架构梳理、实现边界分析和跨模块影响面评估。

skill 必须教主 agent 保持克制：

- 已知单个文件、单个符号或 2 到 3 个文件内的小搜索，优先本地完成。
- 只有边界清晰、只读、能和主 agent 下一步并行推进的问题才派给 explorer。
- 默认启动 1 个 explorer；范围不清或跨模块时用 2 到 3 个；极复杂场景最多 4 个。
- 每个委派 prompt 都要写明范围、具体问题、探索深度、期望输出和只读要求。
- 探索深度只使用 `quick`、`medium`、`very thorough` 三档；没有指定时 explorer 按 `medium` 处理。
- 主 agent 等待期间继续做不重叠的本地调查。
- 主 agent 只整合 explorer 的关键结论，必要时补读少量文件验证，不倾倒完整子代理回复。
- 汇总后立即关闭本 workflow 启动的 explorer；`wait_agent` 完成不等于关闭 agent。

### 2. 专用 Codex role

`codex-explore` 提供专用 roleKey `codex-explorer`。AW 安装后要同时管理注册项和 role layer，并在 tracking、status、uninstall、upgrade、refresh 中都按 `roleKey` 识别它。

生成后的目标形态：

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

要求：

- `config_file` 使用相对 `.codex/config.toml` 的路径。
- role layer 必须写 `name = "codex-explorer"`，避免最终 role 名难以解释。
- 注册项和 role layer 的 `description` 保持一致。
- role layer path 使用 `buildGeneratedName(pluginName, roleKey)` 推导，建议为 `agents/aw-codex-explore-codex-explorer.toml`。
- 旧式没有 `codexRole` 的 Codex agent 继续走原单文件生成路径，不能被本需求强制迁移。

### 3. Config-driven role render

插件 manifest 通过 `config.schema` 声明配置：

- `explorerModel`：string 或 enum，默认 `gpt-5.4-mini`。
- `modelReasoningEffort`：enum，默认 `medium`。
- `promptAppend`：string，默认空字符串。
- `promptOverride`：string，可选，`allowEmpty: false`；显式写入时 `trim()` 后必须非空。

AW config schema 需要新增通用空值约束：

- `allowEmpty?: boolean` 只对 `string` 类型生效，默认 `true`，保持既有插件兼容。
- `allowEmpty: false` 表示显式写入的字符串经 `trim()` 后必须非空。
- 未设置不是空值：如果 key 不存在且 schema 没有 default，effective config 中不应凭空补 `""`；如果 key 不存在但有 default，则使用 default。
- `allowEmpty: false` 的字段不能声明空字符串或纯空白 default。
- `promptAppend` 保持 `allowEmpty: true`，因为空字符串是合法的“无追加内容”；`promptOverride` 使用 `allowEmpty: false`，因为空字符串不能表达“替换成空 workflow”。

`aw config configure` 的 string 字段交互必须保留三种状态：

- 跳过：只在字段选择阶段发生。可选字段没有被选中时，不进入输入，不出现在 `updates` / `updatedKeys`，也不改写 config store。
- 显式空值：字段已被选中并进入输入后，直接回车写入 `""`；输入纯空白时写入原始空白字符串。随后由 config schema 判断该值是否合法。
- 删除当前值：`configure` 首版不提供删除动作；用户必须使用 `aw config unset` 或 `aw config reset`。计划和文档都不能把空白输入描述成删除。

因此 prompt runtime 不能再把被选中 string 字段的空白输入转换成 `undefined`。`allowEmpty: false` 的字段会在 `coercePluginConfigUpdates()` 阶段失败；`allowEmpty: true` 的字段可以通过 `configure` 显式写入 `""`。

分层边界必须清楚：

- config schema / config store / `aw config set/configure` 只认识通用字段约束，例如 `type`、`required`、`values`、`min`、`max`、`allowEmpty`；不能识别 `codex-explore`、`promptOverride`、`codexRole` 或任何插件专属语义。
- `codexRole` manifest 校验可以要求 `promptConfig.overrideKey` 指向一个不允许空值的 string schema 字段；它只检查 schema 是否表达了所需约束，不参与 config 写入时的具体值判断。
- 插件 manifest 通过把自己的 `promptOverride` 字段声明为 `allowEmpty: false` 来复用通用能力；以后其它插件的任意 string 配置也可以使用同一能力。

`codexRole` 只声明这些配置 key 如何绑定到 artifact 字段，不保存默认值：

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

默认值的唯一真值是 `config.schema[configKey].default`。`codexRole.model.default` 和 `codexRole.modelReasoningEffort.default` 都是非法字段；role 渲染、config digest、status stale 判断和 `aw config` effective summary 必须读取同一套 schema default 与 config store 合成结果。

同一个 `codexRole` 内，所有已声明 binding key 必须唯一。下面这些形态都要被 manifest 校验和作者工具拒绝：

- `model.configKey` 和 `modelReasoningEffort.configKey` 指向同一个 schema key。
- `promptConfig.appendKey` 和 `promptConfig.overrideKey` 指向同一个 schema key。
- 任意 binding key 为空、缺失、指向不存在的 schema key，或字段类型不匹配。

### 4. Prompt 合成

最终写入 role layer 的 `developer_instructions` 由三段合成：

```text
safetyPrefix

workflowBody 或 promptOverride

promptAppend
```

规则：

- `safetyPrefix` 是插件固定提供的只读安全前导，必须始终排在最前面。
- `promptOverride` 只替换默认 workflow body，不能影响安全前导。
- `promptAppend` 追加团队或项目偏好，空白值忽略。
- `promptOverride` 不允许生成只有安全前导的弱工作流；它的非空约束来自 config schema 的 `allowEmpty: false`，不是 Codex role 或插件名特判。
- `aw config unset/reset` 清除 `promptOverride` 后按未设置处理，渲染时使用默认 workflow body。
- 生成器不需要理解自然语言语义，但必须用结构保证安全前导不会被配置清空或覆盖。

安全前导至少表达：

- 只能只读探索。
- 禁止创建、编辑、移动、删除、格式化或回退文件。
- 禁止运行破坏性命令或安装依赖。
- 输出必须围绕主 agent 的具体问题，使用结论、证据、不确定点和下一步建议。
- 摘录保持很短，不搬运大段源码。

默认 workflow body 使用 spec 中的中文草案，必须保留探索深度说明和最终输出结构：

- `quick`
- `medium`
- `very thorough`
- `结论`
- `证据`
- `不确定点`
- `建议主 agent 下一步查看`

### 5. Role namespace 与冲突检测

安装、status 和冲突检测不能只看 `[agents.codex-explorer]` 这个字面 table key。Codex 会把同一 config layer 里的 `[agents.*]` 声明和 `agents/**/*.toml` 文件归并到同一个 role 名空间。

需要新增最终 role 名解析：

- 读取当前 config layer 的 `[agents.*]`。
- 声明项带 `config_file` 时，读取对应 role layer；如果文件有 `name`，最终 role 名使用文件里的 `name`，否则使用 table key。
- 同层 `agents/**/*.toml` 中未被声明项引用的文件，也要读取文件里的 `name`。
- 缺少 `name` 的自动发现文件可以用文件 basename 做诊断，但不能把它当成可覆盖依据。
- 输出每个最终 role 的来源、table key、config path、role layer path 和是否 AW managed。

安装前先解析目标 scope 同层最终 role 名集合。这个检测必须作为 install command preflight 执行，位置在 skill trigger materialization、Codex native marketplace / plugin enabled、artifact、tracking、ledger 和 lifecycle 写入之前，不能只放在 `installExtensions()` 路径里。只要已有非 AW 管理 role 的最终名是 `codex-explorer`，安装就失败且不能写半成品；失败时不能留下 native plugin enabled、tracking 记录、degraded ledger 或 repo-managed artifact。冲突包括：

- `[agents.foo] config_file = "./agents/foo.toml"`，但文件里 `name = "codex-explorer"`。
- 用户手写 `agents/*.toml` 直接声明 `name = "codex-explorer"`。

Codex 内建 `explorer` 不算冲突，因为本插件 roleKey 是 `codex-explorer`。

### 6. Tracking、status 与 historical fallback

`GeneratedArtifact` 需要记录逻辑 role metadata：

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
    lastRenderedConfigDigest?: string;
    lastArtifactRefresh?: {
      status: 'succeeded' | 'failed' | 'skipped';
      updatedAt: string;
      triggerKeys: string[];
      refreshReach: {
        commandScope: 'user' | 'project';
        refreshedTargets: Array<{
          scope: 'user' | 'project';
          projectKey?: string;
          configSource: 'default+user' | 'default+user+project';
          paths: string[];
        }>;
        scannedHistoricalProjects: false;
        historicalProjectsMayBeStale: boolean;
      };
    };
  };
}
```

tracking 中还要保存：

- `roleKey`
- registration config path
- role layer path
- artifact 渲染使用的 config source
- 上次成功渲染的 config digest
- 最近一次 config-triggered refresh 结果
- `refreshReach`：本次命令实际刷新到哪些 target、是否扫描历史 project、是否存在未刷新的历史 project scope 可能仍 stale

status 至少要诊断：

- 注册项是否存在。
- `config_file` 是否仍指向 AW 管理 role layer。
- role layer 是否存在。
- role layer `name` 是否等于 `roleKey`。
- role layer `description` 是否和注册项一致。
- 同层是否存在非 AW 管理的同名最终 role。
- user scope 安装是否被更高优先级 project layer 遮蔽。
- 当前 role artifact 是否使用安装 scope 对应的最新 config digest。
- 最近一次 refresh 是否失败。
- 最近一次 `refreshReach` 是否显示 user scope 写入只刷新了 user 和当前 repo，未扫描其它历史 project；如果 tracking / ledger 中存在未纳入本次 refresh 的历史 project scope，status 要给出稳定提示，说明这些 project artifact 可能仍使用旧配置。
- 当前 project 是否存在命中 binding 的 project 覆盖，但只有 user scope artifact；这种覆盖不会进入全局 role 文件。

current catalog 缺失时，historical fallback 必须从 tracking 的 `agentRole` metadata 恢复真实 `roleKey`、registration path、role layer path 和 config source。discovery、status、交互式 uninstall/upgrade 候选，以及按插件名直达的 `aw uninstall codex-explore` / `aw upgrade codex-explore` 都要使用同一套恢复逻辑。恢复不了的 manifest-derived 诊断标为 `unavailable`，不能退回假名或 `historical-agent`。

### 7. Config-triggered artifact refresh

新增 refresh effect 推导工具，唯一输入是 `extensions.agents[].codexRole`：

```text
refresh keys =
- codexRole.model.configKey
- codexRole.modelReasoningEffort.configKey
- codexRole.promptConfig.appendKey
- codexRole.promptConfig.overrideKey

refresh target =
- platform: codex
- kind: agent
- roleKey: codexRole.roleKey
```

写命令接入点：

- `aw config set`
- `aw config configure`
- `aw config unset`
- `aw config reset`

刷新范围：

- user scope config 写入：刷新当前 user scope 已安装的 `codex-explore`，使用 `default+user` 渲染；如果当前 repo 也安装了 project scope artifact，一并刷新当前 repo 的 project artifact，使用 `default+user+project`。
- project scope config 写入：只刷新当前 repo 的 project scope artifact，不改写全局 user artifact。
- current manifest 不可用时，`config reset` 仍然要删除 raw config store，但跳过 artifact refresh，并在 JSON receipt 中给出稳定机器字段，例如 `artifactRefresh.skipped = true` 和 `reason = "manifest-unavailable"`。
- 没有命中 refresh keys 的配置写入保持现状，不刷新 artifact。
- 不扫描所有历史 project。
- 每次 config-triggered refresh 都必须写入 `lastArtifactRefresh.refreshReach`。user scope 写入只能记录 user target 和当前 repo project target；不能把其它历史 project 标成已刷新。
- 判断“其它历史 project 可能 stale”时只能使用 tracking / ledger 中已知的 project scope 记录，不进入历史 project 文件系统扫描；只要存在未纳入 `refreshedTargets` 的 project scope，就把 `historicalProjectsMayBeStale` 置为 `true`。

刷新写入策略：

- 只重渲染 tracking 证明属于 AW 管理的 artifact。
- role layer 或注册项已被外部接管时，不创建新 artifact，记录 failed/stale 诊断。
- 不执行 lifecycle 脚本。
- 不修改用户手写 role 文件。
- 如果刷新失败，优先回滚本次 config store 修改和已写 artifact；无法完全恢复时写入 `lastArtifactRefresh.status = "failed"`，让 status 可见。

config digest 建议只纳入 refresh keys：

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

## 实现分工面

### Manifest 与类型

修改范围：

- `packages/cli/src/types.ts`
- `packages/cli/src/utils/manifest.ts`
- 平台 manifest / source manifest bundle 生成路径

任务：

- 新增 `CodexAgentRoleDefinition`、config binding、prompt config、agent role artifact metadata、refresh metadata 类型。
- 扩展 `PluginConfigSchemaField`，为 `string` 字段新增 `allowEmpty?: boolean`，并在 manifest normalize / config coercion / prompt schema 中保留该语义。
- 校验 config schema：
  - `allowEmpty` 只能用于 `string` 字段，默认 `true`。
  - `allowEmpty: false` 的字段不能声明空字符串或纯空白 `default`。
  - `aw config set/configure` 对 `allowEmpty: false` 字段写入空字符串或纯空白值时必须报错，且不能写 store。
- 校验 `extensions.agents[].codexRole`：
  - `roleKey` 非空、单段、同插件内唯一。
  - `agent.name === codexRole.roleKey`。
  - 声明 `codexRole` 的 agent 禁止 `agentOverrides.codex.name`，即使覆盖值等于 `roleKey` 也拒绝。
  - binding key 必须存在于 `config.schema`。
  - 同一个 `codexRole` 内所有已声明 binding key 不重复。
  - model / reasoning binding schema 类型是 `string` 或 `enum`，且声明 default。
  - prompt append / override schema 类型是 `string`。
  - 如果声明 `promptConfig.overrideKey`，对应 schema 必须是 `type: "string"` 且 `allowEmpty: false`，这样所有插件都通过同一套 config schema 表达“override 不允许为空”。
  - `codexRole.model.default` 和 `codexRole.modelReasoningEffort.default` 非法。
  - `promptConfig.safetyPrefix` 非空。
  - Codex-only 插件缺少 `marketplace.policy.products = ["CODEX"]` 时给清晰错误或作者校验错误。
- 保留 `.agents-plugin/plugin.json` 中的 `codexRole`，但不要把它漏进 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json` 原生 manifest。

### Codex role 基础设施

修改范围：

- `packages/cli/src/utils/codex-config.ts`
- 新增或扩展 `packages/cli/src/utils/codex-roles.ts`
- `packages/cli/src/utils/detect.ts`
- `packages/cli/src/generators/agents.ts`

任务：

- 在 `codex-config.ts` 中支持解析、upsert、remove `[agents.<roleKey>]`。
- 删除注册项时，如果 `config_file` 已经 drift 到非 AW 文件，不删除对方文件。
- 实现 role layer TOML 解析，读取 `name`、`description`、`model`、`model_reasoning_effort`。
- 实现最终 role namespace 收集器。
- 让 session state / 遮蔽判断按最终 role 名工作，而不是按文件 basename。
- 重构 agent generator：
  - Claude `.md` 路径保持不变。
  - 没有 `codexRole` 的 Codex agent 保持旧单文件路径。
  - 有 `codexRole` 的 Codex agent 生成 registration data、role layer content、rendered config digest 和 role metadata。

### Codex adapter

修改范围：

- `packages/cli/src/commands/install.ts`
- `packages/cli/src/adapters/codex.ts`
- `packages/cli/src/utils/tracking.ts`
- status 输出相关类型和 reporter
- `commands/discovery.ts`
- `commands/common.ts`

任务：

- 在 install command 中新增 Codex role preflight，先解析目标 scope 最终 role namespace，所有冲突检测通过后再进入 skill trigger materialization、`installPlugin()`、artifact 生成、tracking、ledger 和 lifecycle。
- preflight 失败必须保持完全只读，不能留下 native plugin enabled、tracking 记录、degraded ledger 或 repo-managed artifact。
- install 写 role layer，再 upsert `[agents.<roleKey>]` 注册项，并把 role metadata 写进 tracking。
- uninstall 对 `agentRole` artifact 同时清理 role layer 和注册项；注册项已 drift 时不误删用户文件。
- upgrade 普通路径和 capabilityChanged/重装路径都按 `roleKey` 处理旧 artifact。
- status 增加 role-specific diagnostics 和 JSON 字段，并保证 `--json` / `--json --verbose` stdout 仍是纯 JSON。
- historical fallback 从 tracking 恢复真实 role identity，discovery 和 direct command 共用 helper。

### Config refresh

修改范围：

- 新增 `packages/cli/src/utils/artifact-refresh.ts`
- `packages/cli/src/commands/runtime.ts`
- `packages/cli/src/index.ts`
- `packages/cli/src/utils/plugin-config.ts`
- config 命令 JSON receipt / reporter
- status stale 判断

任务：

- 从 manifest 收集 Codex role refresh effects。
- 扩展 `CliConfigPromptSchemaEntry`，把 string 字段的 `allowEmpty` 从 manifest prompt schema 传到 runtime；`index.ts` 的 `config configure` 和 `preflightRequiredPluginConfigs()` 的 `toPromptSchema()` 都必须保留这个字段。
- 调整 `configurePlugin` 的 string 输入解析：字段未选中才是跳过；字段已选中时，空白输入必须进入 `updates` / `updatedKeys`，不能被 `parsePromptedConfigValue()` 吞成 `undefined`。
- `configure` 不负责删除当前值；删除只由 `unset/reset` 表达，避免把“空值”和“未设置”重新混在一起。
- 在 `set/configure` 写入前执行通用 config schema 校验；命中 `allowEmpty: false` 的字段如果为空字符串或 `trim()` 后为空，必须失败，且不能留下 config store 或 artifact 变更。
- 在 `set/configure/unset/reset` 写入后判断 changed keys 是否命中 refresh keys。
- 按安装 scope 解析 role render config：user 用 `default+user`，project 用 `default+user+project`。
- 实现 artifact refresh、回滚、`refreshReach` metadata 写入和 status stale 对比。
- 保住 `config reset` 在 current catalog 缺失时仍能清理 raw store 的降级路径。

### 插件内容

新增：

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
- `extensions.agents[]` 声明 `name = "codex-explorer"` 且 `codexRole.roleKey = "codex-explorer"`
- `codexRole` 只绑定 config key，不声明 default
- `config.schema` 声明 `explorerModel`、`modelReasoningEffort`、`promptAppend`、`promptOverride`

`agents/openai.yaml` 要点：

- 默认 `policy.allow_implicit_invocation: true`
- 描述匹配代码库探索、架构梳理、实现边界、跨模块影响面等场景

`SKILL.md` 要点：

- 自动触发版代表用户授权本 workflow 在匹配探索场景里使用 explorer。
- 主 agent 先判断是否真的需要 explorer。
- 默认 1 个 explorer，复杂时 2 到 3 个，极复杂最多 4 个。
- 委派 prompt 必须包含范围、具体问题、探索深度、输出格式和只读要求。
- `spawn_agent` 只传 `agent_type = "codex-explorer"`，不传 model/reasoning override。
- explorer 运行时主 agent 继续做不重叠的本地调查。
- 汇总后只补读少量关键证据。
- 使用完本 workflow 启动的 explorer 后必须调用 `close_agent`。

默认 explorer prompt 要点：

- 安全前导固定在插件源码或 manifest 常量中。
- 工作流正文采用 spec 的中文草案。
- 输出结构固定为“结论 / 证据 / 不确定点 / 建议主 agent 下一步查看”。

### 文档与作者工具

修改范围：

- `docs/plugin-authoring.md`
- `docs/plugin-installation.md`
- `docs/architecture.md`
- `.agents/skills/create-agent-workflows-plugin/references/*`
- `.agents/skills/create-agent-workflows-plugin` 校验脚本

任务：

- 文档说明 `extensions.agents[].codexRole`、roleKey 唯一性、`agent.name === roleKey`、禁止 `agentOverrides.codex.name`。
- 文档说明 config binding、默认值唯一来自 `config.schema`、重复 binding key 非法。
- 文档说明 config schema 的 `allowEmpty`、空值和未设置的区别。
- 文档说明 prompt 合成、安全前导不可覆写，以及 `promptOverride` 通过 `allowEmpty: false` 在配置写入阶段拒绝空值。
- 安装文档说明 Codex role artifact、config 写入自动刷新、status 诊断和卸载行为。
- 作者工具校验缺失 `agents/openai.yaml`、Codex-only policy 缺失、非法 roleKey、重复 roleKey、重复 binding key、schema key 不存在、字段类型不匹配、model/reasoning schema default 缺失、`codexRole` default 字段、`allowEmpty` 用法，以及 `promptOverride` 没有声明 `allowEmpty: false` 等。

## 阶段计划

### 阶段 1：source contract

交付：

- 类型、manifest 校验、platform manifest 过滤和 source manifest 保留逻辑。
- manifest 单测覆盖合法 `codexRole` 和非法字段。

退出标准：

- 合法 spec 形态能被 normalizer 接受。
- 默认值双真值、重复 roleKey、重复 binding key、`agentOverrides.codex.name` 绕行都能给清晰错误。

### 阶段 2：Codex role TOML 与 namespace

交付：

- `[agents.<roleKey>]` 解析/upsert/remove helper。
- role layer TOML 解析 helper。
- 最终 role namespace 收集器。
- `detect.ts` 遮蔽判断按最终 role 名工作。

退出标准：

- 能准确识别 `[agents.foo]` 指向文件内 `name = "codex-explorer"` 的冲突。
- 能识别未被声明引用的 `agents/*.toml` 同名 role。
- AW tracking 管理的同名 role 不被误判为外部冲突。

### 阶段 3：generator、install、uninstall、status

交付：

- 有 `codexRole` 的 Codex agent 生成注册项和 role layer。
- install/uninstall/status/upgrade 按 `roleKey` 处理 agent artifact。
- historical fallback 从 tracking 恢复 role identity。

退出标准：

- 不涉及 config refresh 时，Codex custom role 已经是 AW 一等受管 artifact。
- role 冲突会在任何 native/config/artifact/tracking/ledger 写入前失败，失败后没有半成品状态。
- current catalog 缺失时，status/discovery/direct uninstall/direct upgrade 不退回 `historical-agent`。

### 阶段 4：config-triggered refresh

交付：

- refresh effect 推导、config digest、写命令接入、回滚和 refresh metadata。
- status 对比 digest 并报告 stale/failed。

退出标准：

- 修改 `explorerModel`、`modelReasoningEffort`、`promptAppend` 或 `promptOverride` 后，当前可定位安装目标自动刷新。
- user artifact 不读取 project store；project scope 写入不改写 user artifact。
- user scope 写入后的 `refreshReach` 能区分已刷新的 user / 当前 project target 和未扫描的历史 project target，status 能稳定提示其它历史 project artifact 可能 stale。
- `allowEmpty: false` 的通用 schema 校验生效；空白或仅空格的 `promptOverride` 在 `set/configure` 阶段被拒绝，不写 config store，也不触发 artifact refresh。
- `configure` 中选中的 string 字段直接回车会进入 schema 校验：`allowEmpty: false` 失败，`allowEmpty: true` 可写入 `""`；跳过只能通过不选择该字段完成。
- current catalog 缺失时 `config reset` 仍能删除 raw store 且 JSON stdout 纯净。

### 阶段 5：新增 `codex-explore` 插件

交付：

- `plugins/codex-explore` 源码。
- `SKILL.md`、`agents/openai.yaml`、默认 explorer prompt、config schema。
- build 后生成 runtime bundle。

退出标准：

- 用户能安装 `$codex-explore`。
- skill workflow 指向 `agent_type = "codex-explorer"`。
- role artifact 使用默认 `gpt-5.4-mini` 和 `medium`，并包含安全前导。

### 阶段 6：文档、作者工具和回归

交付：

- 公开文档和作者工具 reference。
- 作者工具校验脚本。
- 单元、集成、smoke 和内容回归测试。

退出标准：

- 文档、校验、CLI 产物和测试矩阵覆盖新 contract。
- 执行：
  - `pnpm test:unit`
  - `pnpm test:integration`
  - `pnpm build`
  - `pnpm test:smoke:build`
  - `pnpm test:smoke:pack`

## 测试矩阵

### Unit

- manifest normalize：
  - 接受 `string` 字段的 `allowEmpty`，并保持默认 `allowEmpty: true` 的兼容行为。
  - 拒绝非 `string` 字段声明 `allowEmpty`。
  - 拒绝 `allowEmpty: false` 搭配空字符串或纯空白 default。
  - 接受合法 `codexRole`。
  - 接受同一插件内多个不同 `roleKey`。
  - 拒绝未知字段、空 roleKey、非法 roleKey、重复 roleKey。
  - 拒绝 `agent.name !== roleKey`。
  - 拒绝任何 `agentOverrides.codex.name`。
  - 拒绝缺失 schema key、字段类型不匹配、model/reasoning schema default 缺失。
  - 拒绝 `codexRole.model.default` 和 `codexRole.modelReasoningEffort.default`。
  - 拒绝同一个 `codexRole` 内重复 binding key。
  - 拒绝 `promptConfig.overrideKey` 指向没有声明 `allowEmpty: false` 的 schema 字段。
  - `agentOverrides.claude = null` 不影响 Codex `codexRole`。
- config coercion：
  - `allowEmpty` 未声明的 `string` 字段保持接受空字符串。
  - `allowEmpty: false` 的 `string` 字段拒绝空字符串和纯空白字符串。
  - `unset/reset` 删除 key 后按未设置处理，不等同于写入空字符串。
- config prompt runtime：
  - `CliConfigPromptSchemaEntry` 保留 `allowEmpty`，`config configure` 和 required-config preflight 都要把 manifest schema 中的值传入 prompt runtime。
  - 可选 string 字段未被选择时保持跳过，不出现在 `updates` / `updatedKeys`。
  - 已选中的 string 字段直接回车时，`updates[key]` 是 `""`；输入纯空白时，`updates[key]` 保留原始空白字符串。
  - `allowEmpty: false` 的字段经 `configure` 输入空字符串或纯空白字符串后，必须在写入前校验失败，不写 config store。
  - `allowEmpty: true` 的字段经 `configure` 可显式写入 `""`，这不是 unset/reset。
- generator：
  - 生成 `[agents.<roleKey>]` 注册数据和 role layer。
  - role layer path 使用 `buildGeneratedName(pluginName, roleKey)`。
  - role file 写入 `name`、`description`、`model`、`model_reasoning_effort`、`developer_instructions`。
  - prompt 合成始终保留安全前导，override 只替换正文，append 追加末尾。
  - 未设置的 `promptOverride` 回退默认 workflow body；显式空白值在 config schema 校验阶段被拒绝，不能渲染成只有安全前导的 role prompt。
  - model/reasoning 默认值只从 `config.schema` default 读取。
  - config digest 只包含 refresh keys，并区分 `default+user` 和 `default+user+project`。
- codex config helper：
  - upsert/remove `[agents.<roleKey>]` 保留其它 TOML。
  - 解析相对 `config_file`。
  - 删除时发现 config_file drift 不误删。
- role namespace：
  - 声明项指向文件内同名 role 能检测冲突。
  - 未被声明引用的同名 role 能检测冲突。
  - AW managed 同名 role 不算外部冲突。
- refresh effect：
  - 只命中 `codexRole` binding keys。
  - unrelated config key 不触发 refresh。
  - `reset` 按可能变化处理。
  - project config 变化不触发 user artifact 重渲染。
  - user scope refresh 的 `refreshReach` 记录 user / 当前 project target，并把未纳入的历史 project scope 标为可能 stale。

### Integration

- `aw install codex-explore -p codex -s user`：
  - native plugin enabled。
  - 生成 `[agents.codex-explorer]` 和 role layer。
  - tracking 记录 roleKey、registration path、role layer path、config source 和 digest。
- `aw install codex-explore -p codex -s project`：
  - role layer 使用 `default+user+project`。
  - project config 覆盖进入 project artifact，不改写 user artifact。
- `aw install codex-explore -p claude` 被 product policy 拦截。
- 安装时存在非 AW 管理最终 role 名 `codex-explorer`，命令在任何 native/config/artifact/tracking/ledger 写入前失败；断言不会留下 native plugin enabled、tracking 记录、degraded ledger 或 repo-managed artifact。
- `aw uninstall codex-explore -p codex` 清理注册项和 role layer，不删除用户手写文件。
- `aw upgrade codex-explore -p codex` 普通升级和 capabilityChanged/重装路径都按 `roleKey` 处理。
- `aw status` 覆盖正常、role layer 缺失、注册项缺失、config_file drift、同名外部 role、project layer 遮蔽、digest stale、refresh failed。
- `aw status --json` 和 `aw status --json --verbose` stdout 保持纯 JSON，并暴露 role 诊断字段。
- current catalog 缺失但 tracking 仍有 `agentRole`：
  - discovery 恢复真实 roleKey。
  - status 展示 `source=historical` 和 role identity。
  - direct uninstall / direct upgrade 仍能恢复真实 roleKey。
- `aw config set/configure/unset/reset` 命中 refresh key 后刷新当前可定位 role layer。
- 同一 repo 已安装 user scope 和 project scope role artifact 后，执行命中 refresh key 的 `aw config set ... -s user`：
  - user role layer 按 `default+user` 重渲染。
  - 当前 repo 的 project role layer 也按 `default+user+project` 同步重渲染。
- 两个 repo 都安装 project scope role artifact 后，在 repo A 执行命中 refresh key 的 `aw config set ... -s user`：
  - `refreshReach.refreshedTargets` 只包含 user target 和 repo A project target。
  - repo A 的 `aw status` 能提示 repo B 这类历史 project target 未扫描，可能仍使用旧 artifact。
- current catalog 缺失时 `aw config reset codex-explore -s user --yes --json` 仍能删除 raw config store，并说明 refresh skipped。
- refresh 失败时回滚 config store 和已写 artifact；无法完全恢复时 status 能诊断 failed。
- `promptOverride` / `promptAppend` 写入后，role layer 中安全前导仍在最前。
- `aw config set/configure` 写入空白或仅空格的 `promptOverride` 时失败；断言 config store、role layer 和 tracking refresh metadata 都没有变化。
- 任意插件的 `string` config 字段只要声明 `allowEmpty: false`，`aw config set/configure` 写入空白或仅空格值都失败；断言这是通用 config schema 行为，不依赖插件名或具体 key。
- 任意插件的 `string` config 字段保持默认 `allowEmpty: true` 时，`aw config configure` 选中字段并直接回车可以写入 `""`；不选择字段才表示跳过。
- skill trigger 默认自动触发，安装覆盖为 manual 后 Codex `allow_implicit_invocation` 为 false。

### 内容回归

必须锁住插件实际交付给模型的内容：

- `SKILL.md` 包含 `close_agent` 要求，并说明 `wait_agent` 不等于关闭 agent。
- `SKILL.md` 要求每个委派 prompt 写探索深度。
- `SKILL.md` 保留 `quick`、`medium`、`very thorough` 三档。
- `SKILL.md` 要求 `spawn_agent` 只传 `agent_type = "codex-explorer"`，不传 model/reasoning override。
- `agents/openai.yaml` 默认允许隐式触发。
- 默认 explorer prompt 保留只读边界。
- 默认 explorer prompt 保留输出结构：`结论`、`证据`、`不确定点`、`建议主 agent 下一步查看`。
- 默认 explorer prompt 不要求 explorer 写实现计划或修改文件。

这些断言可以放在 `authoring-tools.test.ts`、插件 smoke 或专门的 fixture 测试中；关键是让 `SKILL.md` / `agents/openai.yaml` / 默认 role prompt 的回归能被测试发现。

### Smoke

- `pnpm build` 生成 `packages/cli/plugins-dist/codex-explore`。
- `pnpm test:smoke:build` 覆盖 Codex-only marketplace entry、platform manifest、skill 文件和 role source manifest。
- source manifest / bundle layout 断言：`codexRole` 保留在 `.agents-plugin/plugin.json`，不进入 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json` 原生 manifest。
- `pnpm test:smoke:pack` 验收 `pnpm pack:cli` tarball 包含新插件 runtime bundle。

## Review 问题关闭标准

前序 review 的三个 findings 已按下面方式关闭：

- 默认值真值不一致：更新 spec 示例，删除 `codexRole` 内的 `default`；计划和测试都声明默认值只来自 `config.schema`。
- 重复 binding key 未落 contract：manifest 校验、作者工具和单测都把同一个 `codexRole` 内重复 binding key 作为非法输入。
- skill/prompt 内容缺少回归：新增内容回归测试，直接断言 `SKILL.md`、`agents/openai.yaml` 和默认 explorer prompt 的关键句与输出结构。

`docs/dev/reviews/codex-explorer-plugin-plan-review.md` 相关 findings 按下面方式关闭：

- refresh metadata 缺少 `refreshReach`：tracking 保存 `refreshReach`，status 暴露历史 project 未扫描 / 可能 stale 的稳定诊断，集成测试覆盖两个 repo 的 user scope 写入场景。
- 空白 `promptOverride` 语义未定：新增通用 `allowEmpty` schema 能力，`promptOverride` 通过 `allowEmpty: false` 声明非空约束，`aw config set/configure` 只按 schema 拒绝空字符串或纯空白值，并用 unit / integration 测试锁住不写 store、不刷新 artifact 的行为。
- `allowEmpty` 未落到 `config configure` prompt/runtime：把 `packages/cli/src/commands/runtime.ts` 和 prompt schema 转换纳入修改面，明确未选中字段才是跳过；选中 string 字段后的空白输入是显式写入值，删除当前值只走 `unset/reset`。测试覆盖 `allowEmpty: false` 失败和 `allowEmpty: true` 写入 `""` 两条路径。

## 风险与回退

- config refresh 最容易留下半完成状态。实现前先准备 config store、tracking 和 artifact 内容快照，失败时尽量回滚；无法回滚时写 failed metadata。
- 最终 role 名解析要容忍用户手写 TOML 损坏。安装时解析失败应 fail fast；status 可以 degraded warning。
- user scope artifact 不读取 project store，会带来产品解释成本。status 要明确提示 project 覆盖不会影响全局 role 文件，需要 project scope install/refresh 才生效。
- user scope 配置写入不会扫描所有历史 project。tracking 必须写实记录 `refreshReach`，status 要提醒未纳入本次 refresh 的历史 project artifact 可能 stale。
- 只读安全前导无法靠自然语言语义校验 `promptOverride`。配置写入阶段只能通过通用 schema 约束拒绝空白值，生成器也必须通过合成顺序保证安全前导永远排在最前。
- 模型 slug 可用性不是 AW 能静态保证的能力。用户配置不可用模型时，失败可能发生在 Codex spawn 阶段。
- 当前 Codex 会话是否热加载 role artifact 取决于 Codex runtime。文档要说明必要时需要新会话生效。
- 旧式 Codex agent 单文件 artifact 要保持兼容；没有 `codexRole` 的插件不应被迫迁移。

## 首版验收清单

- `pnpm build` 能生成 Codex-only `codex-explore` marketplace entry。
- `aw install codex-explore -p codex -s user` 成功生成 `[agents.codex-explorer]` 和 role layer。
- `aw install codex-explore -p claude` 被 product policy 拦截。
- skill 默认允许隐式触发，并可通过安装触发偏好改为手动。
- role 文件包含 `model = "gpt-5.4-mini"`、`model_reasoning_effort = "medium"` 和带安全前导的 `developer_instructions`。
- 安装不会覆盖任何非 AW 管理且最终 role 名为 `codex-explorer` 的自定义 role。
- role 冲突会在任何 native/config/artifact/tracking/ledger 写入前失败，不留下 native plugin enabled、tracking 记录、degraded ledger 或 repo-managed artifact。
- tracking/status/uninstall/upgrade/refresh 都按 `roleKey` 处理。
- `aw config set/configure/unset/reset` 命中 `codexRole` refresh keys 后自动刷新当前可定位 artifact。
- `aw config set/configure` 写入空白或仅空格的 `promptOverride` 会失败，不写 config store，也不触发 artifact refresh。
- `aw config configure` 选中 string 字段后，空白输入不会被静默跳过；它会作为显式值进入 schema 校验，只有字段允许空值时才能写入。
- user artifact 使用 `default+user`，project artifact 使用 `default+user+project`。
- 同一 repo 同时安装 user/project artifact 时，user scope 配置写入会同步刷新 user artifact 和当前 project artifact。
- `config reset` 在 current catalog 缺失时仍可删除 raw store，并清楚说明 refresh 被跳过。
- status 能报告 role 缺失、注册项 drift、role 遮蔽、config stale、refresh failed，以及 `refreshReach` 显示的历史 project 可能 stale。
- current catalog 缺失但 tracking 仍有 `agentRole` 时，status/discovery/direct uninstall/direct upgrade 仍保留真实 `roleKey`。
- status JSON 保持机器可读，包含 role 诊断字段且不混入人类可读 warning。
- 作者工具能校验 `codexRole`、Codex-only policy、`agents/openai.yaml`、默认值真值和重复 binding key。
- 内容回归能锁住 `close_agent`、探索深度、`agent_type = "codex-explorer"` 和默认 explorer prompt 输出结构。
- uninstall 清理 AW 管理的注册项和 role layer，不影响用户手写文件。
- 单元、集成和 smoke 测试覆盖 manifest、生成器、Codex adapter、config refresh、插件 bundle 和 tarball。
