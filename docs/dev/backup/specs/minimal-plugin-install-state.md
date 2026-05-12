# 插件安装状态最小化需求 Spec

日期：2026-05-07

## 背景

当前 AW 插件安装状态分散在多套持久数据里：`~/.aw/installed.json` 记录 ledger 和 scope record，平台目录里的 `.agent-workflows-manifest.json` 记录 generated artifacts，Codex user native 还有 recovery breadcrumb，动态 artifact 又把 refresh 结果、digest 和 reach 写回 tracking。`status`、主控制台、升级、卸载和 repair 路径需要在这些状态之间互相证明，维护成本越来越高，也让用户容易接触到 `ledger degraded`、tracking、breadcrumb、snapshot 等内部概念。

项目仍处于开发阶段，不需要兼容旧状态格式。本需求重设计安装状态模型，把持久状态压到最少：AW 只保存安全卸载、修复和重装所必需的归属信息；其它健康信息从当前文件、平台原生状态、current catalog 和少量可重建诊断缓存推导。插件文件被非预期修改导致损坏时，不维护复杂的半成功状态树，而是提供诊断、修复、清理和完全清理重装能力。

## 当前基线事实

- `InstalledLedger` 承担了安装事实、scope 初始化判断、能力快照、版本、安装选项继承、skill trigger 写入顺序、lifecycle/config snapshot 指针、依赖安装来源、canonical outgoing dependency edges 和全局 degraded 状态。
- `TrackingManifest` 原本用于精确卸载，现在也承载 dynamic artifact 的 `configDigest`、`contentDigest`、`lastRefresh`、`refreshReach` 等诊断状态。
- Codex user native 的 recovery breadcrumb 有存在价值，因为 `plugin/install` 成功后 Codex 已经写入 cache/config，而 AW 后续步骤仍可能失败；但当前状态枚举和诊断字段过细。
- 依赖能力已经进入当前实现基线：source/runtime `.agents-plugin/plugin.json` 保留 `dependencies.plugins`，写命令通过 dependency planner 和 graph write executor 处理拓扑顺序、安装来源、edge 延迟提交和卸载保护。
- `status` 和主控制台需要合并 current catalog、ledger、tracking、native evidence、install snapshot、config health、artifact health 和依赖投影，复杂度接近一个独立状态机。
- `install` 成功路径要依次写 native、snapshot、artifacts、lifecycle、tracking、ledger 和 dependency metadata；任意阶段失败都要维护多份状态的一致性。

## 已确认决策

- 不兼容旧 `installed.json` / tracking manifest / recovery breadcrumb 格式，不做自动迁移。
- scope 本地 per-plugin install record 是唯一安装真值；单个 record 损坏只影响对应插件和位置，不让同 scope 其它插件一起失忆。
- 维护一个极小的全局依赖索引，只保存已知 install record location、record digest 和 outgoing dependency edges 摘要。它不是安装真值，但会参与跨 scope incoming edge 保护。普通 `uninstall` 继续依赖可信索引做删除保护；`cleanup` 改为显式残留收口入口，只要 AW 能定位到要删的残留，并且没有已知 dependents，就允许继续执行。外部删除、仓库迁移或 project 私有状态被清掉形成的 stale project reference 不能被默认读命令静默裁剪，只能通过 `aw cleanup --dependency-index --prune-stale <token> --yes` 显式退休。
- 移除完整安装快照，但保留极小 historical lifecycle runtime 引用，只服务普通 `uninstall` 和需要先撤销历史副作用的 `repair` / `reinstall` 路径。它不参与安装真值、artifact 比对、dependency 判断或 config schema 解释；缺失或损坏时只影响卸载安全性和 repairability。
- 移除旧版 artifact snapshot 后，current catalog 只能作为“当前版本”的 artifact 真值。record 的 `source.manifestDigest` / `source.bundleFingerprint` 可用于判断 current catalog 是否仍是同一 bundle；如果不同，只能投影为 catalog drift / upgrade available，不能仅凭静态 artifact 不等于 current catalog 就判定内容损坏。
- 插件依赖已经是基线能力。安全卸载、升级、依赖引用保护和状态投影需要的安装来源与 canonical outgoing dependency edges 必须进入 scope 本地 per-plugin install record；`dependents`、`ref-count` 和未使用依赖提醒继续只从 edge 图现算，不作为持久真值。
- 保留 dynamic artifact 的诊断缓存，只记录只读判断所需的 accepted `state`、`disabledReason`、`configDigest`、`contentDigest`、`lastRefresh` 和 `refreshReach`。这些字段不进入 install record，也不作为安装真值；`disabledReason` 只服务诊断展示。
- project scope 下的 `.claude/.agent-workflows/`、`.codex/.agent-workflows/` 和 project local config store 是 AW 本地私有状态，不是应该提交的仓库内容；写入型命令需要保证这些 state 目录默认被忽略，receipt 和人类输出不能把它们当成用户项目文件更新来展示。project shared config store 是团队共享输入，允许影响 repo-visible project artifacts，不能默认忽略。
- project scope 的 repo-visible artifacts 可以随仓库共享；fresh clone 后本机缺少 install record 但仓库里已有可验证的 AW project artifacts 时，状态应显示为“可认领”而不是“有残留”。脚本化认领入口固定为 `aw repair --adopt-existing`，主控制台可以在展示风险后复用同一能力。
- project scope 的 repo-visible artifacts 需要随仓库提交一份极小的 shared identity metadata。它使用独立的 repo-stable shared locator 标识共享产物归属，不能复用本机 `PluginLocation.projectKey` 或由本机 location 生成的 `recordId`。metadata 只记录这批共享产物来自哪个 plugin source 以及可验证的 artifact identity / digest，不表达本机 ownership，也不是安装真值；它的作用是在 fresh clone、分支切换或 current catalog 漂移时，仍能把“合法旧共享产物”和“不可信残留”区分开。
- 不做自动依赖清理。父插件卸载或升级后，如果某个自动安装的依赖没有可信 incoming edge，只给用户提示；健康依赖由用户显式运行 `aw uninstall`，损坏或残留依赖才进入 `aw cleanup`。
- `aw uninstall` 继续作为正常卸载入口；新增 `aw diagnose`、`aw repair`、`aw cleanup`、`aw reinstall`。`cleanup` 只负责残留、marker-only 或损坏状态下的 AW-owned 清理，不替代正常卸载。主控制台复用这些能力。
- 默认 `aw status` 不执行 dynamic artifact renderer。`aw diagnose --deep` 可以执行 renderer；`aw repair` 只有在同一 bundle、marker-only install repair 或 `--adopt-existing` 等允许重新接受当前 artifact 的路径中执行 renderer。
- 共享配置文件损坏时提供 `aw cleanup --force`：先备份共享文件，再删除可定位的 AW-owned 区块；不能重写整份用户配置。
- 单个 install record 只保存自己的 `skillTriggerPreference`；跨 scope 写入顺序、胜者选择或 sibling drift 诊断不再作为安装真值。共享 skill trigger runtime 改为单 owner 合同：同一 plugin/platform 的 shared runtime 同一时间只允许一个 install location 控制，冲突时必须让用户显式接管，不能自动按时间顺序重选胜者。
- stale project reference 的索引修复 / 裁剪复用现有命令面：`aw diagnose` 报告 stale token，`aw repair --dependency-index` 重建可验证索引，`aw cleanup --dependency-index --prune-stale <token> --yes` 显式退休单条 stale 引用。
- shared runtime owner 的脚本化接管通过写命令 flag 表达：`aw install`、`aw repair`、单目标 `aw upgrade` 遇到 owner 冲突时默认失败，用户重跑同一条命令并加 `--takeover-shared-runtime` 才能接管。`upgrade --all` 不允许批量接管。
- 用户默认输出不暴露 ledger、tracking、breadcrumb、snapshot、degraded 等内部术语。

## 目标

1. 把安装真值收敛成 scope 本地 per-plugin install record，加短生命周期 native transaction marker。
2. 移除全局 `ledgerState=degraded` 对用户流程的影响，局部损坏只影响对应插件和位置。
3. `status` 默认只展示用户能理解的状态：已安装、未安装、需要修复、可认领、有残留、由其它来源管理。
4. `diagnose` 能说明哪些 AW-owned 文件缺失、漂移、不可解析，哪些 native 状态缺失或残留。
5. `repair` 能在 current catalog 与既有 record 仍是同一 bundle 时重新应用当前插件的 AW-owned artifacts，并在需要时重新执行平台 native install；catalog 已漂移时不把 repair 变成隐式 upgrade。
6. `uninstall` 能执行正常卸载，包含依赖保护、lifecycle、native uninstall、AW-owned artifact 删除和 install record 删除。
7. `cleanup` 能在残留、marker-only 或损坏状态下清理 AW 明确拥有的 artifacts、native registration 和 install record。
8. `reinstall` 提供“诊断后安全移除，再重新安装”的简单路径。
9. 依赖安装来源和 outgoing dependency edges 跟随当前 scope record 管理；全局依赖索引用于跨 scope 卸载保护、未使用依赖提醒和 status 依赖投影。
10. dynamic artifact、config refresh、skill trigger 偏好和 lifecycle 不再把安装真值膨胀成多份账本；historical lifecycle runtime 只保留安全卸载所需的最小运行面。

## 非目标

- 不读取或迁移旧 `installed.json` / tracking manifest。
- 不保证文件被用户手改后可以无损恢复用户修改；只保证 AW-owned 部分可以诊断、覆盖或清理。
- 不让 `status` 为展示健康而执行 lifecycle、renderer 或 native repair。
- 不持久化每一次 refresh 失败历史。dynamic diagnostic cache 只保留最后一次 refresh 摘要；完整失败详情进入 command receipt、stderr 和 debug log，后续可通过 `diagnose --deep` 重新计算。
- 不保留旧版跨 scope skill trigger drift 诊断。
- 不把 `dependents`、`ref-count`、`autoRemovable`、依赖健康结果或 catalog drift 结果持久化为安装真值。
- 不自动卸载引用归零的依赖；依赖是否继续保留由用户通过 `aw uninstall` 或损坏清理流程显式决定。
- 不用 historical lifecycle runtime 做安装真值、artifact 期望内容来源、config schema 来源或 dependency manifest 来源；它只用于判断卸载 lifecycle 能否安全执行。
- 不在 current catalog 已漂移且没有安装时 artifact truth 的情况下，可靠判断旧版静态 artifact 是否被手工改坏；这类内容健康只能降级为未知，并提示显式 upgrade / reinstall。

## Shared Skill Trigger Runtime Owner

当前产品仍把 `~/.aw` 当作本机共享 marketplace。Codex user scope 和 Claude native runtime 会共用同名插件的 runtime skill 文件；同一 plugin/platform 在多个 scope 或 project 中保存不同 `skillTriggerPreference` 时，共享 runtime 最终只能物化一个偏好。install record 本地化后，这个问题不会消失，只是不能再混进安装真值。

共享 runtime owner 状态落在 `~/.aw/shared-runtime-owners/<platform>/<pluginSlug>.<pluginHash>.json`。`pluginSlug` 使用和 `recordId` 相同的安全路径片段规则，`pluginHash` 至少取 `sha256(pluginName)` 的前 12 位；文件名不能只依赖 slug，也不能直接使用可能包含路径分隔符的原始包名：

```ts
interface SharedSkillTriggerRuntimeOwner {
  version: 1;
  pluginName: string;
  platform: 'codex' | 'claude';
  owner: PluginLocation;
  ownerRecordPath: string;
  ownerRecordDigest: string;
  preference: 'default' | 'manual' | 'auto';
  updatedAt: string;
}
```

要求：

