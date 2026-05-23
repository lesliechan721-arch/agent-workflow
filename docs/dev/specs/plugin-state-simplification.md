# 插件状态简化 Spec

## 文档定位

本文档只定义插件状态简化的需求边界、现状约束、用户体验、公开合同和验收标准，不写实现计划、阶段拆分、测试清单或文件级改造步骤。

本次需求面向开发阶段的状态模型重设。旧安装、旧状态格式和历史兼容行为不作为约束；可以重新设计公开状态、JSON 合同和命令边界。

如果与 `docs/dev/specs/plugin-state-and-tui-simplification.md` 同时存在，后者是包含 TUI、console item 和公开页面模型的完整落地规格；本文保留为状态模型来源文档。两份文档在公开命令、TUI 动作或 `nextSteps` 语义上冲突时，以完整规格为准。

## 背景

插件状态曾经做过一次简化，但随着安装、卸载、升级、修复、清理、动态产物、共享 runtime、依赖保护和异常恢复不断叠加，状态模型再次变得复杂。当前系统为了区分各种异常现场，维护了过多辅助状态，并把很多异常证据提升成用户可见或命令阻断条件。

新的方向是让状态服务正常插件数据，而不是为每一种坏数据建立精细修复路径。正常安装、卸载、升级必须可靠，不应留下 AW 已知的残留。异常插件按尽力而为处理：允许残留，允许用户显式清理后重新安装恢复，不为了“把异常插件完美卸干净”继续扩张状态机。

## 现状探查结论

当前安装真值名义上已经是 per-plugin install record。它记录 AW 对某个 plugin/platform/scope/location 的本机安装事实、ownership、安装来源、产物和 dependency edges。相关类型集中在 `packages/cli/src/install-state/types.ts`。

实际状态判断并不只看 install record。`collectInstallEvidence` 会读取 install record、project artifact identity、dynamic diagnostic cache、historical lifecycle runtime、global dependency index、shared runtime owner、native transaction marker、平台 native 证据和 tracking manifest，再交给 `projectInstallState` 投影。相关路径主要是：

- `packages/cli/src/install-state/evidence.ts`
- `packages/cli/src/install-state/status-projection.ts`
- `packages/cli/src/install-state/transactions.ts`
- `packages/cli/src/commands/install-state-removal.ts`

当前用户可见状态包括 `installed`、`needsRepair`、`adoptable`、`residual`、`externallyManaged`、`notInstalled`。其中 `needsRepair`、`adoptable`、`residual` 多数是在表达异常处理建议，而不是正常安装状态。

`aw uninstall` 现在只处理健康 `installed`，遇到 record 损坏、native marker、shared owner 冲突、historical runtime 不可信、dependency index 异常等情况会 fail closed，并引导 `cleanup` 或 `repair`。这保证了安全，但也让异常插件更容易卡住用户。

`aw cleanup` 已经承担了大量异常收口职责，包括 record 残留、marker-only、cache-only、manifest-only、shared owner、stale dependency index、runtime root 和 owner 残留等。它已经接近通用恢复框架，继续细分会让状态管理更难维护。

`aw repair` 当前同时承担修复、adopt、dependency index 重建和 shared runtime takeover 等职责。按新的目标，它会让“异常要修复”继续压过“异常要可清理、可重装”的原则。

`docs/plugin-installation-technical-details.md` 已经明确区分安装真值和现场证据：平台目录里的文件、diagnostic cache、native marker、shared owner 都不应作为正式安装事实。新的需求应沿用这个方向，并进一步减少辅助证据对主状态的影响。

## 已确认决策

