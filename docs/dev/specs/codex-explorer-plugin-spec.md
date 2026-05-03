# Codex 探索插件需求 Spec

## 背景

Codex 已经有内置 `explorer` 子代理角色，但默认 `spawn_agent` 工具说明很保守：只有用户明确要求子代理、委派或并行 agent 工作时才鼓励使用。单纯要求“深入分析”“充分探索”“详细阅读代码”不天然等同于授权 spawn。

本需求同时交付两个入口：

- 默认轻量入口：通过一段很轻的 Codex instruction 指引主 agent 在代码库探索阶段使用内置 `explorer` role。该入口默认开启，但必须能通过插件配置关闭。它只是建议性提示，不承诺突破 Codex runtime 对 `spawn_agent` 的全局授权规则。
- 显式 skill 入口：通过 `$codex-explore ...` 进入更强约束的探索 workflow，并使用专用 `codex-explorer` role。

基础设施主线采用 **artifact renderer script**：插件脚本负责根据 artifact render config 计算最终 artifact plan，AW CLI 负责校验、写盘、tracking、status、rollback、upgrade 和 uninstall。`enableLightweightInstruction` 只是 renderer 消费的一个插件配置，不是 AW core 内置理解的 instruction 专属开关。

本 spec 只描述需求和边界，不进入具体实现细节。

## 已核对基线事实

### AW 插件模型

- 源码真值是 `plugins/<name>/.agents-plugin/plugin.json`，运行时 `.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json` 由 `pnpm build` 生成。
- Codex 原生插件 manifest 当前只承载 `skills`、`mcpServers`、`apps`。`extensions.instructions`、`extensions.permissions`、`extensions.hooks`、`extensions.agents` 是 AW 安装时生成 Codex repo/user scope 受管产物的来源。
- Codex user scope 仍通过原生 marketplace/plugin enabled 状态接入；Codex project scope 不调用 native marketplace，也不写用户级 `[marketplaces]` / `[plugins]`，而是把 skill、mcp、instruction、permission、hook、agent 等能力收敛为当前仓库的 repo-managed artifacts。skills-only、mcp-only、slashCommands-only 和 extensions-only 插件都可以作为 project scope 候选；带 `apps` 的插件仍在 project scope fail fast。
- 当前 Codex adapter 安装 extension 时直接读取静态 `extensions.instructions` 和 `extensions.agents`，再写当前 scope 的 Codex config 或 agent role 文件。中间没有“读取 effective config 后计算 artifact 形态”的阶段。
- 当前 AW 对 Codex instruction 的安装路径已经存在：`extensions.instructions` 会渲染成当前 scope Codex config 里的 AW managed `developer_instructions` block。
- 当前 AW 对 Codex agent 的生成只会写当前 scope 的 role 文件，不会同时写 Codex config 的 `[agents.<roleKey>]` 注册项，也没有按 `roleKey` 跟踪注册项和 role 文件这一对产物。
- 当前 AW config 可以通过 `config.schema`、`aw config set/configure/unset/reset` 管理 user/project 两层配置；但配置写入只更新 config store 并返回 effective config，不会自动刷新已安装 artifact。
- lifecycle 脚本已经能拿到 effective config 和本次写出的 artifacts，但执行时机是在 artifact 写完之后、tracking/ledger 提交之前。如果让 lifecycle 脚本直接改 Codex config 或 role 文件，会绕过 AW 的受管 artifact 模型。
- 现有 tracking 主要记录 `path/kind/platform/hookGroups`，缺少稳定 artifact id、target、config digest、disabled 状态和最近 refresh 结果。
- `marketplace.policy.products = ["CODEX"]` 可以把插件限制到 Codex，安装时会拦截 Claude。

### Codex agent role contract

- Codex 内置了 `default`、`explorer`、`worker` 等 role。内置 `explorer` 的可见说明来自 `spawn_agent` 工具里的 role description。
- 当前上游 Codex 的 `builtins/explorer.toml` 是空文件。选择 `agent_type = "explorer"` 时，role layer 本身不会写入额外 `model`、`model_reasoning_effort` 或 `developer_instructions`。
- Codex `spawn_agent` 处理顺序是：先应用调用参数中的 `model` / `reasoning_effort`，再应用 role layer。由于内置 `explorer` 的 role layer 为空，调用时显式传入的 `model` 和 `reasoning_effort` 会保留下来。
- 对自定义 role 来说，如果 role 文件写了 `model` 或 `model_reasoning_effort`，这些 role 设置会覆盖调用参数，模型和 effort 不能再被单次 spawn 参数改写。
- Codex 同一 config layer 中的 `[agents.*]` 声明和 `agents/**/*.toml` 自动发现会归并到最终 role 名空间；声明项如果带 `config_file`，最终 role 名会继续读取 role 文件里的 `name`。
- `wait_agent` 只等待子代理进入最终状态，不等于关闭子代理；一次性探索代理用完后仍应调用 `close_agent`。

### Claude Explore 参考

Claude Code 内置 `Explore` agent 给轻量路径提供了几个明确启发：

- role 聚焦文件搜索和代码阅读，不承载复杂实现计划。
- 提示词首要约束是只读、快速搜索、清晰汇报。
- 对外部用户偏向使用轻模型；内部场景可以继承主模型。
- 主 agent 需要指定 thoroughness：`quick`、`medium` 或 `very thorough`。
- Explore agent 不读取完整项目约定来替代主 agent 判断；主 agent 负责解释和整合结果。

## 交付范围总览

以下三块都是本需求范围内的交付项。实现可以分层推进，但验收时不能把任意一块当作可选项。

### 基础设施：artifact renderer script

新增 install-time artifact rendering contract。插件可以在 manifest 中声明 `scripts.artifacts.render`，renderer 读取 `AW_PLUGIN_CONTEXT`，基于 platform、scope、artifact render config、安装事件和既有 tracking 输出 artifact plan。AW 只接受受支持 target 的 plan，不允许脚本任意声明落盘路径。

动态 artifact 还必须在 manifest 中声明不需要执行 renderer 就能读取的能力元数据。installability、project write safety preflight、discovery、status 和 ledger capability snapshot 都先消费这层声明；renderer 只负责在写路径产出具体内容和当前状态，不作为安装前能力真值。

首批支持两个 Codex target：

- `codex.developerInstructionsBlock`：写入、更新、移除当前 scope Codex config 中该插件的 AW managed `developer_instructions` block。
- `codex.agentRole`：同时管理 `[agents.<roleKey>]` 注册项和 role layer 文件。

同一 plugin + platform + scope 的原子单元内，所有落到同一份 Codex config 的变更必须先在内存中合并，再通过一次文档级事务写入，并共享同一份 rollback baseline。不能让 `codex.developerInstructionsBlock`、`codex.agentRole` 或未来其它 config-backed target 各自对同一个 `.codex/config.toml` 执行独立 read-modify-write。

