# Codex 探索插件需求 Spec

## 背景

Codex 已经有子代理能力和 agent role 文件，但默认工具说明对 `spawn_agent` 很保守：只有用户明确要求子代理、委派或并行 agent 工作时才鼓励使用。单纯要求“深入分析”“充分探索”“详细阅读代码”并不天然等同于授权 spawn。因此，一个插件如果想提升探索效率，需要同时解决两件事：

1. 给主 agent 一个明确、可触发的探索工作流，让它知道什么时候可以把代码库问题拆给 explorer。
2. 给 explorer agent 一个可配置、面向只读探索的专用 role，使它能用合适的模型、推理强度和提示词读取代码，并把关键结论压缩反馈给主 agent。

首版采用“默认自动触发，安装时可覆盖为手动触发”的策略。用户选择安装自动触发版时，视为在插件层授权该 skill 在匹配的代码探索场景中使用 explorer 子代理；如果自动触发效果不好，可以改成手动触发安装，再通过 `$codex-explore` 明确进入探索工作流。

本 spec 只描述需求和边界，不进入实现。

## 当前实现边界

### AW 插件模型

- 源码真值是 `plugins/<name>/.agents-plugin/plugin.json`，运行时 `.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json` 由 `pnpm build` 生成。
- Codex 原生插件 manifest 当前只承载 `skills`、`mcpServers`、`apps`。`extensions.agents` 不是 Codex 原生插件 manifest 字段，而是 AW 安装时生成 Codex config layer 产物。
- `marketplace.policy.products` 可以把插件限制到 `["CODEX"]`，安装时会拦截 Claude。
- Codex native plugin enabled 仍是 user scope；project scope 只写当前 repo 的 `.codex/` 受管产物。

### Codex agent role contract

- 当前 AW 的 `extensions.agents` 只会生成 role layer 文件：

```toml
name = "..."
description = "..."
developer_instructions = """..."""
```

- 上游 Codex 支持两类自定义 role 加载方式：在 config layer 的 `agents/` 目录发现 role 文件，或在 `config.toml` 里声明 `[agents.<roleKey>] config_file = "./agents/<file>.toml"`。显式声明能给 AW 一个稳定的注册点，也方便 status、遮蔽判断、卸载和配置刷新统一按 `roleKey` 处理。
- 本需求必须先补齐 AW 的 Codex custom role 基础 contract。Codex agent 受管产物不能只是一份 `.codex/agents/*.toml`，而应由同一个逻辑 role 关联：
  - `.codex/config.toml` 中 AW 管理的 `[agents.<roleKey>]` 注册项，至少包含 `description` 和 `config_file`。
  - `.codex/agents/<generated-file>.toml` 中的 role layer 内容。
  - tracking/status/uninstall 使用的稳定 `roleKey`，不能只用文件 basename 或展示名推断身份。
- role layer 文件实际按 `ConfigToml` 解析，除 `name`、`description`、`nickname_candidates` 之外，还可以带 `model`、`model_reasoning_effort`、`model_reasoning_summary`、`model_verbosity` 等配置。
- 这意味着 Codex 本身可以表达“explorer 默认用某个模型和推理强度”，但 AW 现有 `AgentDefinition` 类型没有字段把这些配置写进 role layer，也没有把 `[agents.<roleKey>]` 注册项纳入受管 artifact contract。
- 本插件需要扩展 `AgentDefinition` / generator / adapter，让 Codex role artifact 能注册 `roleKey`，写入模型、推理强度和由配置合成后的 `developer_instructions`。
- role 文件中的 `name` 如果存在，必须等于 `roleKey`；也可以由生成器省略 `name`，让上游使用 `[agents.<roleKey>]` 作为 role 名。不能允许 role 文件把注册 key 悄悄改成另一个名字。
- Codex 当前内建了 `explorer` role，但它的 role layer 不承载插件需要的模型、reasoning 和自定义提示词配置。上游 `spawn_agent` 可用 role 列表会包含用户自定义 role，因此首版不需要复用或覆盖内建 `explorer`，而是注册专用 `roleKey = "codex-explorer"`，让 skill 显式调用 `spawn_agent(agent_type="codex-explorer")`。这样可以保留内建 `explorer` 的全局语义，并避免 user scope 安装后影响所有 Codex 子代理场景。
- 当前不假设 Codex role 文件能表达工具 allowlist / denylist。首版的“只读”主要靠 role 提示词、skill 工作流和主 agent 派发约束实现；如果上游 Codex 后续支持 role 级工具限制，再把该能力纳入受管 artifact contract。

### Codex 子代理生命周期

