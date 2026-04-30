# Codex 探索插件需求 Spec

## 背景

Codex 已经有子代理能力和 agent role 文件，但默认工具说明对 `spawn_agent` 很保守：只有用户明确要求子代理、委派或并行 agent 工作时才鼓励使用。单纯要求“深入分析”“充分探索”“详细阅读代码”并不天然等同于授权 spawn。因此，一个插件如果想提升探索效率，需要同时解决两件事：

1. 给主 agent 一个明确、可触发的探索工作流，让它知道什么时候可以把代码库问题拆给 explorer。
2. 给 explorer agent 一个可配置的只读 role，使它能用合适的模型、推理强度和提示词读取代码，并把关键结论压缩反馈给主 agent。

首版采用“默认自动触发，安装时可覆盖为手动触发”的策略。用户选择安装自动触发版时，视为在插件层授权该 skill 在匹配的代码探索场景中使用 explorer 子代理；如果自动触发效果不好，可以改成手动触发安装，再通过 `$codex-explore` 明确进入探索工作流。

本 spec 只描述需求和边界，不进入实现。

## 当前实现边界

### AW 插件模型

- 源码真值是 `plugins/<name>/.agents-plugin/plugin.json`，运行时 `.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json` 由 `pnpm build` 生成。
- Codex 原生插件 manifest 当前只承载 `skills`、`mcpServers`、`apps`。`extensions.agents` 不是 Codex 原生插件 manifest 字段，而是 AW 安装时生成 `.codex/agents/*.toml`。
- `marketplace.policy.products` 可以把插件限制到 `["CODEX"]`，安装时会拦截 Claude。
- Codex native plugin enabled 仍是 user scope；project scope 只写当前 repo 的 `.codex/` 受管产物。

### Codex agent role 文件

- 当前 AW 的 `extensions.agents` 会生成：

```toml
name = "..."
description = "..."
developer_instructions = """..."""
```

- 上游 Codex role 文件实际按 `ConfigToml` 解析，除 `name`、`description`、`nickname_candidates` 之外，还可以带 `model`、`model_reasoning_effort`、`model_reasoning_summary`、`model_verbosity` 等配置。
- 这意味着 Codex 本身可以表达“explorer 默认用某个模型和推理强度”，但 AW 现有 `AgentDefinition` 类型没有字段把这些配置写进 `.codex/agents/*.toml`。
- 本插件需要扩展 `AgentDefinition` / generator，让 Codex role artifact 能写入模型、推理强度和由配置合成后的 `developer_instructions`。

### AW config 能力

- 插件可以声明 `config.schema`，通过 `aw config` 管理 user/project 两层配置。
- 当前 config 值会进入 lifecycle context 和 helper，但不会自动驱动 `extensions.agents` 生成内容。
- `aw config set` 只写 AW config store；当前没有“写配置后自动重渲染已安装 role artifact”的能力。
- 如果要让“模型和提示词可配置”影响 role 文件，需要扩展 AW config 到 Codex role artifact 的受管路径。不能用 lifecycle 脚本绕开主链路，否则 tracking、status、uninstall、upgrade 和回滚都会留下缺口。
- 自动刷新不能绑定到所有 `aw config` 写入。很多插件配置只给 lifecycle 或运行时脚本动态读取，不需要刷新 artifact。刷新应由插件 manifest 明确声明，只覆盖配置值会进入受管 artifact 的场景。

## 目标

新增一个 Codex 独享插件，暂定功能目标如下：

- 提供一个探索 skill，指导主 agent 在代码库探索阶段拆分问题、并行派发 explorer、只读取 explorer 汇总出的关键细节。
- 提供一个 Codex explorer agent role，让主 agent 可以通过 `spawn_agent(agent_type=...)` 使用专门的探索提示词。
- skill 默认允许隐式触发，并支持安装时覆盖为手动触发。
- 支持配置 explorer 默认模型和 reasoning effort，首版默认 `gpt-5.4-mini + medium`。
- 支持配置 explorer 提示词，允许用户追加项目偏好，也允许高级用户完全替换默认提示词。
- 对声明会影响受管 artifact 的配置，`aw config set/configure/unset/reset` 写入成功后自动刷新当前可定位的已安装 artifact，不新增额外 apply/sync 命令。
- 插件只面向 Codex，不向 Claude Code 安装任何能力。

## 非目标

