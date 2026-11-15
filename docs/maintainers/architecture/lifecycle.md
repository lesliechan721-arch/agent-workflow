# 插件生命周期

本主题定义安装、同步、重建、移除、停用和清理的当前合同。修改这些动作或共享归属时读取本文件。状态和配置判定见[状态与配置](config-and-status.md)，平台投影见[平台边界](platforms.md)，来源获取与修复见[Catalog Sources](catalog-sources.md)。TUI 的确认、导航与结果展示见 [TUI](tui.md)。

## 需求、目标与输出

两份 Intent 使用 schema 3：`sources` 绑定 Catalog logical identity，`roots` 只保存 source-qualified plugin ID。用户声明位于 `<AW_HOME>/plugin-intents.json`，项目声明位于当前项目 `.agent-workflows/plugin-intents.json`。本机只有一个 `<AW_HOME>/deployment-preferences.json`：schema 2、`targets` 和 `exclusions: [{plugin, target}]`；没有项目偏好或依赖位置 override。初始 targets 为空；排除记录在关闭、重新启用本机 target 后保留。

普通 sync/status 在项目内读取用户与当前项目，在项目外只读用户；显式 `--context user` 不解析调用项目。每个 target 独立展开两份完整依赖闭包，再过滤本次 root/target。相同插件的用户和项目需求按固定平台布局解析。共享原生包合并物理产物，activation 保持各自 scope；Cursor、OpenCode、Pi 等独立 scope 位置不能因用户需求存在就省略项目部署。共享提供者缺失或损坏时修该提供者，失败不改用另一条路由。source-qualified 身份不同不按短名称合并。未知 Intent 或来源不当空需求，不能据此删除、去重或复用。

固定布局由 adapter resolve 按真实产品入口、物理 namespace、scope 和原生身份确定。冲突按真实物理位置判断，不从 target 名称组合推断。共享单元固定 render scope，同一位置的 scope、来源、类别或集合不一致时阻断该组，不按执行顺序覆盖。结构合法的偏好可保存，Review 保留冲突原因和旧输出。

日常命令位于 `aw plugin`：`list`、`show`、`install`、`remove`、`sync`（可加 `--rebuild`）、`status`、`config`。平台偏好由 `aw target` 管理。install/remove 必须显式提供非空插件列表和 `--scope`；`--scope project --context user` 写前拒绝。sync/status 使用 context；remove 的 outputs-only 模式使用物理清理 scope 和显式 target。`--target` 只过滤当前执行，不修改偏好。普通 install 在保存需求前检查平台，空 targets 返回 `noTargetsEnabled`；仅保存需求使用 `--only requirements`。

公开命令、模式组合、确认和输出字段的完整合同见 [CLI 参考](../../reference/cli.md)。CLI 始终非交互；TUI 保留 Review。公共结果通过 `status/data/diagnostics/nextActions` 输出，生命周期将内部 intent/agent 投影为 requirements/target，保留执行、观察、内容三轴与实际变化。内部回执和业务存储格式保持独立。
所有强配置在现有 AW_HOME mutation lock 下原子提交。Review 冻结两份声明、偏好、来源、配置与输出证据，执行锁内重读；stale 不写。依赖提供者失败阻止相关消费者，独立目标继续。共享 Native 包体及 activation 分别观察和报告，不扫描历史项目，不把共享刷新说成更新了其它项目的独立包。

恢复回执继续逐目标报告 execution、observation、content，以及声明、偏好、配置、输出四类变化。部分完成、unknown、blocked 和 failed 不报全部成功。status 严格只读，不运行 renderer、preApply 或来源刷新；coverage 明确用户与当前项目范围，未选 targets 时有需求不等于已满足。cleanup、reinstall、source sync 或新版本始终保留至少一个可用恢复路径。

## Ownership 与删除权限

live ownership 和实际平台组件是输出清理和 status 的现场证据；Intent 表示需求，不是 installed ledger。普通恢复和清理不改声明、偏好或插件配置。不得新增安装合同存储、第二套安装状态或持久依赖图。