- Codex `wait_agent` 只等待子代理进入最终状态，不会自动关闭该子代理，也不会释放 live agent slot。
- `close_agent` 会把目标子代理标记为 closed，并关闭它及其 live descendants。首版 skill 必须要求主 agent 在读取 explorer 结果并完成必要整合后立刻调用 `close_agent`。
- explorer 子代理只服务一次性只读探索，没有必要在会话里长期保留。除非 `close_agent` 已经返回目标不存在，或者 Codex runtime 明确报告该 agent 已关闭，否则主 agent 都应把关闭 explorer 视为工作流的一部分。

### AW config 能力

- 插件可以声明 `config.schema`，通过 `aw config` 管理 user/project 两层配置。
- 当前 config 值会进入 lifecycle context 和 helper，但不会自动驱动 `extensions.agents` 生成内容。
- `aw config set` 只写 AW config store；当前没有“写配置后自动重渲染已安装 role artifact”的能力。
- 如果要让“模型和提示词可配置”影响 role 文件，需要扩展 AW config 到 Codex role artifact 的受管路径。不能用 lifecycle 脚本绕开主链路，否则 tracking、status、uninstall、upgrade 和回滚都会留下缺口。
- 自动刷新不能绑定到所有 `aw config` 写入。很多插件配置只给 lifecycle 或运行时脚本动态读取，不需要刷新 artifact。刷新应由插件 manifest 明确声明，只覆盖配置值会进入受管 artifact 的场景。
- 首版保留 config-driven artifact refresh，因此必须同步定义刷新状态真值：上次成功渲染使用的 effective config digest、最近一次刷新结果、刷新时间、作用 target，以及当前命令上下文以外是否仍可能存在过期安装目标。

## 参考实现启发

参考 Claude Code 内置 `Explore` agent 后，首版设计做三点收敛：

- explorer 角色保持轻量。默认提示词只强调只读、快速搜索、清晰回报，不把实现计划、权限扩展或复杂协作塞进 explorer。
- 主 agent 必须知道“何时不用 explorer”。已知具体文件、单个符号、少量文件内搜索时，本地读取更直接；explorer 只服务边界不清、跨模块或可并行的探索问题。
- 并行数量默认保守。通常 1 个 explorer 足够；多 agent 只用于互不重叠的问题，并且每个任务都要带范围和探索深度。

## 目标

新增一个 Codex 独享插件，暂定功能目标如下：

- 提供一个探索 skill，指导主 agent 在代码库探索阶段拆分问题、并行派发 explorer、只读取 explorer 汇总出的关键细节。
- 提供一个专用 Codex explorer agent role，让主 agent 可以通过稳定 `roleKey = "codex-explorer"` 调用 `spawn_agent(agent_type=...)` 使用专门的探索提示词。
- skill 默认允许隐式触发，并支持安装时覆盖为手动触发。
- 支持在委派 prompt 里声明探索深度：`quick`、`medium` 或 `very thorough`，让 explorer 按任务成本和覆盖范围调节搜索。
- 支持配置 explorer 默认模型和 reasoning effort，首版默认 `gpt-5.4-mini + medium`。
- 支持配置 explorer 提示词，允许用户追加项目偏好，也允许高级用户替换工作流正文；不可覆写的只读安全前导必须始终保留。
- 对声明会影响受管 artifact 的配置，`aw config set/configure/unset/reset` 写入成功后自动刷新当前可定位的已安装 artifact，不新增额外 apply/sync 命令。
- `aw status` 能基于同一份刷新元数据判断受管 role 是否缺失、被遮蔽、配置过期或最近一次刷新失败。
- 插件只面向 Codex，不向 Claude Code 安装任何能力。

## 非目标

- 不改变 Codex 上游 `spawn_agent` 工具的授权规则。
- 不新增 `aw config apply` / `sync` 等配置刷新命令。
- 不让所有插件的配置写入都触发 artifact 刷新；只有 manifest 明确声明 config 会影响 generated artifacts 时才刷新。
- 不要求纯脚本动态读取的配置进入刷新链路。
- 不让插件自动改写用户现有手写 `.codex/agents/*.toml`，也不接管已有非 AW 管理的 `[agents.<roleKey>]` 注册项。
- 不复用或覆盖 Codex 内建 `explorer` role；首版不改变 Codex 全局 `explorer` 语义。
- 不支持通过 `spawn_agent(..., model=..., reasoning_effort=...)` 对本插件 explorer 做单次模型覆盖；模型和 reasoning 以 role artifact 为准。
- 不允许 `promptOverride` 完全替换只读安全前导；override 只替换工作流正文。
- 不让 explorer 直接修改代码；首版定位为只读探索和汇总。
- 不在首版扩展 role 级工具权限、MCP、hook 或 permission mode。模型、reasoning 和提示词配置先走最小闭环，避免把探索插件变成权限扩展面。
- 不引入 MCP server，除非后续确认需要结构化代码索引能力。
- 不把大段源码搬回主 agent；explorer 输出应以结论、文件路径、必要行号和少量摘录为主。