- 不改变 Codex 上游 `spawn_agent` 工具的授权规则。
- 不新增 `aw config apply` / `sync` 等配置刷新命令。
- 不让所有插件的配置写入都触发 artifact 刷新；只有 manifest 明确声明 config 会影响 generated artifacts 时才刷新。
- 不要求纯脚本动态读取的配置进入刷新链路。
- 不让插件自动改写用户现有手写 `.codex/agents/*.toml`。
- 不让 explorer 直接修改代码；首版定位为只读探索和汇总。
- 不引入 MCP server，除非后续确认需要结构化代码索引能力。
- 不把大段源码搬回主 agent；explorer 输出应以结论、文件路径、必要行号和少量摘录为主。

## 预期使用方式

首版默认启用自动触发：当用户要求探索代码库、分析实现边界、梳理架构、定位跨模块影响面时，skill 可以自动进入探索工作流。安装时必须允许用户把触发策略覆盖为手动模式；手动模式下，通过显式 `$codex-explore` 触发：

```text
$codex-explore 充分探索当前需求的实现边界
```

skill 触发后，主 agent 应：

1. 快速拆出 2 到 4 个互不重复的探索问题。
2. 对不阻塞当前下一步的问题，使用 explorer role 并行启动子代理。
3. 给每个 explorer 明确范围、输出格式和禁止写文件要求。
4. 主 agent 在等待期间继续做本地不重叠探索。
5. 汇总 explorer 返回的关键结论，只在必要时补读少量文件验证。

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
- 扩展 `extensions.agents`，让 Codex role artifact 能写入 `model`、`model_reasoning_effort` 等 Codex-only 字段
- `config.schema`，让终端用户可以通过 `aw config` 配置模型、reasoning effort、`promptAppend` 和 `promptOverride`
- config effect 声明，标记这些配置 key 会影响 Codex agent artifact，配置写入后需要自动刷新当前可定位的已安装 role 文件

### Skill 默认策略

首版默认 `allow_implicit_invocation: true`，匹配代码库探索、架构梳理、实现边界分析、跨模块影响面评估等场景时自动触发。自动触发版的安装行为视为用户对该探索 workflow 的授权信号，允许 skill 在匹配场景中调度 explorer 子代理。

`allowInstallOverride` 必须开启。用户如果觉得自动触发过强，可以用手动模式安装，之后只有 `$codex-explore ...` 会触发该 workflow。

自动模式仍要保持克制：主 agent 只把边界清晰、互不重复、不会阻塞自己下一步工作的探索问题派给 explorer；不能把普通实现任务或需要立即决策的问题都外包给子代理。

### Explorer 输出约束

explorer role 的默认提示词应要求：

- 只读探索，不写文件，不运行破坏性命令。
- 优先用 `rg`、`rg --files`、`sed`、`git show` 等轻量读取。
- 回答具体问题，不泛泛总结整个仓库。
- 输出必须包含：
  - 结论摘要
  - 关键文件路径和必要行号
  - 不确定点
  - 建议主 agent 下一步要读或验证的最少内容
- 避免粘贴长代码，必要摘录保持很短。

### Explorer 默认 role 提示词草案

下面内容作为 explorer role 的默认 `developer_instructions` 基线。实现时可直接放入插件源码里的 agent prompt；`promptAppend` 追加在末尾，`promptOverride` 配置存在时整体替换此内容。

```text
你是 Codex Explore agent。你的任务是为主 agent 回答一个边界清晰的代码库探索问题。

你只能做只读探索。不要创建、编辑、移动、删除、格式化或回退文件。不要运行破坏性命令。不要安装依赖。优先使用轻量读取命令，例如 `rg`、`rg --files`、`sed`、`git show`、`git diff`、`ls`，以及读取 package metadata。

严格待在主 agent 给定的范围内。除非任务明确要求，不要泛泛总结整个仓库。如果问题过大，请收窄到最小有用答案，并说明你没有覆盖哪些范围。

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

默认 role 提示词使用中文。若用户或主 agent 明确要求英文输出，可通过 `promptAppend` 或 `promptOverride` 调整。

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

如果结果会阻塞你马上要做的下一步、问题太模糊不适合委派，或用户只是在要求一个很小的直接改动，就把工作留在本地完成。

## 工作流

1. 先快速读取足够的本地上下文，避免给 explorer 派发模糊任务。
2. 有必要时，把探索拆成 2 到 4 个互相独立的问题。
3. 只为互不重叠的问题启动 explorer 子代理。
4. 给每个 explorer 明确范围、具体问题、期望输出结构，并提醒它保持只读。
5. explorer 运行时，继续做本地且不重叠的调查。
6. 汇总 explorer 的结论后，只针对风险最高的说法补读少量代码验证。

默认 explorer role：

- `agent_type`: `explorer`
- 模型和 reasoning 默认值来自已安装的 role artifact。除非用户或当前任务明确需要，不要传 `model` 或 reasoning override。

委派任务示例：

```text
你正在为主 agent 探索一个边界清晰的问题。