- owner 状态只回答“谁可以写 shared runtime skill trigger 以及 refresh 时 replay 哪个 preference”，不是安装真值，不能证明插件已安装。
- `shared-runtime-owners/` 是 `~/.aw` runtime state，必须在 `aw init`、marketplace refresh、layout repair 和 `~/.aw` 原子替换时保留，并排除在 bundle fingerprint / layout freshness 判断之外。
- Codex project scope 的 repo-local skill trigger 不参与 shared runtime owner 合同；它只按当前 project record 写 `.agents/skills/<skill>/agents/openai.yaml`。
- 首个会影响 shared runtime 的 install location 在没有 owner 时，可以在 record 成功提交后成为 owner。owner record 后续 install / repair / upgrade 可以更新 shared runtime 和 owner digest。
- 非 owner location 可以安装自己的 record，但默认不能改变 shared runtime。只要命令会改变 shared runtime 语义，脚本命令必须失败并提示用户用同一条写命令加 `--takeover-shared-runtime` 显式接管；主控制台可以在展示当前 owner 后让用户确认接管。
- 显式接管必须写入新的 owner 状态并 replay 新 owner 的 preference。旧 owner record 如果仍可读取，应保留原 record，只失去 shared runtime 控制权；如果旧 owner 不可读或损坏，接管前必须把风险写进诊断和 receipt。
- install、upgrade 或带 `--takeover-shared-runtime` 的写命令中，owner 状态更新必须和对应 record 提交排序：record 成功提交前只能使用可回滚的 staging / backup；record 失败时必须恢复旧 owner 状态和旧 shared runtime，或者在没有旧 owner 时恢复 embedded 默认。
- `aw init`、marketplace refresh 或 `~/.aw` 替换后，只 replay owner 状态记录的 preference。owner record digest 无法验证时，不自动从其它 record 重选；命令应保留 embedded 默认或当前 staging 默认，并提示运行 diagnose / repair，必要时用 `--takeover-shared-runtime` 显式接管。
- owner 被 uninstall 或 cleanup 删除时，必须删除 owner 状态，并把 shared runtime skill trigger 恢复到 embedded 默认。剩余非 owner record 不自动接管；如果用户希望其中一个位置继续控制 runtime，需要在单目标写命令中加 `--takeover-shared-runtime`。
- owner upgrade 只有在新 record 成功提交后才能更新 owner digest 和 preference。upgrade 失败时，旧 owner 状态必须仍指向旧 record；如果无法验证旧 record，status 显示需要处理。
- `--takeover-shared-runtime` 只对单个明确 plugin/platform/scope/project target 生效；它不能用于 `upgrade --all`，也不能因为一个 target 接管而顺带改变其它 platform/plugin 的 owner。

## 状态模型

状态来源分成九层：

1. **Current catalog**
   当前插件 manifest、`dependencies.plugins`、平台支持范围、静态 artifacts、动态 artifact targets、config schema 和 lifecycle 声明的真值。它只代表当前可安装版本；当既有 record 的 `source` 与 current catalog 不一致时，current catalog 可以证明有升级可用，但不能单独证明旧版静态 artifact 已损坏。

2. **平台现场**
   Claude / Codex 原生插件状态、用户或项目目录下的实际文件、Codex cache、Codex config、Claude settings 等。运行时是否真的可用，以现场为准。

3. **Project artifact shared identity**
   project scope 随仓库提交的最小共享身份线索。它用 repo-stable shared locator 证明 repo-visible artifacts 原本由哪个 plugin source 写入，并给出可验证 artifact identity / digest；它不能证明本机已安装，也不能单独授权卸载或清理。

4. **Scope 本地 per-plugin install record**
   AW 的最小归属记录。它只回答“这个插件在这个位置由 AW 管理了哪些对象，必要安装选项是什么，以及它作为 dependent 记录了哪些 outgoing dependency edges”。它不是健康状态数据库。

5. **Dynamic artifact diagnostic cache**
   动态 artifact 的只读诊断缓存。它记录上一次成功接受的 artifact state / digest，以及最后一次 refresh 的 reach / 失败摘要，让默认 `status` 和 `diagnose` 不执行 renderer 也能判断 disabled、drift、stale 和最近 refresh 失败。缓存损坏或缺失不能让安装状态失真，只能降低诊断确定性。

6. **Historical lifecycle runtime**
   安装时保存的最小历史 lifecycle 运行面。它只让后续普通 `uninstall` 能按安装时 bundle 运行 `scripts.lifecycle.uninstall`，也让 `repair` / `reinstall` 在需要先撤销历史副作用时不误用新版 catalog。它不是 install snapshot，不能解释 artifacts、config 或 dependency 健康。

7. **Global dependency index**
   跨 scope incoming edge 的安全索引。它从 per-plugin install record 重建，只用于依赖保护、未使用依赖提醒和汇总视图，不代表安装成功。涉及可能被其它 scope 依赖的位置时，索引不可用必须阻止删除。

8. **Shared skill trigger runtime owner**
   共享 runtime skill trigger 的单 owner 控制状态。它只决定谁可以写共享 runtime、`aw init` / marketplace refresh replay 哪个 preference，以及 owner 删除后是否需要恢复默认；它不是安装真值，也不从其它 record 自动选胜者。

9. **Native transaction marker**
   只在外部 native write 已成功，但 AW install record 尚未成功提交时短暂存在。它只用于授权后续修复或清理，不代表安装成功。

## Install Record

### 落盘位置

安装真值按插件和 location 拆成独立 record 文件，避免单个 scope manifest 损坏时影响同 scope 所有插件：

- Claude user：`~/.claude/.agent-workflows/records/<recordId>.json`
- Claude project：`<project>/.claude/.agent-workflows/records/<recordId>.json`
- Codex user：`~/.codex/.agent-workflows/records/<recordId>.json`
- Codex project：`<repo>/.codex/.agent-workflows/records/<recordId>.json`

`recordId` 必须从 canonical `PluginLocation` 稳定生成，建议使用可读 `pluginSlug` 加短 hash，例如 `<pluginSlug>.<sha256(location).slice(0,12)>`，避免 scoped package、空格或路径分隔符污染文件名。record 文件内容必须自带完整 location，不能只依赖文件名推导身份。这里的 `PluginLocation.projectKey` 是本机 install record / dependency index 的 location 身份，可以来自本机 canonical path；它不能写入 repo-visible project artifact shared identity，也不能用于生成 shared identity 文件名。

### Project Scope 仓库可见性

project scope 的 install record 和 diagnostic cache 虽然落在项目目录里，但它们仍是 AW 的本地私有状态，语义等同旧版 tracking / ledger 辅助文件，不作为团队协作或模板项目的共享输入。install record 和 diagnostic cache 可以被删除后由 `aw repair`、`aw repair --adopt-existing`、`aw reinstall` 或后续写入命令重建。删除这些文件只会降低 AW 对该 location 的归属和诊断确定性，不应被解释为用户项目源文件变更。

project config 拆成 shared / local 两层；下文提到的 project artifact render config，指 manifest default 与 project shared config store 中可共享键的合并结果：

- project shared config store：`.agent-workflows/plugin-config/<plugin>/config.json`。这是团队共享输入，可以提交到仓库；凡是会影响 repo-visible project artifacts 的可共享配置键，只能从 shared store 读取。
- project local config store：`.agent-workflows/plugin-config.local/<plugin>/config.json`。这是 AW 本地私有状态，默认忽略提交；它可以服务本机读命令、交互式默认值、lifecycle/helper 或未来 local-only 能力，但不能参与 repo-visible project artifact 渲染、digest、stale 判断或 refresh。

user config store 和 project local config store 都是本机私有输入，不能改写团队共享的 project artifacts。project scope 的 artifact render config 只允许合并 manifest default 和 project shared config store 中的可共享键；读命令面向用户展示 project-scope effective config 时，优先级固定为 manifest default < user config store < project shared config store < project local config store。人类输出和 JSON 都必须区分 default、user、project shared value、project local override 和 effective value，不能把 user / local override 当成 artifact truth。

`file` / `directory` 类型是本机路径型配置，现阶段不能进入 project shared config store，也不能参与 project-scope repo-visible artifact 的 render config、digest、stale 判断或 refresh。project scope 下，这类 key 只能写 user config store 或 project local config store，并按本机 realpath 校验；如果未来需要可提交的路径语义，必须另行定义 repo-relative 或 portable path envelope，不能复用当前 `file` / `directory` 的绝对 realpath 语义。即使 schema 为路径型 key 提供 default，project-scope repo-visible renderer 也不能把它解析成绝对 realpath 后纳入共享 artifact truth；如果 project artifact 渲染对这类 key 必填或声明为 refresh key，project install / repair / upgrade / config refresh 的预检应失败，并提示插件作者改用可移植字符串配置，或把该行为放到 lifecycle/helper 等本机 effective config 场景。

project scope 的 lifecycle 和 config helper 读取本机 effective config：manifest default < user config store < project shared config store < project local config store。这个 effective config 可以包含本机路径型配置，也可以因为本机路径失效而让 lifecycle/helper fail closed；但这些本机值不得触发 repo-visible project artifact refresh，也不得改变 project artifact identity、config digest 或 stale 判断。

仓库内真正需要共享的运行时文件是各平台明确写入的 plugin artifacts，例如 `.agents/skills/`、`.codex/config.toml`、`.codex/hooks.json` 或 `.claude/rules/`，以及 AW 随这些 artifacts 写入的最小 shared identity metadata。团队成员 fresh clone 后，可能已经拥有这些 repo-visible artifacts 和 identity metadata，但没有自己的本机 install record；这是一种合法的“可认领”状态，不是默认需要清理的残留。

要求：

- `.claude/.agent-workflows/`、`.codex/.agent-workflows/` 和 `.agent-workflows/plugin-config.local/` 默认进入 project `.gitignore` 或等价 ignore 规则；`.agent-workflows/plugin-config/` 和 `.agent-workflows/project-artifacts/` 不能被默认忽略。仓库模板、测试 fixture 和公开文档也要同步使用这些忽略规则。
- project-scope `install`、`repair`、`upgrade`、`reinstall`、`aw config --scope project --local`，以及会写 project-scope diagnostic cache 的 config refresh，在首次创建这些 private state / local config 目录前应确保 ignore 规则存在；如果未来某个 `aw init` 变体实际创建 project state 目录，也必须遵守同一规则。如果无法安全更新 ignore 文件，命令可以继续，但必须在 receipt / stderr 中给出明确 warning 和建议追加的精确 pattern。
- 写入 project shared config 前必须检查目标路径没有被 project ignore 规则覆盖；如果该路径会被忽略，命令应在刷新任何 repo-visible artifact 前失败，并提示修正 ignore 规则或改用 `--scope project --local` 写入本机覆盖。
- 写入 project artifact shared identity metadata 前，也必须检查 `.agent-workflows/project-artifacts/<platform>/<sharedIdentityId>.json` 没有被 project ignore 规则覆盖；如果该路径会被忽略，project-scope `install`、`repair`、`upgrade`、`reinstall` 和会刷新 repo-visible artifacts 的 config write 必须在第一笔 repo-visible artifact 写入前失败，并提示命中的 ignore pattern、建议保留 `.agent-workflows/project-artifacts/` 可提交，以及本次未写入共享 artifacts。
- `status` 和默认 `diagnose` 保持只读，不能为了补 ignore 规则而修改仓库。
- 默认人类输出可以说明“更新了 AW 本地状态”或“更新了 AW 本机项目配置”，但不能把 `records/*.json`、`diagnostics/*.json`、`.agent-workflows/plugin-config.local/<plugin>/config.json` 归入需要提交的项目文件、插件 artifact 或团队共享配置。JSON receipt 可以列出这些 state/config 文件，字段应标记为 `privateState` / `ignoredState` 一类机器语义。
- 更新 `.agent-workflows/plugin-config/<plugin>/config.json` 时，人类输出和 JSON receipt 必须把它归为 project shared config，而不是 private state；如果该 shared config 影响 repo-visible artifacts，receipt 需要同时列出被刷新或需要刷新的 artifacts。
- 这些 private state / local config 文件不得作为跨机器共享的唯一真值。团队成员在同一仓库中各自安装插件时，由各自本机的 project-scope record 表达本机 AW ownership。

### Project Artifact Shared Identity

project scope 每次写入、刷新或删除 repo-visible artifacts 时，都要同步维护 repo-visible identity metadata。规范路径为：

```text
<repo>/.agent-workflows/project-artifacts/<platform>/<sharedIdentityId>.json
```

`sharedIdentityId` 必须从 canonical `ProjectArtifactSharedLocator` 稳定生成，建议使用可读 `pluginSlug` 加短 hash，例如 `<pluginSlug>.<sha256(locator).slice(0,12)>`。locator 只能由仓库内稳定信息组成：plugin name、platform、project scope 和 repo-relative project root。Codex project scope 通常使用 `repoRelativeProjectRoot: "."`；Claude project scope 按实际 project target 计算，仓库根目录为 `.`，仓库子目录为相对 repo root 的路径。路径分隔符统一为 `/`，不能为空，不能是绝对路径，不能包含 `..`，也不能使用 realpath、home directory、cwd 或 `PluginLocation.projectKey`。

```ts
interface ProjectArtifactIdentityFile {
  version: 1;
  sharedIdentityId: string;
  locator: ProjectArtifactSharedLocator;
  source: {
    pluginVersion: string;
    manifestDigest: string;
    bundleFingerprint: string;
  };
  generatedAt: string;
  artifacts: ProjectArtifactIdentityArtifact[];
}

interface ProjectArtifactSharedLocator {
  plugin: string;
  platform: 'codex' | 'claude';
  scope: 'project';
  repoRelativeProjectRoot: string;
}

interface ProjectArtifactIdentityArtifact {
  kind: 'instruction' | 'permission' | 'hook' | 'agent' | 'skill' | 'mcpServer';
  platform: 'codex' | 'claude';
  path: string;
  paths?: string[];
  artifactKey?: string;
  hookGroups?: TrackedHookGroupIdentity[];
  id?: string;
  target?: string;
  roleKey?: string;
  ownershipMarker?: string;
  state?: 'present' | 'disabled';
  contentDigest?: string;
}
```

