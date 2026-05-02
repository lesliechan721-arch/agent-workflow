# Codex 探索插件执行计划

## 需求来源

本计划落实 `docs/dev/sepcs/codex-explorer-plugin-spec.md`。如果实现过程中发现本计划和 spec 不一致，先回到 spec 校准需求，再更新计划；不要让实现按过期计划继续推进。

本轮 spec 已经从“在静态 `extensions.*` 上补 config binding / `codexRole` 特例”改为 **artifact renderer script** 主线：

- 插件通过 `scripts.artifacts.render` 返回 ArtifactPlan。
- 插件负责根据 effective config 计算 artifact 的 `present` / `disabled` 状态和内容。
- AW CLI 负责校验 plan、写盘、tracking、status、rollback、upgrade、uninstall 和 config-triggered refresh。
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
- 新增 renderer context 和 ArtifactPlan schema。
- 支持 `codex.developerInstructionsBlock` target。
- 支持 `codex.agentRole` target。
- 扩展 tracking，从 path-only 变成 artifact-aware。
- 在 `aw config set/configure/unset/reset` 后，根据已安装 artifact 的 `refreshKeys` 自动刷新当前可定位 target。
- 保留静态 `extensions.instructions/permissions/hooks/agents` 的兼容路径，可通过内置 renderer 或等价兼容层实现。

第二层是 `codex-explore` 插件：

- Codex-only，`marketplace.policy.products = ["CODEX"]`。
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
- 不新增 `aw config apply`、`sync` 或其它刷新命令。
- 不让所有配置写入都触发 refresh；只有已安装 artifact tracking 中的 `refreshKeys` 命中时才刷新。
- 不扫描所有历史 project；refresh 只覆盖当前命令上下文能定位的 target。
- user scope artifact 使用 `config.schema default + user store`；project scope artifact 使用 `config.schema default + user store + 当前 project store`。project config 覆盖不能回写 user artifact。
- 默认轻量入口只调用内置 `explorer`，不调用 `codex-explorer`。
- 专用 `codex-explorer` role 只服务手动 `$codex-explore` skill。
- 不复用或覆盖 Codex 内置 `explorer` role。
- 首版不做 MCP、hook、permission mode、代码索引服务或 role 级工具 allowlist / denylist。
- 首版不做 prompt override；模型和 effort 只来自 `explorerModel`、`modelReasoningEffort`。
- artifact refresh 失败后保留已经写入的 config store，并把受影响 artifact 标记为 refresh failed，让 status 可诊断。

仍需保留上一版计划里已经 review 过、且没有被新 spec 推翻的执行细节：

- Codex role 冲突 preflight 必须尽早执行；发现非 AW 管理的同名最终 role 时，命令保持完全只读，不能写 config store、native plugin enabled、artifact、tracking、ledger，也不能调用 config prompt。
- tracking / status 要能从历史记录恢复 artifact 身份；current catalog 缺失时，status、discovery、交互式 uninstall/upgrade 候选和 direct uninstall/upgrade 不能退回假名。
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
- 定义 renderer script entry，首版至少支持 `runner = "node"`，并复用现有脚本 timeout、bundle、依赖闭包和跨平台 runner 约束。
- 定义 `ArtifactPlan`、`ManagedArtifactId`、`ArtifactState`、`ArtifactTarget`。
- 定义首批 target：
  - `codex.developerInstructionsBlock`
  - `codex.agentRole`
- 定义 artifact kind：
  - `instruction`
  - `codexRole`
  - 保留现有 `permission` / `hook` / `agent` 兼容语义，不强迫旧插件迁移。
- 校验 renderer manifest：
  - `scripts.artifacts.render.path` 必须是插件包内相对路径。
  - runner 不支持时给清晰错误。
  - Codex-only 插件不是强制要求 renderer，但 `codex-explore` 必须声明 renderer。
- 确保 `scripts.artifacts.render` 保留在 `.agents-plugin/plugin.json`，并按需要进入 AW runtime bundle；不能泄漏为 Codex 原生插件 manifest 的未知字段。

### 2. Renderer runtime

修改范围：

- `packages/cli/src/utils/plugin-scripts.ts`
- 新增 `packages/cli/src/utils/artifact-renderer.ts`
- install / upgrade / refresh 调用链

任务：

