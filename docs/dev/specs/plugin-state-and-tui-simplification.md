# 插件状态与 TUI 体验统一简化 Spec

日期：2026-05-22
状态：需求确认稿
整合来源：`docs/dev/specs/plugin-state-simplification.md`、`docs/dev/specs/aw-tui-ux-polish-gap-fix.md`
文档规范：`docs/dev/spec-plan-writing-guide.md`

## 文档定位

本文档整合插件状态简化和 TUI 体验落差修复两组需求，统一定义状态模型、恢复入口、TUI 页面体验、公开合同和验收标准，不写实现计划、阶段拆分、测试文件清单或文件级改造步骤。

两份来源文档仍可作为历史上下文保留；当本文与来源文档在 `repair` 去留、`reinstall` 语义、状态展示分层、TUI 动作入口或 `nextSteps` 展示方式上冲突时，以本文为准。

本次需求面向开发阶段的状态模型和 TUI 公开体验重设。旧安装、旧状态格式、旧 JSON 合同和历史兼容行为不作为约束；可以重新设计公开状态、命令边界和 TUI page model。

## 背景

插件状态模型在安装、卸载、升级、修复、清理、动态产物、共享 runtime、依赖保护和异常恢复不断叠加后，再次变得过细。当前系统为了区分各种异常现场，维护了很多辅助状态，并把不少现场证据提升成用户可见状态或命令阻断条件。用户最终看到的是 `needsRepair`、`adoptable`、`residual`、`diagnose`、`repair`、`cleanup` 等多条路径，而不是清楚的“已安装、未安装、需要清理、外部内容”。

新的方向是让状态服务正常插件数据，而不是为每一种坏数据建立精细修复路径。正常安装、卸载、升级和重装必须可靠；异常插件按尽力而为处理。除了用户配置和明确外部数据，AW 自己可重建的状态都不重要，可以清理后按 current catalog 重建。

TUI 也需要跟随这次收口。当前 TUI 已经有插件控制台雏形，但首页、详情页、状态页、结果页和配置页仍有明显 CLI 痕迹：页面重复展示摘要，详情页混入 catalog/schema/install record 等内部信息，状态和诊断入口没有完全合并，写操作完成后进入独立结果页，配置页像调试页，安装向导仍残留安装期 SkillTrigger 和字符串 `nextSteps`。本轮要把 TUI 收紧成真正的插件管理控制台。

## 现状探查结论

当前安装真值名义上已经是 per-plugin install record。它记录 AW 对某个 plugin/platform/scope/location 的本机安装事实、ownership、安装来源、产物和 dependency edges。相关类型集中在 `packages/cli/src/install-state/types.ts`。

实际状态判断并不只看 install record。`collectInstallEvidence` 会读取 install record、project artifact identity、dynamic diagnostic cache、historical lifecycle runtime、global dependency index、shared runtime owner、native transaction marker、平台 native 证据和 tracking manifest，再交给 `projectInstallState` 投影。相关路径主要包括：

- `packages/cli/src/install-state/evidence.ts`
- `packages/cli/src/install-state/status-projection.ts`
- `packages/cli/src/install-state/transactions.ts`
- `packages/cli/src/commands/install-state-removal.ts`

当前用户可见状态包括 `installed`、`needsRepair`、`adoptable`、`residual`、`externallyManaged`、`notInstalled`。其中 `needsRepair`、`adoptable`、`residual` 多数是在表达异常处理建议，而不是正常安装事实。

`aw repair` 目前承担了过多职责：同 bundle 重铺 AW-owned artifacts、marker-only install 补 record、record + marker residual 收口、project fresh clone adopt、dependency index 重建、shared runtime takeover 和配置驱动 runtime drift 重放。这些能力让用户继续以为“异常要修复”，也让实现为了保留旧 record、旧 source 和旧 artifact truth 付出很高复杂度。按新原则，这些旧状态不值得精细保持。

`aw reinstall` 当前已经是“移除再安装”的入口，但仍继承了旧模型里过保守的 fail-closed 行为。新模型下，`reinstall` 应成为保留配置的重建入口：内部删除 AW-owned 可重建状态和残留，再按 current catalog 安装；不要求用户先手动 `cleanup`。

TUI 当前仍存在几类体验落差：

- 首页正文和 prompt choices 各自展示一套插件摘要，视觉上仍是文本列表。
- 插件详情页混入 catalog、selector、schema digest、install record 等技术诊断字段。
- TUI 功能模型仍残留 `diagnose` / `openDiagnose` / `查看诊断`。
- 状态详情页仍把 `nextSteps` 当正文建议渲染。
- 写操作完成后仍进入独立结果页，并提供 `返回首页`、`状态 · 某位置` 等分叉。
- 配置页默认展示 schema source、manifest digest、catalog channel、minAwVersion、install record path 等内部字段。
- 安装向导仍残留安装期 SkillTrigger 选择模型和字符串 `nextSteps`。
- 危险确认页虽然已有选项确认，但正文仍容易退化成一段 `confirmText`。

## 已确认决策