静态 `extensions.instructions`、`extensions.permissions`、`extensions.hooks`、`extensions.agents` 需要保留兼容。它们可以先被包成 AW 内置 renderer，保证旧插件行为不变；动态 artifact 走插件自定义 renderer。

### 基础设施：配置驱动 artifact refresh

`aw config set/configure/unset/reset` 写入成功后，AW 根据 tracking 中记录的 artifact `refreshKeys` 判断本次变更是否影响当前可定位的已安装 artifact。命中时，AW 按目标 scope 进入刷新流程；若涉及 Codex project scope target，必须先通过 project write safety preflight，再执行 renderer、应用新的 artifact plan，并记录刷新结果。

刷新能力必须走 artifact plan 和 AW 受管落盘链路，不能通过 lifecycle 脚本直接修改 Codex config、role 文件或其它受管文件。

### 入口 A：默认轻量 instruction

插件安装后默认写入一段 Codex instruction。该 instruction 指导主 agent：

- 在合适的代码库探索场景中使用 Codex 内置 `explorer` role。
- 默认调用 `spawn_agent(agent_type="explorer", model=<插件配置>, reasoning_effort=<插件配置>)`。
- 每个 explorer 任务都保持只读、范围清晰、输出简短。
- 主 agent 继续负责本地补读、判断、整合和关闭子代理。

这是默认入口。它调用 Codex 内置 `explorer`，不使用 `agent_type = "codex-explorer"`，也不依赖专用 role 才能运行。

### 入口 B：手动 skill + 专用 agent role

`skill + 专用 codex-explorer agent role` 是同步交付的显式入口。它适合需要更强提示词隔离、更稳定 role 名、或团队希望通过 `$codex-explore` 明确进入探索 workflow 的场景。

要求：

- skill 默认手动触发：Codex `skills/codex-explore/agents/openai.yaml` 中 `policy.allow_implicit_invocation = false`。
- manifest 仍可声明 `skillTriggers.codex-explore.allowInstallOverride = true`，允许用户安装时显式改成 `--skill-trigger auto`。
- 专用 role 使用 `roleKey = "codex-explorer"`，不能覆盖 Codex 内置 `explorer`。
- 该入口必须补齐 Codex custom role 基础设施：注册项、role 文件、tracking、status、uninstall、冲突检测和配置刷新。

## 已确认设计点

- 插件名称：`codex-explore`。
- 产品范围：Codex only，`marketplace.policy.products = ["CODEX"]`。
- 安装范围：`codex-explore` 首版支持 Codex user scope 和 Codex project scope。user scope 使用 Codex native plugin/runtime；project scope 只写当前仓库的 repo-managed skill、instruction 和 role artifact，不启用共享 user native plugin。
- 动态 artifact 采用 `scripts.artifacts.render` 返回 artifact plan。
- 动态 artifact 的安装前能力真值来自 manifest 中的 `artifacts.targets` 声明；renderer plan 不能扩大这层声明里的 platform、scope、target、managed kind 或 project config 写入面。
- 默认轻量入口使用 Codex 内置 `explorer` role。
- 显式 skill 入口使用专用 `codex-explorer` role。
- 模型和 effort 使用插件自己的 AW config，而不是无条件继承主 agent 当前模型。
- 默认配置建议：`enableLightweightInstruction = true`，`explorerModel = "gpt-5.4-mini"`，`modelReasoningEffort = "medium"`。
- `enableLightweightInstruction` 由插件 renderer 转换成 instruction artifact 的 `present` 或 `disabled` 状态，不进入 AW core 的业务判断。
- 配置触发刷新是本需求的基础设施交付，覆盖 instruction 和专用 role 两类 artifact。
- 轻量 instruction 是默认入口，但不是强制入口；关闭后只保留手动 skill + 专用 role 入口。
- 手动 skill + 专用 role 是同步交付入口，但 skill 默认 `manual`。

## 目标

- 新增 Codex-only 插件 `codex-explore`。
- 支持将 `codex-explore` 安装到 Codex user scope 和 Codex project scope；project scope 的 skill、instruction 和 role 都走当前仓库的 repo-managed artifacts。
- 新增 artifact renderer script contract，让插件能根据 artifact render config 计算最终受管 artifact plan。
- 补齐 config-driven artifact refresh：配置写入命中 tracking 中的 `refreshKeys` 后，自动刷新当前可定位的 instruction 和 Codex role artifact。
- 提供轻量 instruction，指导主 agent 在代码库探索阶段使用内置 `explorer`。
- 支持通过 `aw config` 开启或关闭轻量 instruction 入口，避免它和手动 skill 入口互相影响。
- instruction 必须渲染出当前插件配置里的模型和 reasoning effort，让主 agent 默认按配置传给 `spawn_agent`。
- 支持通过 `aw config` 配置 explorer 默认模型和 reasoning effort。
- 配置变更后，当前可定位的已安装 instruction 和专用 role artifact 应自动重渲染，不需要用户额外运行 `apply` / `sync` 命令。
- 提供手动 `$codex-explore` skill 入口，并把该 skill 默认触发策略改为手动。
- 提供专用 `codex-explorer` role；它服务显式 skill 入口，但默认轻量入口不依赖它。
- 插件只面向 Codex，不向 Claude Code 安装任何能力。

## 非目标

- 不改变 Codex 上游 `spawn_agent` 工具的全局授权规则。
- 不把安装型 `developer_instructions` 视为 `spawn_agent` 的新增授权来源；默认轻量入口只提供建议性指引。
- 不把 `--skill-trigger auto` 视为 `spawn_agent` 的新增授权来源；auto skill 只能影响 workflow 是否可被自动选中，不能改变 Codex runtime 的全局子代理授权规则。
- 不在 Codex project scope 启用或依赖 user scope native plugin；project 安装必须只写当前仓库的 repo-managed artifacts。
- 不为 `enableLightweightInstruction` 发明 instruction 专属 manifest 字段、adapter 特例或 `extensions.instructions[].when` 开关。
- 不让 renderer 或 lifecycle 脚本直接写 Codex config、role 文件或其它 AW 受管 artifact。
- 默认轻量入口不通过自定义 Codex role 调用，不写 `agent_type = "codex-explorer"`，也不覆盖内置 `explorer`。
- 首版不引入 MCP server、代码索引服务、hook 或 permission mode。
- 首版不支持自定义 explorer role 的工具 allowlist / denylist。
- 不让 explorer 直接修改代码；首版定位为只读探索和汇总。
- 不把大段源码搬回主 agent；explorer 输出以结论、文件路径、必要行号和少量摘录为主。
- 不让所有插件配置写入都触发 artifact refresh；只有已安装 artifact tracking 中明确记录的 `refreshKeys` 才触发刷新。
- 不要求 `aw config` 静态验证模型 slug 是否对当前账号可用；模型不可用时失败发生在 Codex spawn 阶段。

## 插件形态与配置

### 插件形态

建议结构：

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

manifest 至少声明：

