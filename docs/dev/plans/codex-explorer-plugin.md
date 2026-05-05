# Codex 探索插件执行计划

## 需求来源

本计划落实 `docs/dev/specs/codex-explorer-plugin-spec.md`。如果实现过程中发现本计划和 spec 不一致，先回到 spec 校准需求，再更新计划；不要让实现按过期计划继续推进。

本轮 spec 已经从“在静态 `extensions.*` 上补 config binding / `codexRole` 特例”改为 **artifact renderer script** 主线：

- 插件通过 `scripts.artifacts.render` 返回 ArtifactPlan。
- 插件通过 manifest `artifacts.targets` 声明动态 artifact 的安装前能力真值。
- 插件负责根据目标 scope 的 artifact render config 计算 artifact 的 `present` / `disabled` 状态和内容。
- AW CLI 负责 capability 识别、project write safety preflight、校验 plan、写盘、tracking、status、rollback、upgrade、uninstall 和 config-triggered refresh。
- `enableLightweightInstruction` 是 `codex-explore` renderer 消费的普通配置，不是 AW core 里的 instruction 专属开关。

上一版计划里的这些内容已被新 spec 取代，不再作为本需求执行范围：

- `extensions.agents[].codexRole` 作为 config binding 真值。
- `promptAppend` / `promptOverride`。
- 为 `promptOverride` 新增 `allowEmpty` schema 能力。
- skill 默认隐式触发。
- 让主 agent 在显式 skill 路径之外默认调用 `agent_type = "codex-explorer"`。

仍然保留的产品目标是：默认轻量 instruction 入口 + 手动 `$codex-explore` skill 入口 + 专用 `codex-explorer` role。

## 首版交付目标

首版要交付两层能力。

第一层是 AW 基础设施：

- 新增 `scripts.artifacts.render` manifest contract。
- 新增 `artifacts.targets` manifest metadata，把动态 artifact 纳入 installability、discovery、status current catalog、project write safety preflight 和 ledger capability snapshot。
- 新增 renderer context 和 ArtifactPlan schema。
- 支持 `codex.developerInstructionsBlock` target。
- 支持 `codex.agentRole` target。
- 扩展 tracking，从 path-only 变成 artifact-aware。
- 在 `aw config set/unset/reset` 或主控制台配置向导后，根据已安装 artifact 的 `refreshKeys` 和目标 scope render config 自动刷新当前可定位 target。
- 保留静态 `extensions.instructions/permissions/hooks/agents` 的兼容路径，可通过内置 renderer 或等价兼容层实现。

第二层是 `codex-explore` 插件：

- Codex-only，`marketplace.policy.products = ["CODEX"]`。
- 同时支持 Codex user scope 和 project scope；project scope 只写当前仓库 repo-managed skill、instruction 和 role artifact，不注册或启用共享 user native plugin。
- 默认轻量 instruction 使用 Codex 内置 `explorer` role，并显式传入插件配置里的 `model` 和 `reasoning_effort`。
- `enableLightweightInstruction=false` 时，renderer 返回 disabled instruction artifact，AW 移除或跳过轻量 instruction block，status 报告 disabled by config。
- `$codex-explore` skill 默认手动触发，使用专用 `codex-explorer` role。
- 专用 role 由 `codex.agentRole` target 管理 `[agents.codex-explorer]` 注册项和 role layer 文件。

## 执行边界

首版必须坚持这些边界：

- 不改变 Codex 上游 `spawn_agent` 的全局授权规则。
- 不为 `enableLightweightInstruction` 发明 core adapter 特例、instruction 专属 manifest 字段或 `extensions.instructions[].when`。
- 不让 renderer 或 lifecycle 脚本直接写 `.codex/config.toml`、`.codex/agents/*.toml`、tracking 或 ledger。
- 不通过 lifecycle 脚本实现 artifact refresh。
- `aw status` 是只读路径，不执行 `scripts.artifacts.render` 或 lifecycle 脚本。
- 不新增 `aw config apply`、`sync` 或其它刷新命令。
- 不让所有配置写入都触发 refresh；只有已安装 artifact tracking 中的 `refreshKeys` 命中时才刷新。
- 不扫描所有历史 project；refresh 只覆盖当前命令上下文能定位的 target。
- artifact render config 按目标安装 scope 解析：user scope 使用 `config.schema default + user store`；project scope 使用 `config.schema default + user store + 当前 project store`。project config 覆盖不能进入 user artifact 内容、digest、stale 判断或 refresh 结果。
- 不在 Codex project scope 启用或依赖 user scope native plugin。
- 默认轻量入口只调用内置 `explorer`，不调用 `codex-explorer`。
- 专用 `codex-explorer` role 只服务手动 `$codex-explore` skill。
- 不复用或覆盖 Codex 内置 `explorer` role。
- 首版不做 MCP、hook、permission mode、代码索引服务或 role 级工具 allowlist / denylist。
- 首版不做 prompt override；模型和 effort 只来自 `explorerModel`、`modelReasoningEffort`。
- `--skill-trigger auto` 只影响 skill 是否可被自动选中，不改变 Codex runtime 的 `spawn_agent` 全局授权规则。
- artifact refresh 失败后保留已经写入的 config store，并把受影响 artifact 标记为 refresh failed，让 status 可诊断。

仍需保留上一版计划里已经 review 过、且没有被新 spec 推翻的执行细节：

- 安装/升级路径中的 Codex role 冲突 preflight 必须尽早执行；发现非 AW 管理的同名最终 role 时，命令保持完全只读，不能写 config store、native plugin enabled、artifact、tracking、ledger，也不能调用 config prompt。
- tracking / status 要能从历史记录恢复 artifact 身份；current catalog 缺失时，status、discovery、主控制台 uninstall/upgrade 候选和 direct uninstall/upgrade 不能退回假名。
- user scope 配置写入不会扫描所有历史 project；refresh metadata 要写实记录本次刷新覆盖了哪些当前可定位 target，status 需要能说明其它已知历史 project target 可能仍 stale。
- 内容回归要直接锁住 `SKILL.md`、`agents/openai.yaml`、轻量 instruction 和专用 role prompt 的关键句，而不是只验证文件存在。

## 需求拆解

### 1. Artifact renderer source contract

修改范围：

- `packages/cli/src/types.ts`
- `packages/cli/src/utils/manifest.ts`
- 插件 source manifest bundle / platform manifest 生成路径
- 插件脚本打包相关代码

任务：

- 扩展 `PluginScriptsConfig`，新增 `scripts.artifacts.render`。
- 扩展 manifest schema，新增 `artifacts.targets` 动态能力元数据。
- 定义 renderer script entry，首版至少支持 `runner = "node"`，并复用现有脚本 timeout、bundle、依赖闭包和跨平台 runner 约束。
- 定义 `ArtifactPlan`、`ManagedArtifactId`、`ArtifactState`、`ArtifactTarget`。
- 定义首批 target：
  - `codex.developerInstructionsBlock`
  - `codex.agentRole`
- 定义 artifact kind：
  - `instruction`
  - `codexRole`
  - 保留现有 `permission` / `hook` / `agent` 兼容语义，不强迫旧插件迁移。
- 定义 `artifacts.targets` 字段语义：
  - 稳定 `id`
  - `platform`
  - 适用 `scopes`
  - `target`
  - `projectManagedKind`
  - 允许的 `states`
  - `refreshKeys`
  - `requiresCodexProjectConfig`
- `codex.agentRole` target 的静态 metadata 必须声明最终 `roleKey`，供 install / upgrade / refresh 的 command-level preflight 在不执行 renderer 的情况下检查 role namespace 冲突；renderer 输出的 `roleKey` 必须和该静态声明一致，不能通过 renderer 扩大或改写最终 role 名。
- `projectManagedKind` 使用 Codex project capability snapshot 的既有 kind：`codex.developerInstructionsBlock` 映射为 `instruction`，`codex.agentRole` 映射为 `agent`，不要把 ArtifactPlan 内部的 `kind = "codexRole"` 写入 capability snapshot。
- 校验 renderer manifest：
  - `scripts.artifacts.render.path` 必须是插件包内相对路径。
  - runner 不支持时给清晰错误。
  - Codex-only 插件不是强制要求 renderer，但 `codex-explore` 必须声明 renderer。