generic writer 的可重建 owner marker 绑定 source/plugin、target、scope、Skill 与内容清单。原生目录包及补足复用 owner-aware writer，并绑定 sourceIdentity、physicalKey 与 scope；包内可重建物化证据保留冻结组件 ID 到原生输出的映射。观察区分 absent、satisfied、drifted、conflict、unknown。只替换和清理由精确证据证明归属的输出；foreign、共享和未知内容保留。离线 cleanup 不要求来源仍在线；force 不能认领第三方内容。失败保留成功部分和精确恢复入口，不承诺补偿。

cleanup 从本次精确部署的 owner/native observation 与恢复候选取得位置，不扫描旧 Agent Portable 残留或其他项目。客户端缺失不能阻止证据充分的独占补足清理；原生卸载确需客户端时保留来源与重试证据，不能猜注册已不存在。

管理记录、路径存在和共享引用不自动授予删除权限。有效共享 native、禁用 activation 和 user 继承本身也不构成 project 的待清理输出；其状态证据与范围判断见[状态与配置](config-and-status.md)。Codex private cache 和 installed manifest 不参与普通生命周期、repair、residue 或 cleanup 成败判断，AW 不直接删除它们。

## 写入流程与确认

需要 Catalog 的公开写命令和 `config ... --apply` 使用同一条 rebuild 流程：

~~~text
解析合法请求、共同配置与依赖
  → 逐平台 discover/resolve/inspect，收集独立阻断
  → 按真实 RenderUnit 取得完整静态/动态集合与命令闭包
  → project 到私有 staging，冻结字节、位置、缺口和删除影响
  → Review 或直接 CLI 现有确认
  → 单一 AW_HOME 写锁内重查全部输入与现场证据
  → preflight 通过后每逻辑 target 至多一次 preApply
  → adapter 执行冻结 route/effects，不重新渲染
  → 逐部署后置观测，保留 applied/failed/unknown 与恢复入口
  → 汇总保存事实、平台、产品面与组件结果
~~~

这些命令在 `AW_HOME` mutation lock 内只采集一次当前 target 和当前 project 的现场 inventory。Active snapshot、marketplace 选择和 dependency plan 复用该内存 snapshot；执行不为计划再做第二次全量 inventory。计划完成后，writer 只对计划中的目标重新构建并检查 live ownership、native registration、有效 config 和固定 snapshot evidence。普通 inventory 不扫描历史项目、不建立全局 refcount；移除只检查本次请求释放的依赖，不回收无关历史残留。

`OperationPlan` 只用于 Review、stale fingerprint 比较和 Receipt。真实执行继续由 rebuild executor 使用已准备的 target 和 live evidence 完成；不存在通用 `OperationAction` executor。

Review 冻结 Active snapshot、两份声明、部署偏好、配置、目标和输出证据。联合准备阶段复用本轮已读取的需求；仅刷新现有输出时，安装现场观察也在本轮复用。这些内存数据不跨执行检查边界复用。直接 CLI `--yes` 与 TUI 使用同一个 `requiresConfirmation` 和 `sharedImpact` descriptor；共享替换或重建必须说明可能影响其它项目。Execute 在同一 `AW_HOME` mutation lock 内重读 Active metadata 与 Review digest；source config 或 Active digest 改变时，在 plugin、config 或 native 写入前返回 typed `operationReviewStale` 或要求新 Review。这项检查不访问远端 branch。

同源共享 marketplace 在联合准备结束前汇总各 scope 中准备成功的候选，再统一冻结各子计划的 descriptor 与 Review 证据。准备期间也必须保持现场指纹不变；冻结后或发布开始后，不能加入新候选或扩大已确认的集合。

用户确认后才开始写执行。配置保存和 apply 是两个结果；配置已经提交时，后续准备、执行或 status 失败仍保留已保存值，精确回执见[配置提交与应用](config-and-status.md)。配置写入、生命周期和平台写入各自保留最小本地恢复，不组成跨第三方系统的事务。

## 依赖与部分成功