要求：

- identity metadata 是 project shared input，可以提交到仓库；它不是本机 private state，不能被默认 ignore。
- identity metadata 不表达“这台机器已经由 AW 管理”。本机安装真值仍只能来自 project-scope install record。
- identity metadata 的文件名和内容都不得直接复用本机 `PluginLocation`，也不得保存本机 `projectKey`、`recordId`、绝对路径或 symlink-resolved realpath。fresh clone、换机器或同一仓库移动到不同绝对路径后，同一 shared locator 必须命中同一个 identity 文件。
- identity metadata 写入前必须通过 repo-visible path ignore preflight。命令不能先写项目 artifact、再发现 identity path 被 ignore；否则会留下本机看似成功、团队 fresh clone 却丢失 shared identity 的状态。
- `aw repair --adopt-existing` 认领共享产物时，应按当前机器的 `PluginLocation` 创建本机 install record；它通过 `ProjectArtifactSharedLocator` 和 artifact identity 对齐共享产物，不能要求 identity metadata 中的本机 location 与当前 `projectKey` 匹配。
- `source.manifestDigest` 和 `source.bundleFingerprint` 只用于证明 repo-visible artifacts 的来源版本，以及判断 current catalog 是否仍指向同一 bundle；它们不能代替 current catalog，也不能让旧 bundle 成为新的 artifact 生成真值。source 与 current catalog 不一致时，读路径只能标记 catalog drift / upgrade available，不能因此把旧版 artifact 判成 content drift。
- artifact identity 必须覆盖 repair / cleanup 需要定位的最小信息：完整文件 path、shared file marker / block identity、skill / MCP artifactKey、hook group identity、dynamic artifact id + target + state 等。`contentDigest` 是当前已接受 artifact 内容或 AW-owned block 的校验辅助；它不能代替 current catalog 生成期望内容。
- dynamic artifact 被 shared config refresh 后，如果 repo-visible artifact 内容或 accepted state 变化，必须同时更新 identity metadata。project local config 或 user config 不得改变 project artifact identity metadata。
- install、repair、upgrade、reinstall 成功写入 project repo-visible artifacts 后，必须用 current catalog 的 source 和当前 accepted artifacts 重写 identity metadata。
- uninstall / cleanup 删除 project repo-visible artifacts 时，必须同时删除对应 identity metadata；如果 artifact 已经不存在但 identity metadata 仍可安全对齐，cleanup 可以删除该 metadata。
- identity metadata 缺失时，fresh clone 仍可以尝试用 current catalog、稳定 artifact identity 或 AW-owned marker 判定“可认领”；但一旦 current catalog 已漂移且缺少 identity metadata，不能把旧共享产物稳定归类为可认领，只能降级为残留或归属不明。
- identity metadata 存在但无法解析、shared locator 与当前 project target 不匹配、source 字段缺失、artifact path 越界，或实际 artifacts 与 identity / digest 明显不符时，不能认领；`status` / `diagnose` 应报告共享身份线索损坏或漂移，并提示 repair / cleanup / reinstall。
- identity metadata 与 actual artifacts 匹配，但 `source` 不同于 current catalog 时，`status` 仍应把它归为“可认领”，并在 verbose / JSON 中标记 catalog drift。默认下一步仍是 `aw repair --adopt-existing`，但输出必须说明接管会按 current catalog 重新应用共享 artifacts 并更新 identity metadata。

### Record 结构

install record 文件使用版本化 envelope：

```ts
interface InstallRecordFile {
  version: 2;
  recordId: string;
  record: InstallRecord;
}
```

单条 record 只包含最小归属信息：

```ts
interface InstallRecord {
  pluginName: string;
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
  projectKey?: string;
  installedAt: string;
  updatedAt: string;
  source: {
    pluginVersion: string;
    manifestDigest: string;
    bundleFingerprint: string;
  };
  installSource: InstallRecordInstallSource;
  options?: {
    skillTriggerPreference?: 'default' | 'manual' | 'auto';
  };
  native?: {
    pluginId: string;
    installedByAw: boolean;
  };
  lifecycle?: HistoricalLifecycleRuntimeRef;
  artifacts: InstallRecordArtifact[];
  dependencyEdges: InstallRecordDependencyEdge[];
}
```

`installSource` 和 `dependencyEdges` 是依赖能力引入后的最小必要状态：它们用于卸载保护、未使用依赖提醒、重复 install / upgrade 时刷新依赖引用，以及 status 的依赖只读投影。没有依赖的插件也必须写 `dependencyEdges: []`，避免读路径把缺字段误判为旧格式或不可信状态。

`lifecycle` 是安全卸载的最小历史运行面引用，只在安装时 bundle 声明 lifecycle 时写入。它允许 AW 在 current catalog 已升级、缺失或 lifecycle 路径变化后，仍按安装时 bundle 运行卸载脚本；它不能被其它读路径当作安装快照使用。

```ts
interface HistoricalLifecycleRuntimeRef {
  runtimeRoot: string;
  bundleRoot: string;
  manifestPath: string;
  pluginVersion: string;
  sourceManifestDigest: string;
  bundleFingerprint: string;
  events: Array<'install' | 'upgrade' | 'uninstall'>;
  createdAt: string;
}
```

实现可以首版用 content-addressed 的历史 bundle copy 承载 `bundleRoot`，因为 lifecycle 入口可能依赖相对文件和 runtime dependencies。后续如果能可靠抽取静态闭包，也可以收缩为更小的 runtime closure；无论哪种形式，都必须满足 digest / fingerprint 校验，并且不能把该历史 bundle 暴露为 current catalog 或 status truth。

```ts
interface InstallRecordInstallSource {
  kind: 'explicit' | 'dependency';
  explicitlyRequested: boolean;
}

interface InstallRecordDependencyEdge {
  dependency: PluginLocation;
  declaration: {
    name: string;
    target?: {
      scope?: 'user' | 'project';
    };
    inheritInstallOptions?: boolean;
    when?: {
      platforms?: Array<'codex' | 'claude'>;
    };
  };
}

interface PluginLocation {
  plugin: string;
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
  projectKey?: string | null;
}
```

`installSource` 把“来源”和“当前是否显式保留”分开表达：

- `kind` 表示这条 record 最初由用户显式目标创建，还是作为依赖自动创建。它是来源标记，不因后续保留动作改写。
- `explicitlyRequested` 表示当前位置当前是否被用户显式保留。fresh explicit install、`aw repair --adopt-existing` 创建的本机 record、显式 `aw upgrade <plugin>` 的目标，以及主控制台等价的“保留”动作都写 `true`；依赖自动安装的 fresh record 写 `false`。
- 自动依赖后来被用户显式安装、显式升级或选择保留时，保留原 `kind: "dependency"`，只把 `explicitlyRequested` 置为 `true`。这样 status 仍能说明它最初是自动依赖，卸载和未使用提醒又能知道用户已经显式保留。
- 缺少既有 record 时，用户显式写命令创建的新 record 写 `{ kind: "explicit", explicitlyRequested: true }`。

edge 的 dependent location 由当前 record 隐含，不需要在每条 edge 里重复落盘。edge declaration 保存安装当时生效的依赖声明摘要，用来判断当前安装健康层是否自洽，并与 current catalog 做 drift 对比；这不是完整 manifest snapshot。

artifact identity 必须足以安全修复和清理：

```ts
interface InstallRecordArtifact {
  kind: 'instruction' | 'permission' | 'hook' | 'agent' | 'skill' | 'mcpServer';
  platform: 'codex' | 'claude';
  path: string;
  paths?: string[];
  artifactKey?: string;
  hookGroups?: TrackedHookGroupIdentity[];
  id?: string;
  target?: string;
  roleKey?: string;
  ownershipMarker?: string;
}
```

install record 不得包含：

- `ledgerState`、`degradedAt`、`degradedReason`
- `scopeInitialized`
- `capabilitySnapshot`
- `lastRequestedScope`、`lastRequestedAt`
- `sharedNativeRefs`
- `skillTriggerWriteOrder`
- `dependents`、`refCount`、`autoRemovable`、`unusedDependencyHint`
- `dependencies.satisfied`、`dependencies.missing`、`dependencies.catalogDrift`
- `lastRefresh`、`refreshReach`
- `configDigest`、`contentDigest`
- 完整 install snapshot、capability snapshot、config snapshot 或 artifact health snapshot metadata。record 可以包含上文定义的 `lifecycle` 引用，但只能用于 historical lifecycle 运行。

## Dynamic Artifact Diagnostic Cache

dynamic artifact 的 digest / refresh 元数据不进入 install record，但需要作为独立诊断缓存保留。缓存文件按同一个 `PluginLocation` 分片，建议落在对应 scope 的 AW state 目录：

- Claude user：`~/.claude/.agent-workflows/diagnostics/<recordId>.json`
- Claude project：`<project>/.claude/.agent-workflows/diagnostics/<recordId>.json`
- Codex user：`~/.codex/.agent-workflows/diagnostics/<recordId>.json`
- Codex project：`<repo>/.codex/.agent-workflows/diagnostics/<recordId>.json`

缓存只保存 dynamic artifact 的只读诊断信息：

```ts
interface DynamicArtifactDiagnosticCache {
  version: 1;
  recordId: string;
  location: PluginLocation;
  updatedAt: string;
  artifacts: DynamicArtifactDiagnosticEntry[];
}

interface DynamicArtifactDiagnosticEntry {
  id: string;
  target: string;
  state: 'present' | 'disabled';
  disabledReason?: string;
  artifactKey?: string;
  roleKey?: string;
  refreshKeys?: string[];
  configDigest?: string;
  contentDigest?: string;
  lastRefresh?: {
    status: 'success' | 'failed';
    at: string;
    event: 'install' | 'upgrade' | 'repair' | 'config';
    error?: string;
  };
  refreshReach?: {
    commandScope: 'user' | 'projectShared';
    refreshedUserTarget?: boolean;
    refreshedCurrentProjectTarget?: boolean;
  };
}
```

要求：

- 缓存只由 install / upgrade / repair / config refresh 写入；`status` 和默认 `diagnose` 只能读取。
- 缓存中的 `state`、`disabledReason`、`configDigest` 和 `contentDigest` 描述最近一次成功接受的 artifact 结果。最后一次 refresh 失败只能更新 `lastRefresh` / `refreshReach` 的失败摘要，不能覆盖上一份 accepted state 或 digest。
- 默认 `status` 和 `diagnose` 不执行 renderer。静态 artifact 只有在 current catalog 与 record `source.manifestDigest` / `source.bundleFingerprint` 能证明同一 bundle 时，才可以直接和 current catalog 比较并把差异判为 content drift；如果 source 不一致，只标记 catalog drift / upgrade available，不能仅凭不同于 current catalog 把旧版 artifact 判成损坏。dynamic artifact 默认先读取缓存中的 accepted `state`。`state: "present"` 时，用 `contentDigest` 对比现场文件 digest，用 `configDigest` 对比当前 render config digest；project scope 的当前 render config 只能来自 project artifact render config。`state: "disabled"` 时，目标内容缺失不是损坏，只读取 `disabledReason` 作诊断展示，并继续用 `configDigest`、`lastRefresh` 和 `refreshReach` 判断是否 stale 或最近 refresh 失败。
- 缓存缺失、损坏或 entry 无法和当前 record artifact identity 对齐时，不能臆测 dynamic drift；默认输出应提示运行 `aw diagnose --deep`。只有 current catalog 与 record source 是同一 bundle，或目标处于 marker-only install repair / `--adopt-existing` 路径时，才可以说明 `aw repair` 能重新接受当前 dynamic artifact 并刷新缓存；不能把缓存不可用本身当作已损坏结论。JSON 可标记为 `dynamicDiagnosticUnavailable`。
- `aw diagnose --deep` 可以执行 renderer，计算 current catalog 下的当前期望内容。`aw repair` 只有在同一 bundle、marker-only install repair 或 `--adopt-existing` 路径中可以执行 renderer；成功后刷新缓存。record source 已漂移的普通 repair 不能用 current renderer 输出覆盖旧版 artifact 诊断缓存。
- config refresh 失败不得写入 install record，但可以更新 diagnostic cache 的最后失败摘要，用于后续只读诊断。
- 删除 install record 时应同时删除对应 diagnostic cache；如果 cache 删除失败，只给 warning，不得让正常卸载或清理回滚已完成删除。

## Global Dependency Index

`~/.aw/dependency-index/index.json` 维护极小的全局依赖索引，用来补足 per-scope record 无法天然看到其它 repo 的问题。索引不是安装真值，不能单独证明某个插件已安装；它只帮助命令知道“还应该读取哪些 record 来建立 incoming edge 图”。

建议结构：