## 预期使用方式

首版默认启用自动触发：当用户要求探索代码库、分析实现边界、梳理架构、定位跨模块影响面时，skill 可以自动进入探索工作流。安装时必须允许用户把触发策略覆盖为手动模式；手动模式下，通过显式 `$codex-explore` 触发：

```text
$codex-explore 充分探索当前需求的实现边界
```

skill 触发后，主 agent 应：

1. 先判断是否真的需要 explorer；已知单个文件、单个符号或 2 到 3 个文件内的小搜索，优先本地完成。
2. 有必要时拆出互不重复的探索问题，默认 1 个 explorer；范围不清或跨模块时用 2 到 3 个，极复杂场景最多 4 个。
3. 对不阻塞当前下一步的问题，使用专用 `codex-explorer` role 并行启动子代理。
4. 给每个 explorer 明确范围、探索深度、输出格式和禁止写文件要求。
5. 主 agent 在等待期间继续做本地不重叠探索。
6. 汇总 explorer 返回的关键结论，只在必要时补读少量文件验证。
7. 用完 explorer 后立刻调用 `close_agent` 关闭对应子代理，避免一次性探索 agent 长期占用 live slot。

自动触发安装被视为用户在插件层授权该 workflow 在匹配场景中使用 explorer 子代理。这个授权只覆盖探索 workflow 本身，不改变 Codex 上游 `spawn_agent` 工具的全局规则；如果未来上游规则更严格，skill 应退化为显式触发或先询问用户。

## 建议插件形态

### 插件 manifest

建议结构：

```text
plugins/<plugin-name>/
├── .agents-plugin/plugin.json
└── skills/<skill-name>/
    ├── SKILL.md
    └── agents/openai.yaml
```

manifest 应声明：

- `marketplace.policy.products = ["CODEX"]`
- `skills = "./skills"`
- `skillTriggers.<skill>.allowInstallOverride = true`，让用户可以在自动触发和手动触发之间切换
- 扩展 `extensions.agents`，让 Codex role artifact 能声明稳定 `roleKey`，并写入 `model`、`model_reasoning_effort` 等 Codex-only 字段
- `config.schema`，让终端用户可以通过 `aw config` 配置模型、reasoning effort、`promptAppend` 和 `promptOverride`
- config effect 声明，标记这些配置 key 会影响 Codex agent artifact，配置写入后需要自动刷新当前可定位的已安装 role 注册项和 role 文件

### Codex role 受管产物

`codex-explore` 的 explorer role 使用专用 `roleKey = "codex-explorer"`。Codex 已经内建 `explorer` role，但首版不覆盖它：内建 role 可以继续服务 Codex 的通用探索语义，本插件的可配置模型、reasoning 和提示词全部落在专用 role 上。skill 默认委派示例和主路径都使用 `spawn_agent(agent_type="codex-explorer")`。

安装到 Codex scope 后，AW 应生成并跟踪同一个逻辑 role 的两类产物：

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
- role 文件里的 `name` 必须等于 `roleKey`；如果生成器选择省略 `name`，上游会使用 `[agents.<roleKey>]` 作为 role 名。
- role 文件里的 `description` 如果存在，必须和注册项里的 description 保持一致，避免上游用文件 metadata 覆盖注册 metadata 后让 status 难以解释。
- tracking 中的 agent artifact 必须记录 `roleKey`、注册项所在 config path 和 role layer path。status、遮蔽判断、uninstall、upgrade、refresh 都按 `roleKey` 处理，不按文件 basename 处理。
- 如果目标 scope 已经存在非 AW 管理的 `[agents.codex-explorer]` 注册项，安装不能静默覆盖；应报错并提示用户先移除或改名。用户手写的其它 role 文件不受影响。
- `aw uninstall` 必须同时清理 AW 管理的 `[agents.codex-explorer]` 注册项和 role layer 文件；如果发现注册项已被用户改成指向其它文件，不应删除对方文件。
- 首版不把 `roleKey` 设为 `explorer`，也不接管 Codex 内建 `explorer`。如果未来要提供“替换内建 explorer”的能力，应作为明确 opt-in 的安装变体单独设计，并在安装提示、status 和文档中说明全局副作用。

### Skill 默认策略

首版默认 `allow_implicit_invocation: true`，匹配代码库探索、架构梳理、实现边界分析、跨模块影响面评估等场景时自动触发。自动触发版的安装行为视为用户对该探索 workflow 的授权信号，允许 skill 在匹配场景中调度 explorer 子代理。

`allowInstallOverride` 必须开启。用户如果觉得自动触发过强，可以用手动模式安装，之后只有 `$codex-explore ...` 会触发该 workflow。