- 校验 `artifacts.targets`：
  - 每个动态 artifact 必须有唯一 `id + target`。
  - `refreshKeys` 必须存在于 `config.schema`。
  - `states` 只能使用首版支持状态。
  - `requiresCodexProjectConfig = true` 的 target 会触发 project write safety preflight。
  - `codex.agentRole` target 必须有合法 `roleKey`，且 renderer plan 中的 `roleKey` 必须完全匹配静态 metadata。
- 确保 `scripts.artifacts.render` 和 `artifacts.targets` 保留在 `.agents-plugin/plugin.json` 与 AW runtime bundle 的需要位置；不能泄漏为 Codex 原生插件 manifest 的未知字段。
- Codex project surface 入口必须合并静态 manifest 能力和动态 `artifacts.targets`：
  - `getCodexProjectManagedKinds()` 或等价入口。
  - project scope installability。
  - discovery candidate。
  - status current catalog view。
  - ledger `capabilitySnapshot.projectManagedKinds`。
  - `requiresCodexProjectConfig` / project config backed 判断。
- `codex-explore` 首次 project install 前就应被识别为 `skill + instruction + agent`，不能因为 renderer 尚未执行而误判为 `skill-only`。
- 首次 install、explicit upgrade 和 config-triggered refresh 只要会写 Codex project scope config-backed artifact，都必须在 renderer、native plugin enable、artifact 写入、tracking/ledger 提交和 lifecycle 之前完成 project write safety preflight。

### 2. Renderer runtime

修改范围：

- `packages/cli/src/utils/plugin-scripts.ts`
- 新增 `packages/cli/src/utils/artifact-renderer.ts`
- install / upgrade / refresh 调用链

任务：

- 新增 artifact render 阶段，执行时机在 artifact 写盘之前。
- renderer 通过 `AW_PLUGIN_CONTEXT` 读取 context JSON 路径或等价上下文入口。
- renderer context 至少包含：
  - `event`: `install` / `upgrade` / `refresh`
  - `platform`
  - `scope`
  - plugin name、version、rootDir
  - artifact render config schema、values、sources、issues
  - config mode 和 target scope
  - `changedConfigKeys`
  - previous tracked artifacts
  - AW / Codex / Claude home、manifestPath 等路径
- 新增 artifact render config 解析 helper，并和现有 effective config 口径区分：
  - `effective config` 继续服务 `aw config get/list` 默认读取和项目运行时读取，按当前命令上下文解析 project root。
  - `artifact render config` 只服务 install / upgrade / refresh / digest / stale 判断，按目标安装 scope 解析。
  - user scope render config 只合并 `schema default < user config`。
  - project scope render config 合并 `schema default < user config < 当前 project config`。
  - `aw status` 可以用同一 scope 规则纯计算 `configDigest` / stale 诊断，但不能执行 renderer。
- renderer stdout 必须是 JSON。
- stderr 只作为诊断摘要，不能混入 JSON receipt stdout。
- 非 JSON、未知 version、超时、退出码非 0、未知 target、字段类型错误都视为 render 失败。
- render 失败时不能让插件脚本自行落盘，也不能写半份 tracking。
- install / upgrade 没有 changed keys 时仍按完整 artifact render config 输出 plan。
- refresh 事件必须带上本次变更的 config keys。
- renderer 只允许在 install / upgrade / refresh 这类写路径执行。`aw status` 不执行 renderer；如果 status 需要 digest 对比，只能基于 current catalog、install snapshot、tracking 中的 renderer/manifest digest、config digest 和目标 scope config 纯计算。

### 3. ArtifactPlan 校验

修改范围：

- 新增 `packages/cli/src/utils/artifact-plan.ts`
- manifest / renderer 测试夹具

任务：

- 校验 plan 顶层 `version = 1`。
- `artifacts` 必须是数组。
- `id` 是插件内稳定 id，非空，只允许安全字符。
- `pluginName + id + target` 是受管 artifact 的逻辑身份。
- `platform` 必须等于当前 render context platform。
- `target` 必须是 AW 支持的枚举值。
- `state` 首版支持 `present` 和 `disabled`。
- `refreshKeys` 必须是 `config.schema` 中存在的 key。
- plan artifact 必须落在 manifest `artifacts.targets` 针对当前 platform/scope 声明过的范围内。
- renderer 不能返回未声明 `id`、未声明 target、未声明 state、未声明 refresh key，或 manifest 未声明的 project config 写入面。
- 当前 platform/scope 已声明的动态 artifact 必须返回 `present` 或 `disabled` plan；配置关闭用 `disabled` 表达，不能直接省略。
- disabled artifact 也必须保留足够的 `refreshKeys`，否则从 disabled 改回 present 时无法触发 refresh。
- `state = "disabled"` 时允许缺少 content，但必须允许 `disabledReason`，例如 `config`。
- `state = "present"` 时必须按 target 校验 content。
- 禁止 renderer 声明任意绝对路径或跳出插件/目标目录的路径。
- 同一 plan 中同一个 `id + target` 不能重复。
- 多个 instruction artifact 需要有稳定排序或合成规则，避免刷新顺序造成无意义 churn。
- 计算 artifact `configDigest`，至少纳入：
  - artifact `refreshKeys` 对应 artifact render config 值
  - renderer script digest 或 manifest digest
  - platform、target、id

### 4. Target runtime：`codex.developerInstructionsBlock`

修改范围：

- `packages/cli/src/adapters/codex.ts`
- `packages/cli/src/generators/instructions.ts`
- `packages/cli/src/utils/codex-config.ts`
- tracking/status helper

任务：

- `present` 时，把 artifact `content` 写入当前 scope 对应 Codex config 中该插件的 AW managed `developer_instructions` block。user scope 对应用户级 Codex config，project scope 对应当前仓库 `.codex/config.toml`。
- 支持同一插件多个 present instruction artifact 的稳定合成。
- `disabled` 时，移除该 artifact 对应的受管 instruction 内容，或在生成阶段跳过该内容。
- disabled 不能保留“已禁用”的运行时提示词。
- 同一 plugin + platform + scope 原子单元内，所有落到同一份 Codex config 的 instruction 和 role registration 变更必须在内存中合并，并通过一次文档级事务写入，共享同一份 rollback baseline。
- 写入后 tracking 记录：
  - artifact id
  - target
  - state
  - config path
  - refreshKeys
  - configDigest
  - contentDigest
- status 能区分：
  - present 且健康
  - disabled by config
  - block 缺失
  - content drift
  - config digest stale
  - 最近 refresh failed
- uninstall 清理该插件的受管 block；disabled artifact 也要参与清理，避免旧 block 残留。

### 5. Target runtime：`codex.agentRole`

修改范围：

- `packages/cli/src/commands/codex-project-safety.ts`
- `packages/cli/src/commands/install.ts`
- `packages/cli/src/commands/upgrade.ts`
- config-triggered refresh 的 command 入口 / `packages/cli/src/utils/artifact-refresh.ts`
- `packages/cli/src/utils/codex-config.ts`
- 新增或扩展 `packages/cli/src/utils/codex-roles.ts`
- `packages/cli/src/adapters/codex.ts`
- `packages/cli/src/utils/detect.ts`
- tracking/status helper

任务：

- `present` artifact 必须声明 `roleKey`。
- `content.registration` 描述当前 scope Codex config 中 `[agents.<roleKey>]` 注册项的展示字段，至少包含 `description`，不得包含 `config_file`。
- `content.roleFile` 描述 role layer 文件，至少包含 `name`、`description`、`developer_instructions`。
- `content.roleFile` 允许 Codex-only 字段：
  - `model`
  - `model_reasoning_effort`
