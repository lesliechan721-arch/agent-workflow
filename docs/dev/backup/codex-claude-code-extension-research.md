# Codex 与 Claude Code 扩展能力调研

> 历史文档
> 适用背景：本文记录的是 npm marketplace 新方案定稿前，对 Claude / Codex 扩展能力对齐的中间调研。
> 失效说明：文中把共享 `.claude-plugin/plugin.json` 作为当前推荐落点的部分，已经被 source manifest + build bundle 模型替代。
> 当前方案：请以 [docs/dev/plans/npm-plugin-marketplace-new.md](plans/npm-plugin-marketplace-new.md) 和 [docs/dev/todos/npm-plugin-marketplace-new.md](todos/npm-plugin-marketplace-new.md) 为准。

本文基于以下源码做实现层调研，用来支撑“一个尽量共用的工作流扩展项目”后续的架构决策，不把源码现状当作长期稳定的产品承诺。

- Codex: `/Users/LeslieChan/Desktop/codex/codex-rs`
- Claude Code: `/Users/LeslieChan/Desktop/claude-code-source-code/src/`

如果只想看 Codex 插件面的单独说明，可以先看 [docs/codex-plugins.md](codex-plugins.md)。

## 调研目标

本次重点关注四类能力能否通过插件系统统一承载：

- `skills`
- `agent 定义`
- 自定义 `rules`
- `hooks`

额外也看了两个紧邻能力面，因为它们会直接影响方案边界：

- `MCP`

## 结论先行

如果目标是做一个 `Codex + Claude Code` 共用的工作流扩展项目，插件层可以共用，但只能共用一层比较薄的能力面。

最稳的共同交集是：

- `skills`
- `MCP`
- 一小部分通用 manifest 元数据

如果只看“agent 的定义”，两边其实都能承载这层能力，但挂载位置不同：

- `Claude Code`：插件原生支持 `agents`
- `Codex`：主要走 config layer / `agents` 目录，不属于插件能力

不适合按“一套插件语义，两端完全复用”来设计的部分是：

- `agent 定义` 的落地载体
- 自定义 `rules`
- `hooks`

根本原因不是功能有没有，而是这些能力挂载的位置不同：

- 在 `Claude Code` 里，插件本身就是一等扩展面，`agents / hooks / commands / LSP / MCP / skills` 都可以由插件直接分发。
- 在 `Codex` 里，插件真正承认的能力面非常窄，主要只有 `skills / MCP / apps(connectors)`；`agent 定义`、`rules`、`hooks` 更多属于核心能力或配置层能力，不属于插件能力。

所以，更合理的方案不是“一个插件包解决全部事情”，而是：

- 共享一层薄插件：承载 `skills + MCP`
- 再分别给 `Codex` 和 `Claude Code` 做各自的 adapter / companion 配置层

## 能力矩阵

| 能力 | Codex | Claude Code | 方案含义 |
| --- | --- | --- | --- |
| `skills` | 插件内支持，但能力较薄 | 插件内支持 | 可以共用，但要按“纯 skill”设计 |
| `MCP` | 插件内支持 | 插件内支持 | 最稳共同能力面 |
| `agent 定义` | 走 config layer / `agents` 目录，插件不承载 | 插件原生支持 | 可以统一建模，但需要双端落地 |
| 指令规则 | `AGENTS.md` | `CLAUDE.md / .claude/rules/*.md` | 应单独生成 |
| 权限规则 | `execpolicy` | `settings.json.permissions` | 应单独生成 |
| `hooks` | 配置层 `hooks.json`，不是插件；且只有 command hook 真正生效 | 插件原生支持，事件很多 | 不能做成单一实现 |
| `commands` | 无同级插件面 | 插件原生支持 | Claude 独占 |
| `LSP` | 无同级插件面 | 插件原生支持 | Claude 独占 |
| `apps / connectors` | 插件内支持 | 无对等插件面 | Codex 偏特有 |

## Codex 的扩展边界

### 1. 插件运行时能力面很窄

从实现看，Codex 插件加载后的运行时能力总结只有三类：

- `has_skills`
- `mcp_server_names`
- `app_connector_ids`

对应源码：

- `/Users/LeslieChan/Desktop/codex/codex-rs/plugin/src/load_outcome.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-plugins/src/manifest.rs`

也就是说，Codex 当前真正把插件当作“可执行扩展面”的，只有：

- `skills`
- `MCP servers`
- `apps/connectors`

`interface` 这类字段更多是展示与发现元数据，不是新的运行时能力。

### 2. Codex 已兼容发现 `.claude-plugin/plugin.json`