- 本次可以破坏旧公开行为和旧 JSON 合同，不需要兼容历史安装插件。
- 用户可见状态收敛为四态：`installed`、`notInstalled`、`cleanupRequired`、`external`。
- `needsRepair`、`residual`、`adoptable` 不再作为一等状态；对应信息降级为 reason、diagnostic 或 next step。
- `repair` 命令从目标模型中移除。
- project shared artifacts 的认领入口改为 `aw install --adopt-existing`。
- `project artifact identity` 只服务 project adopt，不再影响已有 record 的健康、卸载和升级。
- `dynamic diagnostic cache` 只作为诊断缓存，不再影响安装状态。
- `global dependency index` 是可重建派生索引，不是安装真值。
- `shared runtime owner` 不再独立作为强状态文件；其 ownership 信息应并入 install record 或由 record/依赖关系推导。
- 有效 install record 存在时，`historical lifecycle runtime` 缺失或 dependency index 安全性无法确认不改变顶层 `installed`。这两类问题只作为命令级阻断、diagnostic 或 `nextSteps` 暴露。
- 缺少 `historical lifecycle runtime` 时，正常 `uninstall` 仍可 fail closed；`cleanup` 不运行 lifecycle，直接尽力删除 AW 已知状态和可重建残留。
- 普通 `aw install` 遇到 `external` 必须 fail closed，不能默认覆盖外部内容。project fresh clone 认领只通过 `aw install --adopt-existing`。
- 无有效 install record 但存在可验证 project shared artifacts 和 project artifact identity 的 fresh clone 场景，顶层状态归为 `external`，reason 使用 `claimableProjectArtifacts`，下一步只能是 `aw install --adopt-existing`，不能默认 cleanup、覆盖或删除。
- dependency index 的显式维护入口是 `aw cleanup --dependency-index --prune-stale <token> --yes`；`repair --dependency-index` 不属于目标模型。
- `--takeover-shared-runtime` 不属于目标公开合同；shared runtime owner 冲突只作为写命令 blocker、diagnostic 或 `nextSteps` 暴露。
- `cleanup` 默认保留插件配置；只有显式 `--remove-config` 才删除配置。
- `cleanup --plan` 从目标模型中移除。
- `reinstall` 是保留配置的重建入口。它不追求保留旧 record、旧 source、旧 artifact truth 或旧诊断状态；除配置和明确外部数据外，旧 AW 状态都可以删除后按 current catalog 重建。

## 目标、范围与非目标

### 目标

简化插件状态管理，让 install record 成为唯一安装真值。正常插件只需要围绕 record、当前 catalog 和实际产物完成安装、卸载、升级和状态展示。

降低异常恢复复杂度。异常插件不再被拆成多个长期维护状态；统一表达为 `cleanupRequired` 或 `external`，用户通过清理、认领或重新安装恢复。

让 `cleanup` 成为明确、直接、可重复执行的恢复入口。除了配置这类不可重建用户数据，其它 AW 已知且可重建的状态和残留都可以大胆删除；删除存在风险时提示用户，但不应让用户陷入无法清理、无法恢复的死锁。

减少辅助状态源。diagnostic cache、dependency index、project identity、historical runtime、native marker、shared owner 都不能再影响主安装事实；它们只在特定命令和诊断中发挥有限作用。

### 范围

本需求覆盖 `codex` 和 `claude` 平台，覆盖 `user` 和 `project` scope，覆盖 `install`、`uninstall`、`upgrade`、`status`、`cleanup`、`reinstall` 及 JSON 输出合同。

本需求覆盖 install-state facade、状态投影、状态证据读取、cleanup 行为边界、project adopt 入口、依赖索引定位、shared runtime ownership 定位、CLI help / command registration、console item / TUI 动作模型、公开文档、插件作者文档和测试合同。

### 非目标

不保留旧状态格式迁移路径。

不保证历史安装插件可以无损升级到新状态模型。

不为异常插件提供精细 repair。

不追求异常插件卸载后零残留。cleanup 的目标是让用户能重新安装恢复，而不是证明所有外部副作用都被完美撤销。

不把插件配置纳入默认清理范围。

## 术语与状态模型

### 安装真值

安装真值只来自有效 install record。存在有效 record 表示该 location 由 AW 管理；缺少有效 record 表示 AW 不应把该 location 当成已安装。

### 现场证据

现场证据包括平台 native 文件、repo-visible artifacts、project artifact identity、diagnostic cache、native marker、historical runtime、dependency index、shared runtime owner 和残留目录。它们可以用于诊断、cleanup 删除计划和用户提示，但不能单独证明插件已安装。

### 四态模型

`installed` 表示存在有效 install record，AW 可以确认该 location 由 AW 管理。diagnostic cache 缺失、dependency index 缺失、project identity 缺失、historical lifecycle runtime 缺失或 dependency index 暂时无法证明依赖安全，都不应让状态离开 `installed`。如果这些辅助证据会阻断某个写命令，应通过 command-level blocker、diagnostic 或 `nextSteps` 表达。

`notInstalled` 表示没有有效 install record，也没有需要提醒用户处理的外部管理证据或 AW 可清理残留。

