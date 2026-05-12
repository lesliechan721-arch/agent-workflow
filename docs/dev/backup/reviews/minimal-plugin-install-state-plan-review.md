# `minimal-plugin-install-state-plan.md` 执行计划复审报告

审查对象：`docs/dev/plans/minimal-plugin-install-state-plan.md`  
关联需求：`docs/dev/specs/minimal-plugin-install-state.md`  
审查时间：2026-05-07

## 结论

本轮复审未发现新的问题。上一轮报告里的两个低优先级缺口已经补齐，而且补得比较扎实：

- P1 现在已经把 install record 禁止字段和对应 schema 单测逐项写清楚，不再只是泛化描述，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:283-304`
- artifact identity / shared locator 的最小字段、repo-stable locator 校验和对应测试也已经落进计划正文，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:275,287-290,304,308`

按当前版本看，这份计划已经和 spec 主线对齐，内部顺序也自洽，能够挂到当前基线继续实施。

## Findings

本轮未发现需要继续修改的问题。

## 已修复项复核

上一轮提到的两个问题，这次都已经补齐，不只是补了一句说明：

- install record 的最小 schema 边界，现在明确写了 `installSource` / `dependencyEdges` / `source` digest 要求，也逐项列出了旧 ledger、health、snapshot、refresh 派生字段的拒绝清单，并补上了 banned fields 的 schema 单测，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:283-285,302-303`
- artifact identity 和 project shared locator 的合同，现在明确要求 `ownershipMarker`、`artifactKey`、`hookGroups`、`id + target`、`roleKey` 等最小 identity 字段，并把 `repoRelativeProjectRoot` 的 repo-stable 校验和跨绝对路径 clone 一致性测试写进去了，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:275,287-290,304,308`

## Spec 对齐情况

这版计划对 spec 的覆盖已经比较完整，没有再看到明显遗漏、偏差，或和 spec 相反的实现方向：

- 新状态模型和最小持久化边界已经拆进 P1/P2：per-plugin install record、dynamic diagnostic cache、project artifact shared identity、historical lifecycle runtime、native transaction marker、shared runtime owner、dependency index、六类状态投影、source drift 规则和 adoptable / residual 分流都有落点，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:274-311,320-359`
- project shared/local config、ignore preflight、路径型配置限制、artifact truth 边界和 receipt 分类已经在 P3/P10 连成闭环，和 spec 对 project scope 的共享边界要求一致，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:368-398,677-704`
- install / upgrade / repair / uninstall / cleanup / reinstall / dependency-index prune / shared runtime takeover 的命令面、事务顺序和 fail-closed 语义都已经被分阶段接住，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:444-513,617-744`
- 文档、作者工具、fixture、CLI 入口和最终必跑验证也没有漏掉，`aw config configure` 的“已移除命令”边界也被保留成回归约束，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:713-804`

我这轮也没有看到计划擅自扩出 spec 之外的新范围。相反，计划对命令面还刻意收住了边界，例如继续维持“`aw config configure` 已移除、不恢复交互式入口”的约束，和 spec、当前 CLI 现状是一致的，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:9-12`

## 可落地性判断

从当前基线看，这份计划是能接住的，理由也比较直接：

- CLI 入口、options normalization、receipt 渲染和 config/status 命令注册目前都集中在 `packages/cli/src/index.ts`，很适合按计划在入口层新增 `diagnose` / `repair` / `cleanup` / `reinstall`、接入 `--takeover-shared-runtime`、`--adopt-existing`、`--dependency-index` 和 `--scope project --local`，见 `packages/cli/src/index.ts:583-905`
- 依赖图写入现在已经有统一的 preflight / execute / commit / rollback 骨架，计划继续复用这层去承接 install-state 事务和依赖边写边回滚，是顺着现有结构演进，不是另起一套写命令框架，见 `packages/cli/src/commands/plugin-dependency-write-executor.ts:51-97`
- config 写入和 refresh 目前也已经收口到共享 helper，计划对 project shared/local config、refresh 边界和 receipt 分类的改造有明确接缝，见 `packages/cli/src/utils/plugin-config-write.ts:48-145`
- `~/.aw` 的 runtime-state preserve、fingerprint 忽略和原子替换链路已经存在，只是现在仍然围绕旧 ledger / snapshot 组织。计划把这一层改成新的 runtime state allowlist，是一次明确的架构切换，不是和现状打架，见 `packages/cli/src/utils/local-marketplace.ts:407-708`

当前基线里旧 `installed.json` / ledger 依赖面确实还很多，这一点从 `local-marketplace.ts` 仍然直接读写 `installed.json` 也能看出来，见 `packages/cli/src/utils/local-marketplace.ts:413-438,599-700`。但这恰恰是这轮 install-state facade 重构要解决的问题，而不是计划自身的矛盾。计划的阶段拆分也已经把“先立新 facade，再迁移写命令，再收口输出/文档/作者工具”讲清楚了，所以我没有看到“计划写得通，但按当前仓库结构无处落脚”的问题。

## 测试覆盖判断

测试矩阵现在也已经覆盖到位，能把这轮改动的主要风险点锁住：

- P1 的 schema / validator / path helper / identity 测试，已经覆盖 install record 最小字段、banned fields、runtimeId 唯一性、locator 稳定性、diagnostic cache 脱钩和 stale / unreadable index 分类，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:300-311`
- P2/P3 把只读状态投影、dynamic cache 行为、adoptable 判定、dependency index coverage、project config 边界、ignore preflight 和路径型配置限制都写成了明确测试，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:343-398`
- P5-P10 覆盖了 owner takeover、install/upgrade、repair/adopt-existing/dependency-index repair、uninstall/cleanup/reinstall/prune、config refresh 和 shared/local config 写入边界，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:459-704`
- P11-P13 又把 CLI 入口、flag 组合、receipt / console-model、文档与作者工具同步，以及 `pnpm test:unit` / `pnpm test:integration` / `pnpm test:smoke:build` 的最终验证接上了，见 `docs/dev/plans/minimal-plugin-install-state-plan.md:729-804`

如果只看 spec 的“测试要求”章节，这份计划现在基本都能找到对应承接点，没有出现“需求里写了，但计划测试矩阵没接住”的明显空洞。单元测试锁 schema、投影和事务边界，集成测试锁命令编排和 fail-closed 语义，smoke 测试锁真实 build 产物，这个分层也是合理的。

## 结语

这次复审可以收敛成一个明确结论：上一轮报告中的问题已经修复，本轮没有发现新的计划问题。现在这份执行计划对 spec 覆盖完整，内部依赖顺序说得通，也能承接当前 CLI 基线；测试矩阵、文档同步和作者工具更新也都已经纳入同一轮交付，可以按当前版本进入实现。