- `marketplace.policy.products = ["CODEX"]`
- `scripts.artifacts.render`：根据 artifact render config 返回 instruction 和 Codex role artifact plan。
- `artifacts.targets`：声明 renderer 可能产出的 Codex artifact、project-managed kind、适用 scope、refresh key 和 project config 写入面，供 installability、preflight、discovery、status 和 capability snapshot 在不执行 renderer 的情况下判断能力。
- `config.schema`：声明 `enableLightweightInstruction`、`explorerModel` 和 `modelReasoningEffort`。
- `skills = "./skills"`：提供手动 skill 入口。
- `skillTriggers.codex-explore.allowInstallOverride = true`：允许用户显式改成自动触发。

建议 manifest 片段：

```json
{
  "scripts": {
    "artifacts": {
      "render": {
        "runner": "node",
        "path": "./scripts/render-artifacts.mjs"
      }
    }
  },
  "artifacts": {
    "targets": [
      {
        "id": "lightweight-instruction",
        "platform": "codex",
        "scopes": ["user", "project"],
        "target": "codex.developerInstructionsBlock",
        "projectManagedKind": "instruction",
        "refreshKeys": ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"],
        "states": ["present", "disabled"],
        "requiresCodexProjectConfig": true
      },
      {
        "id": "codex-explorer-role",
        "platform": "codex",
        "scopes": ["user", "project"],
        "target": "codex.agentRole",
        "projectManagedKind": "agent",
        "refreshKeys": ["explorerModel", "modelReasoningEffort"],
        "states": ["present"],
        "requiresCodexProjectConfig": true
      }
    ]
  }
}
```

本插件的动态 instruction 和专用 role 不应再通过静态 `extensions.instructions` / `extensions.agents` 表达。静态 extensions 继续作为旧插件和简单静态产物的兼容入口。

`artifacts.targets` 的最终字段名可以在实现时微调，但 contract 必须包含下面这些语义：

- 声明是 manifest 级静态元数据，不读取用户配置，不执行 renderer，也不包含 artifact 正文。
- 每个动态 artifact 都必须有稳定 `id`、`platform`、适用 `scopes`、`target`、映射到现有 Codex project capability snapshot 的 `projectManagedKind`、允许的 `states` 和 `refreshKeys`。
- `projectManagedKind` 使用现有 Codex project kind：`codex.developerInstructionsBlock` 映射为 `instruction`，`codex.agentRole` 映射为 `agent`。不要把 renderer 内部的 `kind = "codexRole"` 直接写入 capability snapshot。
- `requiresCodexProjectConfig` 表示 project scope 下该 target 会读取或改写 `.codex/config.toml`，因此首次 install、explicit upgrade 和 config-triggered refresh 都必须在执行 renderer 前进入 Codex project write safety preflight。
- renderer plan 只能返回当前 platform/scope 在 manifest 中声明过的 artifact。返回未声明 `id`、未声明 target、未声明 state、未声明 refresh key，或产生 manifest 未声明的 project config 写入面，都必须失败。
- 对当前 platform/scope 声明的动态 artifact，renderer 应返回一条 `present` 或 `disabled` plan。配置关闭这类情况用 `disabled` 表达，不能直接省略，否则 tracking/status 无法区分“配置关闭”和“renderer 漏产物”。
- 静态 `skills`、`slashCommands`、`mcpServers`、`extensions.*` 与动态 `artifacts.targets` 一起组成 current catalog 的 Codex project-managed kinds。对 `codex-explore`，project scope 首次安装前就应能得到 `skill + instruction + agent`，而不是把它误判为 `skill-only`。

首版只需要让 `enableLightweightInstruction` 控制轻量 instruction artifact 是否存在，让 `explorerModel` 和 `modelReasoningEffort` 进入轻量 instruction 和专用 role；不要为了这个需求引入 prompt override。

### Config schema

建议配置：

```json
{
  "config": {
    "schema": {
      "enableLightweightInstruction": {
        "type": "boolean",
        "title": "Enable lightweight instruction",
        "default": true,
        "description": "Whether to install the lightweight instruction that lets the main Codex agent use the built-in explorer role."
      },
      "explorerModel": {
        "type": "string",
        "title": "Explorer model",
        "default": "gpt-5.4-mini",
        "description": "Model passed to spawn_agent when using the built-in explorer role."
      },
      "modelReasoningEffort": {
        "type": "enum",
        "title": "Explorer reasoning effort",
        "default": "medium",
        "values": ["low", "medium", "high", "xhigh"],
        "description": "Reasoning effort passed to spawn_agent for explorer tasks."
      }
    }
  }
}
```

要求：

- 默认值唯一来自 `config.schema`。
- AW core 需要区分两类配置解析口径：
  - `effective config`：继续沿用现有 contract，按当前命令上下文解析 project root，并按 `schema default < user config < 当前 project config` 合并，服务 `aw config get/list` 默认读取和项目运行时读取，不作为 artifact render 的真值。
  - `artifact render config`：新增安装/刷新/digest 专用口径，按目标安装 scope 解析。user scope 只合并 `schema default < user config`；project scope 合并 `schema default < user config < 当前 project config`。`aw status` 可以用同一 scope 规则纯计算 `configDigest` / stale 诊断，但不能执行 renderer。
- renderer 渲染受管 artifact 时必须读取 `artifact render config`，不能直接复用当前命令上下文的 `effective config`。
- `codex-explore` 同时支持 user/project 两个安装 scope；同一条命令如果同时处理两个 scope，应分别为每个 scope 解析对应的 render config。
- 在仓库内安装或刷新 user scope artifact 时，当前仓库的 project config 不得进入 user scope 的 artifact 内容、`configDigest`、status 判断或 refresh stale 判断，避免单个仓库改写全局用户级产物。
- `aw config set/configure/unset/reset` 修改命中 tracking `refreshKeys` 的 key 后，应按各已安装 artifact 的目标 scope 进入刷新流程，再刷新当前命令上下文能定位的受影响 artifact。
- 若配置写入后的 refresh 命中 Codex project scope artifact，AW 必须在执行 renderer 或写入 artifact 前复用 Codex project install / explicit upgrade 同级别的写入前安全预检。该预检至少覆盖用户级 Codex config 可读性和 external ownership、当前仓库 `.codex/config.toml` 可读性、tracking identity、未受管 repo artifact 冲突，以及其它现有 project write safety 检查。
- `enableLightweightInstruction = false` 时，renderer 应返回轻量 instruction artifact 的 `state = "disabled"`；安装和刷新都不应保留轻量 instruction 正文。
- 未安装插件时，配置只保存；后续 install/upgrade 时按目标 scope 的最新 artifact render config 渲染。

## Artifact renderer contract

### Renderer context

renderer 通过 `AW_PLUGIN_CONTEXT` 读取上下文。最终字段名可以在实现时微调，但 contract 必须包含：