- 本次可以破坏旧公开行为和旧 JSON 合同，不需要兼容历史安装插件。
- install-state 和 `aw status --json` 顶层状态收敛为四态：`installed`、`notInstalled`、`cleanupRequired`、`external`。
- TUI 首页保留任务友好的四类分组：`异常`、`可升级`、`已安装`、`未安装`。这是 console summary 展示层，不是新的安装真值。
- `needsRepair`、`residual`、`adoptable` 不再作为用户可见一等状态；对应信息降级为 reason、diagnostic、TUI 推荐动作或特定命令入口。
- `aw repair` 从目标模型中移除。TUI、帮助、文档、JSON receipt、`nextSteps` 和用户可见输出都不能再把 `repair` 作为可执行恢复入口。
- project shared artifacts 的认领入口改为 `aw install --adopt-existing`。
- 普通 `aw install` 遇到 `external` 必须 fail closed，不能默认覆盖外部内容。project fresh clone 认领只通过 `aw install --adopt-existing`。
- 无有效 install record 但存在可验证 project shared artifacts 和 project artifact identity 的 fresh clone 场景，底层状态归为 `external`，reason 使用 `claimableProjectArtifacts`，下一步只能是 `aw install --adopt-existing`，不能默认 cleanup、覆盖或删除。
- `reinstall` 是保留配置的重建入口。它不追求保留旧 record、旧 source、旧 artifact truth、dynamic diagnostic cache、native marker、historical runtime、dependency index 引用或 shared runtime ownership 残留。
- `cleanup` 直接执行清理，不再提供 `--plan` 作为目标合同。
- `cleanup` 和 `reinstall` 默认保留插件配置；只有显式 `cleanup --remove-config` 或配置命令才删除配置。
- `dynamic diagnostic cache` 只作为诊断缓存，不影响安装状态。
- `project artifact identity` 只服务 project adopt，不影响已有有效 record 的健康、卸载、升级或重装判断。
- `global dependency index` 是可重建派生索引，不是安装真值。
- dependency index 的显式维护入口是 `aw cleanup --dependency-index --prune-stale <token> --yes`；`repair --dependency-index` 不属于目标模型。
- `shared runtime owner` 不再独立作为强状态文件；ownership 信息应并入 install record 或由有效 records / dependency edges 推导。
- `--takeover-shared-runtime` 不属于目标公开合同；shared runtime owner 冲突只作为写命令 blocker、diagnostic 或 `nextSteps` 暴露。
- 有效 install record 存在时，`historical lifecycle runtime` 缺失或 dependency index 安全性无法确认不改变顶层 `installed`，只作为命令级阻断、diagnostic 或 `nextSteps` 暴露。
- 缺少 `historical lifecycle runtime` 时，正常 `uninstall` 仍可 fail closed；`cleanup` 和 `reinstall` 的清理阶段不运行 lifecycle，直接尽力删除 AW 已知且可重建残留。
- TUI 不展示 CLI 命令建议，不展示 `diagnose` 入口，不把 `nextSteps` 渲染成正文建议区。
- TUI 写操作完成、失败或取消后回到刷新后的插件详情页，并只显示最近一次操作结果。

## 目标、范围与非目标

### 目标

简化插件状态管理，让有效 install record 成为唯一安装真值。正常插件围绕 record、current catalog 和实际产物完成安装、卸载、升级、重装和状态展示。

降低异常恢复复杂度。异常插件不再被拆成多个长期维护状态；统一表达为 `cleanupRequired` 或 `external`，用户通过 `cleanup`、`reinstall`、`install --adopt-existing` 或配置管理恢复。

让 `cleanup` 成为明确、直接、可重复执行的清理入口。除了配置这类不可重建用户数据，其它 AW 已知且可重建的状态和残留都可以删除。删除存在风险时提示用户；无法确认归属或可能删除外部数据时跳过或阻断。

让 `reinstall` 成为保留配置的重建入口。它可以处理健康 `installed` 和可安全收口的 `cleanupRequired` 目标，不要求用户先单独运行 `cleanup`。

让 TUI 成为插件管理控制台：首页扫视插件，详情页承载操作，状态作为详情下级页面，写操作回到详情页并展示最近结果，配置页只展示配置管理信息。

减少辅助状态源对用户体验的影响。diagnostic cache、dependency index、project identity、historical runtime、native marker、shared owner 都不能单独证明插件已安装，也不能让有效安装在默认体验里看起来“坏了”。

### 范围

本需求覆盖 `codex` 和 `claude` 平台，覆盖 `user` 和 `project` scope，覆盖 `install`、`uninstall`、`upgrade`、`status`、`cleanup`、`reinstall`、`config`、TUI 主控制台和 JSON 输出合同。

本需求覆盖 install-state facade、状态投影、状态证据读取、cleanup 行为边界、reinstall 行为边界、project adopt 入口、dependency index 定位、shared runtime ownership 定位、CLI help / command registration、TUI 首页、详情页、状态页、配置页、确认页、写操作结果、公开文档、插件作者工具/文档和测试合同。

### 非目标