插件依赖只来自 manifest `dependencies`，只在同一 source 内解析。依赖图拒绝缺失节点、环和超出既定上限的图；执行顺序是稳定的依赖优先拓扑序。

dependency placement 由 User/Project 完整需求闭包自动决定，不提供 scope override 或手动选择。对允许跨 scope 复用的布局，User 需要的共同依赖由 User 提供；scope 独立的 Native 布局在各自 scope 物化。项目即使看到损坏的 User provider 也不自动复制一份 fallback。provider 切换先验证替代目标及 preApply，再清理可证明专属的旧输出；失败保留旧输出并阻止相关 consumer，独立目标继续。Native 的共享包、实际 activation 与专属组件分别核验；合法继承不伪装为项目缺失。安装准备被依赖阻断时，保留依赖、Agent、位置、安全原因和对应恢复入口。

依赖执行顺序只在本次命令内存在。内部后端结果保留 relation、requiredBy、安全后端状态和恢复建议；统一 CLI 生命周期 data 保留请求的所有目标、阻断与未完成项，不公开持久计划、锁或来源内部证据。精确匹配的现有 shared native 可复用，不建立 ownership ledger。

精确插件升级可以选择完整需求闭包中的依赖项，不要求把依赖提升为 Intent root；选择仍绑定原有 root、target 与 provider scope。闭包之外的插件不能借此成为同步目标。

普通 remove 默认清理本次取消需求后失去全部引用的依赖输出，包括传递依赖。候选限于本次请求原依赖闭包、所选物理 scope 和本机执行 targets，且必须没有独立 Intent、没有剩余需求或已观察到的现存消费者，并有充分 live ownership 证据。精确请求按 root×Agent 保留对应关系，不能展开为插件和 Agent 的全部组合；依赖候选只来自同一 Agent 上被选根的贡献，未选位置的现存消费者仍保护其依赖。未知需求、来源或消费者依赖关系不能当作无引用。`--keep-dependencies` 保留这些依赖；它不改变所选根的移除或提供位置切换。清理按依赖者优先执行；依赖者移除失败时，保留它需要的依赖，报告未完成项。Review 冻结依赖清理的精确位置，锁内按同一证据重验。

所选 scope/target 的移除会破坏其他声明或现存插件输出的依赖时，普通 remove 在需求和输出写入前以 `dependencyStillRequired` 阻断。检查按实际 provider 判断；取消另一 scope 的重复声明不影响仍有效的 provider，提供位置切换继续先验证替代目标。普通 remove 的 `--force` 允许取消所选需求并清理该 scope 的所选输出，保留其他依赖者的声明和输出；结果可能不再满足完整需求，后续 sync 可以重新安装缺失依赖。此 flag 只绕过依赖保护，不扩大 ownership、共享内容或路径删除权限，也不启用受限损坏输出恢复。

## 安装、重建、卸载与清理

公开重建命令是 `aw plugin sync --rebuild`，移除命令是 `aw plugin remove`；内部 action 分别为 `reinstall` 和 `uninstall`。公开 remove 取消所选需求并安全清理，底层 uninstall 只描述输出删除。普通 remove 在任何需求或输出写入前完整校验 Active；Active 不可验证时返回 blocked，两个独立 `--only` 模式提供恢复。移除需求不自动等于可以清理共享或外部输出。

- `install`：按当前 Catalog 安装请求插件和缺失依赖；已存在且完整的依赖使用 `keep`，不重复安装。
- `reinstall`：先准备并冻结完整新包，再按平台固定路由重建 AW-owned 组件。expected exclusive path 的 owner marker/header 缺失或损坏时，它不自动 force，也不覆盖该路径；返回 `exclusiveOwnerEvidenceInvalid`，恢复顺序固定为先运行同 target 的 `cleanup --force`，再运行 reinstall。
- `uninstall`：删除可由 live owner marker/token 证明属于 AW 的组件。它不重放历史脚本。
- `cleanup`：不运行 preApply，也不读取依赖图、安装门槛或 Active。两种 scope 均只清理可由 live owner marker/token 或已绑定 offline evidence 证明属于 AW 的所选输出；保留 Intent、偏好、plugin config、foreign 内容和 shared/native payload。
- `cleanup --force`：用于恢复专属且已损坏的 AW-owned 输出，仍保留两份 Intent、偏好和配置。只接受 shallow plan 中精确的 `skill-directory` 与 exclusive `owned-text-file`，不运行 renderer 或读取其源码来推测动态名称；候选必须位于合法 Agent/scope root，路径链和目标不能是 symlink，节点类型、basename 和 artifactKey 必须一致，不能是 shared config、native plugin store 或 marketplace root。合法 foreign owner 在 normal 和 force 中都保留。