```ts
interface GlobalDependencyIndex {
  version: 1;
  updatedAt: string;
  records: GlobalDependencyIndexRecord[];
}

interface GlobalDependencyIndexRecord {
  location: PluginLocation;
  recordPath: string;
  recordDigest: string;
  installSource: InstallRecordInstallSource;
  dependencyEdges: InstallRecordDependencyEdge[];
  lastSeenAt: string;
}
```

要求：

- install / repair / upgrade / uninstall / cleanup 成功提交或删除 record 后，都应刷新索引；刷新失败只给 warning，不影响已经完成的安装状态提交。
- `dependency-index/` 是 `~/.aw` runtime state，必须在 `aw init`、marketplace refresh、layout repair 和 `~/.aw` 原子替换时保留，并排除在 bundle fingerprint / layout freshness 判断之外。
- 使用索引做删除保护前，命令必须尽量重新读取索引中相关 record，并校验 `recordDigest` 或可接受的新 digest。索引和 record 不一致时，以 record 为准并刷新索引；无法读取或无法确认覆盖范围时，对删除类命令 fail closed。
- 当前 project-scope 目标只需要当前 project 可定位 records 和索引中同 `projectKey` 的 verified records；这里的 `projectKey` 仍是本机 location 身份，只能用于本机 install record / dependency index 之间的安全比对，不能和 project artifact shared identity 的 shared locator 混用。user-scope 目标可能被任意 project scope 依赖，必须依赖可信全局索引确认没有 incoming edge。
- 全局索引缺失、损坏或覆盖范围不可信时，`status` 仍可从当前可定位 scope 的 record 判断本地安装，但不得展示“没有可信引用”的未使用依赖提醒。
- 全局索引缺失、损坏或覆盖范围不可信时，`uninstall` / `cleanup` 不能删除可能被其它 scope 引用的目标，必须提示先修复或重建依赖索引。
- 索引丢失后，命令只能从当前可定位 scope 重建部分索引；部分索引不能用于跨 repo 删除授权。`diagnose` 必须说明当前索引覆盖范围不足；如果还有已知 project locations，列出需要重新访问或 repair 的位置，否则提示用户到可能相关的 repo 重新运行诊断或 repair 以重新登记记录。
- 索引中的 project-scope record 无法重新读取时，`status --verbose` / `--json` 和 `diagnose` 必须区分原因。`recordPath` 存在但读取、解析、digest 校验或 location identity 校验失败时，标记为 `unreadableProjectReference`，继续 fail closed；`recordPath` 不存在、project AW state 目录不存在，或能证明 project root 已不存在时，只能标记为 `staleProjectReference` 候选，仍然阻止删除，直到用户显式退休该索引引用。
- stale project reference 的退休入口固定为 `aw cleanup --dependency-index --prune-stale <token> --yes`。它只允许删除全局依赖索引里的历史条目，不能删除 project artifacts、project shared/local config store、install record、diagnostic cache 或 historical lifecycle runtime。`token` 必须由 `diagnose` / verbose status 生成，并绑定 project location、record path 和当时的 index digest；命令必须在 receipt 中列出 retired entries。权限错误、临时 IO 错误、record 损坏或 digest mismatch 不能当作 stale 自动退休，必须提示用户回到对应 project 运行 diagnose / repair / cleanup，或先修复文件权限。
- 全局索引不得保存 `dependents`、`refCount`、`autoRemovable` 或健康结果；这些仍从 verified outgoing edges 实时推导。

## Historical Lifecycle Runtime

historical lifecycle runtime 的规范落盘根目录是 `~/.aw/lifecycle-runtimes/`。首版可以用 content-addressed bundle copy 承载运行面，建议路径形态为：

```text
~/.aw/lifecycle-runtimes/<platform>/<scope>/<scopeKey>/<recordId>/<runtimeId>/
```

其中 `runtimeRoot` 指向 `<runtimeId>/`，`bundleRoot` 必须位于 `runtimeRoot` 内，`manifestPath` 必须位于 `bundleRoot` 内。`scopeKey` 对 user scope 使用稳定常量，对 project scope 使用 canonical project key 的安全路径片段。`runtimeId` 必须由 manifest digest、bundle fingerprint 和唯一写入 nonce 生成，避免同一次 upgrade 中的新旧 runtime 互相覆盖。

要求：

- `lifecycle-runtimes/` 是 `~/.aw` runtime state，必须在 `aw init`、marketplace refresh、layout repair 和 `~/.aw` 原子替换时保留，并排除在 bundle fingerprint / layout freshness 判断之外。
- runtime 内容只能由 install / repair / upgrade / reinstall 写入；`status` 和默认 `diagnose` 只读校验。
- install 或 upgrade 在新 record 成功提交前，不能删除旧 record 引用的 runtime。升级失败时，旧 runtime 必须仍可供普通 `uninstall` 使用。
- record 删除成功后，应删除它引用的 runtime；删除失败只给 warning，后续由 GC 收口。
- GC 只允许删除没有任何 verified install record 引用的 runtime。读取 record 或全局依赖索引失败、无法确认 project record 覆盖范围，或 runtime identity 无法和 record ref 安全比对时，GC 必须 fail closed，保留 runtime。
- 当前命令失败后产生的 staging runtime 可以立即删除；已经 move 到最终 `lifecycle-runtimes/` 下但没有成功 record 引用的 runtime，只能由显式 cleanup 或满足上条条件的 GC 删除。

## Native Transaction Marker

Codex user native install 仍有跨系统非原子问题：`plugin/install` 成功后 Codex 已经写入 cache/config，但 AW 后续写 artifacts 或 record 可能失败。这里保留短生命周期 marker。

marker 落在 `~/.aw/native-recovery/codex/user/<pluginId>.json`，文件格式使用本 spec 的 `NativeTransactionMarker` envelope；旧 breadcrumb 格式不兼容，也不做迁移。

marker 只包含：

```ts
interface NativeTransactionMarker {
  version: 1;
  pluginName: string;
  pluginId: `${string}@aw`;
  platform: 'codex';
  scope: 'user';
  operation: 'install' | 'uninstall';
  nativeWriteSucceeded: true;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}
```

marker 不包含复杂状态枚举。用户只需要理解为“Codex 侧已经写入，但 AW 没完成收尾”。

要求：

- 只在 Codex `plugin/install` 或 `plugin/uninstall` 已成功返回后写入。
- 成功提交 install record 后必须删除 install marker。
- 成功清理 native 残留后必须删除 uninstall marker。
- marker 存在时，`status` 显示需要处理。
- marker-only 状态允许 `repair` 或 `cleanup`，不允许 `upgrade`。
- marker 必须独立于 install record 文件读取；record 文件损坏不能导致 marker 丢失。
- `native-recovery/` 是 `~/.aw` runtime state，`aw init`、marketplace refresh、layout repair 或 `~/.aw` 替换流程不能删除未收口 marker，也不能把 marker 纳入 bundle fingerprint / layout freshness 判断。

## `~/.aw` Runtime State 保留合同

`~/.aw` 同时承载 marketplace bundle 和 AW 自管 runtime state。bundle refresh 只能替换 `.agents/`、`.claude-plugin/`、`plugins/` 等发布内容，不能把 runtime state 当成脏 bundle 文件删除。

以下目录必须纳入同一份集中 allowlist；preserve、bundle fingerprint ignore 和 layout freshness 判断必须共用这份 allowlist，避免某个命令漏保留新状态：

- `plugin-config/`
- `dependency-index/`
- `lifecycle-runtimes/`
- `native-recovery/`
- `shared-runtime-owners/`

新增任何落在 `~/.aw` 下的 runtime state 时，必须同步定义：

- 规范落盘路径和文件 envelope。
- 哪些命令可以写入或删除。
- `aw init`、marketplace refresh、layout repair、`~/.aw` 原子替换时的保留规则。
- 是否排除在 bundle fingerprint 和 layout freshness 判断之外；默认应排除。
- GC 触发边界；除当前命令的临时 staging 外，不能在缺少可信 ownership / reference 证明时删除。

## 命令行为

### `aw install`

安装流程：

1. 从 current catalog 解析用户显式插件和目标 platform/scope；`--platform auto` 仍先按显式目标决定，不让依赖反向影响平台选择。
2. 用 dependency planner 展开当前 platform 生效的依赖图，节点身份是 `(plugin, platform, scope, projectKey)`；已健康满足的依赖不重复安装，但父插件成功后要写 outgoing edge。
3. 做整张图的只读预检：平台支持、project installability、外部 ownership、必填 config、目标文件冲突、role/MCP namespace、依赖安装选项冲突、project shared config / project artifact identity 的 repo-visible path ignore 检查等都必须在第一笔写入前完成。project artifact 会读取的必填配置只能来自 project artifact render config，不能用 user 或 project local 私有覆盖绕过预检；路径型 `file` / `directory` key 不能作为 repo-visible project artifact 的必填共享输入。
4. 按拓扑顺序执行写入节点：依赖先写，dependent 后写。
5. 对每个需要 native runtime 的节点，执行平台 native install。
6. 如果 Codex user native install 成功，立刻写 native transaction marker。
7. 写入或覆盖该节点的 AW-owned artifacts；project scope 同步写入 repo-visible identity metadata；dynamic artifact 在 install 中可以执行 renderer，并在成功应用后刷新 diagnostic cache。
8. 如果安装时 bundle 声明 lifecycle，持久化 historical lifecycle runtime，并记录 digest / fingerprint / events；该 runtime 只供后续历史 uninstall 使用。
9. 运行 install lifecycle。install lifecycle 使用本次 current catalog 解析出的 bundle；成功后 record 引用第 8 步的 historical lifecycle runtime。
10. 写入该节点的 scope 本地 per-plugin install record；自动依赖 fresh record 写 `{ kind: "dependency", explicitlyRequested: false }`，用户显式目标 fresh record 写 `{ kind: "explicit", explicitlyRequested: true }`。如果目标已存在且最初是自动依赖，本次又被用户显式安装，只把 `explicitlyRequested` 置为 `true`，不把 `kind` 改成 `explicit`。
11. dependent 节点成功后，随它的 record 提交 canonical outgoing dependency edges；dependent 失败前不能提前提交 edge。
12. 删除 native transaction marker。
13. 刷新全局依赖索引；索引刷新失败只给 warning，不影响安装成功，但后续涉及跨 scope 删除保护的命令必须在索引修复前 fail closed。

写入 shared runtime skill trigger 前必须先校验 shared runtime owner。没有 owner 时，当前会影响 shared runtime 的 install location 可以在 record 成功提交后成为 owner；owner 是其它 location 且本次命令会改变 shared runtime 语义时，脚本命令必须失败并提示用户重跑同一条命令并加 `--takeover-shared-runtime`。Codex project repo-local skill trigger 不走这条 shared runtime owner 路径。

project scope 安装前如果发现当前仓库已有可认领的同插件 repo-visible artifacts，但本机没有 install record，`aw install` 不能自动接管，也不能把这些文件当成普通未受管冲突直接建议删除。脚本命令应失败并提示 `aw repair --adopt-existing`；如果用户确实想替换现有共享产物，应先走 diagnose / cleanup / reinstall 的显式路径。

如果某个节点 record 成功提交前失败：

- 尽量回滚本次已经写入的 AW-owned artifacts。
- 尽量回滚本次写入或更新的 project artifact identity metadata；如果无法回滚，后续只能把它当作共享身份残留证据，不能当作本机成功安装。
- 尽量删除本次写入的 dynamic diagnostic cache；如果无法删除，后续 `status` / `diagnose` 只能把它当作残留证据，不能当作成功安装。
- 尽量删除本次写入的 historical lifecycle runtime；如果无法删除，后续只能作为孤儿私有状态由 GC 或 cleanup 清理，不能当作成功安装。
- 如果本次 staging 了 shared runtime owner 或已改写 shared runtime，必须恢复旧 owner 状态和旧 runtime；没有旧 owner 时恢复 embedded 默认。无法恢复时，保留可诊断状态并提示 repair、带 `--takeover-shared-runtime` 的单目标命令或 cleanup。
- 如果 native write 已成功且 marker 已存在，保留 marker，提示用户运行 `aw repair` 或 `aw cleanup`。
- 不写该节点的成功 install record，也不提交失败 dependent 的 dependency edges。
- 新装的自动依赖如果尚未被任何成功 dependent edge 引用，应优先回滚清理。
- 新装的自动依赖已经被其它成功 dependent 引用时，不能因后续另一个 dependent 失败而删除。
- 不写全局 degraded 状态；无法完整回滚的局部状态由 record、marker 和现场证据诊断。

如果 record 已成功但 marker 删除失败：

- 安装结果不能报告为完全成功。
- `status` 显示需要处理，`repair` 或 `cleanup` 可以继续收口。

### `aw status`

`status` 默认只读，不修复、不创建目录、不执行 lifecycle、不调用 renderer、不调用 native install/uninstall。