- role 文件里的 `name` 必须等于 `roleKey`。
- `config_file` 使用相对当前 scope Codex config 的路径，由 AW 写入 `[agents.<roleKey>]` 注册项。
- role layer path 由 AW 根据 `pluginName` 和 `roleKey` 稳定生成，例如 `agents/aw-codex-explore-codex-explorer.toml`；renderer 不直接声明任意落盘路径。
- 注册项和 role layer 的 `description` 应保持一致，status 需要能诊断不一致。
- install / refresh 写 role layer，再 upsert `[agents.<roleKey>]` 注册项。
- uninstall 同时清理受管注册项和受管 role layer。
- 如果注册项 drift 到非 AW 文件，不删除用户文件。
- 如果 role layer 被外部接管或内容 drift，refresh 不能静默覆盖，必须进入可诊断状态。
- refresh 前必须重新校验受管身份；如果 `[agents.<roleKey>]` 已经不再指向 tracking 记录的 AW 受管 role 文件，或最终 role 名已被非 AW 管理来源占用，本次 refresh 必须失败并记录诊断。
- `disabled` 行为首版不是 `codex-explore` 主路径，但 target contract 要预留：禁用 role 时清理受管注册项和受管 role 文件，并把状态写入 tracking。
- role namespace 冲突检查必须作为 command 层写入前预检实现，不能只放在 adapter apply 阶段兜底：
  - 扩展 `preflightCodexProjectWriteSafety()` 或新增同级 preflight，读取 `artifacts.targets` 中 `codex.agentRole` 的静态 `roleKey`，在不执行 renderer 的情况下解析当前 layer 最终 role namespace。
  - install / upgrade 在 required-config preflight、config prompt、skill trigger materialization、Codex native marketplace / plugin enabled、renderer、artifact 写入、tracking、ledger 和 lifecycle 之前调用这条 preflight。
  - config-triggered refresh 在 config store 写入成功之后、renderer 或任何 artifact 写入之前复用这条 preflight；失败时保留 config store，但该 refresh 原子单元只记录失败诊断，不写新的成功 digest。
  - adapter apply 阶段仍要复核 renderer plan 的 `roleKey` 与静态 metadata、tracking 中的受管身份一致，但这不是最早冲突拦截点。

最终 role namespace 解析：

- 读取当前 config layer 的 `[agents.*]`。
- 声明项带 `config_file` 时读取对应 role layer；如果文件有 `name`，最终 role 名使用文件里的 `name`，否则使用 table key。
- 同层 `agents/**/*.toml` 中未被声明项引用的文件，也要读取文件里的 `name`。
- 输出每个最终 role 的来源、table key、config path、role layer path 和是否 AW managed。
- 安装前按最终 role 名检测冲突，不能只看 `[agents.codex-explorer]` 字面 table key。
- 已有非 AW 管理最终 role 名为 `codex-explorer` 时安装失败，不能覆盖。
- Codex 内置 `explorer` 不算冲突，因为本插件 roleKey 是 `codex-explorer`。
- 冲突 preflight 必须早于 required-config preflight、skill trigger materialization、Codex native marketplace / plugin enabled、artifact 写入、tracking、ledger 和 lifecycle。
- 冲突 preflight 失败时，fake prompt 不应被调用，工作区不应留下半成品状态。

status 至少诊断：

- 注册项是否存在。
- `config_file` 是否仍指向 AW 管理 role layer。
- role layer 是否存在。
- role layer `name` 是否等于 `roleKey`。
- role layer `description` 是否和注册项一致。
- 同层是否存在非 AW 管理同名最终 role。
- user scope role 的 higher-priority visibility / drift 诊断必须按 Codex 最终 role 名空间解析所有高优先级 layer，不能只按 `[agents.<key>]` 字面 key 或 `agents/*.toml` 文件名判断；如果高优先级 layer 通过不同 table key 或不同 role 文件名暴露同一个最终 `name = "codex-explorer"`，status 必须报告 `unknownByExternalLayer` 或等价稳定状态。
- config digest 是否 stale。
- 最近 refresh 是否失败。

### 6. Tracking、status、uninstall 和 upgrade

修改范围：

- `packages/cli/src/types.ts`
- `packages/cli/src/utils/tracking.ts`
- status 输出相关类型和 reporter
- `packages/cli/src/commands/discovery.ts`
- `packages/cli/src/commands/common.ts`
- install / uninstall / upgrade command

任务：

- 扩展 tracking manifest，支持 artifact-aware record。
- 当前项目仍在开发阶段，首版不要求把已经落盘的旧 path-only tracking 原地迁移到 artifact-aware record。这里的兼容要求只针对静态 `extensions.*` 作为插件源码/runtime contract 仍按原行为安装、status 和卸载。
- 新 tracking 至少表达：
  - `id`
  - `kind`
  - `platform`
  - `target`
  - `state`
  - `disabledReason`
  - `refreshKeys`
  - `configDigest`
  - `contentDigest`
  - `paths`
  - `roleKey`
  - `lastRefresh`
  - `refreshReach`
- `lastRefresh` 至少记录：
  - status: `succeeded` / `failed` / `skipped`
  - updatedAt
  - triggerKeys
  - event
  - error 摘要
- `refreshReach` 至少记录：
  - command scope
  - 实际刷新到的 user / current project target
  - 是否扫描历史 project，首版固定为 false
  - tracking / ledger 已知但未纳入本次刷新范围的 project target 是否可能 stale
- status JSON 必须保持纯 JSON，不能混入人类可读 warning。
- status human 输出要分别展示 instruction 和 role artifact，不要用一个总健康状态掩盖另一个 artifact 的问题。
- project scope status contract 必须把“磁盘 artifact 健康”和“当前会话可见性”作为两个独立维度：
  - artifact 健康覆盖 `present`、disabled by config、missing、content drift、config digest stale、refresh failed。
  - session 可见性覆盖 project trust `trusted` / `untrusted` / `unknown`，并能表达 skill、instruction 和 role 当前是 `visible`、`blockedByProjectTrust`、`projectTrustUnknown`、`unknownByExternalLayer`、`absent` 或等价稳定状态。
  - repo 为 `untrusted` 或 trust 状态未知时，健康 artifact 仍然可以是磁盘健康；status 不能把“artifact healthy but not session-visible”简化成 healthy 或 missing。
  - JSON 输出保留 artifact health、projectTrust、session visibility 的稳定机器字段；human verbose 输出要能说明当前 repo trust / session 加载状态导致的不可见性。
- uninstall 只清理 tracking 中记录的 AW 受管 artifact。
- disabled artifact 也要参与 uninstall 收尾。
- upgrade 普通路径和 capabilityChanged / 重装路径都按 artifact id 和 target 处理旧产物。
- upgrade 的 `capabilityChanged` 比较使用 installed snapshot 与 current catalog 的动态 metadata 合并结果；current catalog 缺失时，只能根据 installed snapshot、tracking artifact kind 和 historical evidence 保守回退，不能执行 renderer 恢复 current truth。
- current catalog 缺失时，historical fallback 必须尽量从 tracking 恢复 artifact id、target、paths、roleKey 和 state。
- discovery、status、主控制台 uninstall/upgrade 候选，以及按插件名直达的 `aw uninstall codex-explore` / `aw upgrade codex-explore` 要共用同一套恢复逻辑。
- 恢复不了的 manifest-derived 诊断标为 unavailable，不能编造假 role 名或 `historical-agent`。
- status 不执行 renderer 或 lifecycle 脚本。它基于 current catalog、ledger、tracking、install snapshot 和当前目标 scope config 只读判断 artifact 缺失、disabled、config stale、drifted 或 refresh failed。

### 7. Config-triggered artifact refresh

修改范围：

- 新增 `packages/cli/src/utils/artifact-refresh.ts`
- `packages/cli/src/index.ts`
- `packages/cli/src/utils/plugin-config.ts`
- config 命令 JSON receipt / reporter
- status stale 判断

任务：

- config 写命令接入点：
  - `aw config set`
  - `aw config unset`
  - `aw config reset`
  - `aw` 主控制台配置向导
- 写入 config store 成功后，读取当前命令上下文能定位的已安装插件 tracking。
- 如果 changed keys 命中任一 artifact 的 `refreshKeys`，且本次写入层会进入该 artifact 所属 scope 的 artifact render config，触发 renderer `event = "refresh"`。
- `reset` 按可能影响该插件所有 tracked `refreshKeys` 处理。
- 未命中任何 `refreshKeys` 时保持现有行为，不刷新 artifact。
- 未安装插件时只保存配置；后续 install / upgrade 按目标 scope 的最新 artifact render config 渲染。
- current manifest / renderer 不可用时，config store 写入仍保留，artifact refresh 标记 skipped 或 failed，并在 JSON receipt 中给稳定机器字段。
- refresh 重新解析 artifact render config：
  - user scope artifact 使用 schema default + user config。
  - project scope artifact 使用 schema default + user config + 当前 project config。
- user scope config 写入：
  - 刷新当前可定位的 user scope artifact。
  - 如果当前 repo 也安装了 project scope artifact，一并刷新当前 repo 的 project artifact。
  - user artifact 使用 `default+user`，当前 repo project artifact 使用 `default+user+project`。