内部 `cleanup` 对应公开 `remove --only outputs`，内部 `cleanup --force` 对应公开 `remove --only outputs --force`。两者使用专用 cleanup 流程，不进入恢复写入 pipeline。两种 scope 都只清理所选 Agent 中可证明归属的现场，不改 Intent、部署偏好或插件配置。无 Active 时仍可凭 live 或已绑定离线证据恢复，未知路径、foreign 与 shared 内容保持不动。`--force` 仅处理现有合同允许的专属损坏输出。两者都不运行 renderer 或 preApply。

selected source/plugin 的 namespaced config inventory 损坏不阻止该目标的 cleanup 或 uninstall；命令保留坏 config，并提示之后使用 `config reset`。ownership、foreign/shared/global 或安全输出 inventory 错误仍 fail closed；强配置损坏由 `remove --only requirements` 或普通 remove 的停用分支报告，不被普通 cleanup 覆盖。

普通 cleanup 使用离线清理，不因 Active 缺少 entry 扩大到停用。`catalogSourceUnavailable`、`bundleUnavailable` 和 `codexIntentSourceUnavailable` 只说明当前恢复路由不可用。Review 绑定目标位置与 live ownership evidence；Execute 在同一 `AW_HOME` mutation lock 内重验，漂移时在删除前返回 stale。实际删除竞态保留输出并返回 partial。

普通 cleanup 不读取 Active；force 可把当前 Active 中所选 plugin bundle 的 shallow evidence 作为可选补充。source、Active 或 store 缺失或损坏不能永久阻止 Intent 取消，或阻止有充分 live evidence 的清理。两者保留 foreign、shared、unknown 内容和无法安全撤销的原生包，不猜测输出路径。

### 受限 force cleanup

force cleanup 是专属损坏输出的恢复动作，不是删除权限升级。除前述 shallow 类型、合法 root、非 symlink 路径链、节点类型、basename 和 artifactKey 校验外，TUI 还要求当前 preview 只有一个唯一、精确、非空的 `forceExclusive` 候选。没有批量 force cleanup；不能绕过依赖、非插件内容或共享内容保护。完成后重新安装是新的操作和 Review。

### 停用已从 Catalog 移除的插件

已确认从健康 Active Catalog 移除的插件通过普通 `aw plugin remove` 的停用分支处理。普通 `cleanup` 不自动分类或删除强配置；停用只修改显式 scope 的需求和输出；配置删除默认关闭，明确选择时删除该插件全部本机 common／平台设置，并在 Review 说明全局影响。独立目录包与共享残留必须可见。

停用失败的恢复命令保留 scope 和 Review 中已确定的输出 Agent 集合；未完成的配置删除保留 `--delete-config`，已完成时不再请求。独立目录残留提供精确人工检查指引，重试重新 Review，不自动携带 `--yes`。

## 平台执行入口与结果

CLI/TUI 共用 adapter 注册表和发现结果。实际入口、配置根、版本/profile、Pi 消费者条件、物理与激活位置进入 preparation evidence。锁内再次观察发生变化时返回 stale，不切换入口后消费旧计划。执行只用已审核 staging 字节，进程重启或 staging 丢失须重新准备。

discover、prepare、materialize、原生 mutation 与 postcheck 的错误只阻断真实依赖分组，其他平台继续。参数错误、共同强配置损坏、无法取得唯一锁、共同授权缺失和用户中断仍可整体停止。共享发布失败只阻断其消费者，不回滚其他平台成功。

