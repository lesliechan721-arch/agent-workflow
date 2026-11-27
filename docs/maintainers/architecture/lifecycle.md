# 插件生命周期

本主题定义安装、同步、重建、移除、停用和清理的当前合同。修改这些动作或共享归属时读取本文件。状态和配置判定见[状态与配置](config-and-status.md)，平台投影见[平台边界](platforms.md)，来源获取与修复见[Catalog Sources](catalog-sources.md)。TUI 的确认、导航与结果展示见 [TUI](tui.md)。

## 需求、目标与输出

两份 Intent 使用 schema 3：`sources` 绑定 Catalog logical identity，`roots` 只保存 source-qualified plugin ID。用户声明位于 `<AW_HOME>/plugin-intents.json`，项目声明位于当前项目 `.agent-workflows/plugin-intents.json`。本机只有一个 `<AW_HOME>/deployment-preferences.json`：schema 2、`targets` 和 `exclusions: [{plugin, target}]`；没有项目偏好或依赖位置 override。初始 targets 为空；排除记录在关闭、重新启用本机 target 后保留。

普通 sync/status 在项目内读取用户与当前项目，在项目外只读用户；显式 `--context user` 不解析调用项目。每个 target 独立展开两份完整依赖闭包，再过滤本次 root/target。相同插件的用户和项目需求按固定平台布局解析。共享原生包合并物理产物，activation 保持各自 scope。项目直接声明的插件仍有项目部署。项目引用的依赖按下文规则选择提供位置。共享提供者缺失或损坏时修该提供者，失败不改用另一条路由。source-qualified 身份不同不按短名称合并。未知 Intent 或来源不当空需求，不能据此删除、去重或复用。

固定布局由 adapter resolve 按真实产品入口、物理 namespace、scope 和原生身份确定。冲突按真实物理位置判断，不从 target 名称组合推断。共享单元固定 render scope，同一位置的 scope、来源、类别或集合不一致时阻断该组，不按执行顺序覆盖。结构合法的偏好可保存，Review 保留冲突原因和旧输出。

日常命令位于 `aw plugin`：`list`、`show`、`install`、`remove`、`sync`（可加 `--rebuild`）、`status`、`config`。平台偏好由 `aw target` 管理。install/remove 必须显式提供非空插件列表和 `--scope`；`--scope project --context user` 写前拒绝。sync/status 使用 context；remove 的 outputs-only 模式使用物理清理 scope 和显式 target。`--target` 只过滤当前执行，不修改偏好。普通 install 在保存需求前检查平台，空 targets 返回 `noTargetsEnabled`；仅保存需求使用 `--only requirements`。

公开命令、模式组合、确认和输出字段的完整合同见 [CLI 参考](../../reference/cli.md)。CLI 始终非交互；TUI 保留 Review。公共结果通过 `status/data/diagnostics/nextActions` 输出，生命周期将内部 intent/agent 投影为 requirements/target，保留执行、观察、内容三轴与实际变化。内部回执和业务存储格式保持独立。
所有强配置在现有 AW_HOME mutation lock 下原子提交。Review 冻结两份声明、偏好、来源、配置与输出证据，执行锁内重读；stale 不写。依赖提供者失败阻止相关消费者，独立目标继续。共享 Native 包体及 activation 分别观察和报告，不扫描历史项目，不把共享刷新说成更新了其它项目的独立包。

平台 adapter 在执行第一个写入动作前复核部署证据。如果在此处发现变化，部署回执的 `operationPlanStale.detail.reasonCode` 标出证据类别，包括客户端发现、部署观察、共享引用、路径、市场或其它安装输入。读取失败时记录 `deploymentEvidenceReadFailed`。子进程清理无法确认时优先记录 `processCleanupUnconfirmed`。

恢复回执继续逐目标报告 execution、observation、content，以及声明、偏好、配置、输出四类变化。部分完成、unknown、blocked 和 failed 不报全部成功。status 严格只读，不运行 renderer、preApply 或来源刷新；coverage 明确用户与当前项目范围，未选 targets 时有需求不等于已满足。cleanup、reinstall、source sync 或新版本始终保留至少一个可用恢复路径。

## Ownership 与删除权限