- project scope config 写入只刷新当前 repo project artifact，不改写 user artifact。
- project config store 的存在不能被误判成 project scope 已安装；project config 变化也不能让 user scope artifact 进入 stale 或 refresh failed 状态。
- 命中 Codex project scope target 时，必须在 renderer 和 artifact 写入前执行 Codex project install / explicit upgrade 同级别的 project write safety preflight。预检至少覆盖用户级 Codex config 可读性和 external ownership、当前仓库 `.codex/config.toml` 可读性、tracking identity、未受管 repo artifact 冲突，以及其它既有 project write safety 检查。预检失败时保留 config store，但不得执行 renderer、不得改写 repo artifact、不得写入新的成功 digest。
- refresh 重新执行 renderer、校验 plan、应用受影响 artifact。
- `enableLightweightInstruction=false` 时，renderer 返回 disabled instruction artifact，AW 移除轻量 instruction block 并更新 tracking。
- `explorerModel` / `modelReasoningEffort` 变化时，instruction 和 role artifact 都应刷新。
- refresh 成功后更新 state、configDigest、contentDigest、lastRefresh。
- refresh 失败后不回滚 config store；受影响 artifact 标记为 refresh failed，让 status 能提示用户修复。
- refresh 不执行 lifecycle 脚本。
- refresh 不修改用户手写 role 文件。
- refresh 不扫描所有历史 project。
- refresh 的最小原子单元是同一 plugin + platform + scope 下本次命中的 artifact 集合。对于同一 scope 中的轻量 instruction 和专用 role，要么一起刷新成功，要么回滚到刷新前 artifact 状态。
- 同一原子单元内若同时改写 `developer_instructions`、`[agents.*]` 注册项或其它共享 Codex config 的受管内容，必须合并成一次 Codex config 文档级事务；apply 失败时按同一份 baseline 整体回滚。
- user scope 和 project scope 分别作为独立原子单元处理，不跨 scope 回滚。
- renderer 失败时不得写 artifact。apply 阶段任一 artifact 失败时，回滚本原子单元已经写入的 Codex config、role 文件和 artifact 内容；tracking 不得声称新 config digest 或新 content digest 已生效。
- 每次 refresh 都写入 `lastRefresh.refreshReach` 或等价字段。user scope 写入只能把 user target 和当前 repo project target 记为已刷新，不能把其它历史 project 标成已刷新。
- 判断“其它历史 project 可能 stale”时，只使用 tracking / ledger 中已知的 project scope 记录，不进入历史 project 文件系统扫描。

config 命令 receipt 建议增加：

```json
{
  "artifactRefresh": {
    "attempted": true,
    "status": "succeeded | failed | skipped",
    "triggerKeys": ["explorerModel"],
    "artifacts": [
      {
        "id": "lightweight-instruction",
        "target": "codex.developerInstructionsBlock",
        "state": "present"
      }
    ]
  }
}
```

### 8. 静态 extensions 兼容层

修改范围：

- `packages/cli/src/adapters/codex.ts`
- `packages/cli/src/generators/*`
- artifact renderer / plan helper

任务：

- 保留旧插件的静态 `extensions.instructions`、`extensions.permissions`、`extensions.hooks`、`extensions.agents` 行为。
- 可以把静态 extensions 包成内置 renderer，也可以在 adapter 中走等价兼容路径；对外语义必须保持不变。
- 旧式 Codex agent 单文件 artifact 不强制迁移到 `codex.agentRole`。
- 静态 instruction 没有 dynamic `refreshKeys` 时，配置写入不触发 refresh。
- 首版不要求迁移已经落盘的旧 path-only tracking；静态 extensions 的兼容重点是源码/runtime contract 和用户可见行为不变。
- status 对静态旧 artifact 不要求报告 config digest。

### 9. `codex-explore` 插件内容

新增：

```text
plugins/codex-explore/
├── .agents-plugin/plugin.json
├── instructions/lightweight.md
├── roles/codex-explorer.md
├── scripts/render-artifacts.mjs
├── scripts/render-artifacts.test.mjs
└── skills/codex-explore/
    ├── SKILL.md
    └── agents/openai.yaml
```

manifest 要点：

- `name = "codex-explore"`
- `marketplace.policy.products = ["CODEX"]`
- `skills = "./skills"`
- `skillTriggers.codex-explore.allowInstallOverride = true`
- `scripts.artifacts.render` 指向 `./scripts/render-artifacts.mjs`
- `scripts.tests.node` 指向 renderer 的插件内 Node 测试，例如 `./scripts/render-artifacts.test.mjs`
- `artifacts.targets` 声明：
  - `lightweight-instruction`：`codex.developerInstructionsBlock`，scope 为 user/project，`projectManagedKind = "instruction"`，允许 `present` / `disabled`，refresh keys 为 `enableLightweightInstruction`、`explorerModel`、`modelReasoningEffort`，project scope 需要 Codex project config preflight。
  - `codex-explorer-role`：`codex.agentRole`，静态 `roleKey = "codex-explorer"`，scope 为 user/project，`projectManagedKind = "agent"`，允许 `present`，refresh keys 为 `explorerModel`、`modelReasoningEffort`，project scope 需要 Codex project config preflight。
- `config.schema` 声明：
  - `enableLightweightInstruction`: boolean，默认 `true`
  - `explorerModel`: string，默认 `gpt-5.4-mini`
  - `modelReasoningEffort`: enum，默认 `medium`，值为 `low | medium | high | xhigh`

renderer 行为：

- 读取 artifact render config。
- `enableLightweightInstruction=true` 时返回 `lightweight-instruction` present artifact。
- `enableLightweightInstruction=false` 时返回 `lightweight-instruction` disabled artifact，`disabledReason = "config"`。
- 轻量 instruction 的 `refreshKeys` 是 `enableLightweightInstruction`、`explorerModel`、`modelReasoningEffort`。
- 始终返回 `codex-explorer-role` present artifact。
- 专用 role 的 `refreshKeys` 是 `explorerModel`、`modelReasoningEffort`。
- role layer 写入 `model`、`model_reasoning_effort` 和专用只读探索提示词。

`agents/openai.yaml` 要点：

- 默认 `policy.allow_implicit_invocation: false`。
- 用户显式传 `aw install codex-explore --skill-trigger auto` 时，才允许该 skill 自动触发。

`SKILL.md` 要点：

- 明确这是手动 `$codex-explore` workflow。
- 主 agent 先判断是否真的需要 explorer；已知单个文件、单个符号或 2 到 3 个文件内的小搜索，优先本地完成。
- 主 agent 使用 `agent_type = "codex-explorer"`。
- 默认 1 个 explorer；复杂时 2 到 3 个；极复杂最多 4 个。
- 委派 prompt 必须包含范围、具体问题、探索深度、输出格式和只读要求。
- 探索深度只使用 `quick`、`medium`、`very thorough` 三档。
- explorer 运行时主 agent 继续做不重叠的本地调查。
- 已经启动 explorer 后，主 agent 必须等待 explorer 进入最终状态并读取结果；不得因为等待一段时间没有结果就关闭 explorer 并自行完成同一探索问题。
- 主 agent 只整合 explorer 的关键结论、文件路径、必要行号和不确定点，必要时补读少量文件验证，不倾倒完整子代理回复。
- 汇总后立即关闭本 workflow 启动的 explorer；`wait_agent` 完成不等于关闭 agent。

轻量 instruction 要点：

- 使用 Codex 内置 `explorer` role。
- 默认传入 `model = <explorerModel>` 和 `reasoning_effort = <modelReasoningEffort>`。
- 只指导主 agent 在合适场景使用 explorer，不复制完整 skill workflow。
- 不内嵌大段示例 prompt，不讲插件机制、安装方式或配置命令。
- 默认正文建议控制在 25 行以内，只保留运行时需要的选择规则、spawn 参数和关闭要求。
- 要求每个 explorer 任务只读、范围清晰、输出简短。
- 已知单个文件、单个符号或少量文件内的小搜索，优先让主 agent 自己完成。
- 如果用户显式要求其它模型，或 Codex runtime 报告配置模型不可用，主 agent 先向用户说明，再按用户最新指示处理。
- 要求主 agent 已经启动 explorer 后等待并读取 explorer 结果；禁止未收到结果就关闭 explorer 并自行接手同一探索问题。
- 要求主 agent 整合结果后关闭 explorer。

专用 role prompt 要点：