问题：Codex agent role TOML 在哪里生成和跟踪？

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
- 不要在 explorer prompt 里粘贴大段代码。
- 如果你还有有价值的本地调查可以做，不要原地等待。
- 如果 explorer 返回宽泛或缺少证据的说法，把它当作线索，并用最少必要证据验证。

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

### 3. “可配置模型和提示词”的含义

决策：插件内置安全默认值，同时允许终端用户覆盖。

插件源码提供默认模型、默认 reasoning effort 和默认 explorer 提示词。终端用户可以通过 `aw config` 调整 `explorerModel`、`modelReasoningEffort`、`promptAppend` 和 `promptOverride`。

这些配置不是运行时脚本动态读取，而是进入受管 Codex role artifact。这样主 agent 常规情况下只需要 `spawn_agent(agent_type=...)`，不需要先额外调用脚本读取配置。

### 4. 模型 slug 和默认 reasoning effort

决策：默认使用 `model = "gpt-5.4-mini"`，`model_reasoning_effort = "medium"`。

这个默认值服务于两个目标：降低主 agent 的上下文压力，并让只读探索更快完成。模型 slug 的可用性取决于账号和 Codex 版本，因此必须通过用户配置允许覆盖。

### 5. 提示词配置是追加还是替换

决策：同时支持 `promptAppend` 和 `promptOverride`。

默认路径是“基础提示词 + `promptAppend`”。当用户配置 `promptOverride` 时，完全替换插件默认提示词。文档需要明确风险：override 可能破坏只读约束和输出格式，适合高级用户或团队统一维护的提示词。

### 6. 如何把模型配置写入 Codex role 文件

方案比较：

1. 扩展 `extensions.agents` schema，新增 Codex-only role config 字段，例如：

```json
{
  "name": "explorer",
  "description": "...",
  "prompt": "...",
  "agentOverrides": {
    "claude": null,
    "codex": {
      "model": {
        "configKey": "explorerModel",
        "default": "gpt-5.4-mini"
      },
      "modelReasoningEffort": {
        "configKey": "modelReasoningEffort",
        "default": "medium"
      },
      "promptConfig": {
        "appendKey": "promptAppend",
        "overrideKey": "promptOverride"
      }
    }
  }
}
```

优点：artifact 仍由 AW generator/tracking/status 管理，最符合当前架构。缺点：要改 manifest 类型、校验、生成器、文档和测试。

2. 新增专门的 Codex role 扩展块，例如 `extensions.codexAgentRoles`。

优点：语义直接，不污染双平台 `agents`。缺点：引入新的 manifest contract，工作量更大。

3. 插件 lifecycle 根据 AW config 写 `.codex/agents/*.toml`。

优点：不需要扩展 manifest parser。缺点：产物不在现有 `GeneratedArtifact` tracking 主链路里，status、uninstall、upgrade、回滚都容易出现边界问题。

4. 新增动态脚本，让 skill 指导主 agent 每次读取最新配置，再把配置传给 `spawn_agent`。

优点：不用改基础设施。缺点：每次触发多一次工具调用，依赖模型记得调用和正确传参，`promptOverride` 很难真正替代 role 的 developer instructions，status/tracking 也看不到运行时实际使用了什么配置。

决策：选方案 1，扩展 `extensions.agents` schema，新增 Codex-only role config 字段。

这样 explorer role 文件仍由 AW generator、tracking、status、uninstall 和 upgrade 管理，不通过 lifecycle 脚本绕开受管 artifact 主链路，也不要求每次 skill 触发都先读一次动态配置。