- 新增 artifact render 阶段，执行时机在 artifact 写盘之前。
- renderer 通过 `AW_PLUGIN_CONTEXT` 读取 context JSON 路径或等价上下文入口。
- renderer context 至少包含：
  - `event`: `install` / `upgrade` / `refresh` / `status`
  - `platform`
  - `scope`
  - plugin name、version、rootDir
  - effective config schema、values、sources、issues
  - `changedConfigKeys`
  - previous tracked artifacts
  - AW / Codex / Claude home、manifestPath 等路径
- renderer stdout 必须是 JSON。
- stderr 只作为诊断摘要，不能混入 JSON receipt stdout。
- 非 JSON、未知 version、超时、退出码非 0、未知 target、字段类型错误都视为 render 失败。
- render 失败时不能让插件脚本自行落盘，也不能写半份 tracking。
- install / upgrade 没有 changed keys 时仍按完整 effective config 输出 plan。
- refresh 事件必须带上本次变更的 config keys。
- status 首版可以先不执行 renderer；如果 status 需要 digest 对比，可基于 tracking 中的 renderer/manifest digest 和 config digest 判断。

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
- disabled artifact 也必须保留足够的 `refreshKeys`，否则从 disabled 改回 present 时无法触发 refresh。
- `state = "disabled"` 时允许缺少 content，但必须允许 `disabledReason`，例如 `config`。
- `state = "present"` 时必须按 target 校验 content。
- 禁止 renderer 声明任意绝对路径或跳出插件/目标目录的路径。
- 同一 plan 中同一个 `id + target` 不能重复。
- 多个 instruction artifact 需要有稳定排序或合成规则，避免刷新顺序造成无意义 churn。
- 计算 artifact `configDigest`，至少纳入：
  - artifact `refreshKeys` 对应 effective config 值
  - renderer script digest 或 manifest digest
  - platform、target、id

### 4. Target runtime：`codex.developerInstructionsBlock`

修改范围：

- `packages/cli/src/adapters/codex.ts`
- `packages/cli/src/generators/instructions.ts`
- `packages/cli/src/utils/codex-config.ts`
- tracking/status helper

任务：

- `present` 时，把 artifact `content` 写入 `.codex/config.toml` 中该插件的 AW managed `developer_instructions` block。
- 支持同一插件多个 present instruction artifact 的稳定合成。
- `disabled` 时，移除该 artifact 对应的受管 instruction 内容，或在生成阶段跳过该内容。
- disabled 不能保留“已禁用”的运行时提示词。
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

- `packages/cli/src/utils/codex-config.ts`
- 新增或扩展 `packages/cli/src/utils/codex-roles.ts`
- `packages/cli/src/adapters/codex.ts`
- `packages/cli/src/utils/detect.ts`
- tracking/status helper

任务：

- `present` artifact 必须声明 `roleKey`。
- `content.registration` 描述 `.codex/config.toml` 中 `[agents.<roleKey>]` 注册项，至少包含 `description` 和 `config_file`。
- `content.roleFile` 描述 role layer 文件，至少包含 `name`、`description`、`developer_instructions`。
- `content.roleFile` 允许 Codex-only 字段：
  - `model`
  - `model_reasoning_effort`
- role 文件里的 `name` 必须等于 `roleKey`。
- `config_file` 使用相对 `.codex/config.toml` 的路径。
- role layer path 建议由 AW 根据 `pluginName` 和 `roleKey` 生成，例如 `agents/aw-codex-explore-codex-explorer.toml`；renderer 不直接声明任意落盘路径。
- 注册项和 role layer 的 `description` 应保持一致，status 需要能诊断不一致。
- install / refresh 写 role layer，再 upsert `[agents.<roleKey>]` 注册项。
- uninstall 同时清理受管注册项和受管 role layer。
- 如果注册项 drift 到非 AW 文件，不删除用户文件。
- 如果 role layer 被外部接管或内容 drift，refresh 不能静默覆盖，必须进入可诊断状态。

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
- user scope role 是否被 project scope 同名 role 遮蔽。
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
- 旧的 `GeneratedArtifact { path, kind, platform, hookGroups }` 需要兼容读取。
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
- uninstall 只清理 tracking 中记录的 AW 受管 artifact。
- disabled artifact 也要参与 uninstall 收尾。
- upgrade 普通路径和 capabilityChanged / 重装路径都按 artifact id 和 target 处理旧产物。
- current catalog 缺失时，historical fallback 必须尽量从 tracking 恢复 artifact id、target、paths、roleKey 和 state。
- discovery、status、交互式 uninstall/upgrade 候选，以及按插件名直达的 `aw uninstall codex-explore` / `aw upgrade codex-explore` 要共用同一套恢复逻辑。
- 恢复不了的 manifest-derived 诊断标为 unavailable，不能编造假 role 名或 `historical-agent`。

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
  - `aw config configure`
  - `aw config unset`
  - `aw config reset`
