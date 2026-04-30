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

## 本轮结论

这版 spec 已经可以看成“接近进入实现”的版本了。上一轮最关键的两个问题都已经修掉：

- 不再默认接管内建 `explorer`，而是改成专用 `roleKey = "codex-explorer"`
- 不再假设 `spawn_agent(..., model=..., reasoning_effort=...)` 可以覆盖 role 文件里锁定的模型和推理强度

按当前基线看，整体方向是合理的，基础设施增量也基本落在现有 AW 结构能承接的位置上：`extensions.agents` 扩展 Codex role contract、`codex-config` 补 agent 注册项写入、tracking/status/uninstall 改成按 `roleKey` 工作，这些都能和现有 generator / adapter / tracking 体系对齐。

现在还剩一个需要先补齐的正确性缺口：spec 的冲突检测只覆盖了非 AW 管理的 `[agents.codex-explorer]` 注册项，但没有覆盖“同层已有其它方式解析出同一个 role 名”的情况。这个边界不补，安装和状态解释都会留下歧义。

另外，配置刷新这块还能再收窄一点。当前写法可以做，但首版有机会用更小的 contract 达到同样目标，减少重复声明和实现面。

## Findings

### 1. role 冲突检测还不够完整，漏掉了“不是 `[agents.codex-explorer]`，但最终仍解析成 `codex-explorer`”的外部角色

- spec 在 `docs/dev/sepcs/codex-explorer-plugin-spec.md:88`、`170-171`、`517` 写的是：不要接管用户手写 role；如果目标 scope 已经存在非 AW 管理的 `[agents.codex-explorer]` 注册项，安装应报错。
- 但上游 Codex 的 role 加载并不只看 `[agents.<roleKey>]` 这个字面 key。它会先读取 `[agents.*]` 声明，再扫描同层 `agents/` 目录里的 `.toml` 文件，并把两边都归并到同一个 role 名空间里，见 `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/config/agent_roles.rs:33-45`、`74-95`、`471-515`。
- 更关键的是，声明项的“最终 role 名”不是一定等于 table key。上游会继续读取 `config_file` 指向的 role 文件，如果文件里有 `name`，最终会以文件里的 `name` 为准，见 `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/config/agent_roles.rs:145-161`、`270-314`。

这会带来两个 spec 里还没写到的冲突来源：

- 用户可能已经有别的声明项，例如 `[agents.foo]`，但它指向的 role 文件里 `name = "codex-explorer"`。
- 用户也可能已经有手写 `agents/*.toml`，文件本身声明了 `name = "codex-explorer"`。

如果 AW 只检查“有没有 `[agents.codex-explorer]`”，就可能出现安装表面成功、实际同层 role 重名、Codex 启动时再报 duplicate warning 的情况。这样既违背了“不接管用户手写 role”的目标，也会让 status / uninstall 很难解释清楚到底谁在生效。

建议：

- 安装前置检查不要只看字面上的 `[agents.codex-explorer]`。
- 应该按上游真实规则解析目标 scope 当前 layer 的实际 role 名集合：把 `[agents.*]` 声明和 `agents/**/*.toml` 都读出来，比较最终解析后的 role 名。
- 只要存在任意非 AW 管理 role 最终占用了 `codex-explorer`，都应视为冲突并直接报错停止。

## 可以再简化的地方

### 1. `artifactRefresh` 可以先不做成独立第二份真值

- spec 在 `docs/dev/sepcs/codex-explorer-plugin-spec.md:391-416` 已经通过 `extensions.agents[].codexRole` 把 config key 和 role 字段的绑定关系写出来了。
- 但在 `456-479` 又额外引入了一份 `config.artifactRefresh.keys/platforms/kinds` 声明。

这不是做不到，而是首版有点偏重：同一组 key 被写了两遍，后面还得补校验、状态解释和错误信息，否则很容易出现“binding 改了，refresh keys 忘了同步”的双份真值问题。

如果目标只是把 explorer 的模型、reasoning 和 prompt 配置写回 Codex role artifact，我更建议首版先收窄成：

- `codexRole` 里的 `configKey` / `appendKey` / `overrideKey` 作为唯一真值
- config 写命令根据这些绑定自动推导“哪些 key 会触发 Codex agent refresh”
- 首版默认只覆盖 `platform=codex`、`kind=agent`

这样已经足够支撑 `codex-explore`，同时能明显减少解析、校验、状态判断和文档里的重复概念。

如果团队坚持保留通用 `artifactRefresh` contract，也建议至少补一条校验规则：`artifactRefresh.keys` 必须和 `codexRole` 的派生 key 集保持一致，避免两边各说各话。

## 上轮问题回查

上一轮报告里的两个核心问题，这版 spec 已经修复：

1. 不再把运行时 `spawn_agent` 参数当成 role 模型覆盖手段。
当前 spec 已经明确：模型和 reasoning 以 role artifact 为准，不支持单次委派临时覆盖，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:90`、`298-300`、`494-500`。这和上游 `spawn_agent` 先应用调用参数、再应用 role 配置的真实顺序一致，见 `/Users/LeslieChan/Desktop/codex/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs:71-80`。

2. 不再默认覆盖内建 `explorer`。
当前 spec 已经改成专用 `roleKey = "codex-explorer"`，skill 也改为显式调用这个 role，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:42`、`73`、`89`、`142`、`355`、`517`。这条修改明显降低了全局副作用和冲突面。

另外，上一轮报告里已经认可的几处基础修复，这版也都还保持着：

- Codex custom role contract 已经扩展到“注册项 + role 文件 + roleKey tracking”
- `promptOverride` 仍然只替换工作流正文，不会移除安全前导
- `agentOverrides` 没被继续拿去承载 config binding 语义
- config-driven refresh 仍然保留了独立状态真值，而不是只写一句“status 要能看出来”

## 结论

当前判断是：

- 这份 spec 的主方向合理，和当前 AW / Codex 基线是对得上的。
- 上一轮两个阻塞实现的问题已经修复。
- 现在离“可以开始实现”只差一个需要补齐的边界：冲突检测必须按最终 role 名来做，不能只检查字面上的 `[agents.codex-explorer]`。

如果把这一点补上，我认为这份 spec 就可以进入实现拆分。

配置刷新这块即便不改，也不是硬阻塞；但如果首版想更稳、更小，我会建议把 refresh contract 先从通用设计收窄到 `codexRole` 绑定推导，等后面真有第二个消费者，再把它抽成通用能力。