```json
{
  "event": "install | upgrade | refresh",
  "platform": "codex",
  "scope": "user | project",
  "plugin": {
    "name": "codex-explore",
    "version": "0.1.0",
    "rootDir": "..."
  },
  "config": {
    "mode": "artifact-render",
    "targetScope": "user | project",
    "schema": {},
    "values": {},
    "sources": {},
    "issues": []
  },
  "changedConfigKeys": ["explorerModel"],
  "previousArtifacts": [],
  "paths": {
    "awHome": "...",
    "codexHome": "...",
    "manifestPath": "..."
  }
}
```

要求：

- renderer 输出 stdout JSON；非 JSON、未知 version、未知 target、字段类型错误都视为 render 失败。
- `config.values` 是目标安装 scope 下的 artifact render config。user scope 的合并顺序是 `schema default < user config`；project scope 的合并顺序是 `schema default < user config < 当前 project config`。`config.sources` 保留各 key 的最终来源，user scope render config 中不得出现 project 来源。
- renderer 可以读取插件包内模板文件，但不能直接修改 Codex 配置或 AW tracking。
- renderer 复用现有脚本打包、依赖闭包、timeout、敏感配置脱敏和跨平台 runner 基础设施，但它是独立于 lifecycle 的 artifact render 阶段。
- `refresh` 事件应带上本次变更的 config key；`install` / `upgrade` 没有 changed keys 时仍必须按完整 artifact render config 输出 plan。
- renderer 只允许在 `install`、`upgrade`、`refresh` 这类写路径执行。`aw status` 是只读路径，不得执行 `scripts.artifacts.render` 或 lifecycle 脚本。

### ArtifactPlan

renderer 输出形态：

```json
{
  "version": 1,
  "artifacts": [
    {
      "id": "lightweight-instruction",
      "kind": "instruction",
      "platform": "codex",
      "target": "codex.developerInstructionsBlock",
      "state": "present",
      "refreshKeys": ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"],
      "content": "..."
    },
    {
      "id": "codex-explorer-role",
      "kind": "codexRole",
      "platform": "codex",
      "target": "codex.agentRole",
      "state": "present",
      "roleKey": "codex-explorer",
      "refreshKeys": ["explorerModel", "modelReasoningEffort"],
      "content": {
        "registration": {
          "description": "Read-only codebase exploration role for Codex Explore."
        },
        "roleFile": {
          "name": "codex-explorer",
          "description": "Read-only codebase exploration role for Codex Explore.",
          "model": "gpt-5.4-mini",
          "model_reasoning_effort": "medium",
          "developer_instructions": "..."
        }
      }
    }
  ]
}
```

`enableLightweightInstruction = false` 时，renderer 返回 disabled artifact，而不是省略它：

```json
{
  "id": "lightweight-instruction",
  "kind": "instruction",
  "platform": "codex",
  "target": "codex.developerInstructionsBlock",
  "state": "disabled",
  "disabledReason": "config",
  "refreshKeys": ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"]
}
```

要求：

- `id` 是插件内稳定身份，安装、刷新、status 和 uninstall 都按 `pluginName + id + target` 定位。
- `state` 首版支持 `present` 和 `disabled`。`disabled` 表示 AW 应移除或跳过对应受管内容，但 tracking 仍记录它是被配置关闭，不是缺失。
- 动态 artifact 即使 disabled 也必须保留足够的 `refreshKeys`，否则从 disabled 改回 present 时 AW 无法判断该配置写入需要触发 refresh。
- `refreshKeys` 必须指向 `config.schema` 中存在的 key。
- `platform` 必须和当前 render context 一致。
- `target` 只能是 AW 支持的枚举值，不能是任意路径。
- AW 负责按 target 生成实际路径；renderer 不直接决定任意文件路径，也不返回 `config_file` 或 role layer path。
- AW 应计算并记录 config digest。digest 至少覆盖该 artifact 的 `refreshKeys` 对应 artifact render config 值，并应纳入 renderer/manifest 版本信息，避免脚本更新后 status 误判为健康。

### Target：`codex.developerInstructionsBlock`

`present` 行为：

- `content` 必须是字符串。
- AW 把 `content` 写入当前 scope 对应的 Codex config 中该插件受管的 `developer_instructions` block。user scope 对应 `~/.codex/config.toml`，project scope 对应当前仓库 `.codex/config.toml`。
- 同一插件如果返回多个 present instruction artifact，AW 需要稳定合成它们，避免刷新顺序改变导致无意义 churn。

`disabled` 行为：

- AW 移除该 artifact 对应的受管 instruction 内容，或在生成阶段跳过该内容。
- 不允许保留一段“已禁用”的运行时提示词，因为它仍可能影响主 agent 行为。
- `aw status` 应报告 disabled by config，不能误报为 missing。

### Target：`codex.agentRole`

`present` 行为：

- artifact 必须声明 `roleKey`。
- `content.registration` 描述当前 scope Codex config 中 `[agents.<roleKey>]` 注册项的展示字段，至少包含 `description`，不得包含 `config_file`。
- `content.roleFile` 描述 role layer 文件，至少包含 `name`、`description`、`developer_instructions`，并允许 Codex-only 字段 `model`、`model_reasoning_effort`。
- role 文件里的 `name` 必须等于 `roleKey`。
- AW 按稳定规则生成 role layer 路径，并把相对当前 scope Codex config 的 `config_file` 写入 `[agents.<roleKey>]` 注册项；tracking、status、uninstall 和 refresh 都以 AW 生成并记录的路径为准。
- AW 负责把注册项和 role 文件作为同一个逻辑 artifact 跟踪、刷新、卸载和诊断。
- 安装前必须按 Codex 最终 role 名空间做冲突检测，不能只看 `[agents.<roleKey>]` 字面 table key。
- role 冲突 preflight 必须发生在任何平台写入、native plugin enable、artifact 写入、tracking/ledger 提交和 lifecycle 执行之前。冲突失败时命令保持只读，不留下半安装状态。
- refresh 前必须重新校验受管身份。若 `[agents.<roleKey>]` 已经不再指向 tracking 中记录的 AW 受管 role 文件，或最终 role 名已由非 AW 管理来源占用，refresh 必须失败并记录诊断，不能静默接管用户文件。
- 若 AW 受管 role 文件仍由 tracking 指向但内容 digest 已偏离上次受管结果，refresh 不能静默覆盖；首版应标记为 drift / refresh failed，让用户通过后续显式修复或重装处理。

`disabled` 行为首版不是 `codex-explore` 的主路径，但 target contract 应预留：禁用 role 时，AW 清理受管注册项和受管 role 文件，并把状态写进 tracking。

## Installability、capability snapshot 与 preflight

动态 artifact 不再通过静态 `extensions.instructions` / `extensions.agents` 表达后，AW 必须把 manifest 的 `artifacts.targets` 纳入 Codex project surface 判断。

要求：