- 写入 config store 成功后，读取当前命令上下文能定位的已安装插件 tracking。
- 如果 changed keys 命中任一 artifact 的 `refreshKeys`，触发 renderer `event = "refresh"`。
- `reset` 按可能影响该插件所有 tracked `refreshKeys` 处理。
- 未命中任何 `refreshKeys` 时保持现有行为，不刷新 artifact。
- 未安装插件时只保存配置；后续 install / upgrade 按最新 effective config render。
- current manifest / renderer 不可用时，config store 写入仍保留，artifact refresh 标记 skipped 或 failed，并在 JSON receipt 中给稳定机器字段。
- refresh 重新解析 effective config：
  - user scope artifact 使用 schema default + user config。
  - project scope artifact 使用 schema default + user config + 当前 project config。
- user scope config 写入：
  - 刷新当前可定位的 user scope artifact。
  - 如果当前 repo 也安装了 project scope artifact，一并刷新当前 repo 的 project artifact。
  - user artifact 使用 `default+user`，当前 repo project artifact 使用 `default+user+project`。
- project scope config 写入只刷新当前 repo project artifact，不改写 user artifact。
- refresh 重新执行 renderer、校验 plan、应用受影响 artifact。
- `enableLightweightInstruction=false` 时，renderer 返回 disabled instruction artifact，AW 移除轻量 instruction block 并更新 tracking。
- `explorerModel` / `modelReasoningEffort` 变化时，instruction 和 role artifact 都应刷新。
- refresh 成功后更新 state、configDigest、contentDigest、lastRefresh。
- refresh 失败后不回滚 config store；受影响 artifact 标记为 refresh failed，让 status 能提示用户修复。
- refresh 不执行 lifecycle 脚本。
- refresh 不修改用户手写 role 文件。
- refresh 不扫描所有历史 project。
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
- tracking 读取要兼容旧 path-only record。
- status 对旧 artifact 不要求报告 config digest。

### 9. `codex-explore` 插件内容

新增：