`cleanupRequired` 表示没有有效可用的 install record，或者 record 本身不可读、不可信，且 AW 发现了可清理的私有状态、可重建残留、异常 record、native marker、historical runtime、shared runtime ownership 残留、非认领场景的 repo-visible AW 产物或其它会影响重新安装的证据。

`external` 表示没有有效 install record，但平台或项目中存在 AW 不应默认删除或覆盖的内容。它包括 AW 不能证明归属的外部插件证据，也包括可通过 project artifact identity 验证来源、但只能显式认领的 project shared artifacts。后者不表示来源不明，只表示本机没有 AW ownership。

### 无 Record 场景投影优先级

缺少有效 install record 时，状态投影按以下顺序收敛。同一 location 只产生一个顶层状态；低优先级证据可以进入 diagnostics，但不能改变顶层状态。

1. 如果存在 AW 无法证明归属、明显属于其它管理方或删除风险不可界定的外部证据，顶层状态为 `external`，reason 使用 `foreignExternalEvidence`。同时存在 AW 可清理残留时，残留只能作为 diagnostics 或附属 next step 暴露，不能让状态覆盖成 `cleanupRequired`。
2. 如果不存在高优先级外部证据，但存在不可读或不可信 record、native transaction marker、AW 私有状态残留、historical runtime 残留、dependency index 引用残留、shared runtime ownership 残留，或其它会阻断重新安装的 AW-owned 证据，顶层状态为 `cleanupRequired`。
3. 如果不存在上述 blocker，且 project scope 中存在可验证的 project shared artifacts 和 project artifact identity，顶层状态为 `external`，reason 使用 `claimableProjectArtifacts`，`nextSteps` 指向 `aw install --adopt-existing`。这类场景不能被投影为 `cleanupRequired`，也不能由普通 `install`、`cleanup` 或 `reinstall` 默认覆盖或删除。
4. 如果没有任何需要处理的证据，顶层状态为 `notInstalled`。

### Reasons 与 Diagnostics

状态细节通过 `reasons`、`diagnostics` 和 `nextSteps` 表达。reason 用于解释为什么进入 `cleanupRequired` 或 `external`；diagnostics 用于展示辅助证据；next steps 用于告诉用户下一步运行哪个命令。

Reason 不是状态机。新增异常类型时，优先归入已有四态，只增加必要 reason，不增加新一等状态。

## 用户体验需求

### 状态查看

`aw status` 默认输出只展示四态和简短下一步。用户不应看到 `needsRepair`、`residual`、`adoptable` 这类旧状态词。

当插件为 `installed` 时，状态输出应让用户确信 AW 仍管理该安装。诊断缓存缺失、依赖索引缺失、project identity 缺失、historical lifecycle runtime 缺失这类可重建或辅助证据问题，不应在默认输出里制造“安装坏了”的感受；如果它们会阻断卸载、升级或重装，应在 verbose / JSON 的 diagnostic、command-level blocker 或 `nextSteps` 中说明。

当插件为 `cleanupRequired` 时，状态输出应直接建议 `aw cleanup <plugin>`。如果配置会保留，应明确说明配置不会默认删除；需要清配置时使用 `--remove-config`。

当插件为 `external` 时，状态输出应说明 AW 没有本机 ownership，默认不会删除或覆盖。reason 为 `claimableProjectArtifacts` 时，下一步应明确指向 `aw install --adopt-existing`；其它外部证据只能提示用户先移除外部内容或等待未来明确外部接管入口。

### 安装与认领

普通 `aw install` 面向新安装或 AW 已拥有目标的覆盖安装。它提交有效 install record 后，该 record 成为后续状态判断、卸载和升级的安装真值。

普通 `aw install` 遇到 `external` 必须 fail closed，并说明 AW 不能证明目标归属，不能默认覆盖外部内容。只有 project shared artifacts 的 fresh clone 场景可以通过 `aw install --adopt-existing` 认领；其它外部内容接管如果未来要支持，必须引入单独 flag 和确认语义。

`aw install --adopt-existing` 是 project shared artifacts 的认领入口。它只在 project scope 中使用，用于 fresh clone 场景：仓库里存在可验证的共享产物和 project artifact identity，但本机没有 install record。认领成功后创建本机 install record，并让状态进入 `installed`。

`project artifact identity` 只用于证明 project adopt 的来源。已有有效 record 的插件，不应因为 identity 缺失或损坏而变成 `cleanupRequired`。

### 卸载