不保留旧状态格式迁移路径。

不保证历史安装插件可以无损升级到新状态模型。

不为异常插件提供精细 `repair`。

不追求异常插件卸载后零残留。cleanup 和 reinstall 的目标是让用户能恢复到可安装、可管理状态，而不是证明所有外部副作用都被完美撤销。

不把插件配置纳入默认清理或默认重装范围。

不重新设计 SemVer、本地 catalog gate、平台选择、SkillTrigger 存储语义或跨插件批量后台能力；这些只在影响本轮状态和 TUI 呈现时规定边界。

不为终端 TUI 引入图形化框架、鼠标交互或 Web UI。

## 术语与状态模型

### 安装真值

安装真值只来自有效 install record。存在有效 record 表示该 location 由 AW 管理；缺少有效 record 表示 AW 不应把该 location 当成已安装。

### 现场证据

现场证据包括平台 native 文件、repo-visible artifacts、project artifact identity、diagnostic cache、native marker、historical runtime、dependency index、shared runtime owner 和残留目录。它们可以用于诊断、cleanup / reinstall 删除范围、TUI 状态详情和用户提示，但不能单独证明插件已安装。

### 底层四态

`installed` 表示存在有效 install record，AW 可以确认该 location 由 AW 管理。diagnostic cache 缺失、dependency index 缺失、project identity 缺失、historical lifecycle runtime 缺失或 dependency index 暂时无法证明依赖安全，都不应让状态离开 `installed`。如果这些辅助证据会阻断某个写命令，应通过 command-level blocker、diagnostic 或 `nextSteps` 表达。

`notInstalled` 表示没有有效 install record，也没有需要提醒用户处理的外部管理证据或 AW 可清理残留。

`cleanupRequired` 表示没有有效可用的 install record，或者 record 本身不可读、不可信，且 AW 发现了可清理的私有状态、可重建残留、异常 record、native marker、historical runtime、shared runtime ownership 残留、非认领场景的 repo-visible AW 产物或其它会影响重新安装的证据。

`external` 表示没有有效 install record，但平台或项目中存在 AW 不应默认删除或覆盖的内容。它包括 AW 不能证明归属的外部插件证据，也包括可通过 project artifact identity 验证来源、但只能显式认领的 project shared artifacts。后者不表示来源不明，只表示本机没有 AW ownership。

### 无 Record 场景投影优先级

缺少有效 install record 时，状态投影按以下顺序收敛。同一 location 只产生一个底层状态；低优先级证据可以进入 diagnostics 或 TUI 状态详情，但不能改变底层状态。

1. 如果存在 AW 无法证明归属、明显属于其它管理方或删除风险不可界定的外部证据，底层状态为 `external`，reason 使用 `foreignExternalEvidence`。同时存在 AW 可清理残留时，残留只能作为 diagnostics 或附属 next step 暴露，不能让状态覆盖成 `cleanupRequired`。
2. 如果不存在高优先级外部证据，但存在不可读或不可信 record、native transaction marker、AW 私有状态残留、historical runtime 残留、dependency index 引用残留、shared runtime ownership 残留，或其它会阻断重新安装的 AW-owned 证据，底层状态为 `cleanupRequired`。
3. 如果不存在上述 blocker，且 project scope 中存在可验证的 project shared artifacts 和 project artifact identity，底层状态为 `external`，reason 使用 `claimableProjectArtifacts`，`nextSteps` 指向 `aw install --adopt-existing`，TUI 推荐动作为认领。这类场景不能被投影为 `cleanupRequired`，也不能由普通 `install`、`cleanup` 或 `reinstall` 默认覆盖或删除。
4. 如果没有任何需要处理的证据，底层状态为 `notInstalled`。

### TUI 友好状态

TUI 首页和插件详情页使用任务友好的展示状态：

| TUI 展示 | 来源 |
|---|---|
| `未安装` | 底层 `notInstalled`，且 current catalog 中可发现插件 |
| `已安装` | 底层 `installed`，且 current catalog 版本不高于已安装版本 |
| `可升级` | 底层 `installed`，且 current catalog 语义版本高于已安装版本 |
| `异常` | 底层 `cleanupRequired` 或 `external`；也包括版本不可比较、已安装版本高于 current catalog、配置阻断等需要处理的友好异常 |

TUI 友好状态不是新的安装真值。`可升级` 只由严格 SemVer 版本比较驱动；bundle fingerprint、source drift、project identity drift 或同版本内容变化不能触发 `可升级`。

### Reasons、Diagnostics 与 Next Steps

状态细节通过 `reasons`、`diagnostics` 和结构化 `nextSteps` 表达。reason 用于解释为什么进入 `cleanupRequired`、`external` 或 TUI `异常`；diagnostics 用于展示辅助证据；next steps 用于 CLI / JSON 说明可继续动作。

Reason 不是状态机。新增异常类型时，优先归入已有四态或 TUI 友好状态，只增加必要 reason，不增加新的一等状态。

TUI 可以消费结构化 `nextSteps` 来决定菜单推荐动作，但不得把 `nextSteps` 渲染成正文建议区，也不得显示 raw command。