```text
plugins/codex-explore/
├── .agents-plugin/plugin.json
├── instructions/lightweight.md
├── roles/codex-explorer.md
├── scripts/render-artifacts.mjs
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
- `config.schema` 声明：
  - `enableLightweightInstruction`: boolean，默认 `true`
  - `explorerModel`: string，默认 `gpt-5.4-mini`
  - `modelReasoningEffort`: enum，默认 `medium`，值为 `low | medium | high | xhigh`

renderer 行为：

- 读取 effective config。
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
- 主 agent 只整合 explorer 的关键结论、文件路径、必要行号和不确定点，必要时补读少量文件验证，不倾倒完整子代理回复。
- 汇总后立即关闭本 workflow 启动的 explorer；`wait_agent` 完成不等于关闭 agent。

轻量 instruction 要点：

- 使用 Codex 内置 `explorer` role。
- 默认传入 `model = <explorerModel>` 和 `reasoning_effort = <modelReasoningEffort>`。
- 只指导主 agent 在合适场景使用 explorer，不复制完整 skill workflow。
- 要求每个 explorer 任务只读、范围清晰、输出简短。
- 已知单个文件、单个符号或少量文件内的小搜索，优先让主 agent 自己完成。
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
- 文档说明 renderer 只能返回 plan，不能直接写 AW 受管文件。
- 文档说明 ArtifactPlan 的 `id`、`target`、`state`、`refreshKeys`、`disabledReason`。
- 文档说明 `codex.developerInstructionsBlock` 和 `codex.agentRole`。
- 文档说明动态 artifact 的 config refresh 行为。
- 文档说明静态 `extensions.*` 仍适合简单静态产物。
- 作者工具校验：
  - renderer path 是否存在。
  - runner 是否受支持。
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
- ArtifactPlan / target / state / tracking 类型草案。
- source manifest bundle 和 platform manifest 过滤逻辑。

退出标准：

- 合法 renderer manifest 能被 normalizer 接受。
- 非法 runner、越界 path、未知 scripts 字段能给清晰错误。
- `scripts.artifacts.render` 不泄漏到 Codex 原生 manifest。

### 阶段 2：renderer runtime 与 plan 校验

交付：

- renderer context 写入和执行。
- stdout JSON 解析、stderr 摘要、timeout、敏感配置脱敏。
- ArtifactPlan 校验。

退出标准：

- install / upgrade 能在写 artifact 之前拿到 plan。
- 非法 plan 不写文件、不写 tracking。
- renderer 失败有可诊断错误。

### 阶段 3：Codex target apply

交付：

- `codex.developerInstructionsBlock` apply/remove。
- `codex.agentRole` apply/remove。
- Codex role namespace 冲突检测。

退出标准：

- instruction present/disabled 能正确写入或移除 managed block。
- role present 能生成 `[agents.codex-explorer]` 和 role layer。
- 同名非 AW 管理 role 会阻止安装。
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
- 旧 path-only tracking 仍可读取。
- current catalog 缺失时，status/discovery/交互式 uninstall/upgrade 候选/direct uninstall/direct upgrade 能从 tracking 恢复真实 artifact identity 和 roleKey。

### 阶段 5：config-triggered refresh

交付：

- config 命令写入后的 refresh 判断。
- renderer refresh event。
- refresh apply、lastRefresh metadata、receipt 输出。

退出标准：

- 修改 `enableLightweightInstruction` 会切换轻量 instruction present/disabled。
- 修改 `explorerModel` 或 `modelReasoningEffort` 会刷新 instruction 和 role。
- 未命中 `refreshKeys` 的配置写入不刷新。
- refresh 失败保留 config store，并让 status 报告 refresh failed。
- 不扫描所有历史 project。
- user scope 写入后的 `refreshReach` 能区分已刷新的 user / 当前 project target 和未扫描的历史 project target，status 能稳定提示其它已知历史 project artifact 可能 stale。

### 阶段 6：新增 `codex-explore` 插件

交付：

- 插件 manifest、renderer、templates、skill、role prompt。
- build 后 runtime bundle。

退出标准：

- `aw install codex-explore -p codex` 成功。
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
- 执行：
  - `pnpm test:unit`
  - `pnpm test:integration`
  - `pnpm build`
  - `pnpm test:smoke:build`
  - `pnpm test:smoke:pack`

## 测试矩阵

### Unit

- manifest normalize：
  - 接受合法 `scripts.artifacts.render`。
  - 拒绝越界 path。
  - 拒绝不支持的 runner。
  - 保证 renderer 字段不进入 Codex 原生 manifest。
- renderer runtime：
  - 生成包含 effective config 的 context。
  - `install` / `upgrade` 没有 changed keys。
  - `refresh` 带 changed keys。
  - stdout 非 JSON 时失败。
  - renderer 超时时失败并脱敏输出。
- ArtifactPlan validation：
  - 接受合法 instruction present。
  - 接受合法 instruction disabled。
  - 接受合法 `codex.agentRole` present。
  - 拒绝未知 target。
  - 拒绝未知 refresh key。
  - 拒绝 disabled artifact 缺少 refreshKeys。
  - 拒绝 `roleFile.name !== roleKey`。
  - 拒绝 renderer 声明任意路径。
  - 拒绝重复 `id + target`。
- config digest：
  - digest 只随 refreshKeys 对应值、renderer/manifest digest、target/id 改变。
  - unrelated config key 不改变 digest。
- Codex config helper：
  - upsert/remove developer instructions block 保留其它 TOML。
  - upsert/remove `[agents.<roleKey>]` 保留其它 TOML。
  - 删除时遇到 config_file drift 不误删用户文件。
- role namespace：
  - `[agents.foo] config_file` 指向文件内 `name = "codex-explorer"` 能检测冲突。
  - 未被声明引用的 `agents/*.toml` 同名 role 能检测冲突。
  - AW managed 同名 role 不算外部冲突。

### Integration

- `aw install codex-explore -p codex -s user`：
  - native plugin enabled。
  - 写入轻量 instruction。
  - 生成 `[agents.codex-explorer]` 和 role layer。
  - tracking 记录两个 artifact id、target、state、refreshKeys、paths 和 digest。
- `aw install codex-explore -p codex -s project`：
  - 使用 project effective config。
  - project artifact 不改写 user artifact。
- `aw install codex-explore -p claude` 被 product policy 拦截。
- 安装时存在非 AW 管理最终 role 名 `codex-explorer`：
  - 命令失败。
  - 失败发生在 required-config preflight 和 config prompt 之前。
  - 不写 native plugin enabled。
  - 不写 instruction。
  - 不写 role layer。
  - 不写 tracking / ledger 半成品。
- `aw config set codex-explore enableLightweightInstruction false`：
  - renderer 返回 disabled instruction。
  - 轻量 instruction block 被移除。
  - role artifact 不受影响。
  - status 报告 instruction disabled by config。
- `enableLightweightInstruction` 从 false 改回 true：
  - instruction 按当前 effective config 重新写入。
- `aw config set codex-explore explorerModel <new>`：
  - instruction 中的 model 更新。
  - role layer 中的 model 更新。
  - tracking digest 更新。
- `aw config set codex-explore modelReasoningEffort high`：
  - instruction 和 role layer 都更新。
- unrelated config key 写入不触发 refresh。
- 同一 repo 同时安装 user scope 和 project scope artifact 后，执行命中 refresh key 的 user scope 写入：
  - user artifact 按 `default+user` 刷新。
  - 当前 repo project artifact 按 `default+user+project` 刷新。
- 两个 repo 都安装 project scope artifact 后，在 repo A 执行命中 refresh key 的 user scope 写入：
  - `refreshReach` 只记录 user target 和 repo A project target 已刷新。
  - repo A 的 status 能提示其它已知历史 project target 未扫描，可能仍使用旧 artifact。
- renderer refresh 失败：
  - config store 保留新值。
  - tracking `lastRefresh.status = failed` 或等价状态。
  - status 能诊断 failed。
- `aw uninstall codex-explore -p codex`：
  - 清理 managed instruction block。
  - 清理 `[agents.codex-explorer]` 注册项和 role layer。
  - 不删除用户手写 role 文件。
- `aw upgrade codex-explore -p codex`：
  - 按 artifact id / target 更新旧 artifact。
  - disabled artifact 不残留旧内容。
- `aw status --json` 和 `aw status --json --verbose`：
  - stdout 是纯 JSON。
  - 包含 instruction 和 role artifact 诊断字段。
- current catalog 缺失但 tracking 仍有 artifact record：
  - discovery 恢复真实 artifact id / target / roleKey。
  - status 展示 historical source 和 artifact identity。
  - 交互式 uninstall / upgrade 候选恢复真实 artifact identity。
  - direct uninstall / direct upgrade 仍按恢复出的 artifact identity 执行。
- `aw install --skill-trigger manual` 后仍可 `$codex-explore` 显式触发。
- `aw install --skill-trigger auto` 后 Codex 才允许该 skill 自动触发。

### 内容回归

必须锁住插件实际交付给模型的内容：

- 轻量 instruction 使用 Codex 内置 `explorer`。
- 轻量 instruction 不出现 `agent_type = "codex-explorer"`。
- 轻量 instruction 包含 `model = <explorerModel>` 和 `reasoning_effort = <modelReasoningEffort>` 的渲染值。
- 轻量 instruction 要求只读、范围清晰、输出简短。
- 轻量 instruction 要求主 agent 关闭 explorer。
- `SKILL.md` 包含 `agent_type = "codex-explorer"`。
- `SKILL.md` 包含 `close_agent` 要求，并说明 `wait_agent` 不等于关闭 agent。
- `SKILL.md` 要求每个委派 prompt 写探索深度。
- `SKILL.md` 保留 `quick`、`medium`、`very thorough` 三档。
- `agents/openai.yaml` 默认 `allow_implicit_invocation: false`。
- 专用 role prompt 保留只读边界。
- 专用 role prompt 保留输出结构：`结论`、`证据`、`不确定点`、`建议主 agent 下一步查看`。
- 专用 role prompt 不要求 explorer 写实现计划或修改文件。

### Smoke

- `pnpm build` 生成 `packages/cli/plugins-dist/codex-explore`。
- `pnpm test:smoke:build` 覆盖 Codex-only marketplace entry、platform manifest、skill 文件和 renderer 脚本。
- runtime bundle 包含 `scripts/render-artifacts.mjs`、instruction template、role prompt、skill 文件。
- `pnpm test:smoke:pack` 验收 `pnpm pack:cli` tarball 包含新插件 runtime bundle。

## Review 问题关闭标准

由于 spec 主线已经改为 artifact renderer script，上一版 review 中围绕 `codexRole` binding、默认值双真值、重复 binding key、`promptOverride` 和 `allowEmpty` 的问题不再按原方案执行。

新的关闭标准：

- 不再有 `codexRole.model.default` 这类双真值字段；模型默认值只在 `config.schema.explorerModel.default` 中出现。
- 不再有 `promptAppend` / `promptOverride`；首版不需要 `allowEmpty`。
- 不再从 `extensions.agents[].codexRole` 推导 refresh effect；refresh 由 tracking 中的 artifact `refreshKeys` 驱动。
- 内容回归仍然保留，直接断言轻量 instruction、`SKILL.md`、`agents/openai.yaml` 和专用 role prompt 的关键行为。
- role 冲突检测仍然保留，但作为 `codex.agentRole` target apply/preflight 的一部分实现。

## 风险与回退

- renderer script 增加新的失败面。实现前要复用脚本 timeout、stderr/stdout 摘要、敏感配置脱敏和可诊断错误。
- ArtifactPlan 校验如果太宽，会重新打开“脚本任意写盘”的风险；首版 target 必须是封闭枚举。
- config refresh 失败后保留 config store，可能出现配置已变但 artifact 未更新。status 必须清楚报告 refresh failed，并给用户可恢复路径。
- role namespace 解析要容忍用户手写 TOML 损坏。安装时解析失败应 fail fast；status 可以 degraded warning。
- user scope 配置写入不会扫描所有历史 project。tracking 必须写实记录 refresh 覆盖范围，status 要提醒未纳入本次 refresh 的已知历史 project artifact 可能 stale。
- 当前 Codex 会话是否热加载 instruction / role artifact 取决于 Codex runtime。文档要说明必要时需要新会话生效。
- 只读边界不是工具级硬隔离。轻量 instruction、skill 和 role prompt 都要把只读约束写清楚。
- 模型 slug 可用性不是 AW 能静态保证的能力。用户配置不可用模型时，失败可能发生在 Codex spawn 阶段。
- 旧式静态 extensions 要保持兼容；内置 renderer 不应改变旧插件的产物路径、tracking 和卸载行为。

## 首版验收清单

- `pnpm build` 能生成 Codex-only `codex-explore` marketplace entry。
- manifest 支持 `scripts.artifacts.render`。
- renderer 能根据 effective config 返回 ArtifactPlan。
- AW 能校验 ArtifactPlan，并拒绝未知 target、未知 refresh key、非法 state、非法 roleKey 和任意路径写入。
- `aw install codex-explore -p codex -s user` 成功写入轻量 instruction、`[agents.codex-explorer]` 和 role layer。
- `aw install codex-explore -p claude` 被 product policy 拦截。
- `agents/openai.yaml` 默认 `allow_implicit_invocation: false`。
- `skillTriggers.codex-explore.allowInstallOverride = true`，安装时可显式切到 auto。
- 轻量 instruction 使用内置 `explorer`，不使用 `codex-explorer`。
- 手动 `$codex-explore` skill 使用 `codex-explorer` role。
- role 文件包含 `model = "gpt-5.4-mini"`、`model_reasoning_effort = "medium"` 和只读探索提示词。
- 安装不会覆盖任何非 AW 管理且最终 role 名为 `codex-explorer` 的自定义 role。
- role 冲突会在 required-config preflight 之前、任何 config/native/artifact/tracking/ledger 写入前失败。
- tracking/status/uninstall/upgrade/refresh 都按 artifact id / target / roleKey 处理。
- `aw config set/configure/unset/reset` 命中 `refreshKeys` 后自动刷新当前可定位 artifact。
- `enableLightweightInstruction=false` 会移除或跳过轻量 instruction，status 报告 disabled by config。
- `explorerModel` / `modelReasoningEffort` 改动会刷新 instruction 和 role。
- refresh 失败会保留 config store，并让 status 报告 refresh failed。
- user scope refresh 不扫描所有历史 project，但 tracking/status 会写实报告当前刷新覆盖范围和其它已知 project target 可能 stale。
- current catalog 缺失但 tracking 仍有 artifact record 时，status/discovery/交互式 uninstall/upgrade 候选/direct uninstall/direct upgrade 仍保留真实 artifact identity。
- status JSON 保持机器可读，包含 instruction 和 role artifact 诊断字段。
- uninstall 清理 AW 管理的 instruction block、注册项和 role layer，不影响用户手写文件。
- 静态 `extensions.*` 旧插件仍按原行为安装、status 和卸载。
- 作者工具和文档覆盖 renderer contract、ArtifactPlan、两个 Codex target、config refresh 和插件默认手动 skill。
- 单元、集成和 smoke 测试覆盖 manifest、renderer、plan validation、Codex target apply、config refresh、插件 bundle 和 tarball。