`aw uninstall` 只处理有效、可正常卸载的 record。卸载应清理 AW 管理的平台注册、repo-visible artifacts、project identity、diagnostic cache、historical runtime、native marker、shared runtime ownership 信息、install record 和可重建派生状态。

如果卸载需要执行旧 lifecycle，但 historical runtime 缺失或不可验证，`aw uninstall` 可以失败，并引导用户运行 `aw cleanup`。这类失败不应扩展成新的 repair 状态，也不应让有效 record 的顶层状态离开 `installed`。

如果 dependency index 缺失或不可信，卸载应先尝试从有效 install records 重建。重建失败且无法确认依赖安全时，可以保守阻断普通卸载，并引导用户查看状态、维护 dependency index 或清理。这类依赖安全阻断不改变有效 record 的顶层 `installed`。

### 清理

`aw cleanup` 是异常插件恢复入口。它不运行 uninstall lifecycle，不尝试精细修复，不要求先执行 plan。

`cleanup` 默认删除 AW 已知且可重建的状态和残留，包括异常 record、diagnostic cache、native marker、historical runtime、dependency index 中对应引用、非认领场景的 project artifact identity、shared runtime ownership 信息和 AW 可定位产物。

reason 为 `claimableProjectArtifacts` 的 `external` 目标不属于默认 cleanup 对象。`cleanup` 不能为了让普通 install 继续而删除可认领共享产物；用户应先通过 `aw install --adopt-existing` 认领，或自行移除这些共享产物后再按普通未安装路径处理。

配置默认保留。只有显式传入 `--remove-config` 时，cleanup 才删除当前 target 的 AW 自管配置。

如果某些删除动作存在风险，命令应在输出中提醒用户，但原则上不应阻断清理。不能清理会让用户无法恢复，因此只有在无法定位目标、无法安全枚举删除范围或可能删除明显外部数据时，才允许保守跳过该项，并在结果中列出残留。

`cleanup` 应可重复执行。重复清理已经不存在的目标应给出稳定结果，不应报错或进入新的异常状态。

### 升级与重装

`aw upgrade` 只处理有效 install record。缺少 record 或 record 不可读时，目标进入 `cleanupRequired`，用户先 cleanup 后重新 install。

`aw reinstall` 是保留配置的重建入口。它读取当前目标状态，删除 AW-owned 且可重建的旧状态和残留，再按 current catalog 重新安装。它不尝试保留旧 record、旧 source、旧 artifact truth、dynamic diagnostic cache、native marker、historical runtime、dependency index 引用或 shared runtime ownership 残留。

`reinstall` 可以处理健康 `installed` 和可安全收口的 `cleanupRequired` 目标。遇到 `cleanupRequired` 时，不应要求用户先单独执行 `cleanup`；命令应在内部使用 cleanup 语义删除 AW-owned 可重建状态，然后继续安装。只有存在 verified dependents、无法安全枚举删除范围、可能删除明显外部数据、目标属于 `external`，或 project shared artifacts 可认领时，`reinstall` 才应在写入前停止并说明原因。

`reinstall` 默认保留插件配置，不提供隐式删除配置语义。用户要清除配置，必须显式使用 `cleanup --remove-config` 或配置命令。

遇到 project shared artifacts 可认领时，`reinstall` 不应把它们当残留覆盖或删除，应引导 `aw install --adopt-existing`。

### 移除 Repair

目标模型不再提供 `aw repair`。历史上由 repair 承担的能力按以下方式分流：

- 重铺有效安装的 AW-owned artifacts、record、diagnostic cache、project identity 或 historical runtime：由 `aw reinstall` 或显式 install/upgrade 路径承担，不再为了保持旧状态做同 bundle 精细修补。
- marker-only install、record + marker residual 和其它半完成写入：由 `cleanup` / `reinstall` 删除 AW 可重建残留后重新安装承担，不再补齐旧 record。
- 配置驱动的 runtime drift：由配置写入后的自动 apply、TUI 重新应用配置或 `reinstall` 承担，不再提供脚本化 `repair` 重放旧安装。
- project fresh clone 认领：由 `aw install --adopt-existing` 承担。
- dependency index 重建：由需要索引的命令自动尝试；显式维护通过 `aw cleanup --dependency-index --prune-stale <token> --yes` 完成，不叫 repair，也不复用普通插件 target 的 repair 语义。
- shared runtime takeover：不再作为公开能力；ownership 信息由 install record 或 record 推导模型处理，冲突按 command-level blocker 处理。
- 异常恢复：统一由 `cleanup` 或 `reinstall` 的清理阶段删除 AW-owned 可重建状态后重新安装处理。

