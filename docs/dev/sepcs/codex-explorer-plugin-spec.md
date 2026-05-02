# Codex 探索插件需求 Spec

## 背景

Codex 已经有内置 `explorer` 子代理角色，但默认 `spawn_agent` 工具说明很保守：只有用户明确要求子代理、委派或并行 agent 工作时才鼓励使用。单纯要求“深入分析”“充分探索”“详细阅读代码”不天然等同于授权 spawn。

本需求同时交付两个入口：

- 默认轻量入口：通过一段很轻的 Codex instruction 指引主 agent 在代码库探索阶段使用内置 `explorer` role。该入口默认开启，但必须能通过插件配置关闭。
- 显式 skill 入口：通过 `$codex-explore ...` 进入更强约束的探索 workflow，并使用专用 `codex-explorer` role。

基础设施主线采用 **artifact renderer script**：插件脚本负责根据 effective config 计算最终 artifact plan，AW CLI 负责校验、写盘、tracking、status、rollback、upgrade 和 uninstall。`enableLightweightInstruction` 只是 renderer 消费的一个插件配置，不是 AW core 内置理解的 instruction 专属开关。

本 spec 只描述需求和边界，不进入具体实现细节。

## 已核对基线事实

### AW 插件模型

- 源码真值是 `plugins/<name>/.agents-plugin/plugin.json`，运行时 `.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json` 由 `pnpm build` 生成。
- Codex 原生插件 manifest 当前只承载 `skills`、`mcpServers`、`apps`。`extensions.instructions`、`extensions.permissions`、`extensions.hooks`、`extensions.agents` 是 AW 安装时生成 Codex repo/user scope 受管产物的来源。
- 当前 Codex adapter 安装 extension 时直接读取静态 `extensions.instructions` 和 `extensions.agents`，再写 `.codex/config.toml` 或 `.codex/agents/*.toml`。中间没有“读取 effective config 后计算 artifact 形态”的阶段。
- 当前 AW 对 Codex instruction 的安装路径已经存在：`extensions.instructions` 会渲染成 `.codex/config.toml` 里的 AW managed `developer_instructions` block。
- 当前 AW 对 Codex agent 的生成只会写 `.codex/agents/<generated>.toml` role 文件，不会同时写 `.codex/config.toml` 的 `[agents.<roleKey>]` 注册项，也没有按 `roleKey` 跟踪注册项和 role 文件这一对产物。
- 当前 AW config 可以通过 `config.schema`、`aw config set/configure/unset/reset` 管理 user/project 两层配置；但配置写入只更新 config store 并返回 effective config，不会自动刷新已安装 artifact。
- lifecycle 脚本已经能拿到 effective config 和本次写出的 artifacts，但执行时机是在 artifact 写完之后、tracking/ledger 提交之前。如果让 lifecycle 脚本直接改 `.codex/config.toml` 或 role 文件，会绕过 AW 的受管 artifact 模型。
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

新增 install-time artifact rendering contract。插件可以在 manifest 中声明 `scripts.artifacts.render`，renderer 读取 `AW_PLUGIN_CONTEXT`，基于 platform、scope、effective config、安装事件和既有 tracking 输出 artifact plan。AW 只接受受支持 target 的 plan，不允许脚本任意声明落盘路径。

首批支持两个 Codex target：

- `codex.developerInstructionsBlock`：写入、更新、移除 `.codex/config.toml` 中该插件的 AW managed `developer_instructions` block。
- `codex.agentRole`：同时管理 `[agents.<roleKey>]` 注册项和 role layer 文件。

静态 `extensions.instructions`、`extensions.permissions`、`extensions.hooks`、`extensions.agents` 需要保留兼容。它们可以先被包成 AW 内置 renderer，保证旧插件行为不变；动态 artifact 走插件自定义 renderer。

### 基础设施：配置驱动 artifact refresh

`aw config set/configure/unset/reset` 写入成功后，AW 根据 tracking 中记录的 artifact `refreshKeys` 判断本次变更是否影响当前可定位的已安装 artifact。命中时，AW 重新执行 renderer，应用新的 artifact plan，并记录刷新结果。