自动模式仍要保持克制：主 agent 只把边界清晰、互不重复、不会阻塞自己下一步工作的探索问题派给 explorer；不能把普通实现任务或需要立即决策的问题都外包给子代理。默认只启动 1 个 explorer；只有当范围不清、涉及多个模块或需要比较既有模式时，才并行启动多个 explorer。

### Explorer 输出约束

explorer role 的默认提示词应要求：

- 只读探索，不写文件，不运行破坏性命令。
- 按主 agent 指定的探索深度调整范围：`quick` 用于快速定位，`medium` 用于常规相关代码梳理，`very thorough` 用于跨模块或命名不确定的综合搜索。
- 优先用 `rg`、`rg --files`、`sed`、`git show` 等轻量读取。
- 回答具体问题，不泛泛总结整个仓库。
- 输出必须包含：
  - 结论摘要
  - 关键文件路径和必要行号
  - 不确定点
  - 建议主 agent 下一步要读或验证的最少内容
- 避免粘贴长代码，必要摘录保持很短。

### Explorer developer_instructions 合成规则

最终写入 role layer 的 `developer_instructions` 必须由三段合成：

1. 不可覆写的只读安全前导，由插件源码固定提供，要求 explorer 只读、不写文件、不运行破坏性命令，并压住输出格式和摘录长度。
2. 工作流正文。默认使用插件内置 explorer prompt；如果配置了 `promptOverride`，只替换这一段。
3. `promptAppend`，追加团队或项目偏好。

如果 `promptOverride` 或 `promptAppend` 试图放宽只读边界，以安全前导为准。AW 不需要理解自然语言语义，但生成器必须保证安全前导始终排在最前面，且不会被配置清空。

安全前导至少要表达这些不可配置约束：只读探索；禁止创建、编辑、移动、删除、格式化或回退文件；禁止运行破坏性命令或安装依赖；输出必须围绕主 agent 的具体问题，并使用结论、证据、不确定点和下一步建议的结构。

### Explorer 默认 role 提示词草案

下面内容作为 explorer role 的默认工作流正文。实现时可直接放入插件源码里的 agent prompt；`promptAppend` 追加在末尾，`promptOverride` 配置存在时只替换工作流正文，不替换只读安全前导。

```text
你是 Codex Explore agent。你的任务是为主 agent 回答一个边界清晰的代码库探索问题。

你只能做只读探索。不要创建、编辑、移动、删除、格式化或回退文件。不要运行破坏性命令。不要安装依赖。优先使用轻量读取命令，例如 `rg`、`rg --files`、`sed`、`git show`、`git diff`、`ls`，以及读取 package metadata。

严格待在主 agent 给定的范围内。除非任务明确要求，不要泛泛总结整个仓库。如果问题过大，请收窄到最小有用答案，并说明你没有覆盖哪些范围。

主 agent 可能会给出探索深度：

- `quick`：快速定位最可能相关的文件、符号或调用点，避免展开无关路径。
- `medium`：常规深度，覆盖相关模块、关键调用链和最可能的测试或 fixture。
- `very thorough`：更全面地搜索多种命名、相邻模块、历史相似实现和测试覆盖，但仍不要做无边界的全仓库总结。

如果主 agent 没有指定探索深度，默认按 `medium` 处理。

工作方式：

1. 先判断哪些文件、模块、命令或测试最可能回答这个问题。
2. 只读取足以支撑结论的最少代码。
3. 优先依据仓库现有架构、命名和本地约定，不要给泛泛的通用建议。
4. 把未提交的用户改动视为有意为之。除非主 agent 明确要求，不要建议回退这些改动。
5. 提到代码时，使用文件路径和必要行号。摘录必须很短。

最终回复必须使用这个结构：

**结论**
直接回答这个具体问题。

**证据**
列出关键文件和行号，并给出最小必要解释。

**不确定点**
说明你无法验证的内容，或可能影响结论的假设。

**建议主 agent 下一步查看**
列出主 agent 接下来最值得阅读的最少文件、测试或命令。

除非主 agent 明确要求，不要输出宽泛实现计划。不要返回大段代码摘录。
```

默认 role 提示词使用中文。若用户或主 agent 明确要求英文输出，可通过 `promptAppend` 或 `promptOverride` 调整工作流正文；只读安全前导仍必须存在。

### Skill 内容草案

下面内容作为 `skills/codex-explore/SKILL.md` 的主体参考。frontmatter 和 Codex `agents/openai.yaml` 仍按插件作者工具的规范生成；这里重点确认模型实际读取到的 workflow 指令。

````markdown
# Codex Explore

当用户要求探索代码库、分析架构、梳理实现边界、评估跨模块影响面，或要求你在改代码前“深入看一下”时，使用这个 skill。