## 公开合同和命令边界

### `aw status --json`

JSON 顶层状态只允许四态：`installed`、`notInstalled`、`cleanupRequired`、`external`。

JSON 可以包含 `reasons`、`diagnostics` 和 `nextSteps`。其中：

- `reasons` 描述状态成因，面向脚本和排障；
- `diagnostics` 展示辅助证据，不表示安装真值；
- `nextSteps` 给出建议命令。

JSON 不再承诺旧的 `needsRepair`、`residual`、`adoptable` 等一等状态。旧字段可以移除或重新设计。

### `aw cleanup`

`aw cleanup` 直接执行清理，不再提供 `--plan` 作为目标合同。

`--force` 可以保留为更明确的高风险确认入口，但它不应成为普通异常恢复的前置条件。默认 cleanup 应尽量删除 AW 已知可重建状态；无法安全删除的外部或未归属内容应跳过并报告。

`--remove-config` 是删除配置的唯一显式合同。没有该参数时，配置必须保留。

`--dependency-index --prune-stale <token> --yes` 是 dependency index 的显式维护入口。它只处理指定 stale index reference，输出和 JSON receipt 必须说明 token、动作结果、跳过或失败原因；它不能执行普通插件 repair，也不能把 dependency index 当成安装真值。

### `aw reinstall`

`aw reinstall` 直接执行保留配置的重建流程：先删除当前 target 上 AW-owned 且可重建的旧状态和残留，再按 current catalog 重新安装。它不能把旧 install record、historical runtime、diagnostic cache、project identity、native marker、dependency index 或 shared runtime owner 当作需要保持的状态。

`reinstall` 内部清理阶段遵守 `cleanup` 的归属和安全边界。无法安全删除的外部或未归属内容必须跳过或阻断，不能为了重装而删除明显外部数据。存在 verified dependents 或无法确认依赖安全时，命令应在新安装前失败。

`reinstall` 不删除插件配置，也不提供隐式删除配置的参数。配置清理只通过 `cleanup --remove-config` 或配置命令完成。

`reinstall` 遇到 project shared artifacts 可认领时必须停止，并提示 `aw install --adopt-existing`。认领不是重装语义，不能通过删除共享产物后重装来替代。

### `aw install --adopt-existing`

`--adopt-existing` 只用于 project scope。它要求存在可验证的 project shared artifacts 和 project artifact identity，且当前 location 没有有效 install record。

如果已有有效 install record，`--adopt-existing` 不应改变现有安装语义。

如果共享产物不可验证，命令应失败并提示 cleanup 或普通 install，而不是创建含糊 record。

### 普通 `aw install` 与 `external`

普通 `aw install` 遇到 `external` 必须失败，不能覆盖、删除或默认认领没有本机 ownership 的内容。错误提示应说明 ownership 风险，并给出可执行的安全路径：reason 为 `claimableProjectArtifacts` 时使用 `aw install --adopt-existing`，其它外部证据先由用户移除或等待未来明确外部接管入口。

如果目标已有有效 install record，普通 install 可以按 AW-owned 覆盖安装语义继续；这不属于 `external`。

### Dependency Index

dependency index 是派生索引。任何命令都不能把它作为安装真值。

需要依赖保护时，命令应优先从有效 install records 重建或校验索引。只有在无法确认依赖安全时，普通卸载和升级才可以保守失败。

cleanup 面向用户显式恢复，只要没有已知 verified dependents，就应继续尽力清理。

显式维护入口固定为 `aw cleanup --dependency-index --prune-stale <token> --yes`。`status --verbose`、JSON `nextSteps` 和公开文档如果需要提示用户处理 stale dependency index，应指向这个入口，而不是 `aw repair --dependency-index`。

### Shared Runtime Ownership

shared runtime ownership 不再由独立强状态文件决定主安装状态。目标模型应让 ownership 信息并入 install record 或从有效 records / dependency edges 推导。

目标公开合同不提供 `--takeover-shared-runtime`。`install`、`upgrade`、`reinstall`、`cleanup`、CLI help、公开文档、TUI、JSON receipt、错误提示和 `nextSteps` 都不能把该 flag 当作可执行恢复入口。批量命令或 `--platform both` 也不能通过任何公开参数批量接管 shared runtime。