刷新能力必须走 artifact plan 和 AW 受管落盘链路，不能通过 lifecycle 脚本直接修改 `.codex/config.toml`、`.codex/agents/*.toml` 或其它受管文件。

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
- 动态 artifact 采用 `scripts.artifacts.render` 返回 artifact plan。
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
- 新增 artifact renderer script contract，让插件能根据 effective config 计算最终受管 artifact plan。
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
- 不为 `enableLightweightInstruction` 发明 instruction 专属 manifest 字段、adapter 特例或 `extensions.instructions[].when` 开关。
- 不让 renderer 或 lifecycle 脚本直接写 `.codex/config.toml`、`.codex/agents/*.toml` 或其它 AW 受管 artifact。
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
- `scripts.artifacts.render`：根据 effective config 返回 instruction 和 Codex role artifact plan。
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
  }
}
```

本插件的动态 instruction 和专用 role 不应再通过静态 `extensions.instructions` / `extensions.agents` 表达。静态 extensions 继续作为旧插件和简单静态产物的兼容入口。

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
- renderer 渲染受管 artifact 时读取 effective config。
- user scope artifact 使用 schema default + user config。
- project scope artifact 使用 schema default + user config + 当前 project config。
- `aw config set/configure/unset/reset` 修改命中 tracking `refreshKeys` 的 key 后，应重渲染当前命令上下文能定位的已安装 artifact。
- `enableLightweightInstruction = false` 时，renderer 应返回轻量 instruction artifact 的 `state = "disabled"`；安装和刷新都不应保留轻量 instruction 正文。
- 未安装插件时，配置只保存；后续 install/upgrade 时按最新 effective config 渲染。

## Artifact renderer contract

### Renderer context

renderer 通过 `AW_PLUGIN_CONTEXT` 读取上下文。最终字段名可以在实现时微调，但 contract 必须包含：

```json
{
  "event": "install | upgrade | refresh | status",
  "platform": "codex",
  "scope": "user | project",
  "plugin": {
    "name": "codex-explore",
    "version": "0.1.0",
    "rootDir": "..."
  },
  "config": {
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
- renderer 可以读取插件包内模板文件，但不能直接修改 Codex 配置或 AW tracking。
- renderer 复用现有脚本打包、依赖闭包、timeout、敏感配置脱敏和跨平台 runner 基础设施，但它是独立于 lifecycle 的 artifact render 阶段。
- `refresh` 事件应带上本次变更的 config key；`install` / `upgrade` 没有 changed keys 时仍必须按完整 effective config 输出 plan。

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
          "description": "Read-only codebase exploration role for Codex Explore.",
          "config_file": "./agents/aw-codex-explore-codex-explorer.toml"
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
- AW 负责按 target 生成实际路径；renderer 不直接决定任意文件路径。
- AW 应计算并记录 config digest。digest 至少覆盖该 artifact 的 `refreshKeys` 对应 effective config 值，并应纳入 renderer/manifest 版本信息，避免脚本更新后 status 误判为健康。

### Target：`codex.developerInstructionsBlock`

`present` 行为：

- `content` 必须是字符串。
- AW 把 `content` 写入 `.codex/config.toml` 中该插件受管的 `developer_instructions` block。
- 同一插件如果返回多个 present instruction artifact，AW 需要稳定合成它们，避免刷新顺序改变导致无意义 churn。

`disabled` 行为：

- AW 移除该 artifact 对应的受管 instruction 内容，或在生成阶段跳过该内容。
- 不允许保留一段“已禁用”的运行时提示词，因为它仍可能影响主 agent 行为。
- `aw status` 应报告 disabled by config，不能误报为 missing。

### Target：`codex.agentRole`

`present` 行为：

- artifact 必须声明 `roleKey`。
- `content.registration` 描述 `.codex/config.toml` 中 `[agents.<roleKey>]` 注册项，至少包含 `description` 和 `config_file`。
- `content.roleFile` 描述 role layer 文件，至少包含 `name`、`description`、`developer_instructions`，并允许 Codex-only 字段 `model`、`model_reasoning_effort`。
- role 文件里的 `name` 必须等于 `roleKey`。
- AW 负责把注册项和 role 文件作为同一个逻辑 artifact 跟踪、刷新、卸载和诊断。
- 安装前必须按 Codex 最终 role 名空间做冲突检测，不能只看 `[agents.<roleKey>]` 字面 table key。

`disabled` 行为首版不是 `codex-explore` 的主路径，但 target contract 应预留：禁用 role 时，AW 清理受管注册项和受管 role 文件，并把状态写进 tracking。

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

status 要能分别报告 instruction 和 role artifact：

- artifact 缺失。
- artifact 因配置关闭。
- artifact 使用过期 config digest。
- renderer 或 apply 最近一次 refresh 失败。
- role 注册项存在但 `config_file` 不再指向 AW 管理文件。
- role layer 文件缺失或最终 role 名冲突。

uninstall 必须只清理 AW tracking 中记录的受管 artifact。被配置关闭的 artifact 也应参与卸载收尾，确保旧 block 或旧 role 文件不会残留。

## 基础设施：Config-triggered artifact refresh

刷新规则：

- refresh keys：`enableLightweightInstruction`、`explorerModel`、`modelReasoningEffort`。
- `enableLightweightInstruction` 只影响 Codex managed instruction artifact 的状态。
- `explorerModel` 和 `modelReasoningEffort` 同时影响 Codex managed instruction artifact，以及专用 `codex-explorer` role 的 role layer 文件。
- refresh target：当前可定位安装目标中的 Codex managed instruction block，以及专用 `codex-explorer` role 的注册项和 role layer 文件。
- refresh 行为：重新解析 effective config，重新执行 renderer，校验并应用 artifact plan，更新 AW tracking 元数据。

`aw config set/configure/unset/reset` 写入成功后：

1. AW 读取当前命令上下文能定位的已安装插件 tracking。
2. 如果变更 key 命中任一 artifact 的 `refreshKeys`，或 `reset` 可能影响这些 key，则触发 renderer。
3. AW 用新的 plan 更新受影响 artifact。对于 `state = "disabled"` 的 instruction，移除受管 block；对于 `state = "present"` 的 instruction，写入新内容。
4. 刷新成功后更新 `configDigest`、`state` 和 `lastRefresh`。
5. renderer 或 apply 失败时，保留已经写入的 config store，把受影响 artifact 标成 `refreshFailed` 或等价诊断状态，让 `aw status` 能提示用户修复。

该能力只对 tracking 中明确记录了 `refreshKeys` 的 artifact 生效。没有动态 artifact 或没有 refresh key 的插件配置仍保持现有行为：配置写入只更新 config store，不触发重渲染。

refresh 只覆盖当前命令上下文能定位的 target。user config 可能影响多个 project，但 AW 不应跨所有历史项目扫描。

## 入口 A：默认轻量 instruction

### 开关行为

`enableLightweightInstruction` 控制 renderer 对轻量 instruction artifact 返回 `present` 还是 `disabled`：

- `true`：安装或刷新时返回 `state = "present"`，并把 `explorerModel` 和 `modelReasoningEffort` 渲染成具体值。
- `false`：安装或刷新时返回 `state = "disabled", disabledReason = "config"`；AW 移除该插件写入的轻量 instruction block，或在生成阶段跳过该 block。
- 从 `false` 改回 `true` 后，应按当前 effective config 重新写入轻量 instruction。
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

explorer 运行时，继续做不重叠的本地调查。整合结果时只保留关键结论、文件路径、必要行号和不确定点；必要时补读少量代码验证。读取并整合结果后，立即关闭本次启动的 explorer。
```

渲染时必须把 `<explorerModel>` 和 `<modelReasoningEffort>` 替换成 effective config 的具体值。

### Spawn 行为

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
- 如果用户明确要求使用其它模型，或当前 Codex runtime 报告配置模型不可用，主 agent 应向用户说明，并按用户最新指示处理。
- 不要使用 `agent_type = "codex-explorer"`，除非用户显式触发 `$codex-explore` 手动 skill。

## 入口 B：手动 skill + 专用 agent role

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

### 专用 role 边界

显式 skill 入口使用专用 `roleKey = "codex-explorer"`：

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

专用 role 的边界：

- 不复用或覆盖内置 `explorer`。
- `roleKey` 是受管身份，tracking/status/uninstall/refresh 都按 `roleKey` 处理。
- 安装前按 Codex 最终 role 名解析规则检查冲突，不能只看 `[agents.codex-explorer]` 字面 table key。
- 如果同层已有非 AW 管理 role 的最终名是 `codex-explorer`，安装必须失败，不能静默覆盖。
- role 文件里的 `name` 必须等于 `roleKey`。
- role layer 中的模型和 effort 来自同一份 AW config。

### Skill 内容边界

手动 skill 可以比轻量 instruction 更详细，但仍应保持克制：

- 指导主 agent 使用 `agent_type = "codex-explorer"`。
- 默认 1 个 explorer；复杂时 2 到 3 个；极复杂最多 4 个。
- 每个任务写明 `quick`、`medium` 或 `very thorough`。
- 强调只读、禁止修改、禁止安装依赖、禁止破坏性命令。
- 要求主 agent 整合后调用 `close_agent`。
- 不要把普通实现工作交给 explorer。

## 预期使用方式

### 默认轻量路径

当 `enableLightweightInstruction = true` 时，用户只要提出需要探索代码库、梳理架构、分析实现边界或评估跨模块影响面，主 agent 可以依据已安装 instruction 判断是否使用内置 `explorer`。当该配置为 `false` 时，默认轻量路径不参与运行时决策，用户通过 `$codex-explore ...` 进入手动 skill 路径。

主 agent 应：

1. 先判断是否真的需要 explorer。
2. 小范围搜索自己完成。
3. 有必要时，把边界清晰、只读、互不重复的问题交给内置 `explorer`。
4. 按插件配置传入 `model` 和 `reasoning_effort`。
5. 等待期间继续做不重叠的本地调查。
6. 整合 explorer 结果，并用最少必要代码补读验证。
7. 用完后关闭 explorer。

### 手动 skill 路径

用户显式触发：

```text
$codex-explore 充分探索当前需求的实现边界
```

此时主 agent 进入手动 skill workflow，并使用专用 `codex-explorer` role。这个路径与默认轻量路径同时交付；如果专用 role 注册、tracking、status、uninstall 或配置刷新缺失，本需求不能视为完成。

## 推荐验收标准

### 基础设施与 renderer

- manifest 支持 `scripts.artifacts.render`，并能把 renderer 打包进插件运行时产物。
- renderer 能收到 effective config、platform、scope、event、changed config keys 和既有 tracking 上下文。
- AW 能校验 renderer 输出的 ArtifactPlan，拒绝未知 target、未知 config key、非法 state、非法 roleKey 和任意路径写入。
- AW 负责落盘，不要求也不允许 renderer 直接修改 `.codex/config.toml` 或 `.codex/agents/*.toml`。
- 静态 `extensions.*` 旧插件仍按原行为安装，可通过内置 renderer 或等价兼容层实现。
- `pnpm build` 能生成 Codex-only marketplace entry。
- `aw install codex-explore -p codex` 成功，`aw install codex-explore -p claude` 被 product policy 拦截。

### 配置刷新

- `aw config set/configure/unset/reset` 修改 `enableLightweightInstruction`、`explorerModel` 或 `modelReasoningEffort` 后，当前可定位的已安装 instruction 和专用 role artifact 会按 renderer plan 自动重渲染或切换启用状态。
- 未记录在 tracking `refreshKeys` 中的配置写入不会触发重渲染。
- `aw status` 能分别报告 instruction 和 role artifact 缺失、被配置关闭、配置过期、最近一次 refresh 失败。
- refresh 元数据能区分 artifact kind 和 artifact id，不能用 instruction 的健康状态覆盖 role 的健康状态，反之亦然。
- renderer 或 apply 失败时，config store 写入保留，受影响 artifact 进入可诊断的 refresh failed 状态。

### 默认 instruction 入口

- 安装后 Codex managed instruction 中包含轻量探索指令。
- instruction 明确要求使用内置 `explorer`，而不是 `codex-explorer`。
- instruction 中出现的 `model` 和 `reasoning_effort` 是 effective config 的具体值。
- 默认配置为 `enableLightweightInstruction = true`、`gpt-5.4-mini + medium`。
- `enableLightweightInstruction = false` 时，renderer 返回 disabled instruction artifact；已安装的轻量 instruction block 会被移除或跳过渲染，`aw status` 报告 disabled by config。
- `enableLightweightInstruction` 从 `false` 改回 `true` 时，轻量 instruction 会按当前 effective config 重新生成。
- instruction 内容保持轻量，不退化成旧 skill 的完整长流程。
- 主 agent 指令包含关闭 explorer 的要求。
- 默认 instruction 入口不要求主 agent 使用 `[agents.codex-explorer]`，也不把 `agent_type` 写成 `codex-explorer`。

### 手动 skill + 专用 role 入口

- `skills/codex-explore/agents/openai.yaml` 默认 `allow_implicit_invocation: false`。
- `skillTriggers.codex-explore.allowInstallOverride = true`。
- `aw install --skill-trigger manual` 后仍可 `$codex-explore` 显式触发。
- `aw install --skill-trigger auto` 后才允许 skill 自动触发。
- 安装后生成 `[agents.codex-explorer]` 注册项和 role layer 文件。
- `enableLightweightInstruction = false` 不影响 `$codex-explore` skill 和专用 role 的安装、刷新、status 或卸载。
- 专用 role 不覆盖 Codex 内置 `explorer`。
- 专用 role 的模型、effort 和提示词来自 renderer 输出的受管 artifact，并按 `roleKey` 做 tracking/status/uninstall/refresh。
- 冲突检测按 Codex 最终 role 名空间执行，不覆盖用户手写同名 role。

## 风险与约束

- artifact renderer script 增加了新的失败面。必须复用脚本 timeout、stderr/stdout 摘要、敏感配置脱敏和可诊断错误。
- 轻量 instruction 仍不能改变 Codex 上游 `spawn_agent` 的全局工具规则。如果未来 runtime 更严格，应退化为显式询问用户或只在 `$codex-explore` 手动触发后使用子代理。
- 内置 `explorer` 当前 role layer 为空，子代理本身不会自动获得额外只读 developer instructions；主 agent 必须在每个委派 prompt 里写明只读约束。
- 只读边界首版不是工具级硬隔离。主 agent 应把 explorer 输出当作线索，并用最少必要证据验证关键结论。
- 模型 slug 不是 AW 能静态保证的能力；用户配置当前账号不可用的模型时，失败发生在 Codex spawn 阶段。
- 配置刷新只保证磁盘上的 AW 受管 artifact 更新。关闭 `enableLightweightInstruction` 会移除磁盘上的轻量 instruction，但当前 Codex 会话是否立刻卸载已读入的 instruction，取决于 Codex runtime；如果不热加载，需要提示用户新会话生效或重启 Codex。
- user config 可能影响多个 project 的 effective config，但 AW 不应跨所有历史项目扫描。配置写入后只刷新当前命令上下文能定位的 target。

## 后续实现拆分建议

1. 定义 `ArtifactPlan`、`ManagedArtifactId`、`ArtifactTarget`、renderer context 和 `scripts.artifacts.render` manifest schema。
2. 扩展 tracking：记录 `id/kind/platform/target/paths/refreshKeys/configDigest/state/disabledReason/lastRefresh`。
3. 把现有静态 `extensions.instructions/permissions/hooks/agents` 包成内置 renderer 或等价兼容层，保证旧插件行为不变。
4. 实现 renderer 执行阶段：复用现有脚本运行基础设施，但让 render 发生在 artifact 写盘之前。
5. 实现 `codex.developerInstructionsBlock` 和 `codex.agentRole` 两个 target 的 plan 校验、落盘、冲突检测、status 和 uninstall。
6. 在 `aw config set/configure/unset/reset` 后接入 conditional refresh：命中 tracking `refreshKeys` 时重新执行 renderer，刷新当前可定位的 artifact；失败时保留 config 写入并记录 refresh 失败。
7. 实现 `codex-explore` 插件源码：Codex-only manifest、config schema、renderer script、手动 skill 文件和默认 `openai.yaml`。
8. 补测试：renderer manifest 校验、ArtifactPlan 校验、instruction present/disabled、Codex role 生成、config refresh、tracking/status/uninstall、skill 默认手动触发、Codex-only product policy。
9. 补 `$codex-explore` skill 对专用 role 的内容级回归测试，避免丢掉 `close_agent`、探索深度和只读约束。
