# `codex-explorer-plugin.md` 执行计划审查报告

审查对象：`docs/dev/plans/codex-explorer-plugin.md`
审查时间：2026-04-30

本轮审查范围：

- 基于当前仓库基线做执行计划 review，不是代码实现 review
- 同时检查方案自洽性、与 spec 的一致性、在当前基线下的可落地性，以及测试计划是否覆盖修改面
- 回查上一版 plan review 报告里的问题是否已经修复

对照依据：

- 计划文档：`docs/dev/plans/codex-explorer-plugin.md`
- 需求 spec：`docs/dev/sepcs/codex-explorer-plugin-spec.md`
- 当前约定：`docs/architecture.md`、`docs/testing.md`
- 当前实现：`packages/cli/src/**`、`packages/cli/tests/**`

## 上轮报告问题回查

上一轮报告里的两个遗留问题，这版计划都已经补上了。

### 已修复 1. direct command 的 historical fallback 现在也保留真实 `roleKey`

上轮指出，current catalog 缺失时不能只修 discovery；`commands/common.ts` 里的公共 historical fallback 也必须恢复真实 `roleKey`，否则按插件名直达的 `aw uninstall <plugin>` / `aw upgrade <plugin>` 仍会退回 `historical-agent`。

这版计划已经把这条路径补齐：

- contract 明确把按插件名直达入口纳入 historical 恢复范围，见 `docs/dev/plans/codex-explorer-plugin.md:206-211`
- 集成测试补了 direct uninstall / upgrade 的 historical fallback 回归，见 `docs/dev/plans/codex-explorer-plugin.md:506-511`
- 实施步骤也要求 discovery 和 `commands/common.ts` 共用同一套 historical 恢复逻辑，见 `docs/dev/plans/codex-explorer-plugin.md:573-576`

这一项可以关闭。

### 已修复 2. `agentOverrides.codex.name` 的绕行口已经封住

上轮指出，当前基线里 `agentOverrides.codex.name` 会在 platform-resolved view 上直接改写 agent 身份，见 `packages/cli/src/utils/platform-entries.ts:3-19`；如果不显式禁止，它仍能绕过 `agent.name === roleKey`。

这版计划已经把这层 contract 写实：

- source contract 明确禁止声明 `codexRole` 的 agent 使用 `agentOverrides.codex.name`，见 `docs/dev/plans/codex-explorer-plugin.md:93`
- 平台过滤语义也同步要求 Codex resolved agent 身份只能由 `roleKey` 决定，见 `docs/dev/plans/codex-explorer-plugin.md:104-109`
- 文档、作者工具和单测都补了对应约束，见 `docs/dev/plans/codex-explorer-plugin.md:445-449`、`458-460`

这一项也可以关闭。

## Findings

### 1. [中] 计划和 spec 对 `codexRole` 默认值真值仍然不一致

计划现在已经明确收口为“默认值只来自 `config.schema`”，并拒绝 `codexRole.model.default` / `codexRole.modelReasoningEffort.default`：

- `docs/dev/plans/codex-explorer-plugin.md:97-98`
- `docs/dev/plans/codex-explorer-plugin.md:412-415`
- `docs/dev/plans/codex-explorer-plugin.md:449-460`

但当前 spec 里仍保留了旧写法，在 `codexRole` 示例中直接声明第二份 `default`：

- `docs/dev/sepcs/codex-explorer-plugin-spec.md:395-420`

这会让需求文档和执行计划出现两套 contract：

- 按 spec 写 manifest，会和计划里的校验、作者工具和测试预期冲突
- 按计划实现，又不再满足当前 spec 示例的字面要求

这不是计划本身的设计错误，反而计划的收口方式更符合当前基线和上一轮 review 的结论；但在文档层面，它仍然是一个没有收干净的需求漂移。

建议：

- 把 spec 里的 `codexRole` 示例改成只绑定 `configKey`，不再声明 `default`
- 同时在 spec 文本里明确“默认值唯一来自 `config.schema[configKey].default`”，避免实现和作者工具继续各自理解

### 2. [中] spec 要求拒绝重复 binding key，但计划正文和测试还没把这条落成明确 contract

spec 现在明确把“非法 Codex role config binding”列进作者校验范围，并举了“空 key、重复 key、字段类型不匹配”等例子，见：

- `docs/dev/sepcs/codex-explorer-plugin-spec.md:473-485`
- `docs/dev/sepcs/codex-explorer-plugin-spec.md:518`

但计划目前只写到了这些校验：

