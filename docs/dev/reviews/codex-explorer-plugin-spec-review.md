# `codex-explorer-plugin-spec.md` 审查报告

审查对象：`docs/dev/sepcs/codex-explorer-plugin-spec.md`
审查时间：2026-04-30

本轮审查范围：

- 基于当前仓库基线继续做方案 review，不是代码实现 review
- 重点判断方案是否合理、能否在当前基线下落地、是否还有明显过度设计
- 回查上一轮 review 报告中的问题是否已经在 spec 中修复

对照依据：

- 当前仓库文档：`docs/architecture.md`、`docs/plugin-authoring.md`、`docs/plugin-installation.md`
- 当前仓库实现：`packages/cli/src/**`
- 上游 Codex 源码：`/Users/LeslieChan/Desktop/codex/codex-rs/**`

## Findings

本轮没有发现新的阻塞性 spec 问题。

上一轮报告里提出的正确性问题和简化点，这版 spec 都已经处理掉了。当前状态更接近“可以进入实现拆分”，而不是“方案本身还需要继续收口”。

## 本轮结论

当前判断是：

- 方案主方向合理，和当前 AW / Codex 基线是对得上的。
- 上一轮的关键问题已经修复，包括最终 role 名冲突、运行时模型覆盖假设、内建 `explorer` 接管边界，以及 refresh contract 的重复真值问题。
- 所需改造虽然涉及 manifest、generator、adapter、tracking、status 和 config 写入链路，但都落在现有主链路扩展点上，不需要绕开当前架构另起一套生命周期方案。
- 这版 spec 里已经没有上轮那种“值得继续主动收窄”的明显复杂度热点；剩下更多是实现工作量，而不是方案设计过重。

## 当前基线下的可实现性判断

这份 spec 现在是“缺基础设施实现，但方向成立”的状态，不是“文档想做的事情和当前代码基线对不上”。

现状里确实还没有 spec 需要的几项核心能力：

- `AgentDefinition` 目前只有 `name / description / prompt / tools`，`GeneratedArtifact` 和 tracking 也还没有 `roleKey`、注册项 path 或 refresh 元数据，见 `packages/cli/src/types.ts:216-337`。
- manifest parser 目前只认识通用 `extensions.agents`，还没有 `codexRole` 这类 Codex-only sibling block，见 `packages/cli/src/utils/manifest.ts:1274-1309`。
- Codex agent 生成器现在只会产出 `.toml` role 文件，不会同时表达 `[agents.<roleKey>]` 注册项，也不会写 `model`、`model_reasoning_effort` 这类 role layer 字段，见 `packages/cli/src/generators/agents.ts:17-53`。
- Codex adapter 的安装/卸载/status 目前仍把 agent 当作单个文件类 artifact 处理，没有围绕同一个逻辑 role 管理“注册项 + role 文件”，status 里的 agent 身份也还是按 `buildGeneratedName(plugin, agent.name)` 推导，见 `packages/cli/src/adapters/codex.ts:893-1185`。
- project layer 诊断现在仍按 `agents/` 目录里的文件 basename 收集 role 名，不按上游最终 role 名解析规则处理，见 `packages/cli/src/utils/detect.ts:220-302`。
- `aw config set/configure/unset/reset` 目前只写 config store，不会联动刷新受管 artifact，见 `packages/cli/src/index.ts:848-1108`。

但这些缺口都刚好落在现有主链路节点上：

- manifest/type 扩展可以落在 `types.ts` + `manifest.ts`
- role 文件和注册项的写入/清理可以收敛到 `generators/agents.ts` + `adapters/codex.ts`
- role 冲突、遮蔽和 session 可见性诊断可以收敛到 `utils/detect.ts` + `adapters/codex.ts`
- refresh 状态真值可以接到现有 tracking manifest 上，见 `packages/cli/src/utils/tracking.ts:18-127`
- config 写入后的 conditional refresh 可以接在现有 `aw config` 命令尾部

还有一个实现层面的正向信号：当前 `codex-config.ts` 虽然还没解析 `[agents.*]`，但已经有基于 TOML AST 的通用 table 读写能力，扩展成安全 upsert/remove `[agents.<roleKey>]` 是顺路的，不需要换一套文件编辑机制，见 `packages/cli/src/utils/codex-config.ts:76-180`、`240-260`。

所以上述工作量不小，但从“能不能在当前基线下实现”这个角度，我的结论仍然是：能，而且 spec 对增量边界已经描述得足够清楚。

## 上轮问题回查

上一轮报告里的核心问题，这版 spec 都已经修掉了。

### 1. role 冲突检测已按“最终 role 名”补齐

上一轮最大的缺口，是 spec 只防 `[agents.codex-explorer]` 这种字面冲突，没有覆盖“其它声明项或手写 role 文件最终也解析成 `codex-explorer`”的情况。

这版 spec 已经明确补上了这层语义：