当这个 skill 生效时，已安装插件代表用户授权该探索 workflow 在匹配的代码库探索场景里使用 explorer 子代理。这个授权只覆盖探索工作，不改变其它任务的全局子代理规则。

## 何时使用 explorer

只把边界清晰、只读、能和你自己的下一步并行推进的问题交给 explorer。适合交给 explorer 的任务包括：

- 找出某个行为在哪里实现。
- 梳理某个功能边界涉及哪些文件。
- 检查仓库里某个既有模式在其它地方如何使用。
- 找出某个小范围最相关的测试或 fixture。
- 围绕一个具体契约比较两个模块或 adapter。

如果结果会阻塞你马上要做的下一步、问题太模糊不适合委派，或用户只是在要求一个很小的直接改动，就把工作留在本地完成。已知单个文件、单个符号或 2 到 3 个文件内的小搜索，直接用本地工具读取通常更快。

## 探索深度

给每个 explorer 指定探索深度：

- `quick`：快速定位最可能相关的文件、符号或调用点。
- `medium`：常规深度，覆盖相关模块、关键调用链和最可能的测试或 fixture。
- `very thorough`：用于跨模块、命名不确定或风险较高的问题，需要搜索多种命名、相邻模块和类似实现。

## 工作流

1. 先快速读取足够的本地上下文，避免给 explorer 派发模糊任务。
2. 有必要时，把探索拆成互相独立的问题。默认启动 1 个 explorer；范围不清或跨模块时用 2 到 3 个，极复杂场景最多 4 个。
3. 只为互不重叠的问题启动 explorer 子代理。
4. 给每个 explorer 明确范围、具体问题、探索深度、期望输出结构，并提醒它保持只读。
5. explorer 运行时，继续做本地且不重叠的调查。
6. 汇总 explorer 的结论后，只针对风险最高的说法补读少量代码验证。
7. 汇总和验证完成后，立即对每个本 workflow 启动的 explorer 调用 `close_agent`。不要把一次性探索 agent 留在会话里。

默认 explorer role：

- `agent_type`: `codex-explorer`，对应受管 `roleKey = "codex-explorer"`
- 模型和 reasoning 默认值来自已安装的 role artifact。不要在 `spawn_agent` 调用里传 `model` 或 reasoning override；如果需要调整默认值，使用 `aw config` 修改后刷新 role artifact。

委派任务示例：

```text
你正在为主 agent 探索一个边界清晰的问题。

问题：Codex agent role 的注册项和 TOML 文件在哪里生成和跟踪？

探索深度：medium

范围：
- 只读 CLI 源码和测试中与 Codex adapters、generated artifacts、agent generators 相关的部分。
- 不要编辑文件。
- 不要运行破坏性命令。

返回：
- 结论
- 带文件路径和行号的证据
- 不确定点
- 建议主 agent 下一步查看
```

## 约束

- 不要把普通实现工作交给 explorer。
- 不要要求 explorer 写文件、跑 formatter、安装依赖或提交 commit。
- 首版不要假设 explorer role 已有工具级硬隔离；只读边界来自 role 提示词和你的委派要求。关键结论仍需要用最少必要证据验证。
- 不要在 explorer prompt 里粘贴大段代码。
- 如果你还有有价值的本地调查可以做，不要原地等待。
- 如果 explorer 返回宽泛或缺少证据的说法，把它当作线索，并用最少必要证据验证。
- 读取并整合 explorer 结果后，立刻关闭本次启动的 explorer。即使 explorer 已经完成，`wait_agent` 也不等于关闭 agent。

## 最终整合

回答用户或进入实现时，把 explorer 结论整合进你自己的判断。不要直接倾倒所有 explorer 回复。只引用真正重要的少量文件和行号。
````

## 已确认设计点

### 1. 插件名称

决策：使用 `codex-explore`。

原因：名称短，用户触发 `$codex-explore` 清晰，也能直接表达这是面向 Codex 的代码探索工作流。

### 2. 探索能力是否允许自动触发

决策：默认自动触发，并允许安装时覆盖为手动触发。

默认安装启用 `allow_implicit_invocation: true`。如果实际体验里自动触发过于积极，用户可以重新安装或通过触发策略覆盖改成手动模式，只保留 `$codex-explore` 显式触发。

### 3. Codex role 基础 contract

决策：首版必须先修 AW 的 Codex custom role 基础 contract，再落 `codex-explore` 插件。

Codex explorer role 的受管身份是 `roleKey`。`codex-explore` 首版使用专用 `roleKey = "codex-explorer"`，并由 AW 同时管理 `.codex/config.toml` 中的 `[agents.codex-explorer]` 注册项和 `.codex/agents/aw-codex-explore-codex-explorer.toml` role layer 文件。这个选择保留 Codex 内建 `explorer` 的默认语义，避免插件安装后改变全局 `explorer` 行为。