### Cleanup 与 Reinstall

`cleanup` 是清理入口，面向用户显式收口异常状态。它删除 AW-owned 且可重建的状态和残留，默认保留配置，不运行 uninstall lifecycle，不尝试精细修复。

`reinstall` 是保留配置的重建入口。它先按 cleanup 语义删除当前 target 上 AW-owned 且可重建的旧状态和残留，再按 current catalog 重新安装。它不保留旧 record、旧 source、旧 artifact truth 或旧诊断状态。

### 操作中心

插件详情页是 TUI 操作中心，不是状态详情页、诊断页或命令提示页。操作中心只回答三件事：

- 这个插件当前整体状态是什么。
- 它在哪些平台或位置有安装、可升级、异常、历史残留或未安装状态。
- 用户现在可以执行哪些 TUI 动作。

更细的证据、诊断事实和恢复评估进入 `状态` 下级页面。

### 最近结果

最近结果是当前插件最近一次 TUI 写操作的结果摘要，只保留一条。它显示在详情页状态摘要之后、平台与安装摘要之前。最近结果必须来自刷新后的插件数据和写操作 receipt / target result，不能从旧结果页文案反解析。

## 用户体验需求

### 状态查看

`aw status` 默认输出只展示底层四态和简短下一步。用户不应看到 `needsRepair`、`residual`、`adoptable` 这类旧状态词。

当插件为 `installed` 时，状态输出应让用户确信 AW 仍管理该安装。诊断缓存缺失、依赖索引缺失、project identity 缺失、historical lifecycle runtime 缺失不应在默认输出里制造“安装坏了”的感受；如果它们会阻断卸载、升级或重装，应在 verbose / JSON 的 diagnostic、command-level blocker 或 `nextSteps` 中说明。

当插件为 `cleanupRequired` 时，状态输出应直接建议 `cleanup` 或 `reinstall` 这类新模型入口。配置默认保留；需要清配置时必须明确使用 `cleanup --remove-config` 或配置命令。

当插件为 `external` 时，状态输出应说明 AW 没有本机 ownership，默认不会删除或覆盖。reason 为 `claimableProjectArtifacts` 时，下一步应明确指向 `aw install --adopt-existing`；其它外部证据只能提示用户先移除外部内容或等待未来明确外部接管入口。

### 安装与认领

普通 `aw install` 面向新安装或 AW 已拥有目标的覆盖安装。它提交有效 install record 后，该 record 成为后续状态判断、卸载、升级和重装的安装真值。

普通 `aw install` 遇到 `external` 必须 fail closed，并说明 AW 不能证明目标归属，不能默认覆盖外部内容。只有 project shared artifacts 的 fresh clone 场景可以通过 `aw install --adopt-existing` 认领；其它外部内容接管如果未来要支持，必须引入单独 flag 和确认语义。

`aw install --adopt-existing` 是 project shared artifacts 的认领入口。它只在 project scope 中使用，用于 fresh clone 场景：仓库里存在可验证的共享产物和 project artifact identity，但本机没有 install record。认领成功后创建本机 install record，并让状态进入 `installed`。

`project artifact identity` 只用于证明 project adopt 的来源。已有有效 record 的插件，不应因为 identity 缺失或损坏而变成 `cleanupRequired`。

### 卸载

`aw uninstall` 只处理有效、可正常卸载的 record。卸载应清理 AW 管理的平台注册、repo-visible artifacts、project identity、diagnostic cache、historical runtime、native marker、shared runtime ownership 信息、install record 和可重建派生状态。

如果卸载需要执行旧 lifecycle，但 historical runtime 缺失或不可验证，`aw uninstall` 可以失败，并引导用户运行 `cleanup` 或 `reinstall`。这类失败不应扩展成新的 repair 状态，也不应让有效 record 的顶层状态离开 `installed`。

如果 dependency index 缺失或不可信，卸载应先尝试从有效 install records 重建。重建失败且无法确认依赖安全时，可以保守阻断普通卸载，并引导用户查看状态、维护 dependency index 或清理。这类依赖安全阻断不改变有效 record 的顶层 `installed`。

### 清理

`aw cleanup` 是异常插件清理入口。它不运行 uninstall lifecycle，不尝试精细修复，不要求先执行 plan。

`cleanup` 默认删除 AW 已知且可重建的状态和残留，包括异常 record、diagnostic cache、native marker、historical runtime、dependency index 中对应引用、非认领场景的 project artifact identity、shared runtime ownership 信息和 AW 可定位产物。

reason 为 `claimableProjectArtifacts` 的 `external` 目标不属于默认 cleanup 对象。`cleanup` 不能为了让普通 install 继续而删除可认领共享产物；用户应先通过 `aw install --adopt-existing` 认领，或自行移除这些共享产物后再按普通未安装路径处理。

配置默认保留。只有显式传入 `--remove-config` 时，cleanup 才删除当前 target 的 AW 自管配置。