Codex 在查找 manifest 时，会同时尝试：

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`

对应源码：

- `/Users/LeslieChan/Desktop/codex/codex-rs/utils/plugins/src/plugin_namespace.rs`

这意味着“统一用 `.claude-plugin/plugin.json` 作为共享入口”在发现层面是可行的。

但这里有一个很重要的约束：

- Codex 对 manifest 的共享字段解析明显更窄。
- 例如 `skills` 在 Codex 里是单个字符串路径，`mcpServers` 也是单个字符串路径。
- Claude Code 同名字段允许数组、对象和 inline 配置。

所以，如果两边共用同一份 `plugin.json`，重名字段必须按 Codex 能接受的最窄形态来写，否则 Codex 会在 manifest 解析阶段直接失败。

### 3. Codex 的 skills 不能替代 hooks / agent 定义 / fork 工作流

Codex skill metadata 目前只有这些主要字段：

- `interface`
- `dependencies`
- `policy`

对应源码：

- `/Users/LeslieChan/Desktop/codex/codex-rs/core-skills/src/model.rs`

这说明 Codex 的 skill 本质上还是“技能说明 + 依赖声明 + 少量策略”的组合，不带下面这些能力：

- skill 级 `hooks`
- skill 指定 `agent`
- skill 指定 `fork context`

如果后续工作流需要“技能触发 agent 工作流”或“技能自带 hook 生命周期”，不能把希望寄托在 Codex skill metadata 上。

### 4. Codex 的 agent 定义不在插件层

从你这个扩展项目的视角，真正需要统一描述的是“agent 定义”。这层在 Codex 里也存在，只是不是插件 manifest，而是来自 config layer 和 `agents/` 目录：

- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/config/agent_roles.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/config/mod.rs`

这意味着：

- 你可以把 `agent 定义` 作为扩展项目的一层统一模型
- 但在 Codex 侧，它的安装面应是配置层或 companion 安装面

### 5. Codex 的 hooks 也不在插件层

Codex 的 hook 配置是从各个 config layer 目录下的 `hooks.json` 发现的。对应源码：

- `/Users/LeslieChan/Desktop/codex/codex-rs/hooks/src/engine/discovery.rs`

当前支持的事件包括：

- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `SessionStart`
- `UserPromptSubmit`
- `Stop`

但实现上还有两个关键限制：

- `prompt hook` 会被直接跳过
- `agent hook` 也会被直接跳过

只有 command hook 这条路径真正工作。对应源码：

- `/Users/LeslieChan/Desktop/codex/codex-rs/hooks/src/engine/discovery.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/hook_runtime.rs`

这点对方案影响很大：如果你想做可移植的 workflow hook 框架，Codex 端能稳定覆盖的其实只是“命令型 hook”。

### 6. Codex 的“规则”至少要拆成两层

Codex 里常被笼统叫作“rules”的东西，实际上至少有两类：

#### 指令类规则

通过 `AGENTS.md` 注入到模型可见指令里。对应源码：

- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/agents_md.rs`

这类规则本质上是 prompt/instruction 规则。

#### 审批/执行类规则

通过 `ExecPolicyManager::load(&config.config_layer_stack)` 装载。对应源码：

- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/session/mod.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/exec_policy.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/execpolicy/README.md`

`execpolicy` 当前是一个命令前缀匹配的审批引擎，核心语义是：

- `allow`
- `prompt`
- `forbidden`

以及命令前缀规则与 host executable 解析。

这不是 prompt 规则系统，也不是插件 manifest 的一部分。它更接近“执行权限和审批策略”。

## Claude Code 的扩展边界

### 1. Claude Code 的插件是主扩展面

Claude Code 的插件 manifest 直接支持这些顶层能力：

- `commands`
- `agents`
- `skills`
- `hooks`
- `outputStyles`
- `channels`
- `mcpServers`
- `lspServers`
- `settings`
- `userConfig`

对应源码：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/schemas.ts`

插件加载流程也会显式装配：

- commands
- agents
- hooks
- MCP
- LSP

对应源码：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/hooks/useManagePlugins.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/pluginLoader.ts`

这和 Codex 的差异非常大。Claude Code 更接近“插件就是产品级扩展容器”。

### 2. Claude 的 hooks 是插件原生能力，而且事件面远宽

Claude Code 插件 hooks 既可以来自 `hooks/hooks.json`，也可以来自 manifest 声明，加载后会统一注册。对应源码：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/pluginLoader.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/loadPluginHooks.ts`

插件 hook 事件面明显更完整，包括但不限于：

- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `PermissionRequest`
- `PermissionDenied`
- `SessionStart`
- `SessionEnd`
- `Stop`
- `StopFailure`
- `SubagentStart`
- `SubagentStop`
- `PreCompact`
- `PostCompact`
- `TaskCreated`
- `TaskCompleted`
- `Elicitation`
- `ElicitationResult`
- `CwdChanged`
- `FileChanged`
- `WorktreeCreate`
- `WorktreeRemove`
- `InstructionsLoaded`

对应源码：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/types/hooks.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/loadPluginHooks.ts`