### 7. 配置变更何时生效

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
      "kinds": ["agent"]
    }
  }
}
```

刷新应重新解析 effective config，并只重渲染 AW 受管 artifact，不触碰用户手写 role 文件，也不执行 lifecycle 脚本。刷新和 config 写入应尽量保持命令级一致性：如果 artifact 刷新失败，优先回滚本次 config store 修改和已经写出的 artifact；如果回滚也失败，ledger/status 必须能报告 degraded 或 stale，并给出可恢复路径。

作用范围需要明确：AW 只刷新当前命令上下文能定位的安装目标，例如 user scope 和当前 project scope；不跨所有历史项目扫描。未安装插件时，配置只保存，后续 install/upgrade 时按最新 effective config 生成 artifact。

### 8. 主 agent 是否应显式传 `model`

决策：默认依赖 role 文件，不显式传模型。

常规路径下，主 agent 只传 `agent_type`，由 explorer role 文件控制模型和 reasoning effort。必要时，skill 可以指导主 agent 显式传 `model` 或 reasoning 相关参数，用来覆盖 role 默认值；这应该作为高级用法，不作为默认调用方式。

## 推荐的首版验收标准

根据以上决策，首版应满足：

- `pnpm build` 能生成 Codex-only marketplace entry。
- `aw install <plugin> -p codex -s user` 成功，`aw install <plugin> -p claude` 被 product policy 拦截。
- Codex 能看到 `$codex-explore`，且 skill 默认允许隐式触发；用户可以安装或覆盖为手动触发模式。
- 安装后生成 explorer role 文件，role 文件包含 `model`、`model_reasoning_effort` 和 `developer_instructions`。
- `aw config set/configure/unset/reset` 修改命中的 refresh key 后，不需要额外命令即可把最新 effective config 重渲染进当前可定位的已安装 role artifact。
- 未声明 `artifactRefresh` 或等价 effect 的插件，配置写入不会触发 artifact 刷新。
- `aw status` 能报告 role artifact 是否存在、是否被更高优先级 `.codex/agents` 同名角色遮蔽。
- `aw status` 能报告受管 artifact 是否使用了过期 config digest，或者最近一次 config-triggered refresh 是否失败。
- `aw uninstall` 能清理 role artifact，不影响用户手写的 role 文件。
- 插件作者校验脚本能发现缺失 `agents/openai.yaml`、非法 config schema、非法 Codex-only role 字段、非法 artifact refresh 声明。
- 单元测试覆盖 manifest 解析、agent TOML 生成、config-triggered artifact refresh、Codex adapter install/uninstall/status。

## 风险与约束

- Codex 的 spawn 工具说明明确限制子代理授权。本插件把“安装自动触发版”定义为插件层授权信号，但这不改变上游工具规则；如果 Codex 未来收紧规则，需要退化为手动触发或首次询问。
- 模型 slug 不是 AW 能静态保证的能力；如果用户配置了当前账号不可用的模型，失败会发生在 Codex spawn 阶段。
- 配置刷新只保证磁盘上的 AW 受管 artifact 更新。当前 Codex 会话是否热加载更新后的 role，取决于 Codex runtime；如果上游不热加载，需要提示用户新会话生效或手动重启 Codex。
- user config 可能影响多个 project 的 effective config，但 AW 不应跨所有历史项目扫描。配置写入后只能刷新当前命令上下文能定位的 target，其他项目需要在对应项目里再次写配置、升级、安装或运行未来的修复命令。
- user scope role 可能被 project scope 同名 role 遮蔽；status 需要继续沿用现有 `repoManagedSessionState.agents` 诊断。
- 如果后续改选 lifecycle 写 role 文件，必须补齐 tracking/status/uninstall，否则会留下受管产物残留。

## 后续实现拆分建议

按当前决策进入实现时，可拆成：

1. 先扩展 agent role artifact contract，让 Codex role TOML 能写 `model` 和 reasoning 相关字段。
2. 扩展 config effect contract，让 manifest 能声明哪些 config key 会影响哪些 generated artifacts。
3. 在 config 写命令后接入 conditional refresh：只对命中声明的插件刷新当前可定位的已安装 artifact，并补齐回滚和 status 诊断。
4. 新增 Codex-only 插件源码、skill、默认 explorer prompt 和 config schema。
5. 补齐 authoring 文档、脚手架或校验脚本的 Codex role 字段和 artifact refresh 声明。
6. 跑 `pnpm build`、相关 unit/integration 测试和插件校验。
