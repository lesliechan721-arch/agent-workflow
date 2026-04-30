# `codex-explorer-plugin.md` 执行计划审查报告

审查对象：`docs/dev/plans/codex-explorer-plugin.md`
审查时间：2026-04-30

本轮审查范围：

- 基于当前仓库基线做执行计划 review，不是代码实现 review
- 同时检查方案自洽性、与 spec 的一致性、在当前基线下的可落地性，以及测试计划是否覆盖修改面
- 回查上一轮 plan review 报告里的问题是否已经修复

对照依据：

- 计划文档：`docs/dev/plans/codex-explorer-plugin.md`
- 需求 spec：`docs/dev/sepcs/codex-explorer-plugin-spec.md`
- 当前约定：`docs/architecture.md`、`docs/testing.md`
- 当前实现：`packages/cli/src/**`、`packages/cli/tests/**`

## 上轮报告问题回查

上一轮报告里的 3 个问题，这版计划都已经补齐，可以关闭。

### 已修复 1. role 冲突 preflight 已经前移到 install command 写入前

这版计划已经把 role 冲突检测写成 install command 的前置 preflight，不再停留在 adapter 或 `installExtensions()` 路径。

- 需求约束见 `docs/dev/plans/codex-explorer-plugin.md:13-17`、`175-192`
- 实现任务见 `docs/dev/plans/codex-explorer-plugin.md:351-355`
- 集成测试也已补上“冲突失败不留下半成品”的断言，见 `docs/dev/plans/codex-explorer-plugin.md:573-574`

这一项可以关闭。

### 已修复 2. user scope 写入联动刷新当前 repo project artifact 已进入正文和测试矩阵

这版计划已经明确：命中 refresh key 的 user scope 写入，不只刷新 user artifact；如果当前 repo 也安装了 project artifact，还要一起刷新，而且两边使用不同 config source。

- refresh 范围约束见 `docs/dev/plans/codex-explorer-plugin.md:262-276`
- 阶段目标见 `docs/dev/plans/codex-explorer-plugin.md:490-495`
- 集成测试覆盖见 `docs/dev/plans/codex-explorer-plugin.md:582-587`

这一项也可以关闭。

### 已修复 3. 最终验收已经补上 tarball 覆盖

阶段 6 的执行清单现在已经把 `pnpm test:smoke:pack` 纳入必跑项，和当前基线的打包验收约定一致。

- 阶段 6 执行清单见 `docs/dev/plans/codex-explorer-plugin.md:518-527`
- smoke 矩阵里也把 tarball 验收写明了，见 `docs/dev/plans/codex-explorer-plugin.md:606-611`
- 基线测试约定见 `docs/testing.md:7-9`、`59-62`

这一项可以关闭。

## Findings

### 1. [高] refresh 元数据没有承接 spec 里的 `refreshReach`，按当前基线仍会留下“其它 project artifact 可能已过期但 status 看不出来”的缺口

spec 对 config-triggered refresh 的持久化真值不只要求记录最后一次 digest 和 refresh 结果，还要求保留 `refreshReach`，用来表达“这次命令实际刷新了哪些 target；如果 user config 可能影响其它 project，但 AW 没有跨历史 project 扫描，status 要说明其它 target 可能仍然是旧 artifact”，见 `docs/dev/sepcs/codex-explorer-plugin-spec.md:479-487`。

这版计划目前只要求 tracking 记录：

- `roleKey`
- registration / role layer path
- config source
- 上次成功渲染 digest
- 最近一次 refresh 结果

见 `docs/dev/plans/codex-explorer-plugin.md:214-221`。同时它又明确“不扫描所有历史 project”，见 `docs/dev/plans/codex-explorer-plugin.md:262-268`。这里少了 spec 要求的那层“刷新覆盖范围”和“未覆盖 target 的不确定性”表达。

这个缺口在当前基线里不是抽象风险，而是真实存在的行为分支。Codex ledger 本来就按 project key 记录多个 project scope 安装目标，见 `packages/cli/src/types.ts:622-624`，安装写入时也会把 project scope 记录进 `projectScopes`，见 `packages/cli/src/adapters/codex.ts:379-394`。也就是说，`aw config set codex-explore ... -s user` 从 repo A 执行时，完全可能只刷新 user artifact 和 repo A 的 project artifact，而 repo B 里同插件的 project artifact 继续停留在旧配置上。

如果计划不把这层 metadata 和 status 诊断写实，进入实现后很容易出现：

- receipt / tracking 只显示“本次 refresh 成功”
- 当前 repo 的 `aw status` 也显示 healthy
- 但其它历史 project scope 安装目标其实仍然 stale

建议补齐这条 contract：

- 在 refresh 元数据里明确持久化 `refreshReach` 或等价字段，至少能表达“刷新到了 user / 当前 project，未扫描其它 project”
- 在 status 里给出稳定诊断，说明 user scope 配置写入可能让其它历史 project artifact 仍停留旧值
- 测试补一条跨两个 repo 的场景，断言 repo A 执行 user scope 写入后，repo A 能看到“当前目标已刷新，但其它 project 可能未刷新”的状态提示

### 2. [中] `promptOverride` 的空白输入语义还没定死，当前基线会直接接受空字符串，测试也没锁住这一分支

计划正文已经写了两条要求：

- `promptOverride` 只替换 workflow body，不能影响安全前导
- 不允许生成只有安全前导的弱工作流

见 `docs/dev/plans/codex-explorer-plugin.md:151-155`。但这里对空白 `promptOverride` 的处理还是模糊的，只有一句“建议在校验或配置写入阶段拒绝空 override”。这会让实现时至少出现三种都说得通的走法：

- 配置写入阶段直接拒绝空字符串
- 渲染阶段把空白 override 当作未设置，回退到默认 workflow body
- 按原样接受空字符串，最后生成“安全前导 + 空正文”

按当前基线，第三种其实很容易不小心发生，因为通用 config 管线对 `string` 字段不会拒绝空字符串，见 `packages/cli/src/utils/plugin-config.ts:248-252`。而测试矩阵目前只锁了“安全前导仍在最前”和“override 只替换正文”，见 `docs/dev/plans/codex-explorer-plugin.md:542-548`、`587-588`，并没有锁住空白输入应该怎么处理。

这会带来两个问题：

- 计划本身对 user-facing 行为不够确定，同一个需求不同实现可能做出不同 CLI 结果
- 一旦实现走成“接受空 override”，就会直接违背前面“不允许弱工作流”的 contract

建议把这条规则改成明确约束，而不是建议项：

- 要么规定空白 `promptOverride` 在 `aw config set/configure` 阶段直接报错
- 要么规定空白 `promptOverride` 视为 unset，渲染时回退默认 workflow body

同时补两类测试：

- unit：锁住空白 `promptOverride` 的规范化 / 渲染行为
- integration：锁住 `aw config set` 或 `aw config configure` 面对空白 override 时的实际 CLI 行为

## 结论

上一轮报告提出的 3 个问题，这版计划已经全部修复：

- role 冲突 preflight 已经前移到 install command 写入前
- user scope 写入联动刷新当前 repo project artifact 已补进正文和测试矩阵
- 最终验收已经补上 `pnpm test:smoke:pack`

从当前基线看，这份计划主链路已经基本成型，也能进入实现准备。但在真正开工前，建议再补齐 2 个点：

- 把 refresh 的覆盖范围和“其它历史 project 可能仍 stale”的状态真值补完整
- 把空白 `promptOverride` 的处理语义定死，并用测试锁住

补完这两处后，这版计划就更接近可以直接落地实施的状态。