- key 必须存在于 `config.schema`，见 `docs/dev/plans/codex-explorer-plugin.md:95`
- 字段类型要匹配，见 `docs/dev/plans/codex-explorer-plugin.md:96`
- model / reasoning 绑定 key 必须有 schema default，见 `docs/dev/plans/codex-explorer-plugin.md:97-98`

对应的作者工具和测试计划也没有把“重复 binding key”单独列出来：

- `docs/dev/plans/codex-explorer-plugin.md:449-460`
- `docs/dev/plans/codex-explorer-plugin.md:533-534`

如果这条不补，下面这些形态理论上都可能滑过去：

- `model.configKey` 和 `modelReasoningEffort.configKey` 指向同一个 schema key
- `promptConfig.appendKey` 和 `promptConfig.overrideKey` 指向同一个 schema key

这会让一个配置值同时驱动两个不同 artifact 字段，渲染、refresh 诊断和用户心智都容易变得模糊。

建议把这条补进计划：

- source contract 明确要求同一个 `codexRole` 内各 binding key 不能重复
- 作者工具和 unit test 补重复 key 负例

### 3. [中] 测试矩阵还没有完整覆盖 spec 约束下的 skill / prompt 内容 contract

这版计划已经把插件内容写得比较具体，和 spec 主要求基本一致，例如：

- `SKILL.md` 必须要求主 agent 在使用完 explorer 后调用 `close_agent`，见 `docs/dev/plans/codex-explorer-plugin.md:424-433`
- 委派 prompt 必须包含探索深度，且 role 工作流正文可以直接采用 spec 草案，见 `docs/dev/plans/codex-explorer-plugin.md:429-439`
- 调用 `spawn_agent` 时只传 `agent_type = "codex-explorer"`，不传 model/reasoning override，见 `docs/dev/plans/codex-explorer-plugin.md:433`

这些都对应 spec 的核心需求：

- `close_agent` 约束，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:49-50`、`497-499`
- `quick / medium / very thorough` 探索深度，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:76`、`191-199`、`282-289`
- `agent_type = "codex-explorer"` 且不显式传模型，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:302-304`、`487-493`
- 默认 role 输出结构，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:240-255`

但测试计划目前主要覆盖的是：

- trigger policy 行为，见 `docs/dev/plans/codex-explorer-plugin.md:529-531`
- 作者工具知道要有 `agents/openai.yaml`，见 `docs/dev/plans/codex-explorer-plugin.md:532-534`
- smoke 覆盖 skill 文件和 bundle 存在性，见 `docs/dev/plans/codex-explorer-plugin.md:538-541`

还没有明确测试去锁住这些真正会交付给模型的内容：

- `SKILL.md` 是否要求 `close_agent`
- `SKILL.md` 是否要求探索深度，并保留 `quick / medium / very thorough`
- `SKILL.md` 是否要求只传 `agent_type = "codex-explorer"`
- 默认 explorer prompt 是否仍保留 spec 要求的输出结构

如果这部分没有测试，后面即使基础设施全部正确，也可能在插件内容回归时把真正的 workflow 要求改丢，而现有测试仍然通过。

建议补一层内容回归：

- `authoring-tools.test.ts` 或插件 smoke 直接断言 `SKILL.md` / `agents/openai.yaml` 的关键语句
- generator 或插件 fixture 测试断言默认 role prompt 仍包含规定的输出结构和探索深度说明

## 结论

这次回查后，上一轮 plan review 提出的两个阻塞点已经修复：

- historical direct command fallback 已经纳入 `roleKey` 恢复范围
- `agentOverrides.codex.name` 的身份绕行口已经被 contract、文档和测试一起封住

从当前基线看，这份执行计划仍然是可落地的。需要扩展的点都落在现有主链路上：

- manifest/type：`packages/cli/src/types.ts`、`packages/cli/src/utils/manifest.ts`
- role 产物与 status：`packages/cli/src/generators/agents.ts`、`packages/cli/src/adapters/codex.ts`
- tracking：`packages/cli/src/utils/tracking.ts`
- config 写入接 refresh：`packages/cli/src/index.ts`

但在进入实现前，建议再补齐 3 个中优先级缺口：

- 让 spec 和计划在 `codexRole` 默认值真值上完全一致
- 把“重复 binding key 非法”补成明确 contract 和测试
- 给插件实际交付的 `SKILL.md` / 默认 role prompt 增加内容级回归测试

补完这三处后，这版计划就更适合直接进入实现。