- `getCodexProjectManagedKinds()` 或等价入口应合并静态能力和 `artifacts.targets` 中当前 platform/scope 适用的 `projectManagedKind`。`codex-explore` 的 project scope managed kinds 应是 `skill`、`instruction`、`agent`。
- `hasCodexProjectManagedArtifacts()`、project scope installability、discovery candidate、status current catalog view 和 `capabilitySnapshot.projectManagedKinds` 都使用同一个合并结果，避免 install / status / upgrade 各自猜测 renderer 产物。
- `pluginDeclaresCodexProjectConfigBackedArtifacts()` 或等价入口应把 `requiresCodexProjectConfig = true` 的动态 target 纳入判断。首次 install、explicit upgrade、config-triggered refresh 和会写 project scope 的 preflight 不能等 renderer 执行后才发现需要读写 `.codex/config.toml`。
- install / upgrade 写入 ledger 时，Codex `capabilitySnapshot` 必须记录 current catalog 中静态能力 + 动态 artifact metadata 的合并结果；renderer plan 和 tracking 记录实际 artifact 状态、路径和 digest，但不能作为安装前 capability snapshot 的唯一来源。
- upgrade 的 `capabilityChanged` 比较应使用 installed snapshot 与 current catalog 的动态 metadata 合并结果。current catalog 缺失时，只能按 installed snapshot、tracking artifact kind 和 historical evidence 保守回退，不能执行 renderer 恢复 current truth。
- project write safety preflight 必须发生在 renderer、native plugin enable、artifact 写入、tracking/ledger 提交和 lifecycle 之前。动态 metadata 已声明会触碰 Codex project config 时，preflight 失败要保持命令只读。

## Tracking、status 与卸载

tracking 需要从 path-only 扩展为 artifact-aware。最终字段名实现时可调整，但至少要表达：

- `id`：插件内稳定 artifact id。
- `kind`、`platform`、`target`。
- `state`：`present`、`disabled`，以及刷新失败时的诊断状态。
- `disabledReason`：例如 `config`。
- `refreshKeys` 和 `configDigest`。
- `paths`：AW 实际写入或管理的路径。`codex.agentRole` 至少包含 config.toml 注册项和 role layer 文件。
- `lastRefresh`：最近一次 install/upgrade/config refresh 的时间、触发 key、结果和错误摘要。
- `contentDigest` 或等价信息，用于 status 判断磁盘内容是否偏离受管计划。

当前项目仍在开发阶段，首版不要求兼容迁移已经落盘的 path-only tracking 记录；实现可以要求本地开发环境清理后重装。这里的兼容要求只指静态 `extensions.*` 作为插件源码/runtime contract 仍能按原行为安装，不代表必须把旧 tracking 文件原地升级。

status 要能分别报告 instruction 和 role artifact：

- artifact 缺失。
- artifact 因配置关闭。
- artifact 使用过期 config digest。
- renderer 或 apply 最近一次 refresh 失败。
- role 注册项存在但 `config_file` 不再指向 AW 管理文件。
- role layer 文件缺失或最终 role 名冲突。

user scope 下的 higher-priority visibility / drift 诊断也必须按 Codex 最终 role 名空间解析，不能只按高优先级 layer 中 `agents/*.toml` 的文件名或 `[agents.<key>]` 字面 key 比对。若更高优先级 layer 通过不同文件名或 table key 暴露了同一个最终 role 名，`aw status` 必须把 user scope 受管 role 标为被遮蔽或冲突。

`aw status` 必须只读，不执行 `scripts.artifacts.render`。它应基于 current catalog / ledger / tracking / install snapshot / 当前目标 scope config 纯计算健康状态：用 tracking 中的 `refreshKeys`、`configDigest`、`contentDigest`、`lastRefresh`、disabled 状态和已接受 plan 摘要判断 artifact 是否缺失、disabled、config stale、drifted 或 refresh failed。current catalog 缺失时只能使用 tracking / historical evidence 做保守诊断，不能通过运行 renderer 恢复真值。

uninstall 必须只清理 AW tracking 中记录的受管 artifact。被配置关闭的 artifact 也应参与卸载收尾，确保旧 block 或旧 role 文件不会残留。

## 基础设施：Config-triggered artifact refresh

刷新规则：

- refresh keys：`enableLightweightInstruction`、`explorerModel`、`modelReasoningEffort`。
- `enableLightweightInstruction` 只影响 Codex managed instruction artifact 的状态。
- `explorerModel` 和 `modelReasoningEffort` 同时影响 Codex managed instruction artifact，以及专用 `codex-explorer` role 的 role layer 文件。
- refresh target：当前可定位安装目标中的 Codex managed instruction block，以及专用 `codex-explorer` role 的注册项和 role layer 文件。
- refresh 行为：按目标安装 scope 完成必要 preflight 后，重新解析 artifact render config，执行 renderer，校验并应用 artifact plan，更新 AW tracking 元数据。user scope refresh 只使用 `schema default < user config`；project scope refresh 使用 `schema default < user config < 当前 project config`。
- 只要 refresh 命中 Codex project scope target，AW 必须先完成和 Codex project install / explicit upgrade 相同等级的 project write safety preflight，不能因为触发入口是 `aw config` 而放宽保护。preflight 失败时，本次 config store 写入仍然保留，但该 project scope 原子单元不得执行 renderer、不得改写 `.codex/config.toml`、repo-managed skill、instruction 或 role 文件，也不得写入新的成功 digest；该 refresh 单元只能进入 `refreshFailed`、`skipped` 或等价诊断状态，供 receipt / `aw status` 说明原因。
- refresh 的最小原子单元是同一 plugin + platform + scope 下本次命中的 artifact 集合。对于 `codex-explore`，这意味着同一 scope 中的轻量 instruction 和专用 role 要么一起刷新成功，要么一起回滚到刷新前的 artifact 状态。
- 同一原子单元内若同时改写 `developer_instructions`、`[agents.*]` 注册项，或其它共享 Codex config 的受管内容，AW 必须把这些 patch 合并为一次 `.codex/config.toml` 文档级事务；apply 失败时按这一份事务 baseline 整体回滚。
- 一次 user config 写入可能同时影响 user scope 和当前 project scope；一次 project config 写入只影响当前 project scope。两个 scope 分别作为独立原子单元处理，不跨 scope 回滚。
- 在仓库内执行配置写入时，project config store 本身不能被误判为 project scope 安装；同时，project config 的变更不得让 user scope artifact 进入 stale 或 refresh failed 状态，因为 user scope render config 不读取 project store。
- renderer 失败时不得写 artifact。apply 阶段任一 artifact 失败时，AW 回滚本原子单元中已经写入的 Codex config、role 文件和 artifact 内容；config store 写入仍然保留。
- 回滚后，tracking 不得声称新 config digest 或新 content digest 已生效；只能记录 `lastRefresh.status = "failed"` 或等价诊断，供 `aw status` 提示用户修复。

`aw config set/configure/unset/reset` 写入成功后：