如果某些删除动作存在风险，命令应在输出中提醒用户，但原则上不应阻断其它可清理项。只有在无法定位目标、无法安全枚举删除范围或可能删除明显外部数据时，才允许保守跳过该项或阻断，并在结果中列出残留。

`cleanup` 应可重复执行。重复清理已经不存在的目标应给出稳定结果，不应报错或进入新的异常状态。

### 重装

`aw reinstall` 是保留配置的重建入口。它读取当前目标状态，删除 AW-owned 且可重建的旧状态和残留，再按 current catalog 重新安装。

`reinstall` 可以处理健康 `installed` 和可安全收口的 `cleanupRequired` 目标。遇到 `cleanupRequired` 时，不应要求用户先单独执行 `cleanup`；命令应在内部使用 cleanup 语义删除 AW-owned 可重建状态，然后继续安装。

`reinstall` 默认保留插件配置，不提供隐式删除配置语义。用户要清除配置，必须显式使用 `cleanup --remove-config` 或配置命令。

`reinstall` 遇到 verified dependents、无法安全枚举删除范围、可能删除明显外部数据、目标属于 `external`，或 project shared artifacts 可认领时，必须在写入前停止并说明原因。遇到可认领 project shared artifacts 时，应引导 `aw install --adopt-existing`，不能把共享产物当残留覆盖或删除。

### 升级

`aw upgrade` 只处理有效 install record。缺少 record 或 record 不可读时，目标进入 `cleanupRequired`，用户通过 `cleanup` / `install` 或 `reinstall` 恢复。

用户可见 `可升级` 只由 current catalog 版本高于已安装版本驱动。版本不可比较、已安装版本高于 current catalog、source drift 或同版本内容漂移都不能伪装成 `可升级`。

### 移除 Repair

目标模型不再提供 `aw repair`。历史上由 repair 承担的能力按以下方式分流：

- 重铺有效安装的 AW-owned artifacts、record、diagnostic cache、project identity 或 historical runtime：由 `aw reinstall` 或显式 install/upgrade 路径承担，不再为了保持旧状态做同 bundle 精细修补。
- marker-only install、record + marker residual 和其它半完成写入：由 `cleanup` / `reinstall` 删除 AW 可重建残留后重新安装承担，不再补齐旧 record。
- 配置驱动的 runtime drift：由配置写入后的自动 apply、TUI `重新应用配置` 或 `reinstall` 承担，不再提供脚本化 `repair` 重放旧安装。
- project fresh clone 认领：由 `aw install --adopt-existing` 承担。
- dependency index 重建：由需要索引的命令自动尝试；显式维护通过 `aw cleanup --dependency-index --prune-stale <token> --yes` 完成，不叫 repair，也不复用普通插件 target 的 repair 语义。
- shared runtime takeover：不再作为公开能力；ownership 信息由 install record 或有效 records / dependency edges 推导模型处理，冲突按 command-level blocker 处理。
- 异常恢复：统一由 `cleanup` 或 `reinstall` 的清理阶段删除 AW-owned 可重建状态后重新安装处理。

TUI、帮助、文档、状态页、结果页、JSON receipt 和 `nextSteps` 不得再引用 `repair`、`修复`、`repairInstall`、`openRepair` 或等价公开动作。

### TUI 首页

首页必须是单一块状卡片列表。首页主体和 prompt 选择不能各自展示一套完整插件摘要。实现可以选择以下任一方式，但用户看到的页面必须只有一套主要卡片：

- 主体区域展示完整块状卡片，选择列表只显示插件名或短标签。
- 选择控件本身支持多行展示时，由选择控件承载卡片，主体区域只显示标题和分组。

首页卡片按 `异常`、`可升级`、`已安装`、`未安装` 分组，空分组不展示。每个分组标题带数量。组内顺序保持稳定；若没有更明确排序规则，沿用当前 console item 顺序，不能在同一轮刷新中跳动。

每张卡片至少包含状态符号、插件名、版本或版本变化、主操作、短描述、平台与位置摘要。异常、历史残留和配置残留必须点名。首页不展示 `主操作：` 这类字段名，主操作使用 `处理`、`升级`、`详情`、`安装`、`重装` 等短动作词。

首页不展示命令、诊断矩阵、schema/catalog 字段、install record 路径或 verbose 级别信息。首页底部操作只保留 `刷新` 和 `退出`。`Esc` 在首页等同退出，`q` 退出。

### TUI 详情页

插件详情页是操作中心。默认不展示以下内部信息：

- `catalog`、`current catalog`、`catalog 缓存`
- `selector`
- `schema source`、`schema identity`、`schema manifest digest`
- `install record` 路径
- `tracking`、`ledger`、`snapshot`
- `minAwVersion`、远程校验细节、内部 fallback 原因

详情页正文不展示“建议”“下一步”或 `nextSteps` 区块。推荐动作通过功能菜单项标记，例如 `状态（推荐）`、`升级（推荐）`、`清理（推荐）`、`重装（推荐）`。菜单 description 可以说明推荐原因，但只能使用用户可理解的 UI 语义，不能写 `运行 aw ...`。