- 只读探索。
- 禁止创建、编辑、移动、删除、格式化或回退文件。
- 禁止运行破坏性命令或安装依赖。
- 输出围绕主 agent 的具体问题，使用结论、证据、不确定点和建议。
- 摘录保持很短，不搬运大段源码。
- 默认输出结构固定为：
  - `结论`
  - `证据`
  - `不确定点`
  - `建议主 agent 下一步查看`

### 10. 文档与作者工具

修改范围：

- `docs/plugin-authoring.md`
- `docs/plugin-installation.md`
- `docs/architecture.md`
- `docs/coding-conventions.md`
- `.agents/skills/create-agent-workflows-plugin/SKILL.md`
- `.agents/skills/create-agent-workflows-plugin/references/*`
- `.agents/skills/create-agent-workflows-plugin` 校验脚本

任务：

- 文档说明 `scripts.artifacts.render` 的用途、上下文、输出和限制。
- 文档说明 `artifacts.targets` 是动态 artifact 的安装前能力真值，并参与 Codex project managed kinds、installability、preflight、status current catalog 和 capability snapshot。
- 文档说明 renderer 只能返回 plan，不能直接写 AW 受管文件。
- 文档说明 ArtifactPlan 的 `id`、`target`、`state`、`refreshKeys`、`disabledReason`。
- 文档说明 `codex.developerInstructionsBlock` 和 `codex.agentRole`。
- 文档说明 artifact render config 与默认 effective config 的区别，以及动态 artifact 的 config refresh 行为。
- 文档说明静态 `extensions.*` 仍适合简单静态产物。
- 作者工具校验：
  - renderer path 是否存在。
  - runner 是否受支持。
  - `artifacts.targets` 是否声明必要字段、scope、target、state、refreshKeys 和 project config 写入面。
  - `codex.agentRole` target 是否声明静态 `roleKey`，且 renderer 输出 fixture 的 `roleKey` 是否与静态 metadata 一致。
  - Codex-only 插件是否声明产品范围。
  - `scripts.artifacts.render` 输出 fixture 是否符合 ArtifactPlan schema。
  - `agents/openai.yaml` 是否存在。
  - skill 默认触发策略是否符合插件意图。
- 架构文档补充 renderer 阶段、plan apply、tracking/status/uninstall 边界，避免后续实现把动态写盘散到 lifecycle。
- `.claude/skills/create-agent-workflows-plugin` 是指向 `.agents/skills/create-agent-workflows-plugin` 的符号链接，验收时按两个入口都能读到最新作者技能内容处理。

## 阶段计划

### 阶段 1：source contract 与 manifest 校验

交付：

- `scripts.artifacts.render` manifest schema。
- `artifacts.targets` manifest schema。
- ArtifactPlan / target / state / tracking 类型草案。
- source manifest bundle 和 platform manifest 过滤逻辑。

退出标准：

- 合法 renderer manifest 能被 normalizer 接受。
- 非法 runner、越界 path、未知 scripts 字段能给清晰错误。
- 合法 `artifacts.targets` 能进入 AW runtime catalog，非法 target/state/refresh key/roleKey 能给清晰错误。
- `scripts.artifacts.render` 和 `artifacts.targets` 不泄漏到 Codex 原生 manifest。

### 阶段 2：renderer runtime 与 plan 校验

交付：

- renderer context 写入和执行。
- stdout JSON 解析、stderr 摘要、timeout、敏感配置脱敏。
- ArtifactPlan 校验。

退出标准：

- install / upgrade 能在写 artifact 之前拿到 plan。
- 非法 plan 不写文件、不写 tracking。
- renderer 失败有可诊断错误。
- `aw status` 不执行 renderer 或 lifecycle。

### 阶段 3：Codex target apply

交付：

- `codex.developerInstructionsBlock` apply/remove。
- `codex.agentRole` apply/remove。
- Codex role namespace 冲突检测。

退出标准：

- instruction present/disabled 能正确写入或移除 managed block。
- role present 能生成 `[agents.codex-explorer]` 和 role layer。
- 同一 scope 内 instruction block 和 role registration 对同一 Codex config 的修改会合并为一次文档级事务。
- command-level role 冲突 preflight 能在 required-config preflight、skill trigger materialization、renderer 和任何写入之前阻止同名非 AW 管理 role。
- uninstall 只清理 AW 管理内容。

### 阶段 4：tracking、status、upgrade

交付：

- artifact-aware tracking。
- status 诊断。
- upgrade / uninstall / historical fallback 兼容。

退出标准：

- status 能分别报告 instruction 和 role artifact。
- disabled by config 不被误报为 missing。
- role layer 缺失、注册项 drift、config stale、refresh failed 都可诊断。
- project scope status 能分别报告 artifact health 和 session visibility，覆盖 `trusted` / `untrusted` / `unknown` repo trust 状态。
- 不要求迁移已经落盘的旧 path-only tracking；静态 extensions 的源码/runtime 兼容行为保持不变。
- current catalog 缺失但 tracking 仍有 artifact-aware record 时，status/discovery/主控制台 uninstall/upgrade 候选/direct uninstall/direct upgrade 能从 tracking 恢复真实 artifact identity 和 roleKey。

### 阶段 5：config-triggered refresh

交付：

- config 命令写入后的 refresh 判断。
- renderer refresh event。
- refresh apply、lastRefresh metadata、receipt 输出。

退出标准：

- 修改 `enableLightweightInstruction` 会切换轻量 instruction present/disabled。
- 修改 `explorerModel` 或 `modelReasoningEffort` 会刷新 instruction 和 role。
- `aw config set/unset/reset` 和主控制台配置向导都各自覆盖 refresh 触发、digest 更新和状态回写。
- 未命中 `refreshKeys` 的配置写入不刷新。
- 命中 `refreshKeys` 的 config-triggered refresh 有独立回归保证不执行插件 lifecycle 脚本。
- refresh 失败保留 config store，并让 status 报告 refresh failed。
- config 命令 JSON receipt 稳定输出 `artifactRefresh.attempted`、`status`、`triggerKeys` 和 `artifacts[]`。
- 不扫描所有历史 project。
- 命中 Codex project scope target 的 refresh 会先执行 project write safety preflight，失败时不执行 renderer、不写 repo artifact、不写成功 digest。
- user scope 和 project scope 分别按自己的 artifact render config 刷新，project config 不影响 user artifact。
- user scope 写入后的 `refreshReach` 能区分已刷新的 user / 当前 project target 和未扫描的历史 project target，status 能稳定提示其它已知历史 project artifact 可能 stale。

### 阶段 6：新增 `codex-explore` 插件

交付：

- 插件 manifest、renderer、templates、skill、role prompt。
- build 后 runtime bundle。

退出标准：

- `aw install codex-explore -p codex -s user` 成功。
- `aw install codex-explore -p codex -s project` 成功，且只写当前仓库 repo-managed skill、instruction 和 role artifact。
- `aw install codex-explore -p claude` 被 product policy 拦截。
- 默认轻量 instruction 使用内置 `explorer`。
- `$codex-explore` skill 默认手动触发，并使用 `codex-explorer` role。
- `aw install --skill-trigger auto` 后才允许 skill 自动触发。

### 阶段 7：文档、作者工具和回归

交付：

- 公开文档。
- 作者工具 reference 和校验脚本。
- 单元、集成、smoke 和内容回归测试。

退出标准：

- 文档、校验、CLI 产物和测试矩阵覆盖 renderer contract。
- 作者工具集成测试覆盖合法 renderer / dynamic target / roleKey metadata，以及非法 target、refresh key、state、roleKey mismatch 和缺失 skill 策略。
- 执行：
  - `pnpm plugin:test codex-explore`
  - `pnpm test:unit`
  - `pnpm test:integration`
  - `pnpm build`
  - `pnpm test:smoke:build`
  - `pnpm test:smoke:plugin-scripts`
  - `pnpm test:smoke:pack`

## 测试矩阵

### Unit

- manifest normalize：
  - 接受合法 `scripts.artifacts.render`。
  - 接受合法 `artifacts.targets`，并把动态 artifact 纳入 Codex project managed kinds。
  - 拒绝越界 path。
  - 拒绝不支持的 runner。
  - 拒绝未知 target、未知 state、未知 refresh key 和非法 `projectManagedKind`。
  - 拒绝缺少静态 `roleKey` 的 `codex.agentRole` target。
  - 保证 renderer 字段和动态 metadata 不进入 Codex 原生 manifest。