1. AW 读取当前命令上下文能定位的已安装插件 tracking。
2. 如果变更 key 命中任一 artifact 的 `refreshKeys`，或 `reset` 可能影响这些 key，并且本次写入层会进入该 artifact 所属 scope 的 render config，则把该 artifact 纳入本次刷新计划。
3. 对即将刷新 Codex project scope artifact 的原子单元，AW 先执行 project write safety preflight；失败时跳过该原子单元的 renderer 和 artifact 写入，只记录失败诊断。
4. AW 用新的 plan 更新受影响 artifact。对于 `state = "disabled"` 的 instruction，移除受管 block；对于 `state = "present"` 的 instruction，写入新内容。
5. 刷新成功后更新 `configDigest`、`state` 和 `lastRefresh`。
6. renderer 或 apply 失败时，保留已经写入的 config store，回滚本原子单元的 artifact 写入，并把受影响 artifact 标成 `refreshFailed` 或等价诊断状态，让 `aw status` 能提示用户修复。

该能力只对 tracking 中明确记录了 `refreshKeys` 的 artifact 生效。没有动态 artifact 或没有 refresh key 的插件配置仍保持现有行为：配置写入只更新 config store，不触发重渲染。

refresh 只覆盖当前命令上下文能定位的 target。user config 可能影响多个 project scope 的 render config，但 AW 不应跨所有历史项目扫描；project config 不影响 user scope render config。命令回执或 `aw status` 不应暗示 AW 已刷新所有历史 project；当 user config 写入只刷新了当前可定位 target 时，应给出可诊断提示。

## 入口 A：默认轻量 instruction

### 开关行为

`enableLightweightInstruction` 控制 renderer 对轻量 instruction artifact 返回 `present` 还是 `disabled`：

- `true`：安装或刷新时返回 `state = "present"`，并把 `explorerModel` 和 `modelReasoningEffort` 渲染成具体值。
- `false`：安装或刷新时返回 `state = "disabled", disabledReason = "config"`；AW 移除该插件写入的轻量 instruction block，或在生成阶段跳过该 block。
- 从 `false` 改回 `true` 后，应按当前 artifact render config 重新写入轻量 instruction。
- 该开关只影响默认轻量入口，不影响 `$codex-explore` skill、skill trigger 安装偏好或专用 `codex-explorer` role。
- `aw status` 在该配置为 `false` 时应把 instruction 报告为 disabled by config；不能把被配置关闭的 instruction 误报成缺失或损坏。

### Instruction 内容要求

instruction 必须保持轻量：

- 不写长篇 workflow，不复制旧 skill 的详细步骤。
- 不内嵌大段示例 prompt。
- 不讲解插件机制、安装方式或配置命令。
- 默认正文建议控制在 25 行以内。
- 只保留主 agent 真正需要在运行时看到的选择规则、spawn 参数和关闭要求。

默认 instruction 草案：

```text
你可以使用 Codex 内置 `explorer` role 来加速代码库探索。该 workflow 只用于边界不清、跨模块、需要比较既有模式、或能和你本地调查并行推进的只读探索问题。

已知单个文件、单个符号、或 2 到 3 个文件内的小搜索，优先自己用本地工具完成。不要把实现、修改、格式化、提交或需要立即决策的问题交给 explorer。

使用 explorer 时，默认只启动 1 个。只有多个问题互不重叠且能并行推进时才启动 2 到 3 个；极少数复杂场景最多 4 个。

默认调用参数：
- `agent_type`: `explorer`
- `model`: `<explorerModel>`
- `reasoning_effort`: `<modelReasoningEffort>`

给每个 explorer 的任务必须写清楚：具体问题、范围、探索深度（`quick` / `medium` / `very thorough`）、只读要求和期望输出。提醒它不要创建、编辑、移动、删除、格式化或回退文件，不要安装依赖，不要运行破坏性命令。

explorer 运行时，继续做不重叠的本地调查。已经启动 explorer 后，必须等待并读取它的结果，不能因为暂时没有返回就关闭 explorer、再由主 agent 自己完成同一个探索问题。整合结果时只保留关键结论、文件路径、必要行号和不确定点；必要时补读少量代码验证。读取并整合结果后，立即关闭本次启动的 explorer。
```

渲染时必须把 `<explorerModel>` 和 `<modelReasoningEffort>` 替换成 artifact render config 的具体值。

### Spawn 行为

默认轻量 instruction 只提供建议性指引。主 agent 仍必须遵守当前 Codex runtime 暴露的 `spawn_agent` 全局工具规则；如果当前规则要求用户明确授权子代理、委派或并行 agent 工作，轻量 instruction 不能把普通“深入分析”请求自动升级成 spawn 授权。

主 agent 在默认 instruction 入口中使用内置 role：

```text
spawn_agent(
  agent_type = "explorer",
  model = "<explorerModel>",
  reasoning_effort = "<modelReasoningEffort>",
  message = "..."
)
```

说明：

- 这是插件配置给出的探索 workflow 默认模型，不是让主 agent 随意选择更小模型。
- 该入口的验收重点是 instruction 正确安装、可关闭、参数按配置渲染；不承诺在没有用户授权子代理的普通会话里一定实际触发 explorer。
- 如果用户明确要求使用其它模型，或当前 Codex runtime 报告配置模型不可用，主 agent 应向用户说明，并按用户最新指示处理。
- 一旦主 agent 已经启动 explorer，就必须等待 explorer 进入最终状态并读取结果，再决定如何整合；不得在未收到结果前关闭 explorer 并自行接手同一探索问题。只有用户明确要求停止、需求变化导致该探索结果不再需要，或 explorer 明确失败时，才允许提前关闭，并应说明原因。
- 不要使用 `agent_type = "codex-explorer"`，除非用户显式触发 `$codex-explore` 手动 skill。

## 入口 B：手动 skill + 专用 agent role

### Scope 策略

当前基线已经支持 Codex project scope 的 repo-managed skill，不再需要通过拒绝 project scope 规避 skill 和 role 可见范围不一致。`codex-explore` 首版同时支持 user scope 和 project scope，并要求 `$codex-explore` skill 与 `codex-explorer` role 始终落在同一个 scope 的受管平面里。

要求：

- `aw install codex-explore --platform codex --scope user` 是支持路径。
- `aw install codex-explore --platform codex --scope project` 是支持路径，只写当前仓库的 repo-managed skill、instruction 和 role artifact，不注册、不启用 user native plugin。
- user scope 下，skill 通过 Codex native plugin/runtime 可见，轻量 instruction 和专用 role 写入用户级 Codex 配置平面。
- project scope 下，skill 写入 `.agents/skills/codex-explore/`，轻量 instruction、专用 role 注册项和 role layer 文件写入当前仓库的 `.codex/` 受管产物；scope 可见性由 repo-managed tracking、repo trust 和 Codex session 加载状态诊断。
- `aw upgrade`、`aw uninstall`、`aw status` 必须按 platform + scope 独立解释本插件；不得把 project config store 的存在误判成 project scope 安装，也不得把 user native plugin 状态当作 project scope 的 installed evidence。