- 先说明安装、status 和冲突检测不能只看 `[agents.<roleKey>]` 字面 key，而要按上游 Codex 的 role 解析规则看最终 role 名，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:42`。
- 在受管产物要求里明确写出检查范围：既包括 `[agents.*]` 声明项，也包括同层 `agents/**/*.toml`；如果声明项带 `config_file`，最终 role 名要继续以 role 文件里的 `name` 为准，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:171-174`。
- 验收标准也同步要求安装不得覆盖任何最终 role 名为 `codex-explorer` 的非 AW 管理角色，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:510`。

这和上游 Codex 的真实行为是一致的：同一 config layer 里，声明项和自动发现的 role 文件会先归并到最终 role 名空间；声明项如果配置了 `config_file`，最终 role 名会继续读取 role 文件里的 `name`，见 `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/config/agent_roles.rs:18-115`、`145-161`、`260-315`。

### 2. 不再假设运行时 `spawn_agent` 参数能覆盖 role 文件里的模型

这版 spec 已经明确把模型和 reasoning 的控制权放回 role artifact：

- 非目标里明确不支持通过 `spawn_agent(..., model=..., reasoning_effort=...)` 做单次覆盖，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:91`。
- skill 草案要求主 agent 不要在 `spawn_agent` 调用里传 `model` 或 reasoning override，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:300-303`。
- 设计点里也再次确认：常规路径只传 `agent_type`，模型和 reasoning 通过 role 文件控制，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:487-493`。

这和上游 `spawn_agent` 的应用顺序也一致：先应用调用参数，再套用 role 配置，所以 role 文件里一旦写死 `model` 或 `model_reasoning_effort`，调用参数本来就不能覆盖它们，见 `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs:62-84`。

### 3. 不再默认接管内建 `explorer`

这一点也已经收住了：

- 当前 spec 明确要求使用专用 `roleKey = "codex-explorer"`，不复用内建 `explorer`，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:43`、`143-176`。
- skill 主路径和验收标准都改成显式调用 `agent_type = "codex-explorer"`，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:143`、`302`、`509-510`。

这明显降低了 user scope 安装后的全局副作用，也让 status、冲突检测和卸载更可解释。

### 4. 上轮提出的 refresh 简化点已经落实

上一轮我建议把 refresh effect 收回到 `codexRole` binding 推导，不要再保留第二份独立声明真值。当前 spec 已经按这个方向收口：

- 明确写出“首版不引入独立 `config.artifactRefresh` 或 `artifactRefresh.keys` 字段”，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:458`。
- refresh keys 直接从 `codexRole.model.configKey`、`modelReasoningEffort.configKey`、`promptConfig.appendKey`、`promptConfig.overrideKey` 推导，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:460-471`。
- 同一段里也把 `codexRole` 定成首版 refresh effect 的唯一真值，避免 binding 和 refresh 声明漂移，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:473-485`。

这解决了上轮剩下的主要复杂度问题。现在 refresh contract 虽然仍需要实现，但不再有“双份声明、双份校验、双份 status 解释”的额外维护负担。

## 复杂度判断

这轮重新看下来，我认为这版 spec 的复杂度已经比较克制了。

它确实要补几层基础设施，但这些复杂度大多是需求本身带来的必要成本：

- 如果要让 Codex custom role 成为 AW 的一等受管 artifact，就必须把“注册项 + role 文件 + tracking/status/uninstall”接成一个完整 contract。
- 如果要让 `aw config` 改动自动进入 role 文件，而不是靠运行时脚本临时拼参数，就必须在 config 写入链路上补 conditional refresh。
- 如果要让 status 能解释“缺失、遮蔽、过期、刷新失败”，就必须给 tracking 增加最小限度的 refresh 元数据。

相比之下，spec 已经主动避开了几条更重的路：

- 没把 role 写入放到 lifecycle 脚本里绕开主链路，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:434-444`
- 没再额外引入独立 refresh 声明，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:446-485`
- 没尝试首版接管内建 `explorer` 或扩 role 级工具权限，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:90-95`

所以我的结论是：当前复杂度主要是“该补的基础设施还没补”，不是“方案设计本身绕远了”。

## 残余风险

本轮没有新的 spec finding，但还有两类风险需要继续按文档里的方式对待：

- 自动触发安装被当成 explorer 授权信号，这本质上仍是对上游 Codex 工具策略的产品层约定，不是硬 runtime 保证。spec 已经把它标成风险并定义了退化路径，这个表述目前是合理的，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:523-528`。
- 只读边界首版主要靠 role prompt 和 workflow 约束，不是工具级硬隔离。spec 也已经把这点写成明确限制，而不是当成已解决能力，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:524-525`。

这两点目前更像产品/runtime 风险，不是当前方案 contract 的设计错误。

## 结论

这轮 review 的结果是：

- spec 现在已经没有明显阻塞实现的方案错误。
- 上轮报告里的关键问题和简化点都已经修复，且修复方向是对的。
- 方案和当前基线之间的差距，主要是“还没实现这些基础设施”，不是“现有架构承接不了”。

按当前仓库结构看，这份 spec 可以进入实现拆分。