- renderer runtime：
  - 生成包含 artifact render config、mode 和 target scope 的 context。
  - user scope context 不包含 project config 来源。
  - `install` / `upgrade` 没有 changed keys。
  - `refresh` 带 changed keys。
  - stdout 非 JSON 时失败。
  - renderer 超时时失败并脱敏输出。
  - status 不执行 renderer。
- ArtifactPlan validation：
  - 接受合法 instruction present。
  - 接受合法 instruction disabled。
  - 接受合法 `codex.agentRole` present。
  - 拒绝未知 target。
  - 拒绝未知 refresh key。
  - 拒绝 manifest `artifacts.targets` 未声明的 artifact id、target、state 或 project config 写入面。
  - 拒绝当前 platform/scope 已声明但 renderer 漏返回的动态 artifact。
  - 拒绝 disabled artifact 缺少 refreshKeys。
  - 拒绝 `roleFile.name !== roleKey`。
  - 拒绝 `codex.agentRole` plan 的 `roleKey` 与 `artifacts.targets` 静态 metadata 不一致。
  - 拒绝 `content.registration.config_file`，该字段只能由 AW 生成。
  - 拒绝 renderer 声明任意路径。
  - 拒绝重复 `id + target`。
- config digest：
  - digest 只随 refreshKeys 对应值、renderer/manifest digest、target/id 改变。
  - user artifact digest 不随当前 repo project config 改变。
  - unrelated config key 不改变 digest。
- Codex config helper：
  - upsert/remove developer instructions block 保留其它 TOML。
  - 多个 present instruction artifact 按实现约定的稳定规则合成；相同 artifact 集合即使 renderer 返回顺序不同，最终 managed block 也不改变。
  - upsert/remove `[agents.<roleKey>]` 保留其它 TOML。
  - 删除时遇到 config_file drift 不误删用户文件。
- role namespace：
  - `[agents.foo] config_file` 指向文件内 `name = "codex-explorer"` 能检测冲突。
  - 未被声明引用的 `agents/*.toml` 同名 role 能检测冲突。
  - user scope status 按高优先级 layer 的最终 role 名空间判断遮蔽；高优先级 layer 使用不同 table key 或不同 role 文件名但同一 `name = "codex-explorer"` 时，仍报告 `unknownByExternalLayer` 或等价稳定状态。
  - role status 能诊断 `[agents.<roleKey>]` 注册项 `description` 与 role layer 文件 `description` 不一致。
  - AW managed 同名 role 不算外部冲突。
  - command-level preflight 能从 `artifacts.targets` 静态 `roleKey` 检查冲突，不依赖 renderer 输出。

### Integration

- `aw install codex-explore -p codex -s user`：
  - native plugin enabled。
  - 写入轻量 instruction。
  - 生成 `[agents.codex-explorer]` 和 role layer。
  - tracking 记录两个 artifact id、target、state、refreshKeys、paths 和 digest。
- 在仓库内安装或刷新 user scope artifact：
  - user artifact 按 `default+user` render config 渲染。
  - 当前仓库 project config 不进入 user artifact 内容、digest 或 stale 判断。
- 未安装 `codex-explore` 时预先写入配置后再 install / upgrade：
  - `aw config set codex-explore enableLightweightInstruction false` 只更新 config store，不产生 renderer 调用、artifact、tracking 或 ledger。
  - 后续 user scope install 首次落盘就按 `default+user` 渲染为 disabled instruction 状态，不先写默认 instruction。
  - 当前仓库存在 project config 时，user scope install / upgrade 仍只读取 `default+user`，project config 不进入 user artifact 内容、digest 或 stale 判断。
  - project scope install / upgrade 读取 `default+user+project`，能使用之前已写入的 user config 和当前仓库 project config。
- `aw install codex-explore -p codex -s project`：
  - 使用 project artifact render config。
  - 写入当前仓库 repo-managed skill、instruction 和 role artifact。
  - 不注册或启用 user native plugin。
  - project artifact 不改写 user artifact。
- dynamic metadata：
  - 首次 project install 前，current catalog 报告 managed kinds 为 `skill`、`instruction`、`agent`。
  - ledger `capabilitySnapshot.projectManagedKinds` 写入静态能力和动态 artifact metadata 的合并结果。
- `aw install codex-explore -p claude` 被 product policy 拦截。
- 安装时存在非 AW 管理最终 role 名 `codex-explorer`：
  - 命令失败。
  - 失败发生在 required-config preflight、config prompt、skill trigger materialization 和 renderer 之前。
  - 不写 native plugin enabled。
  - 不写 instruction。
  - 不写 role layer。
  - 不写 tracking / ledger 半成品。
- project scope `aw status` session visibility：
  - repo trust 为 `trusted` 时，磁盘健康的 skill、instruction 和 role 同时报告 session visible。
  - repo trust 为 `untrusted` 时，磁盘健康仍报告 artifact healthy，但 session visibility 为 blocked by project trust。
  - repo trust 为 `unknown` 时，磁盘健康仍报告 artifact health，session visibility 为 project trust unknown。
  - JSON 同时包含 artifact health、projectTrust 和 per-artifact / per-kind session visibility，human verbose 能说明不可见原因。
- user scope `aw status` higher-priority role visibility：
  - project 或其它高优先级 layer 通过 `[agents.some-alias]` 加 `config_file` 指向 role 文件，且文件内 `name = "codex-explorer"` 时，user scope 受管 role 报告 `unknownByExternalLayer` 或等价稳定状态。
  - project 或其它高优先级 layer 存在不同文件名的未引用 role 文件，且文件内 `name = "codex-explorer"` 时，user scope 受管 role 仍能按最终 role 名空间报告遮蔽或冲突。
- `aw config set codex-explore enableLightweightInstruction false`：
  - renderer 返回 disabled instruction。
  - 轻量 instruction block 被移除。
  - role artifact 不受影响。
  - status 报告 instruction disabled by config。
- `enableLightweightInstruction` 从 false 改回 true：
  - instruction 按当前 artifact render config 重新写入。
- `aw config set codex-explore explorerModel <new>`：
  - instruction 中的 model 更新。
  - role layer 中的 model 更新。
  - tracking digest 更新。
- `aw config set codex-explore modelReasoningEffort high`：
  - instruction 和 role layer 都更新。
- `aw` 主控制台配置向导写入命中 `refreshKeys` 的值：
  - 主控制台选择的写入层保存成功。
  - changed keys 进入 renderer refresh context。
  - 受影响 artifact 按写入后的 artifact render config 刷新。
- `aw config unset codex-explore explorerModel`：
  - 配置 source 回退到 schema default 或更低优先级来源。
  - instruction 和 role layer 按回退后的 artifact render config 重渲染。
  - tracking digest 更新为回退后的值。
- `aw config reset codex-explore`：
  - 按可能影响该插件所有 tracked `refreshKeys` 处理。
  - 命中的 instruction 和 role artifact 都纳入 refresh 计划。
  - reset 后的 tracking/status 不残留 reset 前的成功 digest。
- 带 install / upgrade / uninstall lifecycle 脚本的测试插件在 config-triggered refresh 中：
  - 命中 `refreshKeys` 的 `aw config set/unset/reset` 或主控制台配置向导仍按 renderer + 受管 artifact apply 链路刷新 artifact。
  - fake lifecycle runner 或 lifecycle log 没有新增调用记录。
  - config 命令 JSON receipt 和后续 status 只报告 artifact refresh 结果，不出现 lifecycle 执行副作用。
- unrelated config key 写入不触发 refresh。
- 同一 repo 同时安装 user scope 和 project scope artifact 后，执行命中 refresh key 的 user scope 写入：
  - user artifact 按 `default+user` 刷新。
  - 当前 repo project artifact 按 `default+user+project` 刷新。
- 同一 repo 只安装 project scope artifact，没有安装 user scope artifact 后，执行命中 refresh key 的 user scope 写入：
  - 当前 repo project artifact 仍按 `default+user+project` 刷新。
  - receipt / tracking / status 不能要求或暗示必须同时存在 user scope 安装证据。
- 同一 repo 同时安装 user scope 和 project scope artifact 后，执行命中 refresh key 的 user scope 写入，且 current project scope 原子单元 refresh 失败：
  - user scope 原子单元已成功提交的 instruction / role artifact 和新 digest 保留。
  - current project scope 因 preflight 或 apply 失败进入 `refresh failed`，不写新的成功 digest。
  - receipt / status 同时报告 user scope succeeded 和 current project scope failed，不能把两个 scope 合并成一次跨 scope 回滚。