### Skill 默认策略

`codex-explore` skill 默认必须手动触发：

```yaml
# skills/codex-explore/agents/openai.yaml
policy:
  allow_implicit_invocation: false
```

manifest 允许安装时覆盖：

```json
{
  "skillTriggers": {
    "codex-explore": {
      "allowInstallOverride": true
    }
  }
}
```

含义：

- 默认安装后，Codex 不会隐式触发该 skill。
- 用户仍可通过 `$codex-explore ...` 显式触发。
- 用户明确传 `aw install codex-explore --skill-trigger auto` 时，才允许该 skill 自动触发。
- 这条策略只影响 skill，不影响默认轻量 instruction。
- `--skill-trigger auto` 只表示 `$codex-explore` workflow 可被 Codex 的 skill 选择机制自动选中；它不改变 `spawn_agent` 的全局授权规则，也不能把普通代码分析请求自动升级成子代理授权。

### 专用 role 边界

显式 skill 入口使用专用 `roleKey = "codex-explorer"`：

以下以 project scope 为例，user scope 使用对应的用户级 Codex config 和 role 目录：

```toml
# .codex/config.toml，由 AW 写入的最终形态示例
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

专用 role 的边界：

- 不复用或覆盖内置 `explorer`。
- `roleKey` 是受管身份，tracking/status/uninstall/refresh 都按 `roleKey` 处理。
- renderer 只声明 `roleKey`、展示描述和 role file 内容，不声明 `config_file`；`config_file` 与 role layer path 由 AW 生成并写入 tracking。
- 安装前按 Codex 最终 role 名解析规则检查冲突，不能只看 `[agents.codex-explorer]` 字面 table key。
- 如果同层已有非 AW 管理 role 的最终名是 `codex-explorer`，安装必须失败，不能静默覆盖。
- role 文件里的 `name` 必须等于 `roleKey`。
- role layer 中的模型和 effort 来自同一份 artifact render config。

### Skill 内容边界

手动 skill 可以比轻量 instruction 更详细，但仍应保持克制：

- 指导主 agent 使用 `agent_type = "codex-explorer"`。
- 默认 1 个 explorer；复杂时 2 到 3 个；极复杂最多 4 个。
- 每个任务写明 `quick`、`medium` 或 `very thorough`。
- 强调只读、禁止修改、禁止安装依赖、禁止破坏性命令。
- 已经启动 explorer 后，主 agent 必须等待 explorer 结果；不得因为等待一段时间没有结果就关闭 explorer 并自行完成同一探索问题。
- 要求主 agent 整合后调用 `close_agent`。
- 不要把普通实现工作交给 explorer。
- 即使该 skill 因 `--skill-trigger auto` 被自动选中，主 agent 在调用 `spawn_agent` 前仍必须确认本轮用户请求已经满足 Codex runtime 的子代理授权要求；不满足时应先显式询问用户，或退回主 agent 本地探索。

## 预期使用方式

### 默认轻量路径

当 `enableLightweightInstruction = true` 时，如果用户请求已经符合当前 Codex runtime 对子代理/委派/并行 agent 的授权要求，主 agent 可以依据已安装 instruction 判断是否使用内置 `explorer`。当该配置为 `false` 时，默认轻量路径不参与运行时决策，用户通过 `$codex-explore ...` 进入手动 skill 路径。

主 agent 应：

1. 先判断是否真的需要 explorer。
2. 小范围搜索自己完成。
3. 有必要时，把边界清晰、只读、互不重复的问题交给内置 `explorer`。
4. 按插件配置传入 `model` 和 `reasoning_effort`。
5. 等待期间继续做不重叠的本地调查。
6. 等待 explorer 进入最终状态并读取结果；不能在未收到结果前关闭 explorer 并自行接手同一探索问题。
7. 整合 explorer 结果，并用最少必要代码补读验证。
8. 用完后关闭 explorer。

### 手动 skill 路径

用户显式触发：

```text
$codex-explore 充分探索当前需求的实现边界
```

此时主 agent 进入手动 skill workflow，并使用专用 `codex-explorer` role。这个路径与默认轻量路径同时交付；如果专用 role 注册、tracking、status、uninstall 或配置刷新缺失，本需求不能视为完成。

## 推荐验收标准

### 基础设施与 renderer

- manifest 支持 `scripts.artifacts.render`，并能把 renderer 打包进插件运行时产物。
- manifest 支持 `artifacts.targets` 动态 artifact 能力元数据；Codex project installability、discovery、status current catalog view、project write safety preflight 和 ledger capability snapshot 都从这层元数据读取安装前真值，不执行 renderer。
- `codex-explore` 在首次 project install 之前就被识别为包含 `skill`、`instruction`、`agent` 的 Codex project-managed 插件，而不是 `skill-only` 插件。
- renderer 能在 install/upgrade/refresh 写路径收到 artifact render config、platform、scope、event、changed config keys 和既有 tracking 上下文。
- AW 能校验 renderer 输出的 ArtifactPlan，拒绝未知 target、未知 config key、非法 state、非法 roleKey 和任意路径写入。
- AW 能拒绝 renderer 返回 manifest `artifacts.targets` 未声明的 artifact id、target、state、refresh key 或 project config 写入面。
- AW 负责落盘，不要求也不允许 renderer 直接修改 Codex config 或 role 文件。
- 静态 `extensions.*` 旧插件仍按原行为安装，可通过内置 renderer 或等价兼容层实现。
- `pnpm build` 能生成 Codex-only marketplace entry。
- `aw install codex-explore -p codex -s user` 成功。
- 在仓库内执行 user scope install/refresh 时，user scope instruction、role、`configDigest` 和 status 不受当前仓库 project config 影响。
- `aw install codex-explore -p codex -s project` 成功，写入当前仓库 repo-managed skill、instruction 和 role artifact，且不注册或启用 user native plugin。
- `aw install codex-explore -p claude` 被 product policy 拦截。

### 配置刷新

- `aw config set/configure/unset/reset` 修改 `enableLightweightInstruction`、`explorerModel` 或 `modelReasoningEffort` 后，当前可定位的已安装 instruction 和专用 role artifact 会在必要安全预检通过后，按目标 scope 的 artifact render config 自动重渲染或切换启用状态。
- project config 写入不触发 user scope artifact stale/refresh；user config 写入可以影响 user scope 和当前可定位 project scope，但不扫描所有历史 project。
- 未记录在 tracking `refreshKeys` 中的配置写入不会触发重渲染。
- `aw status` 能分别报告 instruction 和 role artifact 缺失、被配置关闭、配置过期、最近一次 refresh 失败。
- `aw status` 不执行 renderer 或 lifecycle 脚本；配置过期、disabled、drift 和 refresh failed 都从 tracking、install snapshot、current catalog 与目标 scope config 只读推导。
- refresh 元数据能区分 artifact kind 和 artifact id，不能用 instruction 的健康状态覆盖 role 的健康状态，反之亦然。
- renderer 或 apply 失败时，config store 写入保留，受影响 artifact 进入可诊断的 refresh failed 状态。
- apply 阶段任一 artifact 失败时，同一 plugin + platform + scope 下本次命中的 artifact 写入会整体回滚，tracking 只记录失败诊断，不写入新的成功 digest。
- 命中 Codex project scope target 的 config-triggered refresh 必须先通过 project write safety preflight。`externalOwnershipPresent`、`codexProjectUserConfigUnreadable`、`projectConfigUnreadable`、`trackingIntegrityError`、`unmanagedRepoArtifactConflict` 等失败场景下，config store 写入保留，但不得改写任何 repo artifact，也不得写入新的成功 digest；`aw status` 能看到对应失败诊断。

### 默认 instruction 入口

- 安装后 Codex managed instruction 中包含轻量探索指令。
- instruction 明确要求使用内置 `explorer`，而不是 `codex-explorer`。
- instruction 中出现的 `model` 和 `reasoning_effort` 是 artifact render config 的具体值。
- 默认配置为 `enableLightweightInstruction = true`、`gpt-5.4-mini + medium`。
- 默认轻量入口是建议性行为；测试不要求在没有用户明确授权子代理的普通会话中实际 spawn explorer。
- `enableLightweightInstruction = false` 时，renderer 返回 disabled instruction artifact；已安装的轻量 instruction block 会被移除或跳过渲染，`aw status` 报告 disabled by config。
- `enableLightweightInstruction` 从 `false` 改回 `true` 时，轻量 instruction 会按当前 artifact render config 重新生成。
- instruction 内容保持轻量，不退化成旧 skill 的完整长流程。
- 主 agent 指令包含关闭 explorer 的要求。
- 主 agent 指令明确要求等待 explorer 结果，禁止未收到结果就关闭 explorer 并自行接手同一探索问题。
- 默认 instruction 入口不要求主 agent 使用 `[agents.codex-explorer]`，也不把 `agent_type` 写成 `codex-explorer`。

### 手动 skill + 专用 role 入口

- `skills/codex-explore/agents/openai.yaml` 默认 `allow_implicit_invocation: false`。
- `skillTriggers.codex-explore.allowInstallOverride = true`。
- `aw install --skill-trigger manual` 后仍可 `$codex-explore` 显式触发。
- `aw install --skill-trigger auto` 后才允许 skill 自动触发。
- `aw install --skill-trigger auto` 不改变 `spawn_agent` 授权边界；auto skill 被命中时，主 agent 仍要按 Codex runtime 规则判断是否能启动 `codex-explorer`。
- 安装后生成 `[agents.codex-explorer]` 注册项和 role layer 文件。
- `enableLightweightInstruction = false` 不影响 `$codex-explore` skill 和专用 role 的安装、刷新、status 或卸载。
- 专用 role 不覆盖 Codex 内置 `explorer`。
- 专用 role 的模型、effort 和提示词来自 renderer 输出的受管 artifact，并按 `roleKey` 做 tracking/status/uninstall/refresh。
- 冲突检测按 Codex 最终 role 名空间执行，不覆盖用户手写同名 role。
- `$codex-explore` skill 要求主 agent 等待 explorer 结果，禁止未收到结果就关闭 explorer 并自行接手同一探索问题。

## 风险与约束

- artifact renderer script 增加了新的失败面。必须复用脚本 timeout、stderr/stdout 摘要、敏感配置脱敏和可诊断错误。
- 轻量 instruction 和 auto skill 都不能改变 Codex 上游 `spawn_agent` 的全局工具规则。如果 runtime 不把当前用户请求视为子代理授权，应退化为显式询问用户或只在 `$codex-explore` 显式触发后使用子代理。
- Codex project scope 的 skill、instruction 和 role 可见性依赖 repo-managed artifacts、repo trust 和 Codex session 加载行为；status 需要把磁盘 artifact 健康和当前会话可见性分开诊断。
- 内置 `explorer` 当前 role layer 为空，子代理本身不会自动获得额外只读 developer instructions；主 agent 必须在每个委派 prompt 里写明只读约束。
- 只读边界首版不是工具级硬隔离。主 agent 应把 explorer 输出当作线索，并用最少必要证据验证关键结论。
- 模型 slug 不是 AW 能静态保证的能力；用户配置当前账号不可用的模型时，失败发生在 Codex spawn 阶段。
- 配置刷新只保证磁盘上的 AW 受管 artifact 更新。关闭 `enableLightweightInstruction` 会移除磁盘上的轻量 instruction，但当前 Codex 会话是否立刻卸载已读入的 instruction，取决于 Codex runtime；如果不热加载，需要提示用户新会话生效或重启 Codex。
- user config 可能影响多个 project 的 project-scope artifact render config，但 AW 不应跨所有历史项目扫描。project config 不影响 user-scope artifact render config。配置写入后只刷新当前命令上下文能定位且确实受该写入层影响的 target。

## 后续实现拆分建议

1. 定义 `ArtifactPlan`、`ManagedArtifactId`、`ArtifactTarget`、renderer context、`scripts.artifacts.render` manifest schema，以及 `artifacts.targets` 动态 capability metadata schema。
2. 扩展 tracking：记录 `id/kind/platform/target/paths/refreshKeys/configDigest/state/disabledReason/lastRefresh`。
3. 扩展 Codex project surface：`getCodexProjectManagedKinds()`、installability、project config backed 判断、discovery/status current catalog view 和 ledger capability snapshot 都合并静态 manifest 能力与动态 `artifacts.targets`。
4. 把现有静态 `extensions.instructions/permissions/hooks/agents` 包成内置 renderer 或等价兼容层，保证旧插件行为不变。
5. 实现 renderer 执行阶段：复用现有脚本运行基础设施，但让 render 只发生在 install/upgrade/refresh 写路径的 artifact 写盘之前。
6. 实现 `codex.developerInstructionsBlock` 和 `codex.agentRole` 两个 target 的 plan 校验、落盘、冲突检测、status 和 uninstall。
7. 在 `aw config set/configure/unset/reset` 后接入 conditional refresh：命中 tracking `refreshKeys` 时先对 Codex project scope target 执行 project write safety preflight，再重新执行 renderer 并刷新当前可定位的 artifact；失败时保留 config 写入并记录 refresh 失败。
8. 实现 `codex-explore` 插件源码：Codex-only manifest、dynamic artifact metadata、config schema、renderer script、手动 skill 文件和默认 `openai.yaml`。
9. 补测试：dynamic artifact metadata 校验、renderer manifest 校验、ArtifactPlan 校验、Codex project installability / capability snapshot / project config backed 判断、instruction present/disabled、Codex role 生成、config refresh、tracking/status/uninstall、skill 默认手动触发、Codex-only product policy。
10. 补 `$codex-explore` skill 对专用 role 的内容级回归测试，避免丢掉 `close_agent`、探索深度和只读约束。