默认状态由 install record、project artifact shared identity、诊断缓存和现场推导：

- **已安装**：record 存在，record 中的 AW-owned artifacts 可定位，native evidence 满足目标平台最低要求，record 的 outgoing dependency edges 指向的依赖也处于健康状态；dynamic artifact 的缓存未显示 stale、drift 或最近 refresh 失败。current catalog 与 record source 不一致时，如果其它证据都健康，顶层状态仍保持“已安装”，默认输出提示可升级，verbose / JSON 标记 catalog drift / upgrade available。dynamic diagnostic cache 缺失、损坏或无法对齐时，如果其它证据都健康，顶层状态仍可保持“已安装”，但默认输出要给温和提示，verbose / JSON 标记 `dynamicDiagnosticUnavailable`。
- **需要修复**：record 存在，但 AW-owned artifact 缺失、shared file 不可解析、native evidence 缺失，dynamic diagnostic cache 显示 stale / drift / 最近 refresh 失败，record 的 dependency edge 缺失、不完整、指向无法验证的位置、指向位置不健康，或 record 引用的 historical lifecycle runtime 缺失、损坏导致普通卸载无法安全运行。静态 artifact 内容只有在 current catalog 与 record source 能证明同一 bundle，或存在可验证 accepted content digest / shared identity 时，才能因为内容差异进入“需要修复”；单纯 catalog drift 不属于损坏。
- **可认领**：project scope 没有本机成功 record，但当前仓库中存在能和 current catalog、project artifact shared identity、稳定 artifact identity 或 AW-owned marker 对齐的 repo-visible project artifacts，且没有 native transaction marker、损坏私有状态或其它半完成本机写入证据。identity metadata 与现场 artifact 匹配但 source 已不同于 current catalog 时，仍属于“可认领”，verbose / JSON 需要标记 catalog drift。默认下一步是 `aw repair --adopt-existing`，不是 cleanup。
- **有残留**：没有成功 record，也不满足“可认领”条件，但发现 native transaction marker、AW 私有状态残片、无法安全对齐到 current catalog 或 project artifact shared identity 的 AW marker block / AW 命名文件、Codex cache / enabled entry 等残留证据。
- **由其它来源管理**：发现同名平台原生插件，但没有 AW ownership 证据。
- **未安装**：没有 record，也没有可归属残留。

依赖状态从 verified scope records 的 outgoing edges 反向推导：

- `dependents`、`autoInstalled` 和“没有可信引用”的提醒是只读投影，不落盘。
- `autoInstalled` 只表示 record 的来源是 `installSource.kind === "dependency"`，即最初由依赖自动创建；即使后来被用户显式保留，它仍可显示为 `autoInstalled: true`。未使用依赖提醒只在 `kind === "dependency"`、`explicitlyRequested === false`、没有 verified incoming edge 且全局依赖索引可信时展示。
- 当前安装健康层以 record 中的 dependency edge declaration 和满足位置为准；current catalog 新增、删除或调整依赖，只展示为 catalog drift / upgrade 建议，不能单独把当前安装打成依赖缺失。
- 静态 artifact 健康层也遵守同一边界：current catalog 新增、删除或调整静态 artifact，只展示为 catalog drift / upgrade 建议；如果旧版 artifact 仍可定位且没有其它损坏证据，不能因为它不同于 current catalog 就把顶层状态降级为“需要修复”。
- 如果 record 缺少依赖 metadata，或者全局依赖索引不足以安全构建 incoming index，不展示“没有可信引用”的提醒。
- 对 user-scope 目标，incoming dependents 必须来自可信全局索引和重新校验后的 record；只看当前 repo 不足以证明可以删除或可以提示未使用。Codex user 原生残留如果没有 install record / native marker、且残留只落在 AW 可定位的 native surface 上，可以作为显式 cleanup 例外直接收口。
- dynamic diagnostic cache 缺失或损坏时，默认 `status` 不执行 renderer，也不能臆测 dynamic drift；不能只因为缓存不可用就把目标降级为“需要修复”。人类输出只给温和提示，verbose/json 标记 `dynamicDiagnosticUnavailable` 并建议 `aw diagnose --deep`。如果同时存在其它可验证损坏，则由那些损坏决定顶层状态。
- project scope 计算 dynamic artifact 的 config digest / stale 状态时，只能使用 project artifact render config；user config store、project local config store 或路径型配置的变化不能让 repo-visible artifact 变成 stale。
- shared runtime owner 状态不可读、owner record digest 无法验证，或当前目标请求改变 shared runtime 但不是 owner 时，默认输出只给下一步；verbose/json 标记 owner、是否需要 takeover，以及是否跳过 replay。

默认输出只给友好摘要和下一步。详细差异进入 `aw diagnose`、`aw status --verbose` 或 `aw status --json`。

### `aw diagnose`

诊断命令不写 install record 或 diagnostic cache。默认诊断不执行 renderer；`aw diagnose --deep` 可以执行 renderer，计算 dynamic artifact 的当前期望内容。只有 current catalog 与 record source 是同一 bundle，或当前目标处于 `--adopt-existing` / marker-only repair 可用路径时，诊断才提示用户用 `aw repair` 接受并写回结果；source 已漂移时应提示 `aw upgrade` 或 `aw reinstall`。

诊断输出必须覆盖：

- install record 是否存在。
- record 中每个 artifact 是否存在。
- shared file 是否可解析。
- shared file 中 AW-owned block / entry / hook group 是否存在。
- project artifact shared identity 是否存在、可解析、shared locator / source / artifact identity 是否和现场 repo-visible artifacts 对齐。
- 静态 artifact 文件是否存在、shared marker 是否可定位，以及在 current catalog 与 record source 为同一 bundle 时内容是否和 current catalog 期望一致；source 已漂移时只报告 catalog drift / upgrade available，不能把跨版本内容差异当作 damage。
- dynamic artifact 默认是否和 diagnostic cache 中的 accepted content digest 一致，render config 是否 stale，最近 refresh 是否失败；`--deep` 再比较 current catalog 下的当前期望内容。
- dynamic artifact 的 accepted state 是 `present` 还是 `disabled`；disabled artifact 需要展示 `disabledReason`，但不能把目标内容缺失诊断成 missing。
- native plugin 是否 enabled / installed / cache present。
- dependency edges 是否完整，指向的位置是否健康，当前插件被哪些可信索引覆盖的 verified record 依赖。
- historical lifecycle runtime 是否存在、digest / fingerprint 是否匹配、是否包含安装时声明的 uninstall lifecycle。
- 自动安装的依赖是否没有可信 incoming edge；这里只给手动清理提示，不执行自动清理。
- current catalog 的依赖声明与当前 record 中的 edge declaration 是否有 drift。
- 全局依赖索引是否存在、是否能覆盖目标删除保护所需范围。
- 全局依赖索引中是否存在 `staleProjectReference` 或 `unreadableProjectReference`，以及它们当前为什么阻止删除。
- shared runtime owner 是否存在、是否指向当前目标、owner record digest 是否可验证，以及当前操作是否需要显式 takeover。
- 是否存在没有 install record 的残留。
- project scope 没有本机 record 时，仓库中的 repo-visible artifacts 是否可认领；如果可认领，输出 `aw repair --adopt-existing`，并说明这会创建本机 AW 状态而不是清理仓库文件。如果可认领证据来自旧 source 的 identity metadata，还必须说明接管会按 current catalog 重新应用共享 artifacts 并更新 identity metadata。
- 是否可以自动 repair。
- 是否可以安全 cleanup。
- 如果需要 `--force` 才能清理，说明会备份哪些文件。
- 如果存在 stale project reference，输出可复制的 `aw cleanup --dependency-index --prune-stale <token> --yes`，并说明这只会退休索引引用，不会删除原项目文件。

### `aw repair`

repair 用 current catalog 修复当前插件在目标位置的 AW-owned artifacts，但不能用普通 repair 隐式跨越 record source 与 current catalog 的版本边界。source 已漂移时，repair 可以收口 native marker、私有状态、依赖索引等不改变 artifact 版本语义的问题；凡是需要用 current catalog 重写静态 / dynamic artifacts 或刷新 dependency graph 的场景，必须提示用户运行 `aw upgrade`、`aw reinstall`，或在 project fresh clone 场景显式运行 `aw repair --adopt-existing`。

要求：

- 除 `aw repair --dependency-index` 只修复全局依赖索引外，普通 plugin repair 在允许重新生成 artifacts、依赖图或 dynamic render 输入的路径上需要 current catalog；current catalog 不可用时，必须在任何写入前失败，并提示恢复 catalog、升级 AW，或在明确理解风险后选择 cleanup；reinstall 需要先恢复 current catalog。命令不得把 historical lifecycle runtime、project artifact shared identity 或旧 source 当成 current catalog 使用。
- record 存在且 current catalog 与 record `source.manifestDigest` / `source.bundleFingerprint` 能证明同一 bundle 时，按 record 的 artifact identity 清理或覆盖旧 AW-owned 部分，再按 current catalog 写入新 artifacts。
- record 存在且 current catalog 与 record source 是同一 bundle 时，按 current catalog 重新规划当前 platform 生效依赖，补齐缺失依赖，刷新当前 record 的 outgoing dependency edges。source 已漂移时，当前安装健康层以 record 中已有 dependency edges 为准；current catalog 依赖变化只提示 upgrade，不由 repair 自动改写。
- record 存在但 source 已不同于 current catalog 时，普通 repair 不得重写 static artifacts、dynamic diagnostic cache、project artifact identity source、historical lifecycle runtime 或 install record source 为 current catalog。若现场损坏需要重新生成 artifacts 才能恢复，命令必须在写入前失败，并提示用户选择 `aw upgrade` 接受当前 catalog，或走 `aw reinstall` / `aw cleanup`。
- record 存在但 historical lifecycle runtime 缺失或损坏时，repair 只能在 current catalog 与 record 的 `source.manifestDigest` / `source.bundleFingerprint` 能证明同一 bundle 时重建该 runtime；无法证明时不能静默改用新版 lifecycle，应提示普通 uninstall 的安全性受限，用户可以选择恢复旧 bundle、继续 repair artifacts，或走 cleanup。
- record 是 shared runtime owner 时，repair 可以 replay owner preference 并刷新 owner digest；record 不是 owner 且 repair 会改变 shared runtime 语义时，必须提示用户重跑同一条命令并加 `--takeover-shared-runtime`。
- record 缺失但 native transaction marker 存在时，允许 marker-only repair install，但必须先做 native post-check：如果现有 enabled config 和 active cache 已满足目标平台最低要求，repair 只补齐依赖、artifacts、historical lifecycle runtime、dynamic diagnostic cache、install record 和全局依赖索引，成功后删除 marker，不重新执行 native install。
- marker-only repair 的 post-check 发现 native evidence 缺失或明显不一致时，不能把 marker 解释成“native 仍健康”。命令可以进入普通 native install 修复路径，但这必须作为 post-check 失败后的显式 native 修复步骤呈现在 verbose / JSON / debug 事件中；native 修复仍失败时，不写成功 record，保留或更新 marker，并提示 `aw cleanup` / `aw reinstall`。
- project scope record 缺失但存在可认领的 repo-visible artifacts 时，默认 `aw repair` 保持只诊断不接管；脚本化接管必须显式传 `--adopt-existing`。主控制台可以在展示 artifact 列表、缺失本机 record、将要创建的 private state 和可能执行的 lifecycle 后，让用户确认同一语义的接管。
- `aw repair --adopt-existing` 只适用于 project scope。它必须先完成与 project install / explicit upgrade 同等级的只读安全预检，确认现有 repo-visible artifacts 可以和 current catalog 的 artifact identity、project artifact shared identity、AW marker 或声明的 shared-file block 对齐；无法确认归属、identity metadata 损坏、内容和 identity / digest 明显不符、shared file 不可解析且 marker 不可定位，或命中未受管冲突时，命令必须失败并提示 diagnose / cleanup / reinstall，不得静默覆盖共享文件。
- `aw repair --adopt-existing` 可以使用旧 source 的 project artifact shared identity 授权接管，但不能把旧 source 当成 current catalog。identity source 与 current catalog 不同时，命令必须在写入前说明会按 current catalog 重新应用共享 artifacts、清理旧 AW-owned 部分并更新 identity metadata；如果 current catalog 不可用，命令必须失败并提示恢复 catalog、升级 AW 或显式 cleanup。
- `aw repair --adopt-existing` 成功路径会按 current catalog 补齐依赖、在本机首次认领且 current catalog 声明 project scope install lifecycle 时执行该 install lifecycle、持久化 historical lifecycle runtime、写入或更新 project artifact identity metadata、写入本机 install record、刷新 dynamic diagnostic cache 和全局依赖索引。它不得把 user config store、project local config store 或路径型配置写入 repo-visible artifacts；dynamic artifact 的 accepted digest 必须按 project artifact render config 渲染得到。
- `aw repair --adopt-existing` 的 lifecycle 判定必须只看本机 project-scope 安装事实：如果没有可验证本机 record 证明当前 location 已完成 install lifecycle，而 current catalog 为该 project target 声明了 `scripts.lifecycle.install`，认领就要执行 install lifecycle，并在预检摘要、receipt 和 JSON 中说明原因是 `adoptExistingFirstLocalRecord`。lifecycle 失败时不写成功 record，不更新 identity metadata 为已认领状态；如果 current catalog 没有 install lifecycle，则只记录未执行原因，不能臆测旧共享产物已经在本机跑过 lifecycle。
- record 缺失且只有不可认领残留 artifacts 时，默认不直接 repair，应提示用户先 `aw cleanup`，或在主控制台里确认清理 / 重新安装路径。
- repair 可以在同一 bundle、marker-only install repair 或 `--adopt-existing` 路径中执行 dynamic artifact renderer；record source 已漂移的普通 repair 不能执行 renderer 并把结果当作当前安装修复结果。
- repair 成功后按实际写入内容重写 install record，刷新 dynamic diagnostic cache 和全局依赖索引；source 已漂移但只收口 native marker、依赖索引或私有状态的 repair 必须保留原 record source，不能把 record 刷成 current catalog。
- repair 失败不写成功 record；如果已有 record，保留原 record 供 cleanup 使用。