- 同一 repo 同时安装 user scope 和 project scope artifact 后，执行命中 refresh key 的 project scope 写入：
  - 只刷新当前 repo project artifact。
  - user artifact 不进入 stale、refresh failed 或成功刷新列表。
- 当前 repo 只有 project config store、没有 project scope 安装 tracking 后，执行命中 refresh key 的 user 或 project scope 配置写入：
  - 不触发 project artifact refresh 或 project write safety preflight。
  - receipt / status 不生成 project 侧 stale、refresh failed 或成功刷新状态。
- 两个 repo 都安装 project scope artifact 后，在 repo A 执行命中 refresh key 的 user scope 写入：
  - `refreshReach` 只记录 user target 和 repo A project target 已刷新。
  - repo A 的 status 能提示其它已知历史 project target 未扫描，可能仍使用旧 artifact。
- 命中 project scope artifact 的 config-triggered refresh 遇到 project write safety preflight 失败：
  - config store 保留新值。
  - 不执行 renderer。
  - 不改写 `.codex/config.toml`、repo-managed skill、instruction 或 role 文件。
  - tracking 不写新的成功 digest，status 能诊断失败原因。
- config-triggered refresh 前 role 受管身份已经 drift：
  - `[agents.codex-explorer].config_file` 被改到非 AW 管理 role 文件后，命中 `refreshKeys` 的 `aw config ...` 记录 artifact refresh failed，不执行 renderer 或任何 artifact 写入，不接管用户文件，不写新的成功 digest，status 能诊断 registration drift。
  - tracking 仍指向 AW role 文件但 role layer 内容 digest 已偏离上次受管结果后，命中 `refreshKeys` 的 `aw config ...` 记录 artifact refresh failed，不覆盖 drift 内容，不写新的成功 digest，status 能同时诊断 content drift 和 refresh failed。
- renderer refresh 失败：
  - config store 保留新值。
  - tracking `lastRefresh.status = failed` 或等价状态。
  - status 能诊断 failed。
- apply 阶段在同一原子单元内部分写入后失败：
  - config store 保留新值。
  - 已写入的 `.codex/config.toml`、role layer 和本原子单元内其它受管 artifact 按刷新前 baseline 整体回滚。
  - tracking 不写新的成功 `configDigest` / `contentDigest`，只记录失败诊断。
  - status 能同时报告 refresh failed 和回滚后的 artifact 健康状态。
- `aw uninstall codex-explore -p codex`：
  - 清理 managed instruction block。
  - 清理 `[agents.codex-explorer]` 注册项和 role layer。
  - 不删除用户手写 role 文件。
- `aw upgrade codex-explore -p codex`：
  - 按 artifact id / target 更新旧 artifact。
  - disabled artifact 不残留旧内容。
- `aw upgrade codex-explore -p codex` 时存在非 AW 管理最终 role 名 `codex-explorer`：
  - 命令失败。
  - 失败发生在 required-config preflight、config prompt、skill trigger materialization 和 renderer 之前。
  - 不写 native state。
  - 不改写 instruction、`[agents.codex-explorer]` 注册项或 role layer。
  - 不改 tracking / ledger。
- `aw upgrade codex-explore -p codex` 遇到 dynamic metadata `capabilityChanged` 并进入重装路径：
  - `capabilityChanged` 比较使用 installed snapshot 与 current catalog 动态 metadata 合并结果。
  - 旧 instruction block、旧 `[agents.codex-explorer]` 注册项、旧 role layer 和旧 tracking 都按 artifact id / target 清理或替换。
  - 重装后不留下旧 block、旧 role 文件或旧 artifact tracking 残留。
- 静态 `extensions.*` 兼容回归：
  - 旧静态 `extensions.instructions`、`extensions.permissions`、`extensions.hooks`、`extensions.agents` 插件在新基础设施下 install / status / uninstall 仍按原行为工作。
  - 静态 instruction 没有 dynamic `refreshKeys` 时，`aw config set/unset/reset` 和主控制台配置向导不触发 renderer refresh 或 artifact rewrite。
  - status 不对静态旧 artifact 额外报告 dynamic `configDigest` stale / refresh failed 诊断。
- config 命令 JSON receipt：
  - refresh succeeded 时，`aw config ... --json` 输出 `artifactRefresh.attempted = true`、`status = "succeeded"`、命中的 `triggerKeys` 和刷新后的 `artifacts[]`。
  - refresh failed 时，`aw config ... --json` 输出 `status = "failed"`、稳定 error 摘要和未写入成功 digest 的 artifact 结果。
  - current manifest / renderer 不可用时，`aw config ... --json` 输出该分支约定的稳定 `skipped` 或 `failed` 状态、原因字段和空写入结果，不混入人类可读文本。
- `aw status -j`、`aw status -j --verbose`、`aw status -j --debug`、`aw status -j --verbose --debug`：
  - stdout 是纯 JSON。
  - verbose / debug 人类诊断只进入 stderr 或 debug log。
  - 包含 instruction 和 role artifact health、projectTrust 和 session visibility 诊断字段。
- `aw status` 诊断 role metadata drift：
  - `[agents.codex-explorer]` 注册项 `description` 与 role layer 文件 `description` 不一致时，JSON 暴露稳定诊断字段，human verbose 说明不一致来源。
- current catalog 缺失但 tracking 仍有 artifact-aware record：
  - discovery 恢复真实 artifact id / target / roleKey。
  - status 展示 historical source 和 artifact identity。
  - 主控制台 uninstall / upgrade 候选恢复真实 artifact identity。
  - direct uninstall / direct upgrade 仍按恢复出的 artifact identity 执行。
- `aw install --skill-trigger manual` 后仍可 `$codex-explore` 显式触发。
- `aw install --skill-trigger auto` 后 Codex 才允许该 skill 自动触发。
- 作者工具：
  - `tests/integration/authoring-tools.test.ts` 覆盖合法 `scripts.artifacts.render`、`artifacts.targets`、`codex.agentRole.roleKey` 和 renderer fixture。
  - 校验脚本拒绝非法 target、非法 state、未知 refresh key、缺失 `codex.agentRole.roleKey`、renderer fixture roleKey 不匹配和缺失 skill 默认策略。
  - `.agents/skills/create-agent-workflows-plugin` 的 reference / 示例包含 renderer contract、ArtifactPlan、两个 Codex target、config refresh 和默认手动 skill 约定。

### 内容回归

必须锁住插件实际交付给模型的内容：

- 轻量 instruction 使用 Codex 内置 `explorer`。
- 轻量 instruction 不出现 `agent_type = "codex-explorer"`。
- 轻量 instruction 包含 `model = <explorerModel>` 和 `reasoning_effort = <modelReasoningEffort>` 的渲染值。
- 轻量 instruction 不内嵌大段示例 prompt。
- 轻量 instruction 不讲插件机制、安装方式或配置命令。
- 轻量 instruction 默认正文不超过 25 行。
- 轻量 instruction 要求只读、范围清晰、输出简短。
- 轻量 instruction 要求配置模型不可用或用户显式指定其它模型时，主 agent 向用户说明并按最新指示处理。
- 轻量 instruction 要求主 agent 等待 explorer 结果，并禁止未收到结果就关闭 explorer 并自行接手同一探索问题。
- 轻量 instruction 要求主 agent 关闭 explorer。
- `SKILL.md` 包含 `agent_type = "codex-explorer"`。
- `SKILL.md` 包含 `close_agent` 要求，并说明 `wait_agent` 不等于关闭 agent。
- `SKILL.md` 要求主 agent 等待 explorer 结果，并禁止未收到结果就关闭 explorer 并自行接手同一探索问题。
- `SKILL.md` 要求每个委派 prompt 写探索深度。
- `SKILL.md` 保留 `quick`、`medium`、`very thorough` 三档。
- `agents/openai.yaml` 默认 `allow_implicit_invocation: false`。
- 专用 role prompt 保留只读边界。
- 专用 role prompt 保留输出结构：`结论`、`证据`、`不确定点`、`建议主 agent 下一步查看`。
- 专用 role prompt 不要求 explorer 写实现计划或修改文件。

### Smoke