如果你的工作流高度依赖 hook 生命周期，Claude 端可以直接走插件面，而 Codex 端做不到同等映射。

### 3. Claude 的 agent 定义可以通过插件分发，但有明确安全边界

Claude Code 插件可以直接分发 agent definition。对应源码：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/loadPluginAgents.ts`

但插件 agent 有明确限制：

- `permissionMode` 会被忽略
- `hooks` 会被忽略
- `mcpServers` 会被忽略

源码里还明确写了原因：这些能力会提升 agent 的控制权，不应该埋在第三方插件的单个 agent 文件里，应该交给用户在 `.claude/agents/` 显式定义。

这说明 Claude 的插件虽然强，但也不是“所有 agent 权限都能在插件内声明”。

### 4. Claude 的 agent 定义能力更强，但仍有边界

Claude Code 的 agent 基础定义支持：

- `hooks`
- `permissionMode`
- `mcpServers`
- `background`
- `isolation`
- `skills`

对应源码：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/tools/AgentTool/loadAgentsDir.ts`

也就是说：

- Claude 插件能直接分发 `agent 定义`
- 而且这层定义本身比 Codex 丰富得多
- 但扩展项目仍然只需要关心“定义怎么描述和分发”，不用把平台运行机制带进模型里

### 5. Claude 的 skill 与 plugin skill 不是一回事

这是这次调研里最容易误判的一点。

Claude 普通 skill loader 确实支持这些 frontmatter：

- `hooks`
- `context: fork`
- `agent`
- `paths`

对应源码：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/skills/loadSkillsDir.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/types/command.ts`

但插件里的 `skills/` 当前走的是 plugin command loader，这条路径里没有看到对下面这些字段的同等解析与填充：

- `hooks`
- `context`
- `agent`

对应源码：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/loadPluginCommands.ts`

所以不能简单说：

- “Claude 插件 skill 等价于普通 Claude skill”

更准确的说法是：

- Claude 普通 skill 能力更强
- Claude 插件 skill 目前更接近“插件里的一类 prompt command”

这会直接影响共用设计。如果你把过多 agent/hook 行为绑定在 skill 语义里，那么这套设计在 Claude 插件面本身也不一定完整成立。

### 6. Claude 的“规则”与“权限”也是两套系统

Claude 的指令规则核心是：

- `CLAUDE.md`
- `.claude/CLAUDE.md`
- `.claude/rules/*.md`
- `CLAUDE.local.md`

支持：

- 目录向上遍历
- `@include`
- `paths` frontmatter 条件规则

对应源码：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/claudemd.ts`

Claude 的权限规则则来自设置层，而不是 `CLAUDE.md`：

- `settings.json.permissions.allow`
- `settings.json.permissions.deny`
- `settings.json.permissions.ask`
- `settings.json.permissions.defaultMode`
- `settings.json.permissions.additionalDirectories`

对应源码：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/settings/types.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/permissions/permissionsLoader.ts`

换句话说，Claude 也需要把“指令规则”和“权限规则”分开建模，只是它们的落点和 Codex 不一样。

### 7. Claude 的 plugin-only 策略没有覆盖规则文件

`strictPluginOnlyCustomization` 只锁以下几个 surface：

- `skills`
- `agents`
- `hooks`
- `mcp`

对应源码：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/settings/types.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/settings/pluginOnlyPolicy.ts`

这里没有把 `CLAUDE.md rules` 算进去。

这说明就算在 Claude 里，规则文件本身也没有完全并入插件化 surface。它依旧是一套并行的配置/指令系统。

### 8. Claude 插件 settings 也不是通用后门

Claude 插件虽然有 `settings` 字段，但目前真正 allowlist 的只有：

- `agent`

对应源码：

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/pluginLoader.ts`

这意味着插件不能顺手把通用 permissions、全局 hooks 策略之类的东西一并写进去。

## 差异对方案的直接影响

### 1. 共享插件层应该只承载“共同最小集”

最稳的共同能力面建议收敛到：

- `skills`
- `MCP`
- 基础 manifest 元数据

如果再往上叠：

- 更复杂的 agent 控制面
- workflow hooks
- prompt rules
- approval rules

就会很快碰到两边承载层级不一致的问题。

### 2. `agent 定义` 可以统一建模

更稳的做法是这样拆：

- 在共享模型里，只描述 `agent 定义`
- 在 Codex 里，定义落到 config-layer roles / `agents` 目录
- 在 Claude 里，定义落到插件 `agents` 或 `.claude/agents`

### 3. 自定义规则一定要拆成两套产物