`aw repair --dependency-index` 是全局依赖索引修复入口：

- 它只重建或刷新可验证的 index entries：当前可定位 records、索引中仍能读取并通过 digest / identity 校验的 records。
- 它不能裁剪 `staleProjectReference`；遇到 stale 候选时，只能保留并提示用户先运行 `aw cleanup --dependency-index --prune-stale <token> --yes`。
- 它不能把部分重建索引用作跨 repo 删除授权；只要仍有未退休的 stale / unreadable project reference，涉及 user-scope 依赖删除的命令继续 fail closed。
- 它不执行 plugin repair，不运行 renderer，不改写 artifacts、install record、shared/local config store 或 lifecycle runtime。

### `aw uninstall`

`uninstall` 是正常卸载入口，面向“record 存在且安装身份可信”的目标。它不同于 `cleanup`：`uninstall` 可以运行卸载 lifecycle，并按依赖 planner 保护仍被使用的位置；`cleanup` 只处理残留、marker-only 或损坏状态。

要求：

- 删除前必须从当前可定位 records 和可信全局依赖索引构建 incoming edge 图。目标仍被其它 verified record 的 dependency edge 引用时，`uninstall` 必须失败，并列出 dependent location。
- 全局依赖索引缺失、损坏或覆盖范围不足时，普通 `uninstall` 不能删除可能被其它 scope 引用的目标。
- 如果 record 声明了 `lifecycle` 且其中包含 `uninstall`，必须优先按该 historical lifecycle runtime 运行 uninstall lifecycle，并校验 manifest digest、bundle fingerprint、plugin name/version 和入口路径边界。current catalog 不能替代历史 runtime，除非它能和 record 中的 digest / fingerprint 证明为同一 bundle。
- historical lifecycle runtime 缺失、损坏、digest 不匹配或 record / 现场损坏到无法安全运行 lifecycle 时，普通 `uninstall` 失败，并提示 `aw diagnose` / `aw repair` / `aw cleanup`。用户选择 `cleanup` 时不会运行 lifecycle，因此输出必须说明可能残留 lifecycle 负责的外部副作用。
- 删除 record 中列出的完整 AW-owned 文件或目录。
- 从 shared file 中删除 AW-owned block、entry、hook group 或 role registration。
- project scope 同步删除 repo-visible identity metadata。
- 对需要 native runtime 的 user scope，调用平台 native uninstall。
- 如果目标是 shared runtime owner，删除 owner 状态，并把 shared runtime skill trigger 恢复到 embedded 默认；剩余非 owner record 不自动接管。
- 删除 install record、dynamic diagnostic cache、该 record 引用的 historical lifecycle runtime 和对应 native transaction marker。
- 刷新全局依赖索引；索引刷新失败只给 warning，但后续删除类命令仍需先恢复可信索引。

卸载父插件不会顺带删除依赖。命令完成后，如果发现某些自动安装的依赖已经没有可信 incoming edge，只输出手动清理建议。

### `aw cleanup`

cleanup 是底层残留 / 损坏清理入口，不替代正常卸载。目标处于健康 installed 状态时，普通 `aw cleanup` 应失败并提示使用 `aw uninstall`；只有 marker-only、没有成功 record 的不可认领残留、record 损坏、shared file 损坏、native 状态半完成，或 `diagnose` 判定普通 uninstall 不安全时，才进入 cleanup。目标处于“可认领”状态时，默认下一步必须是 `aw repair --adopt-existing`；如果用户显式选择 cleanup，输出和 receipt 必须说明这会删除仓库中的共享 project artifacts，而不是只清理本机私有状态。

cleanup 清理 AW 明确拥有的内容：

- 如果目标仍被其它 verified install record 的 dependency edge 引用，cleanup 必须失败，并列出 dependent location。
- cleanup 不再因为全局依赖索引缺失、损坏或覆盖范围不足而硬性中止；它会保留 warning，但只要没有已知 dependents、而且残留归属可定位，就继续执行显式收口。
- 删除 record 中列出的完整 AW-owned 文件或目录。
- 从 shared file 中删除 AW-owned block、entry、hook group 或 role registration。
- project scope 同步删除 repo-visible identity metadata。
- 对需要 native runtime 的 user scope，调用平台 native uninstall。
- 如果目标是 shared runtime owner，删除 owner 状态，并把 shared runtime skill trigger 恢复到 embedded 默认；剩余非 owner record 不自动接管。
- 删除 install record、dynamic diagnostic cache 和该 record 引用的 historical lifecycle runtime。
- 删除对应 native transaction marker。
- 刷新全局依赖索引；索引刷新失败只给 warning。

cleanup 遇到 artifact 已经缺失时应视为已清理。

cleanup 不运行 uninstall lifecycle，不顺带删除依赖。命令完成后，如果发现某些自动安装的依赖已经没有可信 incoming edge，只输出手动清理建议。cleanup 是用户明确接受“只删除 AW-owned 状态、可定位残留，或已明确放弃认领的 project artifacts”的底层清理入口；如果目标原本有 historical uninstall lifecycle，输出必须提示未执行该 lifecycle，外部副作用可能需要手动处理。

共享配置文件不可解析时：

- 如果 AW marker 或 ownership block 仍可定位，可以只删除 AW-owned 区块。
- 如果 marker 不可定位，普通 cleanup 失败，并提示运行 `aw diagnose` 查看手动处理建议。
- `aw cleanup --force` 必须先备份受影响共享文件，再删除可定位的 AW-owned 区块。
- `aw cleanup --force` 不允许重写整份共享配置，也不允许删除无法定位归属的用户内容。

`aw cleanup --dependency-index --prune-stale <token> --yes` 是 stale project reference 的受控裁剪入口：

- 只能处理 `diagnose` / verbose status 已标记为 `staleProjectReference` 的 token。
- 执行前必须重新读取当前 index，确认 token 绑定的 location、record path 和 index digest 仍匹配；不匹配时失败并提示重新 diagnose。
- 成功后只删除对应 index entry 并写 receipt；不得删除任何 project 文件、plugin artifact、shared/local config store、record、diagnostic cache 或 lifecycle runtime。
- 如果 token 对应条目变成可读 record，命令应刷新索引并拒绝 prune。
- 如果 token 对应条目是 `unreadableProjectReference`，命令必须 fail closed。

### `aw reinstall`

`reinstall` 是一等能力，行为等价于：

1. `aw diagnose`
2. 如果目标是健康 installed 状态，执行 `aw uninstall`；如果是残留、marker-only 或损坏状态，执行 `aw cleanup`；如果是可认领状态，默认停止并提示先 `aw repair --adopt-existing` 或显式 cleanup 后再重装
3. `aw install`

如果 uninstall / cleanup 无法安全完成，reinstall 必须停止，不继续覆盖未知状态。用户可以显式选择 `aw cleanup --force` 后再重新执行 reinstall。

### `aw upgrade`

upgrade 简化为“按 current catalog 重新应用并替换 record”：

- 不依赖 capability snapshot 判断能力变化。
- 使用 dependency planner 展开 current catalog 中当前 platform 生效依赖；缺失依赖先安装，已安装依赖先升级，父插件最后升级。
- 直接从 current catalog 生成期望 artifacts。
- 只有 shared runtime owner 的 upgrade 可以更新 shared runtime skill trigger 和 owner digest；非 owner upgrade 如果会改变 shared runtime 语义，必须提示用户重跑单目标 upgrade 并加 `--takeover-shared-runtime`。
- 为升级后的 current catalog bundle 写入新的 historical lifecycle runtime；旧 runtime 必须保留到升级成功提交新 record 之后，避免失败回滚时丢失旧安装的安全卸载面。
- 清理旧 record 中存在但新期望中不存在的 AW-owned artifacts。
- 覆盖仍然存在的 AW-owned artifacts。
- 成功后写新 record，project scope 更新 repo-visible identity metadata，刷新 dynamic diagnostic cache 和当前 record 的 outgoing dependency edges；删除的旧 edge 只能在父插件升级成功后移除。
- 显式 `aw upgrade <plugin>` 成功后，目标 record 的 `explicitlyRequested` 必须为 `true`；如果它原本是自动依赖，保留 `kind: "dependency"`。作为依赖图前置节点被升级的插件不因本次前置升级变成显式保留，除非它原本已经 `explicitlyRequested === true`。
- 新 record 成功提交后才能删除旧 record 引用的 historical lifecycle runtime；删除失败只给 warning，并允许后续 GC 清理。
- 成功后刷新全局依赖索引；索引刷新失败只给 warning。

如果当前 record 损坏或现场不可信，upgrade 不进入复杂恢复分支；应提示用户先运行 `aw repair` 或 `aw reinstall`。

marker-only 状态不能 upgrade。显式 upgrade 必须失败并提示先 `aw repair` 或 `aw cleanup`；`upgrade --all` 应跳过该目标。

`upgrade --all` 的根集合只包含 `installSource.explicitlyRequested === true` 的 install record，不用 `kind` 过滤。自动依赖只有从显式根的 current catalog 目标依赖图可达时，才参与升级；已经不再被 current catalog 需要的自动依赖，等父插件成功刷新 edges 后只进入提示，不自动清理。

`--takeover-shared-runtime` 只允许用于单目标 `install`、`repair` 和显式 `upgrade <plugin>`。`upgrade --all` 如果遇到 shared runtime owner 冲突，应跳过该目标并提示用户对单个插件重跑显式 upgrade。

### `aw config set/unset/reset`

配置写入层级：

- 默认仍写 user config store。
- `--scope project` 写 project shared config store `.agent-workflows/plugin-config/<plugin>/config.json`；这是会影响 repo-visible project artifacts 的唯一 project 配置输入。
- `--scope project --local` 写 project local config store `.agent-workflows/plugin-config.local/<plugin>/config.json`；它是本机私有覆盖，默认忽略，不触发 repo-visible project artifact refresh。
- project local config 写入如果发现用户修改的 key 已被 dynamic artifact 声明为 refresh key，命令应说明该 local override 不会影响共享 artifact；JSON receipt 用稳定字段暴露 skipped reason，不能把 artifact 标成 stale。
- `aw config set --scope project` 写 project shared config store 时，不允许写入 schema 类型为 `file` / `directory` 的 key；命令必须在任何写入前失败，提示这类值会落成本机 realpath，应该改写 user store 或 `--scope project --local`。`unset` / `reset` 可以删除 shared store 中既有的路径型 key，帮助用户清理手工写入或旧实验状态；读取、install preflight 或 refresh 遇到 shared store 中仍存在路径型 key 时，应把它报告为 invalid shared config，并阻止 repo-visible project artifact refresh。

可以触发 artifact refresh 的配置写入只有 user config store 和 project shared config store：

- user config store 只刷新 user-scope artifacts，不刷新任何 project-scope repo-visible artifacts。
- project shared config store 只刷新当前 project-scope artifacts；它不扫描其它历史项目。

project shared config 写入前，命令必须先判断当前 project target 是否已有本机 install record、是否处于“可认领”状态：