- `pnpm build` 生成 `packages/cli/plugins-dist/codex-explore`。
- `pnpm plugin:test codex-explore` 覆盖 renderer 在最终测试基准 manifest、临时 bundle、隔离 `AW_HOME` 和受管临时 project root 下读取 `AW_PLUGIN_CONTEXT`，并验证 instruction / role ArtifactPlan 输出。
- `pnpm test:smoke:build` 覆盖 Codex-only marketplace entry、platform manifest、skill 文件和 renderer 脚本。
- runtime bundle 包含动态 artifact metadata、`scripts/render-artifacts.mjs`、instruction template、role prompt、skill 文件。
- `pnpm test:smoke:plugin-scripts` 覆盖插件脚本 staging、test-only helper 复制边界和最终 bundle 下的脚本运行形态。
- `pnpm test:smoke:pack` 验收 `pnpm pack:cli` tarball 包含新插件 runtime bundle。

## Review 问题关闭标准

由于 spec 主线已经改为 artifact renderer script，上一版 review 中围绕 `codexRole` binding、默认值双真值、重复 binding key、`promptOverride` 和 `allowEmpty` 的问题不再按原方案执行。

新的关闭标准：

- 不再有 `codexRole.model.default` 这类双真值字段；模型默认值只在 `config.schema.explorerModel.default` 中出现。
- 不再有 `promptAppend` / `promptOverride`；首版不需要 `allowEmpty`。
- 不再从 `extensions.agents[].codexRole` 推导 refresh effect；refresh 由 tracking 中的 artifact `refreshKeys` 驱动。
- 内容回归仍然保留，直接断言轻量 instruction、`SKILL.md`、`agents/openai.yaml` 和专用 role prompt 的关键行为。
- role 冲突检测仍然保留，并以前置 command-level preflight 为准；`codex.agentRole` target 的 apply 阶段只做一致性复核和受管身份保护。
- config-triggered refresh 必须单独覆盖 role registration drift 和 role content drift 两条受管身份保护分支。
- 测试矩阵必须单独锁住多 instruction 稳定合成，以及 role 注册项和 role layer `description` 不一致的 status 诊断。
- 测试矩阵必须单独锁住 user scope 和 project scope refresh 作为独立原子单元处理；project scope 失败时不得回滚已经成功提交的 user scope artifact。
- 测试矩阵必须单独覆盖静态 `extensions.*` 兼容层，包括旧插件 install/status/uninstall、静态 instruction 配置写入不触发 refresh，以及 status 不误报 dynamic `configDigest` 诊断。
- 测试矩阵必须单独覆盖未安装时先写配置再 install / upgrade 的渲染口径，以及 upgrade 路径的 role 冲突 command-level preflight。

## 风险与回退

- renderer script 增加新的失败面。实现前要复用脚本 timeout、stderr/stdout 摘要、敏感配置脱敏和可诊断错误。
- ArtifactPlan 校验如果太宽，会重新打开“脚本任意写盘”的风险；首版 target 必须是封闭枚举。
- `artifacts.targets` 如果没有被所有 installability/status/upgrade 入口统一消费，project scope 容易再次出现 install 判定、capability snapshot 和实际产物不一致。实现时要把动态 metadata 合并逻辑集中到同一套 helper。
- config refresh 失败后保留 config store，可能出现配置已变但 artifact 未更新。status 必须清楚报告 refresh failed，并给用户可恢复路径。
- role namespace 解析要容忍用户手写 TOML 损坏。安装时解析失败应 fail fast；status 可以 degraded warning。
- user scope 配置写入不会扫描所有历史 project。tracking 必须写实记录 refresh 覆盖范围，status 要提醒未纳入本次 refresh 的已知历史 project artifact 可能 stale。
- 当前 Codex 会话是否热加载 instruction / role artifact 取决于 Codex runtime。文档要说明必要时需要新会话生效。
- 只读边界不是工具级硬隔离。轻量 instruction、skill 和 role prompt 都要把只读约束写清楚。
- 模型 slug 可用性不是 AW 能静态保证的能力。用户配置不可用模型时，失败可能发生在 Codex spawn 阶段。
- 旧式静态 extensions 要保持源码/runtime contract 兼容；内置 renderer 不应改变旧插件的产物路径和卸载行为。

## 首版验收清单

- `pnpm build` 能生成 Codex-only `codex-explore` marketplace entry。
- manifest 支持 `scripts.artifacts.render`。
- manifest 支持 `artifacts.targets`，并把动态 artifact 纳入 Codex project managed kinds、installability、preflight、status current catalog 和 capability snapshot。
- `codex.agentRole` 的动态 metadata 静态声明 `roleKey`，renderer plan 中的 `roleKey` 必须匹配该声明。
- renderer 能根据目标 scope 的 artifact render config 返回 ArtifactPlan。
- AW 能校验 ArtifactPlan，并拒绝未知 target、未知 refresh key、非法 state、非法 roleKey 和任意路径写入。
- AW 能拒绝 renderer 返回 manifest 未声明的 artifact id、target、state、refresh key 或 project config 写入面。
- `aw install codex-explore -p codex -s user` 成功写入轻量 instruction、`[agents.codex-explorer]` 和 role layer。
- `aw install codex-explore -p codex -s project` 成功写入当前仓库 repo-managed skill、instruction 和 role artifact，且不注册或启用 user native plugin。
- `aw install codex-explore -p claude` 被 product policy 拦截。
- `agents/openai.yaml` 默认 `allow_implicit_invocation: false`。
- `skillTriggers.codex-explore.allowInstallOverride = true`，安装时可显式切到 auto。
- 轻量 instruction 使用内置 `explorer`，不使用 `codex-explorer`。
- 手动 `$codex-explore` skill 使用 `codex-explorer` role。
- role 文件包含 `model = "gpt-5.4-mini"`、`model_reasoning_effort = "medium"` 和只读探索提示词。
- 安装不会覆盖任何非 AW 管理且最终 role 名为 `codex-explorer` 的自定义 role。
- role 冲突会通过 command-level preflight 在 required-config preflight、config prompt、skill trigger materialization、renderer 之前，以及任何 config/native/artifact/tracking/ledger 写入前失败。
- upgrade 路径遇到非 AW 管理同名最终 role 时，也会在 renderer 和任何写入前失败，不改 native state、instruction、role、tracking 或 ledger。
- tracking/status/uninstall/upgrade/refresh 都按 artifact id / target / roleKey 处理。
- `aw config set/unset/reset` 和主控制台配置向导命中 `refreshKeys` 后自动刷新当前可定位 artifact。
- 未安装插件时写入配置只保存 config store；后续 install / upgrade 按目标 scope 的最新 artifact render config 首次落盘。
- 命中 project scope target 的 config refresh 先执行 project write safety preflight；失败时不执行 renderer、不写 repo artifact、不写成功 digest。
- `enableLightweightInstruction=false` 会移除或跳过轻量 instruction，status 报告 disabled by config。
- `explorerModel` / `modelReasoningEffort` 改动会刷新 instruction 和 role。
- refresh 失败会保留 config store，并让 status 报告 refresh failed。
- user scope 和 project scope refresh 作为独立原子单元处理，一边失败不能回滚另一边已经成功提交的 artifact。
- user scope refresh 不扫描所有历史 project，但 tracking/status 会写实报告当前刷新覆盖范围和其它已知 project target 可能 stale。
- project config 不影响 user scope artifact 的内容、digest、stale 判断或 refresh 结果。
- current catalog 缺失但 tracking 仍有 artifact-aware record 时，status/discovery/主控制台 uninstall/upgrade 候选/direct uninstall/direct upgrade 仍保留真实 artifact identity。
- status 保持 artifact health 和 session visibility 两层诊断，project scope 覆盖 repo trust `trusted` / `untrusted` / `unknown`。
- `aw status -j`、`-j --verbose`、`-j --debug`、`-j --verbose --debug` 的 stdout 都是纯 JSON，包含 instruction 和 role artifact 诊断字段。
- uninstall 清理 AW 管理的 instruction block、注册项和 role layer，不影响用户手写文件。
- 静态 `extensions.*` 旧插件仍按原行为安装、status 和卸载；静态 instruction 的配置写入不触发 refresh，status 不误报 dynamic `configDigest` 诊断。
- 作者工具和文档覆盖 renderer contract、ArtifactPlan、两个 Codex target、config refresh 和插件默认手动 skill。
- 单元、集成、`pnpm plugin:test codex-explore` 和 smoke 测试覆盖 manifest、renderer、plan validation、Codex target apply、config refresh、插件脚本测试入口、插件 bundle 和 tarball。
