# `codex-project-scope-repo-managed-isolation.md` 执行计划复审报告

审查对象：`docs/dev/plans/codex-project-scope-repo-managed-isolation.md`
审查时间：2026-04-30

本轮复审继续以当前仓库基线为准，范围限定为：

- 执行计划 review，不是实现代码 review
- 同时检查文档自洽、当前基线是否承接得住、测试闭环是否完整
- 复核上一轮报告中的问题是否已经修复，并继续补查新的结构性缺口
- 重点核对这份计划是否已经完整接住当前基线里的 config、lifecycle、install snapshot、tracking、status、interactive 和 `upgrade --all` 合同

## Findings

### 1. 中严重度：`upgrade --all` 的 `skipped[].code` 仍然没有完全收成稳定合同，几类 code 只出现在类型里，缺少唯一语义和正向回归

位置：

- `docs/dev/plans/codex-project-scope-repo-managed-isolation.md:447-463`
- `docs/dev/plans/codex-project-scope-repo-managed-isolation.md:476-479`
- `docs/dev/plans/codex-project-scope-repo-managed-isolation.md:331`
- `docs/dev/plans/codex-project-scope-repo-managed-isolation.md:437`
- `docs/dev/plans/codex-project-scope-repo-managed-isolation.md:1350-1363`
- `docs/dev/plans/codex-project-scope-repo-managed-isolation.md:1520`

问题：

这版计划已经把上一轮两处主要问题补平了，尤其是：

- project `.codex/config.toml` 损坏现在已经统一收口到 target-level `projectConfigUnreadable`
- `catalogNotCurrent` 也已经从类型占位收成了明确语义和回归要求

但 `SkippedUpgradeTarget.code` 这组稳定合同还没有彻底闭环。

现在类型里一共列了 10 个 code：

- `codexProjectUserConfigUnreadable`
- `externalOwnershipUnknown`
- `externalOwnershipPresent`
- `installOptionsUnavailable`
- `projectConfigUnreadable`
- `trackingIntegrityError`
- `catalogNotCurrent`
- `catalogNotProjectInstallable`
- `unmanagedRepoArtifactConflict`
- `scopeNotInitialized`

正文和验收标准真正收成唯一语义、并写出稳定回归要求的，实际上只有后四类里的：

- `projectConfigUnreadable`
- `catalogNotCurrent`
- `catalogNotProjectInstallable`
- `unmanagedRepoArtifactConflict`

剩下几类目前还有三个问题：

- `user config` 损坏、external ownership 冲突、external ownership 无法可靠判断、tracking identity 损坏、tracking-only `overridable` 偏好不可恢复，这些分支在正文里都写成了 `upgrade --all` target-level skipped / refused，但没有明确规定各自必须落成哪个 `code`
- 有些 code 看起来还和现有主文重叠，尤其 `codexProjectUserConfigUnreadable` 和 `externalOwnershipUnknown`。在当前语义下，user `~/.codex/config.toml` 不可读本身就会让 external ownership 无法可靠判断；如果不先写死，落地时很容易一处实现返回前者，另一处实现返回后者
- `scopeNotInitialized` 还停留在 union 里，但这版计划已经把 `upgrade --all` 改成 evidence-first discovery。按主文现在的描述，真正进入 target discovery 的应当是已有 managed evidence 的 target，这个 code 至少在文档层已经看不出清晰、可达的触发路径

测试覆盖也被这个问题连带拉开了口子。当前矩阵已经锁住了：

- `projectConfigUnreadable`
- `catalogNotCurrent`
- `catalogNotProjectInstallable`
- `unmanagedRepoArtifactConflict`

但对下面这些分支，还没有看到“正向断言具体 `code`”的回归要求：

- user `~/.codex/config.toml` 损坏导致整批 Codex project target skipped
- external ownership 冲突
- `overridable` tracking-only target 的 install options 无法恢复
- tracking `artifactKey` 损坏导致的 target-level skip / refusal

这会让 `skipped[]` 虽然名义上是稳定机读合同，实际却仍有一部分靠实现者自行决定。

建议：

- 如果首版只准备稳定支持 4 个 skip code，就把 union 和相关文案收窄到这 4 个，其他情况统一只保留 `reason`，不要先把未来 code 暴露成稳定合同
- 如果这些 code 也打算首版稳定支持，就把每一类触发条件、优先级和与相邻 code 的边界明确写死，并补齐 direct command 返回值、CLI receipt 和退出码回归
- `scopeNotInitialized` 要么补一条明确、可达、可测试的触发路径，要么直接从 stable union 中删除，避免把旧模型残留带进新合同

## 已关闭问题

上一轮报告里的两处主要问题，这版计划都已经补平了：

- `upgrade --all -p codex -s project` 遇到损坏的 project `.codex/config.toml` 时，现在已经明确收口为 target-level `skipped[]`，同批 skills-only target 可以继续：`docs/dev/plans/codex-project-scope-repo-managed-isolation.md:46`、`327`、`437`、`1366-1368`、`1487`
- `catalogNotCurrent` 已经从类型占位补成稳定 skip code，并补了 direct command、human receipt、mixed continuation 和 fatal catalog load 的边界：`docs/dev/plans/codex-project-scope-repo-managed-isolation.md:56`、`477`、`1369-1371`、`1520`

另外，这轮也确认下面这些主干没有回退：

- Codex project repo-managed 边界、只读 catalog 与共享 runtime 副作用隔离已经前后一致
- required config 顺序、`selectedScope` 写入层、lifecycle / config snapshot 接入和 rollback 恢复链路还保持成体系
- 交互式平台候选、缺少 `codex` executable 时的 repo-managed 可执行性、`auto` evidence-first 推断和 mixed refusal 规则都已经和当前基线接上
- 公共 `slashCommands`、manual-only skill、MCP quoted key、tracking `artifactKey`、status item-level 语义和 smoke/build/pack 验收项都还在计划里

## 复审结论

这版计划已经明显比上一轮稳，之前最影响落地的两处边界也确实修掉了。就当前基线承接性来看，Codex project scope 的 repo-managed 安装模型、shared runtime 隔离、`upgrade --all` target-level skip、interactive 平台解析、公共 `slashCommands`、MCP quoted key 和 tracking identity 这些主路径，已经基本写清楚，也具备落地空间。

现在还没完全收口的，主要是 `upgrade --all` 的稳定 `skipped[].code` 合同。它已经被定义成 direct command 返回值的一部分，但并不是每个保留下来的 code 都有清楚语义和完整回归。这个点如果不先收紧，后面实现出来以后，测试即使跑通，也不一定能证明机读合同真的稳定。

除了上面这 1 项，我这轮没有再发现新的结构性缺口。

## 测试覆盖评估

这版测试矩阵整体已经很完整，主链路基本都在：

- install / uninstall / explicit upgrade / `upgrade --all`
- status 的 default / verbose / JSON / debug
- interactive install / uninstall / upgrade
- repo skill、公共 `slashCommands`、manual-only skill、MCP quoted key、多 server、rollback、tracking-only evidence、required config、lifecycle/config snapshot、runtime env、smoke build/pack/plugin-scripts

但如果按“是否已经完全覆盖”来判断，我这轮还不能给完全通过，原因只剩这一处：

- `upgrade --all` 的 stable `skipped[].code` union 还没有完全定义完，也没有把每个保留 code 都用正向回归锁死

把这处再补平，这份计划就更适合直接进入实现拆分。