- record 存在时，按普通 config refresh 合同处理。
- record 缺失但当前仓库存在可认领 repo-visible artifacts 时，如果本次 changed keys 会触发 repo-visible artifact refresh、dynamic diagnostic cache 更新或 project artifact identity metadata 重写，命令必须在写 shared config 前失败，并提示先运行 `aw repair --adopt-existing`。config write 不能绕过显式认领入口，也不能在没有本机 ownership record 时改写共享 artifacts。
- record 缺失且处于可认领状态时，如果命令能证明 changed keys 不会影响 current catalog 下的 project artifacts、不会触发 renderer、不会更新 identity metadata，也不会创建本机 private state，可以把 shared config 当作预写配置落盘。receipt / JSON 必须明确标记 `configRefreshSkippedReason: "adoptExistingRequired"`，说明当前机器尚未认领、没有刷新共享 artifacts，下一步仍是 `aw repair --adopt-existing`。
- record 缺失且没有可认领 artifacts 时，`aw config --scope project` 仍可用于安装前预写 project shared config；后续 `aw install` 使用这份 shared config 生成 repo-visible artifacts。

如果配置写入影响已安装 dynamic artifact：

- 直接尝试重新应用受影响 artifacts。
- 成功后更新 install record 中必要的 artifact identity；project scope 同步更新 repo-visible identity metadata；并刷新 dynamic diagnostic cache。
- 失败时命令失败或返回明确 warning，提示运行 `aw diagnose --deep`；如果 current catalog 与 record source 是同一 bundle，可以提示 `aw repair`，否则提示 `aw upgrade` / `aw reinstall`。
- 不把失败状态写入 install record；可以把最后一次 refresh 失败摘要写入 dynamic diagnostic cache。

project scope refresh 必须使用 project artifact render config。user config store、project local config store 和路径型配置的变化不得触发 project artifact refresh，也不得改变 project artifact 的 `configDigest`。

### `aw config get/list`

配置读取命令默认可以展示面向本机使用的 effective config，但 project scope 下必须把来源讲清楚：

- `aw config get/list --scope project` 的 effective config 优先级固定为 manifest default < user config store < project shared config store < project local config store。project artifact truth 仍只来自 project artifact render config；user config store、project local config store 和路径型配置只能影响本机读命令、交互默认值、lifecycle/helper 或未来 local-only 能力。
- `aw config get/list --scope project` 的人类输出不能只展示被 local override 覆盖后的单一值。至少需要区分 project shared value、project local override 和最终 effective value；如果某个 key 存在 local override，输出必须说明它只影响本机读命令或交互默认值，不影响 repo-visible project artifacts。
- JSON 输出必须为每个 key 暴露稳定来源字段，能表达 `default`、`user`、`projectShared`、`projectLocal` 和 effective value；project local override 或路径型配置命中时，还要暴露 artifact truth 仍来自 project artifact render config。
- `aw config get/list --scope project --local` 可以只聚焦 project local store，但输出仍要标明这是本机私有覆盖层，不能作为共享 artifact 的渲染输入。
- 读取命令不触发 artifact refresh，不写 install record、diagnostic cache 或 shared/local config store。

## 文件损坏语义

AW 只能自动处理自己明确拥有的内容。

完整文件或目录：

- 路径来自 install record，且位于对应 scope 允许写入区域内。
- repair 可以覆盖。
- cleanup 可以删除。

共享文件：

- 必须有可识别的 AW-owned marker、block id、artifactKey 或 hook group identity。
- repair 只替换 AW-owned 部分。
- cleanup 只删除 AW-owned 部分。
- 文件不可解析但 marker 区间可定位时，可以按 marker 修复或清理。
- 文件不可解析且 marker 不可定位时，不自动修改；`cleanup --force` 也不能删除无法定位归属的内容。

残留证据：

- project scope 下有可验证的 repo-visible AW artifact，但没有本机 install record 时，优先显示“可认领”；可验证证据可以来自 current catalog、project artifact shared identity、稳定 artifact identity 或 AW-owned marker。只有这些证据都无法安全对齐、artifact 位于 private state、或带有半完成本机写入证据时，才显示“有残留”。
- 有 AW marker 或 AW 命名文件，但没有 install record 且不满足“可认领”条件时，status 显示“有残留”。
- cleanup 可以删除明显 AW-owned 的独立文件。
- shared file 残留需要能定位 AW marker；否则给手动处理建议。

## 输出与用户体验

默认人类输出禁止出现以下内部术语：

- `ledger` / `账本`
- `tracking`
- `breadcrumb`
- `degraded`
- `capabilitySnapshot`
- `installSnapshot`
- `healthSource`
- `repo-managed`
- `artifactRefresh`
- `configDigest`
- `contentDigest`

推荐文案：

- “插件文件缺失或被修改，需要修复。”
- “仓库里已有这个插件的项目文件，但这台机器还没有 AW 本地记录；可以认领后继续管理。”
- “Codex 侧已有残留，但 AW 没有完整安装记录。”
- “可以重新应用插件文件，或清理后重新安装。”
- “AW 的本地状态已更新；这些文件默认不会提交到仓库。”
- “项目共享配置已更新；如果这些配置会影响插件文件，相关文件也需要一并刷新并提交。”
- “本机项目配置已更新；它不会改写团队共享的插件文件。”
- “仓库里已有可认领的插件文件；请先认领，再修改会刷新共享插件文件的配置。”
- “这个配置值是本机路径，不能写入项目共享配置；请改用用户配置或本机项目配置。”
- “卸载脚本需要安装时保存的运行环境；当前记录缺失或损坏，不能安全执行普通卸载。”
- “清理只会删除 AW 可以确认拥有的内容，不会运行插件卸载脚本。”
- “依赖插件缺失或不可用，需要补齐依赖。”
- “这个插件仍被其它安装位置使用，不能直接清理。”
- “这个自动安装的依赖暂时没有可信引用，如不再需要可以手动清理。”
- “共享 skill 触发策略当前由另一个安装位置控制；如需接管，请重跑同一条命令并加 `--takeover-shared-runtime`。”
- “共享配置文件无法安全解析，请先修复文件格式，或查看诊断详情。”
- “强制清理会先备份相关配置文件，再删除可确认属于 AW 的内容。”
- “依赖索引里还有已不存在项目的历史引用；删除前需要先确认并清理这条索引引用。”
- “当前目录里的插件版本已经不是最新；现有安装仍可使用，如需更新请运行 `aw upgrade`。”
- “当前记录来自旧版本，无法确认旧版插件文件是否被手工改坏；如需改到当前版本，请运行 `aw upgrade`，如需重建请运行 `aw reinstall`。”

JSON 输出可以保留机器字段，但字段围绕新模型命名，例如：

- `installRecordPresent`
- `nativeTransactionPresent`
- `dynamicDiagnosticPresent`
- `dynamicDiagnosticUnavailable`
- `dynamicArtifactState`
- `damagedArtifacts`
- `dependencyEdgesPresent`
- `dependencyIndexTrusted`
- `staleProjectReferences`
- `staleProjectReferences[].pruneToken`
- `unreadableProjectReferences`
- `missingDependencies`
- `dependents`
- `autoInstalled`
- `unusedDependencyHint`
- `catalogSourceDrift`
- `upgradeAvailable`
- `staticArtifactContentCheck`
- `catalogDependencyDrift`
- `historicalLifecyclePresent`
- `historicalLifecycleHealthy`
- `sharedSkillTriggerOwner`
- `sharedSkillTriggerTakeoverRequired`
- `projectArtifactIdentityPresent`
- `projectArtifactIdentityHealthy`
- `projectArtifactSharedIdentityId`
- `projectArtifactSharedLocator`
- `projectArtifactIdentitySource`
- `projectArtifactCatalogDrift`
- `adoptExistingLifecycle`
- `adoptExistingLifecycleReason`
- `adoptableProjectArtifacts`
- `adoptExistingAvailable`
- `residualEvidence`
- `repairAvailable`
- `cleanupAvailable`
- `forceCleanupAvailable`
- `privateStateFiles`
- `ignoredStateFiles`
- `sharedConfigFiles`
- `configSources`
- `configRefreshSkippedReason`
- `projectSharedPathConfigRejected`

## 测试要求

至少覆盖：