这个 contract 属于本需求范围内必须完成的基础设施工作。只扩展 role TOML 生成器、但不注册 role、不按 `roleKey` 做 tracking/status/uninstall 的实现不满足首版要求。

### 4. “可配置模型和提示词”的含义

决策：插件内置安全默认值，同时允许终端用户覆盖。

插件源码提供默认模型、默认 reasoning effort、不可覆写的只读安全前导和默认 explorer 工作流正文。终端用户可以通过 `aw config` 调整 `explorerModel`、`modelReasoningEffort`、`promptAppend` 和 `promptOverride`。

这些配置不是运行时脚本动态读取，而是进入受管 Codex role artifact。这样主 agent 常规情况下只需要 `spawn_agent(agent_type="codex-explorer")`，不需要先额外调用脚本读取配置。

### 5. 并行数量和探索深度

决策：默认 1 个 explorer；范围不清或跨模块时 2 到 3 个，极复杂场景最多 4 个。

原因：Claude `Explore` 的实践更偏向“少量、明确、快速”的搜索代理，而不是把探索天然拆成很多子任务。首版应优先降低上下文噪音和调度成本。

委派 prompt 必须写明探索深度：`quick`、`medium` 或 `very thorough`。如果主 agent 没写，explorer role 按 `medium` 处理。

### 6. 模型 slug 和默认 reasoning effort

决策：默认使用 `model = "gpt-5.4-mini"`，`model_reasoning_effort = "medium"`。

这个默认值服务于两个目标：降低主 agent 的上下文压力，并让只读探索更快完成。模型 slug 的可用性取决于账号和 Codex 版本，因此必须通过用户配置允许覆盖。

### 7. 提示词配置是追加还是替换

决策：同时支持 `promptAppend` 和 `promptOverride`。

默认路径是“安全前导 + 默认工作流正文 + `promptAppend`”。当用户配置 `promptOverride` 时，只替换默认工作流正文，安全前导仍然由生成器拼在最前面。文档需要明确风险：override 可能破坏输出结构和探索质量，适合高级用户或团队统一维护的提示词；但它不能移除只读边界。

### 8. 如何把模型配置写入 Codex role 文件

方案比较：

1. 在 `extensions.agents[]` 中新增 Codex-only sibling block，例如 `codexRole`，专门描述 role 注册、Codex-only 配置字段和 config binding：

```json
{
  "name": "codex-explorer",
  "description": "...",
  "prompt": "...",
  "agentOverrides": {
    "claude": null
  },
  "codexRole": {
    "roleKey": "codex-explorer",
    "model": {
      "configKey": "explorerModel",
      "default": "gpt-5.4-mini"
    },
    "modelReasoningEffort": {
      "configKey": "modelReasoningEffort",
      "default": "medium"
    },
    "promptConfig": {
      "safetyPrefix": "builtin",
      "appendKey": "promptAppend",
      "overrideKey": "promptOverride"
    }
  }
}
```

优点：artifact 仍由 AW generator/tracking/status 管理，且不污染 `agentOverrides` 现有语义。缺点：要改 manifest 类型、校验、生成器、adapter、文档和测试。

2. 复用 `agentOverrides.codex` 放 `model.configKey`、`promptConfig.overrideKey` 等绑定描述。

优点：字段位置看起来接近现有 agent extension。缺点：`agentOverrides` 当前语义是平台字段 patch，不是“生成时去哪里取配置”的 binding；复用它会污染 parser、类型系统和 `resolvePlatformEntries()`。

3. 新增专门的 Codex role 扩展块，例如 `extensions.codexAgentRoles`。

优点：语义直接。缺点：会把共享 agent 定义拆成另一套顶层 contract，插件作者需要在两个位置理解同一类能力。

4. 插件 lifecycle 根据 AW config 写 `.codex/config.toml` 和 `.codex/agents/*.toml`。

优点：不需要扩展 manifest parser。缺点：产物不在现有 `GeneratedArtifact` tracking 主链路里，status、uninstall、upgrade、回滚都容易出现边界问题。

5. 新增动态脚本，让 skill 指导主 agent 每次读取最新配置，再把配置传给 `spawn_agent`。

优点：不用改基础设施。缺点：每次触发多一次工具调用，依赖模型记得调用和正确传参，`promptOverride` 很难真正替代 role 的 developer instructions，status/tracking 也看不到运行时实际使用了什么配置。

决策：选方案 1，在 `extensions.agents[]` 中新增 Codex-only sibling block。

这样 explorer role 注册项和 role 文件仍由 AW generator、tracking、status、uninstall 和 upgrade 管理，不通过 lifecycle 脚本绕开受管 artifact 主链路，也不要求每次 skill 触发都先读一次动态配置。`agentOverrides` 继续只表示平台字段 patch，不承担 config binding 语义。