详情页只展示当前状态摘要、平台与位置摘要、最近结果和功能菜单。更细证据进入 `状态` 下级页面。

### TUI 状态页

TUI 只保留 `状态` 概念，不展示 `诊断` 功能、`查看诊断` 文案或 `openDiagnose` 等用户可感知入口。

需要查看更细信息时，统一使用 `状态` 和 `详情`：

- 详情页功能菜单入口叫 `状态`。
- 状态摘要页里的深层入口叫 `详情`。
- 状态详细信息页标题使用 `详情` 或 `状态详情`，不使用 `诊断`。

状态摘要页默认只展示有现场证据的位置，不列纯未安装 catalog 位置。状态详情页可以展示结构化诊断事实，但仍不展示 raw command、stdout/stderr 原文、堆栈或内部对象字段。

状态页正文不渲染 `nextSteps` 列表。可继续动作必须进入操作区，例如 `清理`、`重装`、`配置`、`重新应用配置`、`返回`、`退出`。没有可执行动作时，只展示状态说明和 `返回` / `退出`。

### TUI 写操作结果

安装、升级、卸载、清理、重装、认领、处理重复安装、配置保存、配置重置和重新应用配置完成后，TUI 必须：

- 重新加载当前插件的 console item。
- 回到当前插件详情页。
- 在详情页顶部展示最近结果。
- 只保留最近一次结果；新的写操作覆盖旧结果。

单插件写操作完成后不出现独立结果页，不提供 `返回首页` 作为默认下一步，也不提供 `状态 · 某位置` 的分叉入口。用户如需看状态，通过详情页功能菜单进入 `状态`。

失败和取消也回到详情页。取消结果可以用短提示显示一次，但不能写入最近结果为成功，也不能把用户带到结果页分叉。

最近结果区域只展示操作名和成功/失败/部分完成状态、每个真实目标的简短结果、失败时的一句用户可理解原因。最近结果不展示命令、不展示内部错误栈、不展示完整 receipt JSON、不展示旧 result page 的“可继续查看目标状态”文案。

### TUI 配置页

配置管理页默认只展示配置管理信息：

- 插件名。
- 当前配置 target。
- 当前作用层。
- 可应用位置；没有可定位 runtime target 时省略或用一句 no-op 说明。

字段列表只展示用户可理解的字段标题、当前值状态和来源。SkillTrigger 内建字段使用自然标题，例如 `codex-explore 触发方式`，不展示 `aw.skillTriggers.<skill>.trigger` 或 `$aw` 存储路径作为主标题。

配置页默认不展示 schema identity、schema digest、manifest digest、catalog channel、minAwVersion、install record path、内部 source identity。遇到 schema unavailable 或 store-only 旧配置时，展示用户语义，例如“当前插件列表已无法解释这层旧配置，只能整层清理”。

`生效` 视图只读，不展示会让用户误以为能直接写入生效层的 `更新`、`清空` 或 `重置` 操作。`个人`、`项目` 和 `本地` 视图只展示当前层可执行的操作。没有可执行操作时，只显示 `返回` 和 `退出`，不展示 disabled 操作堆叠。

### TUI 向导与确认

安装、升级、重装和相关 TUI 写向导的公开 step、页面文案、确认页和结果区域都不得出现安装期 SkillTrigger 选择。触发策略只能在配置页中作为 AW 内建配置字段查看和修改。

TUI 预检阻断、失败原因和恢复建议必须来自结构化状态：

- 可由 TUI 执行的动作进入菜单。
- 纯说明进入阻断原因正文。
- CLI command 只允许出现在 CLI 人类输出或 JSON command 字段，不进入 TUI。

未安装插件进入安装时，TUI 必须先选平台，再选 scope。第一页只展示 `Codex`、`Claude Code`、`全部支持平台` 这类平台选项；第二页只展示 `个人`、`项目` 等位置选项。安装目标页不得把平台和 scope 的笛卡尔积混在同一个列表。

危险确认页继续使用选项页，默认选中 `取消`。正文至少展示操作对象、真实目标、将要删除/覆盖/重建的内容、不会影响的内容、配置是否保留或删除。确认页不能只显示一段 `确定要 ... 吗？`。`confirmText` 可以作为兼容输入，但不能成为最终页面的唯一正文。

## 公开合同和命令边界

### `aw status --json`

JSON 顶层状态只允许四态：`installed`、`notInstalled`、`cleanupRequired`、`external`。

JSON 可以包含 `reasons`、`diagnostics` 和结构化 `nextSteps`。其中：

- `reasons` 描述状态成因，面向脚本和排障。
- `diagnostics` 展示辅助证据，不表示安装真值。
- `nextSteps` 给出建议动作。命令只能作为 CLI / JSON 附属字段，不能成为 TUI 页面文案。

JSON 不再承诺旧的 `needsRepair`、`residual`、`adoptable` 等一等状态。旧字段可以移除或重新设计。

### `aw cleanup`

`aw cleanup` 直接执行清理，不再提供 `--plan` 作为目标合同。