包、注册、activation、trust、组件 presence 与 load 各自保留。ComponentGap.requiredFeatures 必填，完整传递冻结 feature/values、缺口 ID 与 componentId；无能力要求的执行错误使用空数组。不能将缺少 block 或一个 Instructions audience 简化为整类缺失。

成功有意空集合在 Review 中明确撤销旧输出，新目标为成功 no-op；全部 unmet 或渲染失败不触发空集卸载。部分 unmet 时，可更新独立支持的组件，但保留旧补足文件，不将本次缺少投影当作作者关闭；此保护不依赖原生包是否存在。取消一个需求不删除仍被引用的共享包或命令绑定。preApply 失败不清旧输出，Grok 同 scope Instructions 渲染失败也不能发布缺正文的 Agent 包。

结果按本次真实范围汇总：全部完成 success/0；有完成部分、有效部分结果或 confirmed/possible 变更为 partial/4；全部执行前受阻且无业务变更为 blocked/3；执行失败且无有效部分或已知/可能变更为 failed/1。成功保存需求、配置或偏好也是已提交变更。超时或异常后先有限 observe，重试重新 prepare，不盲目重放。

## preApply

Manifest v4 只允许 `scripts.preApply: { path: string, timeoutMs?: number }`。旧 `postApply` 是未知字段，不能迁移或作为兼容别名。该入口只用于安装前环境校验或安装外部系统工具。作者端公开输入结构、cwd 与超时完整合同参见[插件运行时合同](../../reference/plugin-runtime.md#preapply-contract)。AW 插件依赖仍由 manifest `dependencies` 声明，Node 依赖仍在 build-time bundle 中闭包。

AW 固定使用 bundle 内的 Node entry，以 plugin root 为 cwd，继承 `PATH`，并为脚本创建临时隔离 `HOME`。输入通过 stdin 注入；stdout 和 stderr 按 effective sensitive config 脱敏。AW 等待 stdin 写入完成或受控失败、脚本退出和进程树清理后才完成 target；只有脚本明确以 code 0 且无 signal 退出并确认清理成功时，脚本未读取 stdin 造成的 `EPIPE` 才不改变成功结果。其它 stdin 错误使用稳定脱敏的 `preApplyInputFailed` 诊断。非零退出、spawn 失败或超时会终止进程树。

每个 target 每次命令最多运行一次，脚本必须幂等。`install`、`sync`、`reinstall` 和 `config ... --apply` 运行它；`cleanup`、`uninstall`、`status` 和 Review preparation 不运行。默认 timeout 是 300 秒，Manifest 和 CLI override 的有效范围都是 1 秒至 30 分钟。`--script-timeout` 只由会运行 preApply 的命令公开和消费。TUI 高级选项复用相同校验范围；Review 显示票据绑定的实际值和会运行脚本的 namespaced plugin、platform、scope，preview 和确认后的执行只使用该冻结值。只保存配置、`cleanup` 和 `uninstall` 不传递该选项。

同一命令中，纯激活共享包的附属目标可复用该包已成功执行的 preApply；它没有独立组件、配置输入或补足变化时，不因多选一个 scope 重复执行。具有独立资源或配置输入的目标仍各自执行。主目标的环境校验和 provider 切换保护保持，不能仅因原生 effects 为空跳过；失败结果不能作为成功记录复用。

preApply 只能在 TUI Review 明确确认或直接 CLI `--yes` 后开始，JSON、noninteractive 或内部非 direct-CLI 调用不能绕过该门禁。普通字段或整层删除确认不等于脚本授权。target 的 schema、config、artifact 和 ownership 只读 preflight 必须先成功。preApply 成功后才可为该 target 执行 stale cleanup、native/artifact write、postcheck 和 receipt。`reinstall` 也先运行 preApply，再 cleanup，并复用同一 target preflight。

preApply 失败时，该 target 不执行任何 AW-owned cleanup 或 write，receipt 记录稳定且脱敏的失败，并提供 `sync` 或 `reinstall` 恢复。其它 target 继续执行。AW 不回滚脚本已成功完成的外部动作，也不增加外部副作用 ownership、journal、补偿或 cleanup 能力。

preApply 不允许遗留后台后代；AW 在脚本正常退出、超时或中断后先终止并确认本次脚本的进程树，再完成该 target。进程树清理无法确认时，preApply 失败并阻止该 target 的 AW-owned cleanup 或 write。身份无法证明属于本次脚本的 foreign 进程不会被终止。

CLI 在 preApply 执行期间收到 `SIGINT` 或 `SIGTERM` 时，先清理脚本进程树和本次临时目录，再分别以标准信号退出码 `130` 或 `143` 退出，不继续其它 target。清理无法确认时以 `1` 退出。

## 恢复与性能证据

每条失败链必须可用 `cleanup`、`cleanup --force`、`reinstall`、来源刷新或新版本发布恢复。无法证明 ownership 时宁可保留内容，也不能删除用户或共享内容。

性能观察复用现有 debug event。`review.prepare.*` 记录 Review 准备阶段耗时；`performance:stage` 记录 `catalog.load`、`catalog.validation`、`inventory`、`dependency.plan`、`target.build` 及 `recovery.*` 的阶段名与耗时。恢复阶段覆盖规划、锁等待、锁内重查、子计划准备与执行及最终状态读取，记录开始、成功或失败；诊断失败不覆盖操作结果。命令阶段另记录结果，Catalog load 另记录聚合 source/Active/validation 计数，不记录 digest、路径或错误文本。`native:start|success|error` 只记录白名单 `agent`、稳定 operation、`exitCode`、固定 reason 和 `durationMs`，不记录 args、cwd、stdout、stderr 或未知 error/cause 文本；`rebuild:action` 分别记录 `inspect`、`native.write`、`artifacts.write` 和 `postcheck.inspect` 等真实写阶段耗时。没有 native 或 artifact 动作时不伪造对应阶段。测试用 provider 调用次数、检查范围和阶段事件验证 write 性能边界。Warm install 的总时长只对受控 fake native runner 使用宽松门槛；本地 Catalog 阶段 p95 目标为 500ms，不能据此承诺第三方 CLI 时长。

首版不增加 authoritative installed-state DB、GC/read lease、新锁层级、全局事务或补偿状态机。Active snapshot 已是不可变内容寻址目录，操作直接引用它；当前可观察的重复 inventory 可以用操作内 snapshot 消除。这些事实不足以证明新增持久状态和协调协议的成本合理。

## 实现与验证入口

写入口是 [`write-commands.ts`](../../../packages/cli/src/commands/write-commands.ts)，联合恢复在 [`recovery/`](../../../packages/cli/src/recovery/) 与 [`intent/`](../../../packages/cli/src/intent/)。[`rebuild-command.ts`](../../../packages/cli/src/commands/rebuild-command.ts) 准备目标，[`rebuild-operations.ts`](../../../packages/cli/src/commands/rebuild-operations.ts) 执行 preApply、清理、平台写入与复核。[`operation-plan.ts`](../../../packages/cli/src/commands/operation-plan.ts) 只管理 Review fingerprint 与回执描述。

归属规则在 [`ownership.ts`](../../../packages/cli/src/utils/ownership.ts)，离线计划与精确证据在 [`offline-cleanup-evidence.ts`](../../../packages/cli/src/commands/offline-cleanup-evidence.ts)。

修改测试或选择验证命令前读取[测试指南与 Test Value Gate](../testing.md)。现有验证入口包括 [`ownership.test.ts`](../../../packages/cli/tests/unit/ownership.test.ts)、[`rebuild-operations.test.ts`](../../../packages/cli/tests/unit/rebuild-operations.test.ts) 和 [`rebuild-task-command.test.ts`](../../../packages/cli/tests/unit/rebuild-task-command.test.ts)。它们的覆盖不能扩大为真实 Codex/Claude 客户端资格；客户端验证边界见[测试指南](../testing.md#1-test-layers测试层级)。