### 9. 配置变更何时生效

决策：不新增命令；配置写入后按插件声明自动刷新。

`aw config set/configure/unset/reset` 写入成功后，AW 检查插件 manifest 是否声明“这些配置 key 会影响 generated artifacts”。只有满足下面条件时才刷新：

- 当前写入的 key 命中了 manifest 声明的 refresh keys；`reset` 视为该层所有 refresh keys 都可能变化。
- 插件在当前命令上下文能定位到已安装 target。
- 受影响 target 的 platform / artifact kind 与声明匹配，例如 `codex` + `agent`。

未声明 refresh effect 的插件保持现有行为：配置写入只更新 AW config store，不刷新 artifact。这覆盖“配置由 lifecycle/helper/运行时脚本动态读取”的插件。

建议 manifest 形态先用概念字段表达，最终字段名实现时再确定：

```json
{
  "config": {
    "schema": {
      "explorerModel": { "type": "string", "default": "gpt-5.4-mini" },
      "modelReasoningEffort": {
        "type": "enum",
        "values": ["low", "medium", "high", "xhigh"],
        "default": "medium"
      },
      "promptAppend": { "type": "string", "default": "" },
      "promptOverride": { "type": "string", "default": "" }
    },
    "artifactRefresh": {
      "keys": ["explorerModel", "modelReasoningEffort", "promptAppend", "promptOverride"],
      "platforms": ["codex"],
      "kinds": ["agent"],
      "metadata": {
        "digest": true,
        "lastResult": true
      }
    }
  }
}
```

刷新应重新解析 effective config，并只重渲染 AW 受管 artifact，不触碰用户手写 role 文件，也不执行 lifecycle 脚本。对于 Codex role，受影响 artifact 包括 `[agents.<roleKey>]` 注册项和 role layer 文件。

首版必须定义刷新元数据的持久化真值。建议放在 scope-local tracking manifest 的插件记录下，最终字段名实现时再确定，但至少要表达：

- `lastRenderedConfigDigest`：上一次成功渲染当前受管 artifact 使用的 effective config digest，只覆盖 manifest 声明会影响 artifact 的 key。
- `lastArtifactRefresh`：最近一次 config-triggered refresh 的结果、时间、触发 key、platform/scope/kind、roleKey 和受影响路径。
- `refreshReach`：本次命令上下文实际刷新了哪些 target；如果 user config 可能影响其它 project，但 AW 无法跨历史项目扫描，需要在 status 中说明其它 target 可能仍用旧 artifact。

刷新和 config 写入应尽量保持命令级一致性：如果 artifact 刷新失败，优先回滚本次 config store 修改和已经写出的 artifact；如果回滚也失败，必须把 `lastArtifactRefresh.status = "failed"` 或等价状态写入元数据，让 `aw status` 能给出 degraded/stale 诊断和可恢复路径。

作用范围需要明确：AW 只刷新当前命令上下文能定位的安装目标，例如 user scope 和当前 project scope；不跨所有历史项目扫描。未安装插件时，配置只保存，后续 install/upgrade 时按最新 effective config 生成 artifact。

### 10. 主 agent 是否应显式传 `model`

决策：默认依赖 role 文件，不显式传模型。

常规路径下，主 agent 只传 `agent_type`，由 explorer role 文件控制模型和 reasoning effort。按当前 Codex 上游行为，`spawn_agent` 会先应用调用参数里的 `model` / `reasoning_effort`，再套用 role 配置；只要 role 文件里写了 `model` 或 `model_reasoning_effort`，调用参数就不能覆盖它们。

首版不支持“单次委派临时覆盖 explorer 模型或 reasoning”。调整路径只有 `aw config` 写入配置，再触发 artifact refresh，把新默认值写进 role layer。如果后续确实要支持单次覆盖，需要重新设计 role 是否写死模型配置，不放进首版。

### 11. explorer 子代理是否需要关闭

决策：需要。skill 必须要求主 agent 在读取、整合、必要验证 explorer 输出后，立刻对本次 workflow 启动的每个 explorer 调用 `close_agent`。

原因：Codex `wait_agent` 只等待子代理完成，不会自动关闭线程，也不会释放 live agent slot。`codex-explore` 的 explorer 是一次性只读探索代理，保留在会话里没有收益，反而会占用子代理额度并增加后续协作噪音。

## 推荐的首版验收标准

根据以上决策，首版应满足：