`--force` 可以保留为更明确的高风险确认入口，但它不应成为普通异常恢复的前置条件。默认 cleanup 应尽量删除 AW 已知可重建状态；无法安全删除的外部或未归属内容应跳过并报告。

`--remove-config` 是删除配置的唯一显式合同。没有该参数时，配置必须保留。

`--dependency-index --prune-stale <token> --yes` 是 dependency index 的显式维护入口。它只处理指定 stale index reference，输出和 JSON receipt 必须说明 token、动作结果、跳过或失败原因；它不能执行普通插件 repair，也不能把 dependency index 当成安装真值。

### `aw reinstall`

`aw reinstall` 直接执行保留配置的重建流程：先删除当前 target 上 AW-owned 且可重建的旧状态和残留，再按 current catalog 重新安装。

`reinstall` 不能把旧 install record、historical runtime、diagnostic cache、project identity、native marker、dependency index 或 shared runtime owner 当作需要保持的状态。

`reinstall` 内部清理阶段遵守 `cleanup` 的归属和安全边界。无法安全删除的外部或未归属内容必须跳过或阻断，不能为了重装而删除明显外部数据。存在 verified dependents 或无法确认依赖安全时，命令应在新安装前失败。

`reinstall` 不删除插件配置，也不提供隐式删除配置的参数。配置清理只通过 `cleanup --remove-config` 或配置命令完成。

`reinstall` 遇到 project shared artifacts 可认领时必须停止，并提示 `aw install --adopt-existing`。认领不是重装语义，不能通过删除共享产物后重装来替代。

### `aw install --adopt-existing`

`--adopt-existing` 只用于 project scope。它要求存在可验证的 project shared artifacts 和 project artifact identity，且当前 location 没有有效 install record。

如果已有有效 install record，`--adopt-existing` 不应改变现有安装语义。

如果共享产物不可验证，命令应失败并提示 cleanup、reinstall 或普通 install，而不是创建含糊 record。

### 普通 `aw install` 与 `external`

普通 `aw install` 遇到 `external` 必须失败，不能覆盖、删除或默认认领没有本机 ownership 的内容。错误提示应说明 ownership 风险，并给出可执行的安全路径：reason 为 `claimableProjectArtifacts` 时使用 `aw install --adopt-existing`，其它外部证据先由用户移除或等待未来明确外部接管入口。

如果目标已有有效 install record，普通 install 可以按 AW-owned 覆盖安装语义继续；这不属于 `external`。

### `aw repair`

目标模型不提供 `aw repair`。公开 CLI help、文档、TUI、JSON receipt、状态 `nextSteps`、错误提示和用户可见输出都不能把 `repair` 作为恢复入口。

如果短期保留隐藏迁移 stub，它只能输出确定性错误和替代入口说明，不能执行修复逻辑，不能读取或写入插件状态，也不能产出成功 JSON envelope。

### Dependency Index

dependency index 是派生索引。任何命令都不能把它作为安装真值。

需要依赖保护时，命令应优先从有效 install records 重建或校验索引。只有在无法确认依赖安全时，普通卸载、升级和重装才可以保守失败。

cleanup 和 reinstall 面向用户显式恢复，只要没有已知 verified dependents 且能安全界定删除范围，就应继续尽力清理。

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

cleanup 和 reinstall 的清理阶段不执行 uninstall lifecycle，也不因为 historical runtime 缺失而阻断对 AW-owned 可重建残留的清理。

### Console Item 与 TUI Page Model

TUI page model 必须提供足够结构化的信息，让 renderer 能区分：

- 首页卡片字段。
- TUI 友好状态与底层四态。
- 详情页状态摘要。
- 详情页菜单推荐标记。
- 状态摘要和状态详情。
- 最近结果。
- 配置字段 entries。
- 危险确认影响范围。

实现不能通过拼接 CLI 人类输出、诊断文本或旧 result page 文案来生成 TUI 页面。

TUI 公开模型中不得出现 `diagnose` 或 `repair` 作为 feature kind、action kind、label、menu choice 或 result target。

### `nextSteps` 边界

TUI 可以消费结构化 `NextStepInstruction` 来决定推荐哪个菜单项，但不得把 `nextSteps` 当页面正文列表展示。

如果某条 `NextStepInstruction` 是 `cliCommand` 且没有可映射 UI action，TUI 只能展示其 `label` / `description` 代表的状态说明；不能显示 command，也不能生成“复制命令执行”的建议。

旧字符串数组只能作为 legacy 过渡字段存在。安装向导、目标选择、依赖确认、配置保存和写操作失败页都不能直接渲染 `nextSteps: string[]`。

### 配置页边界

配置页以 `ConfigFieldEntryV2` 或等价结构化字段为主数据源。配置页不能把 schema 元数据、catalog 元数据或 install record 路径作为普通字段展示。

JSON 和 CLI verbose 可以继续暴露调试所需字段；TUI 默认页面不承担这个职责。

## 验收标准