建议从一份中立 DSL 或中间模型生成两套内容：

- 指令规则
- 权限/审批规则

建议映射关系：

| 中立概念 | Codex | Claude Code |
| --- | --- | --- |
| 指令规则 | `AGENTS.md` | `CLAUDE.md` / `.claude/rules/*.md` |
| 权限规则 | `execpolicy` | `settings.json.permissions` |

不要把这两类规则混成一个“rules”概念继续往插件 manifest 里塞，否则后面会越来越难收束。

### 4. hooks 建议只抽象公共事件语义，不抽象统一载体

可以统一抽象“事件”和“期望行为”，比如：

- before tool
- after tool
- before permission prompt
- session start
- stop

但不建议强行统一成一份可直接执行的 hook 配置，因为两边差异太大：

- Claude 插件 hooks 很强，事件多
- Codex hooks 在插件外，而且只有 command hook 稳定可用

### 5. 共用 manifest 时要按 Codex 兼容子集写

如果决定统一用 `.claude-plugin/plugin.json`，建议共享字段遵循 Codex 可解析的最窄子集：

- `name`
- `version`
- `description`
- `skills`: 单个相对路径字符串
- `mcpServers`: 单个相对路径字符串
- `interface`

额外的 Claude 字段可以继续加，但要注意两件事：

- 共享重名字段不能用 Claude 独有的宽类型
- 需要把 Claude 独占能力和 Codex 侧 companion 配置分开

## 推荐的实现策略

### 方案 A：共享插件层 + 双端适配层

这是当前最推荐的方案。

优点：

- 共享面清晰，后续不容易被某一端实现细节绑死
- 能同时吃到 Claude 强插件面和 Codex 原生配置层能力
- 规则、hooks、agent 定义都能各走各的正确落点

缺点：

- 安装和打包逻辑会多一层
- 需要维护一份中立模型到双端产物的编译过程

### 方案 B：以 Claude 插件为主，Codex 做兼容降级

只适合需求很轻的场景。

前提通常是：

- 真正要共用的只有 `skills + MCP`
- 其他能力接受在 Codex 里缺省或弱化

如果你的目标里 `hooks`、`agent 定义`、自定义规则都很重要，这个方案后面大概率会走回 A。

## 几个容易踩的坑

### 坑 1：看到 Codex 支持 `.claude-plugin/plugin.json`，就以为两边 manifest 可以完全共用

不是这样。

Codex 只是能发现这份文件，不代表它支持 Claude manifest 的全部字段形态。共享重名字段仍然要按 Codex 的窄类型来写。

### 坑 2：把 Claude 普通 skill 的能力直接套到 Claude 插件 skill 上

这也是不成立的。

普通 skill loader 有 `hooks / context: fork / agent` 能力，不等于插件 skill 当前路径也完整支持。

### 坑 3：把 rules 当成单一概念

无论是 Codex 还是 Claude，都至少要拆成：

- 指令规则
- 权限/审批规则

两端只是文件名和装载点不同，不是概念不同。

### 坑 4：假设 hooks 可以天然跨端统一

实际情况更像：

- Claude 可以做“插件级 hooks 平台”
- Codex 只能稳定承载“配置层 command hooks”

如果一开始就按最强模型设计统一 hook 载体，后面 Codex 端会很别扭。

## 最终建议

如果后续要做正式方案设计，建议把项目拆成三个层次：

1. `Core Workflow Model`
2. `Shared Plugin Surface`
3. `Platform Adapters`

推荐的职责划分是：

- `Core Workflow Model`：定义技能、事件、规则、agent 定义、中立 DSL
- `Shared Plugin Surface`：只产出可跨端复用的 `skills + MCP + metadata`
- `Platform Adapters`：分别产出 Codex 和 Claude 的 hooks、rules、agent 定义、permissions 安装物

按当前源码现状看，这样的边界最不容易返工。

## 代表性源码入口

下面这些文件最值得作为后续设计时的回看入口：

### Codex

- `/Users/LeslieChan/Desktop/codex/codex-rs/core-plugins/src/manifest.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/plugin/src/load_outcome.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/utils/plugins/src/plugin_namespace.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core-skills/src/model.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/config/agent_roles.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/hooks/src/engine/discovery.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/hook_runtime.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/agents_md.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/exec_policy.rs`
- `/Users/LeslieChan/Desktop/codex/codex-rs/execpolicy/README.md`

### Claude Code

- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/schemas.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/pluginLoader.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/hooks/useManagePlugins.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/loadPluginHooks.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/plugins/loadPluginAgents.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/skills/loadSkillsDir.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/types/command.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/claudemd.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/settings/types.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/permissions/permissionsLoader.ts`
- `/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/settings/pluginOnlyPolicy.ts`