owner 冲突不产生新的顶层状态。有效 install record 存在时，冲突只作为 command-level blocker、diagnostic 或 `nextSteps` 暴露；没有有效 record 时，陈旧或损坏的 shared runtime owner 文件属于可清理 AW 残留，除非同时存在更高优先级的外部证据。

record-derived ownership 至少遵守以下规则：

- claim：目标只有在没有其它有效 record 控制同一 plugin/platform 的 shared runtime，或目标就是推导 owner 时，才可以写入 shared runtime。
- refresh：只有推导 owner 可以刷新 shared runtime；非 owner 写命令在第一笔写入前失败，reason 使用 `sharedRuntimeOwnerConflict`。
- release：删除或清理 owner record 时释放 ownership；释放后如果还有其它有效 record 需要同一 shared runtime，按稳定规则重新推导 owner 并重新物化，否则移除 shared runtime。
- takeover：目标模型不支持接管。用户必须先卸载、清理或调整冲突 owner 对应的有效安装，再重新执行原命令。

清理异常插件时，shared runtime ownership 残留属于可重建 AW 状态，可以删除。若存在可能影响其它有效安装的风险，应提醒用户，并尽力基于有效 records 避免误删。

### Historical Lifecycle Runtime

historical lifecycle runtime 只服务正常 uninstall 或需要旧版本上下文的正常路径。它缺失时，不应产生新的异常状态分支。

cleanup 不执行 lifecycle，也不因为 historical runtime 缺失而阻断。

## 验收标准

- 状态模型只向用户和 JSON 顶层暴露 `installed`、`notInstalled`、`cleanupRequired`、`external`。
- 有效 install record 是唯一安装真值；diagnostic cache、project identity、dependency index、native marker、historical runtime 和 shared runtime ownership 不能单独证明已安装。
- `needsRepair`、`residual`、`adoptable` 不再作为用户可见一等状态。
- `aw repair` 不再作为目标命令存在；原职责已分流到 install、cleanup、reinstall、upgrade 或自动索引重建。
- `aw install --adopt-existing` 能覆盖 project fresh clone 认领场景，并且不会影响已有有效 record 的安装。
- 无有效 record 的可认领 project shared artifacts 顶层状态为 `external`，reason 为 `claimableProjectArtifacts`，next step 指向 `aw install --adopt-existing`。
- diagnostic cache 缺失、损坏或 stale 不会让有效安装变成异常状态。
- dependency index 缺失或不可信时，写命令会尝试从有效 records 重建；无法确认依赖安全时才阻断普通卸载或升级。
- historical runtime 缺失和 dependency index 安全性无法确认不会改变有效 record 的顶层 `installed`，只会形成命令级阻断、diagnostic 或 `nextSteps`。
- shared runtime ownership 不再作为独立主状态影响健康判断。
- 公开合同不再提供 `--takeover-shared-runtime`；owner 冲突只作为 command-level blocker、diagnostic 或 `nextSteps` 暴露。
- 正常 uninstall 仍可以因为 historical lifecycle runtime 缺失而 fail closed，并明确引导 cleanup。
- `aw cleanup` 不需要先执行 plan，默认清理 AW 已知且可重建状态和残留。
- `aw cleanup` 默认保留配置；只有 `--remove-config` 会删除配置。
- `aw reinstall` 默认保留配置，并能对可安全收口的 `cleanupRequired` 目标执行清理后重新安装，不要求用户先单独运行 cleanup。
- `aw reinstall` 不保留旧 record、旧 source、旧 artifact truth、diagnostic cache、native marker、historical runtime、dependency index 引用或 shared runtime ownership 残留。
- `aw reinstall` 遇到 verified dependents、无法安全枚举删除范围、明显外部数据或 project adopt 场景时，会在新安装前停止并给出下一步。
- `aw cleanup` 对异常插件可重复执行，重复执行不会引入新异常。
- cleanup 无法安全删除的外部或未归属内容会被跳过并报告，不会阻止其它可清理项继续执行。
- 普通 `aw install` 遇到 `external` 必须 fail closed；project fresh clone 认领只通过 `aw install --adopt-existing`。
- dependency index 的公开维护入口是 `aw cleanup --dependency-index --prune-stale <token> --yes`，公开文档和 `nextSteps` 不再指向 `repair --dependency-index`。
- 文档明确说明异常插件的恢复方式是 cleanup/install 或 reinstall 的删除后重建，而不是精细 repair。