- 状态模型只向用户和 JSON 顶层暴露 `installed`、`notInstalled`、`cleanupRequired`、`external`。
- TUI 首页只使用 `异常`、`可升级`、`已安装`、`未安装` 作为友好分组；这层分组能稳定映射到底层四态和版本比较结果。
- 有效 install record 是唯一安装真值；diagnostic cache、project identity、dependency index、native marker、historical runtime 和 shared runtime ownership 不能单独证明已安装。
- `needsRepair`、`residual`、`adoptable` 不再作为用户可见一等状态。
- `aw repair` 不再作为目标命令存在；TUI、帮助、文档、JSON receipt、错误提示和 `nextSteps` 不再引用 `repair` 或公开“修复”动作。
- `aw install --adopt-existing` 能覆盖 project fresh clone 认领场景，并且不会影响已有有效 record 的安装。
- 无有效 record 的可认领 project shared artifacts 底层状态为 `external`，reason 为 `claimableProjectArtifacts`，next step 和 TUI 推荐动作指向 `aw install --adopt-existing`。
- diagnostic cache 缺失、损坏或 stale 不会让有效安装变成异常状态。
- dependency index 缺失或不可信时，写命令会尝试从有效 records 重建；无法确认依赖安全时才阻断普通卸载、升级或重装。
- historical runtime 缺失和 dependency index 安全性无法确认不会改变有效 record 的顶层 `installed`，只会形成命令级阻断、diagnostic 或 `nextSteps`。
- shared runtime ownership 不再作为独立主状态影响健康判断。
- 公开合同不再提供 `--takeover-shared-runtime`；owner 冲突只作为 command-level blocker、diagnostic 或 `nextSteps` 暴露。
- 正常 uninstall 仍可以因为 historical lifecycle runtime 缺失而 fail closed，并明确引导 cleanup 或 reinstall。
- `aw cleanup` 不需要先执行 plan，默认清理 AW 已知且可重建状态和残留。
- `aw cleanup` 默认保留配置；只有 `--remove-config` 会删除配置。
- `aw reinstall` 默认保留配置，并能对可安全收口的 `cleanupRequired` 目标执行清理后重新安装，不要求用户先单独运行 cleanup。
- `aw reinstall` 不保留旧 record、旧 source、旧 artifact truth、diagnostic cache、native marker、historical runtime、dependency index 引用或 shared runtime ownership 残留。
- `aw reinstall` 遇到 verified dependents、无法安全枚举删除范围、明显外部数据、`external` 或 project adopt 场景时，会在新安装前停止并给出下一步。
- cleanup 和 reinstall 无法安全删除的外部或未归属内容会被跳过并报告，不会阻止其它可清理项继续执行。
- 普通 `aw install` 遇到 `external` 必须 fail closed；project fresh clone 认领只通过 `aw install --adopt-existing`。
- dependency index 的公开维护入口是 `aw cleanup --dependency-index --prune-stale <token> --yes`，公开文档和 `nextSteps` 不再指向 `repair --dependency-index`。
- TUI 首页展示按状态分组的块状插件卡片，不再重复展示正文摘要和 prompt description。
- 首页卡片能一眼看到状态、插件名、版本或版本变化、平台摘要和主操作；没有命令建议和内部字段。
- 插件详情页不展示 `current catalog`、`selector`、`schema identity`、`manifest digest`、`install record` 等技术诊断行。
- 详情页菜单可以标记推荐动作，但正文没有“下一步”或建议区块。
- TUI 任意用户可见页面不出现 `诊断`、`查看诊断`、`repair` 或公开“修复”入口；需要深层信息时通过 `状态` -> `详情` 进入。
- 状态详情页不渲染 raw command，不渲染字符串 nextSteps，不提示用户复制命令。
- 执行一次成功的安装、升级、卸载、清理、重装、认领、配置保存或重新应用配置后，TUI 直接回到刷新后的插件详情页，并在顶部显示最近结果。
- 写操作完成后不出现带 `返回首页`、`状态 · 某位置`、`退出` 分叉的独立结果页。
- 写操作失败后也回到当前插件详情页，最近结果只显示简短失败原因；后续处理动作通过菜单推荐标记呈现。
- 配置管理页默认只展示配置 target、作用层、字段、来源、最近结果和当前层可执行操作，不展示 schema/catalog/install record 调试信息。
- `生效` 配置视图只读，不展示 `更新`、`清空`、`重置` 等写操作。
- 安装、升级、重装向导中不出现 SkillTrigger 触发策略选择，也不在公开 steps 中出现 `selectSkillTrigger`。
- 未安装插件的安装目标选择仍是“先平台、再位置”两步，不展示平台和 scope 组合矩阵。
- 危险动作确认页默认选中取消，并结构化展示影响范围；页面不能只是一句确认问题。
- TUI 页面中不出现 `aw ...` 命令建议。CLI 人类输出和 JSON 的命令字段不受本条约束，但不能被 TUI renderer 直接复用为页面文案。
- 旧 `diagnose`、旧 `repair`、字符串 `nextSteps`、`confirmText`、schema/catalog 元数据如果仍作为内部过渡字段存在，不得进入 TUI 用户可见输出。