live ownership 和实际平台组件是输出清理和 status 的现场证据；Intent 表示需求，不是 installed ledger。原生安装、启用和加载状态采用原生命令/API，配置只补充声明与 scope 信息；完整状态规则见[状态与配置](config-and-status.md#22-平台产品面与组件事实)。补充证据可阻止危险写入或删除，不能将原生已安装改为未安装。普通恢复和清理不改声明、偏好或插件配置。不得新增安装合同存储、第二套安装状态或持久依赖图。

generic writer 的可重建 owner marker 绑定 source/plugin、target、scope、Skill 与内容清单。原生目录包及补足复用 owner-aware writer，并绑定 sourceIdentity、physicalKey 与 scope；包内可重建物化证据保留冻结组件 ID 到原生输出的映射。观察区分 absent、satisfied、drifted、conflict、unknown。只替换和清理由精确证据证明归属的输出；foreign、共享和未知内容保留。离线 cleanup 不要求来源仍在线；force 不能认领第三方内容。失败保留成功部分和精确恢复入口，不承诺补偿。

cleanup 从本次精确部署的 owner/native observation 与恢复候选取得位置，不扫描旧 Agent Portable 残留或其他项目。客户端缺失不能阻止证据充分的独占补足清理；原生卸载确需客户端时保留来源与重试证据，不能猜注册已不存在。

管理记录、路径存在和共享引用不自动授予删除权限。对于仍在 Catalog 的插件，有效共享 native、禁用 activation 和 user 继承本身也不构成 project 的待清理输出；确认下架后的例外见[停用已移除插件](#停用已从-catalog-移除的插件)。状态证据与范围判断见[状态与配置](config-and-status.md)。Codex private cache 和 installed manifest 不参与普通生命周期、repair、residue 或 cleanup 成败判断，AW 不直接删除它们。

## 写入流程与确认

需要 Catalog 的公开写命令和 `config ... --apply` 使用同一条 rebuild 流程：

~~~text
解析合法请求、共同配置与依赖
  → 并行读取独立平台的 discover/resolve/inspect，按原目标顺序收集结果
  → 按真实 RenderUnit 取得完整静态/动态集合与命令闭包
  → project 到私有 staging，冻结字节、位置、缺口和删除影响
  → Review 或直接 CLI 现有确认
  → 单一 AW_HOME 写锁内重查全部输入与现场证据
  → preflight 通过后每逻辑 target 至多一次 preApply
  → adapter 执行冻结 route/effects，不重新渲染
  → 逐部署后置观测，保留 applied/failed/unknown 与恢复入口
  → 汇总保存事实、平台、产品面与组件结果
~~~

同一只读阶段按实际来源、平台、scope 和项目共享等价的 inventory 读取。Active snapshot、marketplace 选择和依赖计划可以使用这次结果。Review、锁内重查、写入现场和最终状态分别取证。writer 在写入前检查目标的 live ownership、native registration、有效配置和冻结的输出。普通 inventory 只覆盖当前上下文，移除只检查本次请求释放的依赖。

`OperationPlan` 用于 Review、stale fingerprint 比较和回执。联合安装与同步在同一把 `AW_HOME` 写锁内调度准备好的原生目标、Portable 输出和托管命令包。读取和写入并发上限分别为 4 和 2，按进程可用核心数下调，各至少为 1。每项工作沿用对应的 rebuild、adapter 或 writer。命中声明平台的部署共用一个命令包候选及其冻结路由。最终回执按计划顺序归并，各目标保留实际执行和读回结果。命令包撤销和显式维护见[包维护与配置应用](../../reference/managed-commands.md#包维护与配置应用)。

独立宿主的登记、独占的包目录和位于不同目的地的 Portable Skill 可以同时写入。每个写入步骤一起领取实际涉及的目录、文件和宿主登记库。路径别名、父目录替换及同一设置文件的读改写共用相应资源。需要扫描多个宿主的现有登记时，读取会等这些位置的写入结束，以免把正在更新的清单当作损坏。一个位置被占用时，可以先执行已经就绪的其它位置。无法限定副作用的 `preApply` 在本次操作内独占执行，后续目标重新核对受影响的现场。调度状态随命令结束而释放。

收到中断时停止派发，收拢已经开始的操作，再释放本次持有的资源。回执保留已保存的声明、已验证的目标和待恢复的精确位置。已经发出但无法确认结果的写入保留未知影响，未开始的目标记为 `not-run`。进程退出取决于子进程清理结果，见 [CLI 退出码](../../reference/cli.md#3-状态与进程退出码)。

Review 冻结 Active snapshot、两份声明、部署偏好、配置、目标和输出证据。联合准备阶段复用本轮已读取的需求；仅刷新现有输出时，安装现场观察也在本轮复用。这些内存数据不跨执行检查边界复用。直接 CLI `--yes` 与 TUI 使用同一个 `requiresConfirmation` 和 `sharedImpact` descriptor；共享替换或重建必须说明可能影响其它项目。Execute 在同一 `AW_HOME` mutation lock 内重读 Active metadata 与 Review digest；source config 或 Active digest 改变时，在 plugin、config 或 native 写入前返回 typed `operationReviewStale` 或要求新 Review。这项检查不访问远端 branch。

同源共享 marketplace 在联合准备结束前汇总各 scope 中准备成功的候选，再统一冻结各子计划的 descriptor 与 Review 证据。准备期间也必须保持现场指纹不变；冻结后或发布开始后，不能加入新候选或扩大已确认的集合。

用户确认后才开始写执行。配置保存和 apply 是两个结果；配置已经提交时，后续准备、执行或 status 失败仍保留已保存值，精确回执见[配置提交与应用](config-and-status.md)。配置写入、生命周期和平台写入各自保留最小本地恢复，不组成跨第三方系统的事务。

## 依赖与部分成功

插件依赖来自 manifest `dependencies`，在同一 source 内解析。依赖图拒绝缺失节点、环和超出既定上限的图。安装按目标及其实际 provider scope 建立依赖。提供者完成写入并通过所需的现场校验后，对应消费者才可以执行。独立部署可以先完成，命令按稳定的依赖优先顺序报告结果。

dependency placement 由 User/Project 完整需求闭包自动决定，不提供 scope override 或手动选择。Codex、Claude、Copilot 和 generic 沿用共享提供者规则。Antigravity、Cursor、Grok、OpenCode 和 Pi 的项目可以继承已安装且健康的同源个人静态 Skill 依赖。仅有个人声明时，只安装项目根仍可将缺少的依赖安装到项目。显式项目根、需要按范围渲染、运行安装脚本或生成专属配置的包保留各自的部署。项目即使看到损坏的 User provider 也不自动复制一份 fallback。provider 切换先验证替代目标及 preApply，再清理可证明专属的旧输出；失败保留旧输出并阻止相关 consumer，独立目标继续。Native 的共享包、实际 activation 与专属组件分别核验；合法继承不伪装为项目缺失。安装准备被依赖阻断时，保留依赖、Agent、位置、安全原因和对应恢复入口。

只同步项目根时，如果它复用的个人依赖已核验健康，重试会跳过该依赖的安装脚本。同时选择个人根且它也需要这项依赖时，该依赖的个人安装脚本执行一次。generic 核对 AW 所有权、内容摘要，以及升级时已确认移除的旧 Skill。共享个人包的原生平台核对依赖文件与宿主登记，项目仍执行自己的启用步骤。安装脚本可能改变依赖。首次安装、同步和重建都会在脚本之后、消费者写入之前重新核对它实际使用的直接和间接依赖，包括经多条路径复用的个人依赖。核对失败只阻断依赖它的写入，独立目标可以完成。显式选择该个人插件时仍按普通同步处理。

依赖执行顺序只在本次命令内存在。内部后端结果保留 relation、requiredBy、安全后端状态和恢复建议；统一 CLI 生命周期 data 保留请求的所有目标、阻断与未完成项，不公开持久计划、锁或来源内部证据。精确匹配的现有 shared native 可复用，不建立 ownership ledger。

精确插件升级可以选择完整需求闭包中的依赖项，不要求把依赖提升为 Intent root；选择仍绑定原有 root、target 与 provider scope。闭包之外的插件不能借此成为同步目标。

普通 remove 默认清理本次取消需求后失去全部引用的依赖输出，包括传递依赖。候选限于本次请求原依赖闭包、所选物理 scope 和本机执行 targets，且必须没有独立 Intent、没有剩余需求或已观察到的现存消费者，并有充分 live ownership 证据。精确请求按 root×Agent 保留对应关系，不能展开为插件和 Agent 的全部组合；依赖候选只来自同一 Agent 上被选根的贡献，未选位置的现存消费者仍保护其依赖。未知需求、来源或消费者依赖关系不能当作无引用。`--keep-dependencies` 保留这些依赖；它不改变所选根的移除或提供位置切换。清理按依赖者优先执行；依赖者移除失败时，保留它需要的依赖，报告未完成项。Review 冻结依赖清理的精确位置，锁内按同一证据重验。

所选 scope/target 的移除会破坏其他声明或现存插件输出的依赖时，普通 remove 在需求和输出写入前以 `dependencyStillRequired` 阻断。检查按实际 provider 判断。当前项目中归属明确的原生包在取消声明或从 Active 下架后，仍可保护同源个人 Skill 依赖。无法读取依赖闭包时，保护限于该来源和目标下可能被继承的个人包。用 `remove --only outputs` 清理项目包，或核验已存在的健康项目副本后，可以继续卸载。取消另一 scope 的重复声明不影响仍有效的 provider，提供位置切换继续先验证替代目标。普通 remove 的 `--force` 允许取消所选需求并清理该 scope 的所选输出，保留其他依赖者的声明和输出；结果可能不再满足完整需求，后续 sync 可以重新安装缺失依赖。此 flag 只绕过依赖保护，不扩大 ownership、共享内容或路径删除权限，也不启用受限损坏输出恢复。

项目已声明、尚未安装的插件也会保护它需要的 User 提供者。读取某个依赖的插件清单失败时，已绑定 Active 的 Catalog 依赖条目可以确认哪些根可能共用提供者。分目录部署的 Native 目标分别观察个人与当前项目的实际提供位置。允许共用的目标上，Project 显式根有自己的部署需求，其余可能借用 User 的依赖保留为未知。普通 remove 保留仍可能被引用的提供者及其声明。对于 generic，若 Project 也显式声明同一提供者，Review 和写锁内均核实项目副本属于 AW、内容完整且依赖满足后，可以移除 User 副本。索引也无法确认闭包时，保留同来源、同目标、对应提供范围的保护。执行安装或重新放置仍需取得完整的插件清单。

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

普通 cleanup 不读取 Active；force 可把当前 Active 中所选 plugin bundle 的 shallow evidence 作为可选补充。source、Active 或 store 缺失或损坏不能永久阻止 Intent 取消，或阻止有充分 live evidence 的清理。两者保留 foreign、shared、unknown 内容和无法安全撤销的原生包，不猜测输出路径。旧产物不符合当前路径或来源证据时，扫描错误仍保留精确恢复位置；不能把它加入合法 owner reference。普通和 force 均不能处理时，说明备份、核对精确配置引用、人工移出扫描目录和重新查询的步骤。坏头部不能独自证明归属或无关性；未改变前置条件前，不循环推荐同一失败清理命令。

### 受限 force cleanup

force cleanup 是专属损坏输出的恢复动作，不是删除权限升级。除前述 shallow 类型、合法 root、非 symlink 路径链、节点类型、basename 和 artifactKey 校验外，TUI 还要求当前 preview 只有一个唯一、精确、非空的 `forceExclusive` 候选。没有批量 force cleanup；不能绕过依赖、非插件内容或共享内容保护。完成后重新安装是新的操作和 Review。

### 停用已从 Catalog 移除的插件

已确认从健康 Active Catalog 移除的插件通过普通 `aw plugin remove` 的退役（retire）分支处理。普通 `cleanup` 不读取 Active、不自动升级为退役，也不删除强配置。退役在公共授权点完整校验 Active（不只校验传输完整性），在本次操作内冻结 source identity、snapshot digest、插件缺席事实和部署计划；写锁内在首次写入前重新核验这些依据，Active 变化或插件恢复上架时返回 `operationReviewStale`。退役模式参与部署及 OperationPlan 指纹，不能用普通卸载或离线清理的计划执行退役。

退役只取消显式 scope 的需求，不扫描或修改其他项目目录。配置删除默认关闭，明确选择时删除该插件全部本机 common／平台设置，并在 Review 说明全局影响。对于 Codex、Claude、Copilot，只有证实同源 AW 归属、原生登记观测可确认且没有归属冲突，退役才可忽略其他 scope 或项目的共享引用，撤销共享原生登记并清除共享包及精确市场条目。这里绕过的是 `sharedReferences` 对 AW-owned 共享包的保留规则，不是 `foreign`、`shared` 或 `unknown` ownership 的删除保护。Claude managed 登记仍阻断。多插件退役的部署证据绑定实际目标的原生登记、激活及市场条目，其他已确认插件的变更不使该目标失效；共享文件的实际原子写入仍以当时完整现场复核、保留无关字段。

共享包已缺席时，只有当前平台的 canonical marketplace 配置证明了 Active source identity，且宿主市场登记指向同一 canonical 根，才允许清理当前 scope 的失效激活或原生登记；缺少、损坏或冲突的证据不能授权解绑。现场只有可证明归属的独占补足、没有共享原生包、登记或激活线索时，仍按独占 owner 证据清理，不要求本来就没有生成的市场。逐平台动作与后置观测顺序见[原生路由](platforms.md#2-原生包正文与-lifecycle-路由)。Review 说明共享包退役导致其他项目使用失效，但其声明保留，进入对应项目后再收尾；不隐藏任何实际残留。共享原生目标只有真实观察到包和登记均缺席（无登记路由可为不适用）且清理动作完成时才算完成。

已确认下架但退役未完成时，重新审阅并运行 `aw plugin remove <selector> --scope <scope>`；不能用保留共享包的 outputs-only 清理代替退役。仅在需要离线清理所选独占输出时，使用 `--only outputs` 和明确的 target。未完成的配置删除保留显式 `--delete-config` 的重新 Review 指引，已完成时不再请求。独立目录残留提供精确人工检查指引，重试不自动携带 `--yes`。

## 平台执行入口与结果

CLI/TUI 共用 adapter 注册表和发现结果。实际入口、配置根、版本/profile、Pi 消费者条件、物理与激活位置进入 preparation evidence。锁内再次观察发生变化时返回 stale，不切换入口后消费旧计划。执行只用已审核 staging 字节，进程重启或 staging 丢失须重新准备。

discover、prepare、materialize、原生 mutation 与 postcheck 的错误只阻断真实依赖分组，其他平台继续。参数错误、共同强配置损坏、无法取得唯一锁、共同授权缺失和用户中断仍可整体停止。共享发布失败只阻断其消费者，不回滚其他平台成功。

包、登记、有效启用、组件和加载事实各自保留。单插件与分组后置检查都要求对应路由的交付事实，包括 Grok 所需的信任状态。Pi 的执行扩展及 OpenCode 的可选运行观测按各自证据报告。组件缺口保留 `requiredFeatures` 的具体 feature/values、缺口 ID 和可用的 `componentId`，例如缺少 Hook 阻断或一个 Instructions audience。无能力要求的真正未满足项使用空数组。

原生动作回执与后续只读状态分开：Pi Project remove 的精确成功确认可完成本次撤销及专属包清理，即使有效 list 未显示 Project 段；registration 仍保留 unknown。命令、清单与归属边界见[状态证据](config-and-status.md#31-只读观察)。Grok 首次 User 来源须先由用户显式原生授信，目录信任和 AW --yes 均不能代替。

完整声明只缺平台能力时，适用组件照常交付，缺口随同结果报告。所有项都跳过时保留需求，完成零项交付。已完成或无适用项的目标在输入、能力和现场证据相同时无需重新写入。配置、版本、能力变化或实际产物漂移会重新求值。真正缺少依赖或资源、renderer 失败、权限拒绝及原生写入失败仍保留未完成与恢复路径。

成功有意空集合在 Review 中明确撤销旧输出，新目标可为成功 no-op。完整的新声明如果明确请求了一个旧入口无法保留的限制，Review 只撤回已证实归 AW 独占、当前作用域的旧入口，例如新版要求无工具但当前适配器不能表达该限制的角色。旧 renderer 只返回 `unmet` 而未提供完整声明时，保留缺少撤回依据的旧项。共享、外来、归属未知以及撤销失败的内容继续受保护，已观察到仍可能生效的旧输出随结果单列，并保留适用的恢复方法。取消需求时保留仍被引用的共享原生包。插件的 AW_HOME 共享命令包在平台卸载或清理后保留。preApply 失败时保留旧输出，Grok 同 scope 的 Instructions 渲染失败时停止相关 Agent 包的发布。

结果按本次真实范围汇总：全部完成 success/0；有完成部分、有效部分结果或 confirmed/possible 变更为 partial/4；全部执行前受阻且无业务变更为 blocked/3；执行失败且无有效部分或已知/可能变更为 failed/1。成功保存需求、配置或偏好也是已提交变更。超时或异常后先有限 observe，重试重新 prepare，不盲目重放。

## preApply

Manifest v4 只允许 `scripts.preApply: { path: string, timeoutMs?: number }`。旧 `postApply` 是未知字段，不能迁移或作为兼容别名。该入口只用于安装前环境校验或安装外部系统工具。作者端公开输入结构、cwd 与超时完整合同参见[插件运行时合同](../../reference/plugin-runtime.md#preapply-contract)。AW 插件依赖仍由 manifest `dependencies` 声明，Node 依赖仍在 build-time bundle 中闭包。

AW 固定使用 bundle 内的 Node entry，以 plugin root 为 cwd，继承 `PATH`，并为脚本创建临时隔离 `HOME`。输入通过 stdin 注入；stdout 和 stderr 按 effective sensitive config 脱敏。AW 等待 stdin 写入完成或受控失败、脚本退出和进程树清理后才完成 target；只有脚本明确以 code 0 且无 signal 退出并确认清理成功时，脚本未读取 stdin 造成的 `EPIPE` 才不改变成功结果。其它 stdin 错误使用稳定脱敏的 `preApplyInputFailed` 诊断。非零退出、spawn 失败或超时会终止进程树。

每个 target 每次命令最多运行一次，脚本必须幂等。`install`、`sync`、`reinstall` 和 `config ... --apply` 运行它；`cleanup`、`uninstall`、`status` 和 Review preparation 不运行。默认 timeout 是 300 秒，Manifest 和 CLI override 的有效范围都是 1 秒至 30 分钟。`--script-timeout` 只由会运行 preApply 的命令公开和消费。TUI 高级选项复用相同校验范围；Review 显示票据绑定的实际值和会运行脚本的 namespaced plugin、platform、scope，preview 和确认后的执行只使用该冻结值。只保存配置、`cleanup` 和 `uninstall` 不传递该选项。

同一命令中，纯激活共享包的附属目标可复用该包已成功执行的 preApply；它没有独立组件、配置输入或补足变化时，不因多选一个 scope 重复执行。具有独立资源或配置输入的目标仍各自执行。主目标的环境校验和 provider 切换保护保持，不能仅因原生 effects 为空跳过；失败结果不能作为成功记录复用。

preApply 需要 TUI Review 的明确确认或直接 CLI 的 `--yes`。内部原生写入入口收到缺少脚本授权的请求时，先返回相应诊断，连本次写入的动态 renderer 也不会启动。审批范围按实际目标和动作核对，普通字段或整层删除确认不能授权脚本。target 的 schema、config、artifact 和 ownership 只读 preflight 必须先成功。preApply 成功后才可为该 target 执行 stale cleanup、native/artifact write、postcheck 和 receipt。`reinstall` 也先运行 preApply，再 cleanup，并复用同一 target preflight。

preApply 失败时，该 target 不执行任何 AW-owned cleanup 或 write，receipt 记录稳定且脱敏的失败，并提供 `sync` 或 `reinstall` 恢复。其它 target 继续执行。AW 不回滚脚本已成功完成的外部动作，也不增加外部副作用 ownership、journal、补偿或 cleanup 能力。

preApply 不允许遗留后台后代；AW 在脚本正常退出、超时或中断后先终止并确认本次脚本的进程树，再完成该 target。进程树清理无法确认时，preApply 失败并阻止该 target 的 AW-owned cleanup 或 write。身份无法证明属于本次脚本的 foreign 进程不会被终止。

CLI 在 preApply 执行期间收到 `SIGINT` 或 `SIGTERM` 时，先清理脚本进程树和本次临时目录，再分别以标准信号退出码 `130` 或 `143` 退出，不继续其它 target。清理无法确认时以 `1` 退出。

## 恢复与性能证据

每条失败链必须可用 `cleanup`、`cleanup --force`、`reinstall`、来源刷新或新版本发布恢复。无法证明 ownership 时宁可保留内容，也不能删除用户或共享内容。

### 宿主权限恢复

卸载和 `aw plugin remove --only outputs` 撤回本次移除的 owner 中已核验的权限贡献。OpenCode User、Project 和 Antigravity CLI Global 可按各自配置路径与归属记录离线清理。缺失或损坏的归属证据不妨碍其他专属输出清理。遗留规则仍可能生效，`--force` 也只处理可证实归属的内容。先在宿主配置中核对遗留规则，再用相同目标和范围同步以重建后续归属证据。同步会保留无法区分出处的规则。

移除某个 owner 后若会恢复其他插件的权限，Review 先列出受影响的插件和恢复规则。写入成功后回执标明恢复的插件和位置。OpenCode User 限制的变更也可能恢复 AW 已知 Project 的规则，按[平台权限投影](platforms.md#opencode-v2)中的项目 Review 一并确认。

OpenCode User 批次按已提交的 owner 推进经确认的 Project 改动。批次结束时，回执逐项目列出已写入的改动以及仍需复核的配置。若只有部分 User owner 完成，超出原 Review 的 Project 改动保留待复核。`permissionRelatedProjectUpdateIncomplete` 或项目写入中断时，先重试回执列出的失败 User 目标，再到每个未完成的项目根运行 `aw plugin sync --context project --target opencode`，审阅本项目当前规则后重试。如果需要保持 User 输出已移除，在对应项目打开 TUI，仅选择 Project 的 OpenCode 位置同步。`--only outputs` 保留 User 需求，联合 CLI 同步可能重新部署该位置。失败项目仍保存用于同步的 owner 声明。

宿主文件不可解析或检查后被修改时，权限写入以 `permissionConfigurationConflict` 停止。确认或修复文件后重新准备 Review。若回执为 `permissionOwnershipWriteFailed`，宿主规则可能已经交付，先检查当前文件再同步，避免假定写入已回滚。相对 `OPENCODE_CONFIG_DIR` 导致路径无法确认时，设置客户端实际使用的绝对路径后重试。诊断含义见[CLI 回执](../../reference/cli.md#4-业务-payload-的边界)。

### 性能取证

性能观察复用现有 debug event。`review.prepare.*` 记录 Review 准备阶段耗时；`performance:stage` 记录 `catalog.load`、`catalog.validation`、`inventory`、`dependency.plan`、`target.build` 及 `recovery.*` 的阶段名与耗时。恢复阶段覆盖规划、锁等待、锁内重查、子计划准备与执行及最终状态读取，记录开始、成功或失败；诊断失败不覆盖操作结果。命令阶段另记录结果，Catalog load 另记录聚合 source/Active/validation 计数，不记录 digest、路径或错误文本。`native:start|success|error` 只记录白名单 `agent`、稳定 operation、`exitCode`、固定 reason 和 `durationMs`，不记录 args、cwd、stdout、stderr 或未知 error/cause 文本；`rebuild:action` 分别记录 `inspect`、`native.write`、`artifacts.write` 和 `postcheck.inspect` 等真实写阶段耗时。没有 native 或 artifact 动作时不伪造对应阶段。测试用 provider 调用次数、检查范围和阶段事件验证 write 性能边界。Warm install 的总时长只对受控 fake native runner 使用宽松门槛；本地 Catalog 阶段 p95 目标为 500ms，不能据此承诺第三方 CLI 时长。

首版不增加 authoritative installed-state DB、GC/read lease、新锁层级、全局事务或补偿状态机。Active snapshot 已是不可变内容寻址目录，操作直接引用它；当前可观察的重复 inventory 可以用操作内 snapshot 消除。这些事实不足以证明新增持久状态和协调协议的成本合理。

## 实现与验证入口

写入口是 [`write-commands.ts`](../../../packages/cli/src/commands/write-commands.ts)，联合恢复在 [`recovery/`](../../../packages/cli/src/recovery/) 与 [`intent/`](../../../packages/cli/src/intent/)。[`rebuild-command.ts`](../../../packages/cli/src/commands/rebuild-command.ts) 准备目标，[`rebuild-operations.ts`](../../../packages/cli/src/commands/rebuild-operations.ts) 执行 preApply、清理、平台写入与复核。[`operation-plan.ts`](../../../packages/cli/src/commands/operation-plan.ts) 只管理 Review fingerprint 与回执描述。

归属规则在 [`ownership.ts`](../../../packages/cli/src/utils/ownership.ts)，离线计划与精确证据在 [`offline-cleanup-evidence.ts`](../../../packages/cli/src/commands/offline-cleanup-evidence.ts)。

修改测试或选择验证命令前读取[测试指南与 Test Value Gate](../testing.md)。现有验证入口包括 [`ownership.test.ts`](../../../packages/cli/tests/unit/ownership.test.ts)、[`rebuild-operations.test.ts`](../../../packages/cli/tests/unit/rebuild-operations.test.ts) 和 [`rebuild-task-command.test.ts`](../../../packages/cli/tests/unit/rebuild-task-command.test.ts)。它们的覆盖不能扩大为真实 Codex/Claude 客户端资格；客户端验证边界见[测试指南](../testing.md#1-test-layers测试层级)。