- `pnpm build` 能生成 Codex-only marketplace entry。
- `aw install <plugin> -p codex -s user` 成功，`aw install <plugin> -p claude` 被 product policy 拦截。
- Codex 能看到 `$codex-explore`，且 skill 默认允许隐式触发；用户可以安装或覆盖为手动触发模式。
- skill 指令包含保守派发策略：默认 1 个 explorer、复杂时 2 到 3 个、极复杂最多 4 个，并要求每个委派任务写明探索深度。
- skill 指令要求主 agent 使用 `agent_type = "codex-explorer"`，并在读取、整合、必要验证 explorer 输出后立刻调用 `close_agent`。
- 安装后生成 `[agents.codex-explorer]` 注册项和 explorer role 文件；注册项的 `config_file` 指向 AW 管理的 role layer。安装不得覆盖 Codex 内建 `explorer` role 或已有非 AW 管理的同名自定义 role。
- role 文件包含 `model`、`model_reasoning_effort` 和 `developer_instructions`；`developer_instructions` 必须始终包含不可覆写的只读安全前导。
- tracking 记录 `roleKey = "codex-explorer"`、注册项 path 和 role layer path；status、遮蔽判断、uninstall、upgrade、refresh 都按 `roleKey` 处理。
- `aw config set/configure/unset/reset` 修改命中的 refresh key 后，不需要额外命令即可把最新 effective config 重渲染进当前可定位的已安装 role 注册项和 role layer。
- 未声明 `artifactRefresh` 或等价 effect 的插件，配置写入不会触发 artifact 刷新。
- `aw status` 能报告 role 注册项和 role layer 是否存在、`config_file` 是否仍指向 AW 管理文件，以及 `roleKey` 是否被更高优先级 config layer 遮蔽。
- `aw status` 能基于刷新元数据报告受管 artifact 是否使用了过期 config digest，或者最近一次 config-triggered refresh 是否失败。
- `aw uninstall` 能清理 role 注册项和 role layer，不影响用户手写的 role 文件或非 AW 管理的同名注册项。
- 插件作者校验脚本能发现缺失 `agents/openai.yaml`、非法 config schema、非法 Codex-only role 字段、非法 artifact refresh 声明。
- 单元测试覆盖 manifest 解析、agent TOML 生成、`[agents.<roleKey>]` 注册、config-triggered artifact refresh、Codex adapter install/uninstall/status。

## 风险与约束

- Codex 的 spawn 工具说明明确限制子代理授权。本插件把“安装自动触发版”定义为插件层授权信号，但这不改变上游工具规则；如果 Codex 未来收紧规则，需要退化为手动触发或首次询问。
- 首版 explorer 的只读边界不是工具级硬隔离。如果 Codex role 不能限制工具，必须在 role prompt、skill 委派模板和主 agent 验证步骤里反复压住边界；后续如上游支持工具 allowlist / denylist，应优先把它纳入 role artifact。
- `promptOverride` 只替换工作流正文，不能替换安全前导；但自然语言仍不是硬隔离，主 agent 仍要把 explorer 的输出当作线索并做最少必要验证。
- 模型 slug 不是 AW 能静态保证的能力；如果用户配置了当前账号不可用的模型，失败会发生在 Codex spawn 阶段。
- 配置刷新只保证磁盘上的 AW 受管 artifact 更新。当前 Codex 会话是否热加载更新后的 role，取决于 Codex runtime；如果上游不热加载，需要提示用户新会话生效或手动重启 Codex。
- user config 可能影响多个 project 的 effective config，但 AW 不应跨所有历史项目扫描。配置写入后只能刷新当前命令上下文能定位的 target，其他项目需要在对应项目里再次写配置、升级、安装或运行未来的修复命令。
- user scope role 可能被 project scope 同名 role 遮蔽；status 需要继续沿用现有 `repoManagedSessionState.agents` 诊断，但遮蔽判断必须按 `roleKey` 而不是文件名。
- 如果后续改选 lifecycle 写 role 注册项或 role 文件，必须补齐 tracking/status/uninstall，否则会留下受管产物残留。

## 后续实现拆分建议

按当前决策进入实现时，可拆成：

1. 先扩展 agent role artifact contract：写 `[agents.<roleKey>]` 注册项、role layer 文件，并让 tracking/status/uninstall 全部按 `roleKey` 工作。
2. 扩展 Codex role TOML 生成，让 role layer 能写 `model`、reasoning 字段和“安全前导 + 工作流正文 + append”的 `developer_instructions`。
3. 扩展 config effect contract，让 manifest 能声明哪些 config key 会影响哪些 generated artifacts，并定义刷新元数据。
4. 在 config 写命令后接入 conditional refresh：只对命中声明的插件刷新当前可定位的已安装 artifact，并补齐回滚和 status 诊断。
5. 新增 Codex-only 插件源码、skill、默认 explorer prompt 和 config schema。
6. 补齐 authoring 文档、脚手架或校验脚本的 Codex role 字段和 artifact refresh 声明。
7. 跑 `pnpm build`、相关 unit/integration 测试和插件校验。