- install 成功只写 scope 本地 per-plugin install record、dynamic diagnostic cache、全局依赖索引，以及 project scope 的 repo-visible identity metadata；不写旧 `installed.json`。
- 同一 scope 下多个插件分别写入独立 record 文件；损坏其中一个 record 时，status / uninstall / cleanup 只影响对应插件位置，不影响其它 record。
- project-scope install / repair / upgrade 首次创建 `.claude/.agent-workflows/`、`.codex/.agent-workflows/` 或 `.agent-workflows/plugin-config.local/` private state / local config 目录时，会确保 ignore 规则存在；无法安全更新 ignore 时给出 warning 和精确 pattern。
- project-scope `aw config --scope project` 默认写 `.agent-workflows/plugin-config/` shared store，不自动忽略，并在 receipt 中归类为 project shared config；`aw config --scope project --local` 写 `.agent-workflows/plugin-config.local/`，会确保 ignore 规则存在，默认 receipt 不把 local config store 当作需要提交的项目文件。
- project shared config 路径如果被 project ignore 规则覆盖，写命令在刷新 repo-visible artifacts 前失败，并提示修正 ignore 或改用 `--local`。
- project-scope `aw config set --scope project` 写 `file` / `directory` 类型 key 时，在任何写入前失败，并提示改用 user store 或 `--scope project --local`；`unset` / `reset` 可以删除 shared store 中既有路径型 key。
- project shared config store 已经包含 `file` / `directory` 类型 key 时，install / repair / upgrade / config refresh 会把它报告为 invalid shared config，不执行 repo-visible artifact refresh；project local / user store 中同类 key 仍按本机 realpath 校验，并且只影响本机 effective config。
- project artifact shared identity 路径如果被 project ignore 规则覆盖，project-scope install / repair / upgrade / reinstall / config refresh 在写任何 repo-visible artifact 前失败，并提示命中的 ignore pattern 和修复建议。
- `aw config get/list --scope project` 的 effective config 按 manifest default < user config store < project shared config store < project local config store 合并；人类输出和 JSON 都区分 default、user、project shared value、project local override 和 effective value，local override 命中时不能暗示它会影响 repo-visible project artifacts。
- project-scope lifecycle 和 config helper 收到的 context 使用 manifest default < user config store < project shared config store < project local config store；artifact renderer、dynamic config digest 和 stale 判断仍只使用 project artifact render config。project local / user 的路径型配置失效时会阻断 lifecycle/helper，但不会让 repo-visible artifact 变 stale。
- project-scope `status` 和默认 `diagnose` 不会为了补 ignore 规则写入仓库。
- 默认人类 receipt 不把 `records/*.json` / `diagnostics/*.json` 当作需要提交的项目文件；JSON receipt 可通过 `privateStateFiles` / `ignoredStateFiles` 暴露机器可读状态。
- fresh clone 后 repo-visible project artifacts 存在但本机 record 缺失时，status 显示“可认领”而不是“有残留”，默认下一步指向 `aw repair --adopt-existing`。
- project-scope install / repair / upgrade 写入 repo-visible artifacts 时，会同步写 `.agent-workflows/project-artifacts/<platform>/<sharedIdentityId>.json` shared identity metadata；文件使用 repo-relative path，包含 repo-stable shared locator、source manifest digest / bundle fingerprint 和 artifact identity / digest，不包含本机 `projectKey`、`recordId` 或绝对路径，并且不会被默认 ignore，也不会在当前 ignore 规则覆盖该路径时静默写入。
- 同一仓库在不同绝对路径 fresh clone 后，project-scope `status` 仍能用同一个 shared locator 识别已有共享产物为“可认领”，`aw repair --adopt-existing` 不会生成第二份等价 identity metadata。
- fresh clone 后本机 record 缺失、current catalog 已漂移，但 project artifact shared identity 能和实际 repo-visible artifacts 对齐时，status 仍显示“可认领”，verbose / JSON 标记 catalog drift，而不是降级为“有残留”。
- `aw install` 遇到可认领 project artifacts 时不会自动接管，也不会默认建议清理；脚本输出提示用户运行 `aw repair --adopt-existing`。
- `aw config --scope project` 遇到可认领 project artifacts 且本机 record 缺失时，如果 changed keys 会触发 repo-visible artifact refresh、identity metadata 重写或 diagnostic cache 更新，命令会在写 config 前失败并提示 `aw repair --adopt-existing`。
- `aw config --scope project` 遇到可认领 project artifacts 且本机 record 缺失时，如果 changed keys 可证明不影响 repo-visible artifacts，可以只预写 shared config；receipt / JSON 标记 `configRefreshSkippedReason: "adoptExistingRequired"`，且不会创建 record、identity metadata、diagnostic cache 或 lifecycle runtime。
- `aw repair --adopt-existing` 在 project scope 下通过安全预检后写入显式保留的本机 record、project artifact shared identity、dynamic diagnostic cache、historical lifecycle runtime 和全局依赖索引；归属不明、identity metadata 损坏、内容和 identity / digest 明显不符，或 shared file marker 不可定位时失败且不覆盖共享文件。
- `aw repair --adopt-existing` 用旧 source identity 认领漂移 catalog 时，会先说明本次会按 current catalog 重新应用并更新共享 artifacts / identity metadata；current catalog 不可用时失败，不把旧 identity 当成 current catalog。
- `aw repair --adopt-existing` 在本机没有可验证 project record 且 current catalog 声明 project install lifecycle 时，会执行 install lifecycle，并在 human / JSON receipt 中标记 `adoptExistingLifecycleReason: "adoptExistingFirstLocalRecord"`；lifecycle 失败时不写成功 record、不把 identity metadata 更新成已认领状态。
- project-scope uninstall / cleanup 删除 repo-visible artifacts 时，会同步删除对应 project artifact shared identity；artifact 已缺失但 identity metadata 可安全对齐时，cleanup 可以删除该 metadata。
- `aw reinstall` 遇到可认领 project artifacts 时默认停止并提示先认领或显式清理，不能把 fresh clone 的共享产物当成残留直接删除。
- install record schema 不包含 ledger/capability/degraded/refresh 历史字段，也不包含完整 install snapshot；只允许包含 `lifecycle` historical runtime ref。
- record source 与 current catalog 不一致但 record artifacts 可定位、native evidence 和 dependency edges 都健康时，status 顶层仍是“已安装”，verbose / JSON 标记 `catalogSourceDrift` / `upgradeAvailable`，不把旧版静态 artifact 与 current catalog 的差异记入 `damagedArtifacts`。
- record source 与 current catalog 不一致，且静态 artifact 缺失或需要重新生成才能恢复时，普通 `aw repair` 不用 current catalog 覆盖成新版，不刷新 record source，命令提示用户选择 `aw upgrade`、`aw reinstall` 或 `aw cleanup`。
- record source 与 current catalog 能证明同一 bundle 时，静态 artifact 内容不同于 current catalog 才会进入 content drift，status 显示需要修复，repair 可以按 current catalog 恢复。
- 带 uninstall lifecycle 的插件安装后会保存 historical lifecycle runtime；current catalog 升级、缺失或 lifecycle 路径变化时，普通 `uninstall` 仍按历史 runtime 执行卸载脚本。
- historical lifecycle runtime 缺失、digest 不匹配或 bundle fingerprint 不匹配时，普通 `uninstall` 不会静默回退到新版 current catalog，而是失败并提示 repair / cleanup。
- repair 只有在 current catalog 与 record 的 digest / fingerprint 证明同一 bundle 时，才会重建缺失的 historical lifecycle runtime。
- 普通 plugin repair 在 current catalog 不可用时会在写入前失败，不会用 historical lifecycle runtime、project artifact shared identity 或旧 source 生成 artifacts / dependency edges。
- `aw init --force`、marketplace refresh、layout repair 和 `~/.aw` 原子替换会保留 `plugin-config/`、`dependency-index/`、`lifecycle-runtimes/`、`native-recovery/`、`shared-runtime-owners/`，并且这些目录不参与 bundle fingerprint / layout freshness 判断。
- historical lifecycle runtime GC 只删除没有 verified install record 引用的 runtime；record 或全局依赖索引不可读、覆盖范围不足或 identity 无法安全比对时，GC fail closed 并保留 runtime。
- shared skill trigger runtime 同一 plugin/platform 只接受 owner record 写入；非 owner 改变 shared runtime 语义时必须失败并提示 `--takeover-shared-runtime`，`aw init` / marketplace refresh 只 replay owner 状态，不从其它 record 自动重选。
- shared runtime owner 文件名必须包含 collision-free 的插件 hash；两个插件名 slug 相同但原始名称不同，不能落到同一个 owner 文件。
- 非 owner 的单目标 install / repair / upgrade 加 `--takeover-shared-runtime` 后，成功提交 record 才能改写 owner 状态并 replay preference；命令失败时必须恢复旧 owner 状态和 shared runtime。
- `upgrade --all` 不能接受 `--takeover-shared-runtime` 批量接管；遇到 owner 冲突时只跳过目标并给出单目标命令建议。
- owner uninstall / cleanup 后会删除 owner 状态并恢复 embedded 默认；剩余非 owner record 不自动接管。
- install record schema 必须包含 `installSource` 和 `dependencyEdges`；无依赖也写空数组。
- install record schema 不包含 `dependents`、`ref-count`、`autoRemovable`、未使用依赖提醒或已计算的依赖健康结果。
- fresh explicit install 写 `{ kind: "explicit", explicitlyRequested: true }`；依赖自动安装写 `{ kind: "dependency", explicitlyRequested: false }`；自动依赖后来被用户显式安装、显式升级或选择保留时，保留 `kind: "dependency"` 并把 `explicitlyRequested` 置为 `true`。
- dynamic diagnostic cache 保存 dynamic artifact 的 accepted `state`、`disabledReason`、`configDigest`、`contentDigest`、`lastRefresh` 和 `refreshReach`，但这些字段不进入 install record。
- 安装带依赖的父插件时，缺失依赖先写；自动依赖 record 标记为 dependency 来源，父插件 record 写 outgoing dependency edge。
- 父插件安装失败时，不提交失败父插件的 dependency edge；未被成功 edge 引用的新自动依赖会回滚或进入可诊断残留状态。
- 全局依赖索引缺失或损坏时，status 仍能从 scope 本地 record 判断当前安装，但不展示未使用依赖提醒。
- 全局依赖索引缺失、损坏或覆盖范围不足时，`uninstall` 继续对可能被其它 scope 引用的目标 fail closed；`cleanup` 则以“没有已知 dependents + 残留归属可定位”为准继续执行显式收口。
- 全局依赖索引中的 project record path 缺失或 project 私有状态目录已不存在时，diagnose / verbose status 标记 `staleProjectReference`，但删除类命令在用户显式退休该索引引用前仍 fail closed。
- `aw repair --dependency-index` 只重建可验证 index entries，不能裁剪 stale project reference，也不能把部分重建索引用作跨 repo 删除授权。
- `aw cleanup --dependency-index --prune-stale <token> --yes` 只退休 token 指向的 stale index entry，不删除 project 文件；token 过期、条目重新可读或条目不可读但不 stale 时必须失败。
- 全局依赖索引中的 project record 存在但不可读、损坏、digest mismatch 或 location identity 不匹配时，diagnose / verbose status 标记 `unreadableProjectReference`，不能把它当作 stale 自动退休。
- status 从现场推导已安装、需要修复、可认领、有残留、外部管理、未安装。
- status 从 verified records 和全局依赖索引推导 dependents、autoInstalled、未使用依赖提醒和 catalog dependency drift，不执行安装、修复或自动清理。
- `autoInstalled` 按 `installSource.kind === "dependency"` 投影；已显式保留的自动依赖仍显示 autoInstalled，但不会出现未使用依赖提醒。`upgrade --all` 用 `explicitlyRequested === true` 选根，已显式保留的自动依赖可以作为根，未显式保留的自动依赖只能作为显式根的 current catalog 依赖参与升级。
- current catalog 新增依赖但当前 record 的 dependency edges 自洽时，status 只显示 drift / upgrade 建议，不把当前安装直接判为缺失依赖。
- record 的 dependency edge 指向缺失、不健康或无法验证的位置时，status 显示需要修复；repair 可以按 record 中已有 edge declaration 补齐依赖，只有 current catalog 与 record source 是同一 bundle 时才刷新为 current catalog 的 dependency graph。
- `cleanup` / `uninstall` 目标仍被 verified dependency edge 引用时失败；卸载父插件后，引用归零的自动依赖只给手动清理提示，不自动删除。
- dependency metadata 不完整或 incoming index 覆盖范围不足时，不展示未使用依赖提醒。
- 删除一个 AW-owned skill 文件后，如果 current catalog 与 record source 仍是同一 bundle，status 显示需要修复，repair 能恢复；如果 source 已漂移，repair 不隐式升级，必须提示显式 upgrade / reinstall / cleanup。
- 修改 shared config 中 AW-owned block 后，diagnose 能识别漂移，repair 只替换 AW block。
- 修改 dynamic artifact 输出文件后，默认 status / diagnose 能用 diagnostic cache 识别 content drift；cache 缺失时不执行 renderer，不只因 cache 不可用把顶层状态降级为“需要修复”，并提示 `diagnose --deep`。
- dynamic artifact 上次 accepted state 为 `disabled` 时，默认 status / diagnose 不把目标内容缺失判为 missing，并能展示 disabled reason；如果 render config 已变化或最近 refresh 失败，仍要提示 stale / refresh failed。
- project shared config store 中可共享键变化但 dynamic artifact 未刷新时，默认 status / diagnose 能用 diagnostic cache 识别 config stale；`diagnose --deep` 可以执行 renderer，repair 只有在同一 bundle、marker-only install repair 或 `--adopt-existing` 路径中才可以执行 renderer。user config store、project local config store 或路径型配置变化不能让 repo-visible project artifact 变 stale。
- 健康 installed 目标运行普通 `aw cleanup` 会失败并提示 `aw uninstall`；损坏、残留或 marker-only 状态下 cleanup 可以清理可确认属于 AW 的内容。
- 普通 `aw uninstall` 会从 historical lifecycle runtime 运行卸载 lifecycle；`aw cleanup` 不运行 lifecycle，并提示可能残留外部副作用。
- shared config 不可解析且 marker 不可定位时，普通 cleanup 不破坏文件。
- `cleanup --force` 会备份共享文件，并且只删除可定位的 AW-owned 区块。
- Codex user native install 成功但 record 写入失败时，保留 native transaction marker，status 显示需要处理。
- marker-only repair install 在 native post-check 已满足时不重跑 native install，只补齐 AW 状态、写 record 并删除 marker。
- marker-only repair install 在 native post-check 失败时才进入显式 native 修复路径；native 修复失败不写成功 record，并保留可诊断 marker。
- marker-only cleanup 成功后删除 native state 和 marker，status 回到未安装。
- upgrade 不消费 marker-only 状态，提示先 repair 或 cleanup。
- user config 写入只刷新 user-scope dynamic artifacts；有本机 record 的 project shared config 写入只刷新当前 project-scope dynamic artifacts。可认领但未认领的 project shared config 写入遵守 `adoptExistingRequired` 边界；路径型配置和 project local config 写入不触发 repo-visible project artifact refresh。失败不写 install record，可以写 dynamic diagnostic cache 的最后失败摘要。
- `status` 默认不执行 renderer；`diagnose --deep` 可以执行 renderer，repair 只有在同一 bundle、marker-only install repair 或 `--adopt-existing` 路径中执行 renderer。
- install record 只保存当前 location 自己的 `skillTriggerPreference`；shared runtime owner 状态只保存 replay 当前 owner 所需的 preference，不写全局顺序字段或自动胜者列表。
- 默认 stdout 不出现内部状态术语。

## 实施顺序建议

这份 spec 应按 install-state 架构切换落地，不适合只在旧 `installed.json` / tracking 结构上补字段：

1. 先引入新的 install-state facade，落地 per-plugin install record、dynamic diagnostic cache、project artifact shared identity、shared runtime owner 和 dependency index 的只读投影。
2. 再迁移写命令：`install`、`repair`、`uninstall`、`cleanup`、`reinstall`、`upgrade` 和 config refresh 都应通过同一层状态 facade 读写 ownership、identity、diagnostic 和 dependency 信息。
3. 最后同步公开文档、测试 fixture 和 `.agents/skills/create-agent-workflows-plugin/` 作者参考，避免运行时行为和插件作者约定脱节。

## 文档与作者工具要求

实施时必须同步更新：

- `docs/architecture.md` 的 Runtime State、Discovery and Status。
- `docs/plugin-installation.md` 的安装、依赖自动安装、升级顺序、卸载保护、未使用依赖提示、shared skill trigger 单 owner、状态、故障排查、project artifact shared identity、project artifact 认领，以及 project shared/local config 的 ignore / receipt 分类、可认领状态下 config write 边界和路径型配置限制。
- `docs/plugin-authoring.md` 中 `dependencies.plugins`、dynamic artifact、lifecycle、config refresh、skill trigger install override 的状态语义，以及 project shared/local config / project artifact shared identity 的输入边界：只有 project artifact render config 能影响 repo-visible project artifacts，identity metadata 只证明共享 artifact 来源，local config 不是安装证据、默认不作为团队共享输入；`file` / `directory` 只能作为本机 effective config，不能成为 project shared artifact truth。
- `.agents/skills/create-agent-workflows-plugin/` 下作者参考，尤其是 tracking、project artifact shared identity、lifecycle、Codex scope、project shared/local config、路径型配置和 shared skill trigger owner 行为描述；作者文档需要说明 uninstall lifecycle 仍按安装时 historical runtime 执行，但 lifecycle runtime 不再是完整 install snapshot。
- 测试 fixture 中所有依赖 `installed.json`、ledger degraded、capability snapshot、完整 install snapshot、dependency edge 旧位置的断言；保留并重写 historical lifecycle runtime 的最小引用断言。
