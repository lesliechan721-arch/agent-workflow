# TUI 当前交互与能力

本主题定义控制台的页面、键盘、Review、结果和诊断。修改 TUI 导航或投影时从本文件读取。TUI 直接调用 CLI 的规划、来源、配置和写入服务，不循环启动 CLI 子进程；不同来源可以部分成功，不承诺跨来源回滚。只有修改底层语义时，再读[生命周期](lifecycle.md)、[状态与配置](config-and-status.md)、[来源](catalog-sources.md)或[公开 Review](../../reference/review-and-eval.md)。

## 当前边界与主题入口

首页有插件、插件清单、插件来源、Agent 管理四个领域入口。状态附在入口卡内，不设重复全局统计，不弹出项目恢复提醒。页面复用首页、集合列表、实体详情、编辑器、操作流程和完整阅读六类模板；依赖图是集合模板的专用渲染器，业务路由和许可阶段保留。

页面投影、Reader、键盘和内部关系证据不新增 CLI 入口、Status JSON、额外 I/O、持久记录、锁或恢复状态机。主题中的来源获取、状态读取和写入仍调用已有服务。会话数据与草稿不构成部署授权。

按任务进入[来源与插件更新](#来源与插件更新)、[清单与位置状态](#清单与位置状态)、[安装与批量目标](#安装与批量目标)、[确认与结果](#确认与结果)、[设置保存与应用](#设置保存与应用)、[依赖关系](#依赖关系)、[浏览与完整阅读](#浏览与完整阅读)、[返回重载与退出](#返回重载与退出)或[能力覆盖](#能力覆盖)。

## 来源与插件更新

TUI 初始 load 不访问网络，也不等待 freshness 检查。进入 ready 后，每个 session 只为 `autoCheck` 开启的 source 自动检查一次：primary 先开始，其它 source 最多并发两个。关闭 `autoCheck` 的来源只在用户显式检查时 probe。健康 Git Active 先只解析远端 ref；ref 未变化时不 fetch，固定 commit 不联网；ref 变化时才 fetch 并完整验证。检查结果只进入 session-private overlay，不修改统一恢复状态、Active、固定的 session Catalog 子集、插件列表或 target revision。远端失败只显示 `checkFailed`，健康 Active 仍可浏览。reload 不重复全量检查；退出时取消所有 probe，session、token 和 source fingerprint 拒绝迟到结果。

TUI generation 使用 generation status v2 的 Active compatibility 投影。健康但 unsupported 的 Active 显示为 `incompatible`，技术详情显示 required 和 missing capability ID；不显示 available capability 全集，也不把该状态显示为损坏或提供重新下载修复动作。

候选 snapshot digest 相同时状态为 current；commit 变化只作为 provenance。Git 候选版本更高时提示更新；相同版本但 digest 不同为 version conflict，较低版本为 rollback，logical identity 变化或能力不兼容也阻止普通更新。能力诊断只从 typed compatibility error 投影 required 和 missing capability IDs；主视图只显示缺失数量，技术详情显示 missing IDs，不显示当前 AW 的 available 集合。候选不兼容时旧 Active 保持可用，普通 update 不出现，轻量检查和完整验证都保留相同结构诊断。版本比较复用 strict SemVer。Path digest 变化显示本地内容变化。TUI 只提示候选，绝不自动切换 Active。用户可从来源详情显式获取并启用、重新下载并精确修复、验证并切换，或使用当前候选替换无法修复的损坏 Active。更新成功只表示 Active Catalog 已切换；已安装插件不会自动升级，TUI 重新计算可用的插件升级。背景检查取得的完整 candidate 和 Manifest 只可在当前 TUI session 内复用于普通 activate/update Review preparation；复用绑定当前 session/token、source config fingerprint、明确为 null 或具体 key 的 Active store key，并要求完整 evidence。source mutation、repair、replaceDamaged、state recovery 或任一 binding 变化都回退到重新 probe。该 overlay 不持久 Candidate，不写 store 或临时 snapshot，也不改变 Status 或 Active。Execute 始终重新解析 candidate 并逐字段比较 Review evidence；变化时返回 `catalogGenerationReviewStale`。add/update 的主路径先按 Review config digest 保存配置，再启用确认的候选；配置成功但启用失败时保留新配置，并在 TUI 提供重试。若 Catalog 已启用但主来源切换失败（`partialReason: 'primary'`），已启用的 Active 保持有效可用，主来源未改变，并在操作结果中作为独立的部分成功保留，不能简化为未生效或全部失败。generation state 无效时，TUI 可经独立 Review 原子重建只含目标 Active 的有效 state；它不修改 source config 或删除 store，且不信任无效 state 中的其它指针。Active store 损坏时，精确 repair 始终以强 Active state 为目标，并保持 Active 的 source fingerprint 和 provenance 不变。只有 metadata 和 snapshot 完整匹配时，弱 store entry 才能提供可信旧版本；任一不完整时不得声明 version conflict 或 rollback。旧版本不可用时，普通恢复或 update 在写 state 前阻止，并保留当前 Active；用户必须进入独立 replace Review。未保存的 config/source/Portable 草稿、ReviewPreparing、active Review 或写入进度阻止开始 Active 切换或 reload；freshness probe 可以完成并保留 session 结果。

TUI 的 `PluginUpdateProjection` 把 runtime 的 target revision 与当前 session 的已验证 Catalog candidate 合并为插件级更新事实，并与 health 分开显示。它只在 installed version、目标 Active 或 candidate version、source identity、generation key、manifest/content evidence 和 capability compatibility 都可验证时提供“更新到 X”；Catalog version、ref commit 或未验证 candidate 本身都不能作为插件更新。candidate 需要切换 Active 时，来源切换 Review 与重新规划后的精确插件更新 Review 是两个确认边界。来源切换成功只说明 Active 已改变；插件写入失败仍单独报告。更新 intent 绑定 installed/active version、source identity 和 generation key；锁内任一项改变时返回 stale，不得无声跟随新 candidate。该 projection 和 candidate overlay 都是 session-private 数据，不改变 统一状态 JSON。

Catalog ref 页面只把 Release 和 Beta 投影为现有 explicit ref；底层仍只有 `cliChannel | explicit`。官方来源的下载方式从两个既定 HTTPS/SSH URL 派生，局部选择只修改 URL 草稿，通过 source mutation Review 提交；不新增持久 transport 字段。来源 ID 为 official 但 URL 为自定义地址时仍保留地址编辑，不静默替换镜像。Catalog logical identity 继续只来自 snapshot 的 Workspace identity，不修改 live owner identity。

来源列表的“检查全部”包含关闭自动检查的来源，同时最多检查两个来源。页面显示正在处理的来源和各自结果，不提供虚构百分比。必要时可获取和验证候选内容，结果保留在 session overlay；检查不启用或切换 Active Catalog。

TUI 的 Store 页面只读取同一 status 服务。清理 Review 从 dry-run 检查冻结精确 `authorizedItems`，执行时把该集合交给同一 prune 服务。确认以后出现的新候选不在授权集合中，不能被本次操作删除；大小无法完整证明时显示未知，不能显示为零。TUI 不增加锁、自动 GC 或持久清理计划。

## 清单与位置状态

TUI 插件清单先显式选择个人或当前项目，再读取所选范围需求与现场；进入页面不授权写入。已确认缺失或不完整的目标进入统一恢复 Prepare/Review，来源阻断、无法确认目标和可重试失败分别显示。局部重查保留查询、焦点和旧快照，失败时标记旧快照未确认；`H` 重新加载完整会话。partial 结果保留精确失败目标与原请求。

TUI 插件清单按显式 scope 组合当前 Catalog summary、统一恢复 status inventory、可识别的 config store 和 live ownership。已移除插件的声明、禁用 activation、Native、AW 输出、Portable 与 config-only 残留仍可见，进入独立“停用已移除插件”任务；普通 cleanup 只清理所选现场且不改强配置。新增安装只接受健康 Catalog summary 中符合资格的插件。foreign 与 shared 内容保留；成功后重新读取 Intent、Catalog、live ownership 与设置事实决定是否继续显示。

TUI 按当前 scope 将受阻、未确认、待同步、就绪依次作为互斥根分类；明确 false 与 unknown 同时存在时，底层 `allSatisfied` 仍为 false。声明根和额外现场分别显示，extraObserved 不把另一 scope 的已安装内容当作本 scope 的额外根。来源缺失、依赖、配置、collision 和残留保留具体诊断及下一步动作；诊断不写入新的持久数据库。

TUI 必须把 `orphaned` placement 纳入“需要处理”问题列表，并提供指向该范围的清理入口；同插件另一范围为 `ready` 时，不能隐藏残留问题或把清理指向正常范围。

TUI placement 在 ownership health 之外投影 collision blocker，但不能把 foreign-only collision 计为 installed。foreign-only placement 使用 `blocked`；`present` 或 `partial` placement 保留 installed ownership health，并同时保留 collision blocker。每个平台 placement 独立判断：混合平台仍可进入添加并只列可用 target；所有平台都阻断时，Preview 和平台菜单先提供“查看输出冲突”，且不显示添加、升级或重新安装。installed collision 仍提供安全移除入口，删除只处理 AW-owned 内容并保留 foreign 内容。

插件清单先选择个人或当前项目，再按所选范围的根聚合。声明区包含该范围全部声明，额外安装区仅含该范围非声明及非声明依赖的可归属根；左右切分区，`f` 按根总体状态筛选，优先级为受阻、未确认、待同步、就绪。位置状态继续独立，“共用个人安装”只采用已有 sharedUser 证据。“同步可执行项”不受查询影响，Review 保留当前范围的完整请求、精确目标与受阻项；多选同步只使用勾选根。受阻问题按已有安全动作分流，不把配置或输出冲突一律送到来源页。局部检查失败保留旧清单并标记过期，成功重查后清除标记；未进入的另一范围不主动读取。

同一插件的不同平台和 scope 分别显示结论与严重度。平台汇总只用于排序和建议，不把一个范围的问题复制到另一个范围。当前 scope 重新检查不自动安装、恢复或清理 foreign 内容。无效或不可读的当前范围声明保留安全详情和重新检查入口。返回后可继续查看剩余位置。

## 安装与批量目标

插件安装使用唯一本机 targets，不临时选择平台或逐依赖位置。用户只选择所有项目或当前项目的需求范围，再进入只读准备和操作汇总。完整 User/Project 闭包先确定 provider 与必要 activation；目标过滤不改变声明或依赖保护。空 targets 时单项、批量和快捷键安装均禁用，提供独立 Agent 管理，保存后重新发起安装。统一 Skill 来源按每个 Agent 的交付方式投影，不再提供独立通用 Skills 消费入口。Agent 管理只有一个保存动作和 s 快捷键，成功后弹窗默认同步，取消只保留策略。目录冲突可保存策略但阻止冲突部署，必需依赖排除则不能保存。

批量选择页的插件行显示用途与版本信息，Space 修改插件选择，Enter 查看插件。批量添加只选择所有项目或当前项目的需求范围，使用本机已选 Agent；本机 targets 为空时禁止安装，并提供 Agent 管理入口。维护任务默认沿用本次枚举的精确安装目标，范围编辑只能删减或恢复该集合，不添加缺失的平台或位置；范围变化后撤销旧 Review 并重新取证。 重新检查后出现的新位置不会自动加入；位置或相关证据变化时必须重新确认。空集合不执行。

TUI 批量写入支持添加、同步、重建、移除和普通清理；force cleanup 仍只允许单个 target。批量添加以所选插件和共同需求范围建立联合恢复 Review；平台由本机策略确定，位置由完整 User/Project 需求推导。既有输出的维护批次固定一个内部 action，沿用每个精确目标自己的 scope 和 platform，建立一张 Review ticket。执行完成后只记录一条 history；顶层 receipt 汇总所有分组的 target 和 rebuild 结果，分组结果只用于显示来源归属和计算重试根插件。批次不新增持久状态、ledger 或锁。

批量添加允许选择已有部分安装的插件；“未安装”筛选只包含已确认没有安装的插件，不把未知现场当作缺失。来源不可用、能力不足和 config-only 等新增选择门禁只适用于 browse 添加；已安装清单继续提供移除、同步和 cleanup 恢复入口。选择需求范围后，联合计划按本机 targets、排除、完整依赖闭包和实际现场区分已有、待部署、跳过与受阻目标。Review 显示可执行动作及每个受阻原因，确认后只执行已审核的安全动作；独立目标可部分成功，受阻目标保留恢复说明。位置摘要和可分页的完整明细来自同一计划，窄屏可完整阅读并返回原选择。

“按项目清单准备”使用当前项目的 sync-all 合同，允许准备尚未安装的已保存根；“修复异常”使用有版本证据的精确恢复任务，不能把未知版本的已有目标当成未安装。手动批量维护由 Controller 按动作和精确 status target 枚举位置，不从平台展示摘要反推 scope，也不按 supported scopes 扩张目标。合法的 Codex native 双位置启用保留两个请求位置；共享内容的写入影响仍由原 planner 在 Review 中说明。

批量选择分别记录已选状态、新增选择资格和执行资格。已选项始终能逐项取消；从当前清单消失的已选 ID 仍以不可用占位显示，不静默丢弃或执行。“全部已选”以选择集合为准。继续动作在窄屏保持可见，与候选使用同一焦点序列；聚焦插件保留用途说明。 批量安装的渲染和导航使用同一个有序分组模型：顶部操作、使用范围、工具。初始焦点落在首个可操作项，视口随焦点移动。

平台维护每个平台只有一个入口，位置卡绑定精确 `(pluginId, platform, scope)`。多个位置初次进入不预选，Enter 选定后才启用对应动作；上下移动只改变焦点。单位置初次可自动选择，返回保留有效选择；已选目标失效后清空且不自动换到其它位置，即使仅剩一个。补充安装入口明确标出新位置，并进入原安装选择与 Review 流程，不作为已选位置的维护写入。新增位置不加入原授权。实际许可、共享影响与受限清理继续由原 planner 和 ownership 门禁决定，未知状态不产生伪安全写入。

## 确认与结果

TUI 的部署与来源变更入口在进入 Review 前先进入 `ReviewPreparing`。普通 `ReviewPreparing` 只执行当前 intent 的验证和证据采集，不执行写入。用户显式选择“刷新并同步”是唯一例外：它在建立插件 Review 前刷新相关来源，并可切换可重建的 Active 弱状态；Esc 只取消后续 Review 和插件写入，不回滚已完成的 Active 刷新。一次成功的 TUI load 固定可用来源的 Active snapshot 子集，并保留其它来源的失败证据；子集 digest 只包含成功来源。同一 session 的浏览、设置、status、依赖 preview 和 Review 都读取该固定子集。load 只读取 source config、catalog state 和 Active store；它不 fetch 或同步，并在本地读取完成后立即进入 ready。页面只显示实际已开始的 status、Catalog、inventory、dependency plan、config、Portable 或 evidence 边界，并在 debug 日志记录阶段耗时。可用 Esc 协作式取消。取消会使迟到的只读结果失效。底层不支持 signal 的读取可以结束，但不能再创建 Review。准备成功时，Review 原位替换准备页，因此 Back 返回原页面并保留其选择或草稿。

`ReviewPreparing` 的公共 snapshot 只包含 operation id、kind、subject、当前安全 stage、状态及安全错误字段。原始 `OperationIntent`、config updates、preset、source path 或 URL 只保存在 controller 私有、按 operation id 索引的内存中，并在成功或取消时清理。Config ViewModel 和 controller 公共 snapshot 对 sensitive 顶层字段只投影状态，不包含 value、effective value、draft、default 或 choices 原文。

统一恢复的 Review 固定当前 scope 和精确的 root×Agent 目标，并绑定完整声明、部署偏好、来源及后端证据。执行在现有 `AW_HOME` mutation lock 内、首次副作用前重读这些证据；声明、偏好或目标路径变化使 Review stale。普通 sync 不提交声明或偏好。失败重试只选择原请求中可安全重试的精确目标，重新准备并建立 Review，不将不规则目标集合展开为笛卡尔积。清单检查和导航不启用来源、不更新插件，也不执行平台写入。

Review 仍是用户确认边界。插件 Review 按 Project intent、User intent、Shared Codex native、User activation、Project activation 和 AW extensions 分层。直接 CLI `--yes` 与 TUI 使用同一个 `requiresConfirmation` 和 `sharedImpact` descriptor；shared replace 或 reinstall 必须说明它可能影响其它项目。Review evidence 包含 Active snapshot digest。用户确认后才进入 `Progress` 并开始插件或配置写执行；`Progress` 不接受 Esc 取消，只能按现有约定请求在操作完成后退出。`ReviewPreparing` 的可取消准备状态和 `Progress` 的已接受写状态不得共用 busy 或取消语义；除上文明确的“刷新并同步”弱状态刷新外，准备阶段保持只读。锁内底层写入校验见[生命周期写入流程](lifecycle.md#写入流程与确认)。Catalog generation Execute 在同一锁内逐字段匹配 Review 时 Active 的存在性、logical identity、snapshot digest、source fingerprint/identity、commit 和 manifest digest；无 Active Review 不可覆盖并发新建的 Active。repair 匹配后才替换目标 entry，并复用同一锁 token 提交 state。provider resolve 和普通 content-addressed store publication 保持锁外；stale 操作最多留下可删除 orphan，不覆盖 Active。

操作 Review 先从执行计划分别投影用户汇总和技术详情，再独立分页；数据量不改变默认信息边界。技术分组中的共享、删除和脚本风险仍须在用户汇总中说明。完整汇总保留在页面，只有既有 `requiresConfirmation` 要求额外授权时才打开风险确认层，默认选择返回检查。确认层绑定当前 Review ticket，不建立另一套授权；它独占输入，取消保留页面上下文，失效或过期的 ticket 不可执行。风险内容超出空间时可分页阅读，低于最低终端尺寸不接受写入确认。

没有业务分歧的恢复任务自动只读准备并进入一次影响 Review。推荐更新只有在冻结的精确目标仍完整、全部可执行、版本证据未变、无需启用来源且无需选择 scope 时，才自动只读准备真实 Review；调整选择只能删减或恢复本次冻结的推荐插件集合，并重新取证和签发 Review ticket。版本、位置、来源、删除或可执行子集需要决定时保留选择。取消或返回 Review 不得自动再次进入准备。依赖图按根插件和方向保留会话内展开、焦点和滚动上下文；普通节点详情返回恢复阅读位置，失效节点按有效祖先或根规范化，不保存到磁盘。

普通批次按 source 分组，同一 source 的所有根插件通过一次 typed write 解析依赖和构建目标，因此共享依赖和 native projection 只处理一次。不同 source 独立执行；一个分组失败不回滚或阻止其它分组。当前项目的 sync-all 在准备 Review 时读取 Intent roots，并冻结规范化的 requested plugin IDs 和 source/platform 分组。确认后，executor 在现有单一 `AW_HOME` mutation lock 内重新读取 Intent，并用已冻结 ID 作为 selectors、`all:false` 重新解析；完整根集合或分组变化时返回 typed stale，不能把后来新增的 root 自动加入本次写入。

每个可执行分组分别绑定其 `operationPlan.planFingerprint`。锁内首次复核按去除全局 Intent digest 的分组计划语义比较；前序分组完成后，后续分组重新预览，只忽略已完成 target 和对应 Intent digest 的预期变化，再把当前完整 fingerprint 交给 typed writer。没有 operation plan 的预览失败分组也进入同一 Review，但标记为不可执行；确认固定保留已审核的失败结果。即使该来源在确认后恢复，也不能重新求值后开始写入，且不能阻止其它已审核分组继续。部分失败后的 retry 只从能恢复精确 `(pluginId, platform, scope)` 的失败 requested target，或失败 dependency 的 `requiredBy` 根计算新的 selected targets；无法细分到精确 target 的失败分组不提供重试。retry 必须重新读取 status、Intent、Catalog 和依赖，建立新的 preparation、evidence、fingerprint 和 Review ticket，不能复用旧计划。

带诊断的未确认目标仍可只读重查；只有可靠缺失且失败或部分完成的精确 plugin/Agent pair 可以重新准备，冲突和未知不会变成重试。版本改变必须明确选择更新，并重新显示操作汇总；无法确认版本时保留重新检查和诊断。可执行子集完成后，剩余目标继续提供处理入口，不自动升级或删除。

TUI 普通 cleanup 使用[生命周期离线清理](lifecycle.md#安装重建卸载与清理)，不扩大为停用。受限 force 必须从当前唯一 exact shallow 候选建立新 Review；执行后重新安装另起操作。

插件和配置 Review 展示托管命令的 producer、固定参数、共享影响、权限与沙箱例外；Progress/Result 同时投影 commandResults 和平台结果。平台卸载报告保留的共享包及显式移除入口。操作汇总的声明、偏好、配置、输出四类影响来自准备计划；结果的四类变更来自实际回执。来源启用成功与插件更新成功分别报告。

TUI preview 保持只读，显示本次本机 CLI 的来源与版本。CLI 缺失或不支持时提示安装、升级或修复 Codex CLI/App；不提供托管获取或缓存授权。

## 设置保存与应用

TUI 把结构损坏的 store、Catalog/schema 不可用和字段覆盖无效分开处理。结构损坏页只显示 profile、脱敏 target 摘要和稳定 code，并只允许整层 reset 或返回；qualified plugin ID 和 profile 可直接建立 reset Review，不要求 Catalog 或 schema 可用。Catalog/schema 不可用时不打开字段编辑器；可确定设置层目标时仍可整层 reset。用户可从该页进入嵌套来源恢复；完成后返回原 plugin、profile、group 和 field 锚点，重新读取 schema 并重新校验父草稿。消失或变为无效的字段必须显式显示并阻止保存，直到用户放弃该项草稿；旧 Review ticket、evidence 和确认不能复用，也不能自动提交。字段覆盖无效时继续提供字段修改、unset 和整层 reset，并只把低层脱敏值显示为“删除后恢复”的解释，不把它投影为可运行 effective。配置已提交但 apply 失败的结果页明确保留设置，并可通过新的 Review 重新采集 evidence 后调用现有 runtime replay；`invalidConfig` 结果只返回设置修复，不提供直接 retry apply。reset 结果页显示四种 receipt disposition，quarantine 仍只显示 basename。

控制台设置总览显示实际或拟有效值，来源与待保存状态单独显示。先选择 common 或具体 Agent profile，再编辑字段；不选择 user/project 值层。每个 profile 保留独立草稿。对象与数组以完整候选编辑，子编辑不写盘；取消子编辑保留其他草稿，取消容器保留总览草稿。rowId 仅用于会话焦点，不进入持久值或 Review。保存整体覆盖。平台覆盖优先于 common，无效覆盖不得回退运行；删除覆盖的继承值只用于说明。字段 unset 在编辑器可达；恢复当前 profile 默认值位于设置选项。保存提交后再询问更新插件，输出更新使用独立 Review。

控制台搜索把 query 与输入焦点分开；退出输入后 query 继续参与来源和安装状态筛选。所有字符输入显示静态光标，并按 grapheme cluster 和终端显示宽度保留输入尾部。数字输入在解析前拒绝空白，空字符串按显式 set 保存；对象子属性与普通数字共用解析语义。统一值呈现显示实际属性值，摘要只用于显示；完整对象用于dirty、预设匹配及保存差异。设置页 Tab 切换公共/平台 profile，左右切换字段分组，来源标识默认值、公共继承、平台覆盖或未保存。保存直接提交，成功后默认询问更新插件；更新另起 Review，取消保留保存结果。保存失败保留草稿。敏感输入、失效值恢复、跨插件导航和 stale 保护继续有效。

插件设置卡片在顶边右侧显示值来源，描述保留在对应卡片内：未聚焦时最多两行，聚焦后展开全文。超出单屏的卡片正文使用 PgUp/PgDn 阅读；左右键仍只切换可见分组。错误信息和待保存状态保留，敏感值继续使用既有安全投影；不另设底部描述区。

用户从 `configUnavailable` 明确进入嵌套 source recovery 时，config 草稿保持只读，只允许该恢复流程建立新的来源 Review；其它 Active 切换和 reload 仍受草稿门禁阻止。

数组编辑器在进入前固定 profile，本地增删改排后以完整 JSON 数组保存，不按索引写盘。完整候选通过 Core 校验；128 项、262144 字节和对象 32 属性限制仍有效。引用候选只来自当前 profile 的有效来源配置；同 profile 已确认草稿可以使用，跨 profile 未保存来源须先保存。无候选、失效原值或来源无效时说明原因并允许返回修复。普通保存保护此前有效的未安装 consumer 引用。

保存菜单与 `s` 先校验并保存，成功后默认询问更新插件；Esc 只保留保存。更新只刷新已有输出，不新增 Intent、targets 或缺失安装。`u` 恢复当前 profile 默认值，只清该 profile 覆盖；危险动作显示红色。字段 unset 可清 stale 值。旧格式及历史项目值文件不自动迁移或合并，保留文件和恢复诊断；配置存储与数组能力检查在受影响写入前完成。精确配置合同仍见[状态与配置](config-and-status.md)与公开合同[Plugin Manifest 与配置声明合同](../../reference/manifest-and-config.md)。

## 依赖关系

TUI 的依赖关系页只解释当前数据，不改变 placement。正向声明边来自当前 source 的 manifest。Controller 从统一恢复状态 inventory 的 dependency component 读取 dependency ID、platform、scope、project 和 state；只有声明边有效、dependency state 为 `ready`，且 consumer 有当前现场 scope evidence（复用 `hasActualScopeEvidence`，不接受纯 Intent）时，才写入内部 `availablePlacementReferences`。它不重新计算 scope 选择。反向“哪些插件依赖它”同时保留已知声明边和这些可用关系，边分别显示为未验证与已验证；无位置的声明仍可阅读，不能按 `depth` 推断一条边。默认页面把它说明为本次状态检查：只检查当前项目和个人位置，其他项目未检查；它不表示插件已被调用，也不表示历史安装关系已经确认。共享节点明确标记为同一节点；graph blocker 或环显示为无效，不能渲染为正常树。该页不恢复已安装依赖迁移，不提供绕过依赖保护的删除入口，也不改变 `getBlockingDependents`、移除或 cleanup 门禁。

TUI 依赖关系区分三类数据。Catalog declaration 说明插件声明需要什么；`availablePlacementReferences` 说明本次 统一状态 检查中，声明边、依赖 `ready` 状态和 consumer 当前现场位置可以同时匹配；历史 applied binding 则需要证明某次安装已把该边应用到该位置。历史 binding 尚未实现，因此不会填充 `placementReferences`，也不会把可用关系称为实际调用或已确认安装关系。`availablePlacementReferences` 只是 TUI 内部投影，不新增 Status JSON、I/O、持久记录、锁或现场扫描。图的证据分类不放宽锁内写入与依赖删除保护。

依赖入口仅在任一方向存在已知边时显示，未知无边不能声称已确认零关系。双向图的当前节点和直接依赖从左侧起始，不为上游横向汇合右移整图；箭头指向所需插件，实线／虚线表达边证据，节点标签表达健康；共享和循环以引用呈现，完整关系可达，不改变卸载许可。

## 浏览与完整阅读

首页有插件、插件清单、插件来源、Agent 管理四个业务入口，固定描述为“管理  Agent Workflows 插件”（管理后两个半角空格）；`?` 打开临时帮助层，内容复用当前页面及焦点状态的快捷键提示；长帮助可用左右键分页，关闭后恢复原焦点和视口。可选择的页面内容与下方业务动作使用同一纵向焦点序列，不需要 Tab 切换区域。普通返回使用 Esc，风险取消和结果恢复仍有明确动作。长列表的 `a` 在当前对象与实际下方动作之间往返，只改变焦点和视口。输入与弹层独占其按键，可见动作与业务快捷键调用同一 handler；后台状态更新不把已聚焦的下方动作强制拉回列表对象。 可见确认按钮和 `c` 必须复用同一个稳定 action ID 与 handler，推荐更新、选择校验、目标和导航也遵守此规则。

插件和来源卡片将身份放在顶部，行高按实际显示宽度计算，短用途允许换行。插件详情共用结构化身份、来源、目录版本和位置事实，安装版本及健康状态分别显示；声明版本只有真实证据存在时才显示，不能从目录版本补齐。常用动作直接可达；更多操作保留平台维护、来源和技术诊断。仅个人或项目声明、已保存配置或关系引用也保留原 canonical 身份，缺少目录定义不改用纯文本报告或切换到其它插件。普通 About 和常驻“完整基本信息”入口已移除，基础事实不生成分页 summary。插件详情把范围徽标、Agent 状态表、内容、依赖和操作放在同一条连续阅读路径中；上下键移动阅读位置和动作焦点，PgUp/PgDn 快速移动，左右键不翻详情页。视口随终端高度调整，当前焦点和末尾动作始终可达。状态表区分已安装版本与目录最新版本，物理路径和底层诊断收进按需打开的技术详情。来源详情仍通过当前页信息焦点纵向阅读，`a` 在信息与动作之间切换，只有信息焦点显示翻页提示；技术全文使用公共 Reader。来源详情将地址、下载方式、版本策略、当前／候选目录、来源健康与检查结果分别显示，检查失败不覆盖当前版本的可用性。关系节点 Enter 进入统一插件详情，完整引用按需进入 Reader。平台观测缺失仍显示未知，不以缺少安装摘要推断未安装。内容清单使用同页纵向滚动，并区分目录版本与已知安装版本。批量和任务 Review 的插件摘要来自已确认的结构化目标与版本证据，未知版本明确显示未知，不从文案或当前目录版本推断。结果先列插件结论，再列位置和所需插件；独立位置行保留所属插件身份，完整失败节点及精确重试仍可达。 compact 页面中的静态行仍显示核心 value；辅助说明在默认页可读，或有完整阅读入口。长节点、来源和设置前后值使用 Reader。行高预算按实际渲染计算，小屏不能以截断替代完整阅读。

查询区按主标签、搜索、状态筛选、选择摘要的顺序只显示实际维度，不建立第二焦点区。左右切当前主标签，`/` 原位搜索，`f` 切状态；空搜索的光标位于占位文字之前，占位文字不计入输入值；输入时左右只移动光标，普通字母不触发背景动作。主标签选中项使用强调色，其余弱化；查询行与动作行的快捷键统一在右侧，包括 `/`。计数基于当前主标签和搜索，隐藏非当前零项，当前筛选变零仍保留条件。返回与刷新以实体或动作 ID 保留焦点、查询、选择和滚动。普通动作标题白色，焦点由强调色、背景和指示符表达；成功、警告、错误和未知只用于独立状态事实，并配文字或符号，禁用动作保持灰色。不从插件状态或名称给动作上色，不生成没有信息的孤立状态符号；实际状态、版本、风险和禁用原因继续保留。

插件库统一显示目录、安装和仅保留配置的插件，以真实 pluginId 区分来源中的同名对象。`/` 在当前页输入查询，Enter 或 Esc 结束输入并保留查询；`f` 原位循环全部、已安装、未安装、可更新和需要处理五种筛选，非输入态的左右键切换来源。这些操作不增加浏览历史或清除选择。`m` 原位进入多选，Space 勾选、Enter 查看详情，返回后恢复查询、来源、筛选、焦点和选择。空结果仍可原位修改查询及筛选。

内容名称、类型、工具和可选简介分别投影。卡片顶边显示名称、右侧类型；正文显示简介预览和工具标签。短条目 Enter 不打开额外详情，长名称／长简介和真实读取问题使用公共 Reader，返回恢复查询、焦点与滚动。普通缺简介不构成 issue；真实条目读取失败保留条目安全问题，整体或部分清单不可读保留覆盖状态，不把不完整清单说成零项。保留路径、符号链接和读取预算边界。更多操作的每个平台入口及维护页的每个位置都使用独立卡片呈现真实事实。

分页阅读页共用先换行后分页的 Reader 和横向页码，使用左右方向键及 PgUp/PgDn，页脚提示翻页和 Esc 返回，不再占用正文菜单展示 p/n 翻页动作。首末页不可用方向调暗，页数至少为 1；尺寸变化后位置合法且全文可达。来源标签、配置分组、关系树和输入光标保留自身方向键语义，集合纵向滚动提示不改成横向。阅读页的 `[y] 复制全文` 只在用户触发后复制当前阅读对象的完整正文，复用安全化原文，不复制分页切片或显示宽度产生的软换行。复制成功或失败有明确反馈，失败保留阅读位置及已有报告保存入口；输入和弹层不触发背景复制。剪贴板使用当前操作系统已有工具，Linux 需要相应桌面会话及 wl-copy、xclip 或 xsel，不自动安装工具。

插件内容页只展示指定插件的目录版本组件清单，按需读取并在会话内复用；状态重读时失效。启动不扫描全部内容，不把目录清单当成旧安装内容。按安装位置的 `f` 筛选在同一来源、query 和快照中轮转非零候选；当前项目匹配 project 安装，所有项目匹配 user 安装，未知不算未安装。当前筛选变零仍保留上下文，离开后才隐藏；筛选不改变已选集合。

## 返回、重载与退出

TUI 浏览历史的每一帧有会话内稳定 ID。安装、插件维护、配置、来源恢复和 Portable 安装流程记录自己的 flow ID、父 flow、稳定起点帧和返回目标。Flow 只管理导航归属和内存草稿引用；它不保存执行计划，不替代 Review ticket，也不是持久状态。

冻结的插件恢复任务可以作为设置编辑或显式更新的起点。嵌套流程保留父任务的精确目标和批量草稿归属，完成后返回父任务并重新取证；普通详情入口没有外层 flow 时也遵守同一返回合同。嵌套更新完成不清除仍有剩余目标的外层批量草稿。来源问题优先进入对应恢复入口，不被版本未知的通用重检入口遮蔽。

操作进入结果页前，Controller 必须删除该 flow 的选择、输入、准备、Review 和 Progress 帧。插件安装把原预览锚点更新为插件详情，再追加只读 Result。因此关闭 Result 后先到插件详情，再返回保留 query、来源、焦点实体和滚动位置的原列表。回首页必须把历史重置为唯一根帧。确认前返回会撤销旧 Review ticket，并保留所属 flow 的草稿；再次确认必须重新准备证据。执行后的重试也必须建立新 attempt 并重新读取证据。

状态刷新后，Controller 必须按实体 ID 校验当前路由和逐层恢复的祖先。插件、来源或问题消失时回对应安全列表；来源筛选失效时回同模式的未筛选列表。所有包含插件或来源实体的 route 都遵守该规则。依赖移除阻断页只说明依赖者和返回路径，不提供绕过依赖保护的强制清理入口。

控制台进程由一个 Session Host 持有当前 Controller、进度 feed 和 session epoch。`h` 只清除当前导航 flow、Review ticket、临时进度和草稿，并回到唯一根帧；它保留本次加载的状态 snapshot、来源检查时间和 session cache。`H` 先保护所有草稿，再取消并等待本 session 的只读请求；确认没有写操作后，才销毁旧订阅并用新的 runtime dependencies、进度 feed 和 Controller 读取本地状态。迟到响应必须同时受 session epoch 和 Controller 内的 flow、frame 或 request identity 保护。执行中 `h`/`H` 只覆盖一个待处理导航；Esc 只撤销该导航。只有 succeeded Result 才自动执行待处理导航，且先把结果交给共享 history owner；partial、stale、blocked 或无法确认清理结果都停留在 Result。Session Host 不用取消 signal 中断写操作，也不新增持久状态。正常退出和异常退出都必须在 session reporter 仍绑定时封闭新入口，等待现有写操作，再取消并等待只读请求，最后释放 Controller。

范围清单重查使用同一会话的 Catalog 快照。若当前 Active generation 或来源配置已变化，保留旧结果及查询、焦点、滚动和选择状态，明确提示按 `H` 重新加载；清单、详情、内容和设置定义不得混用新旧快照。恢复和退役的准备阶段把取消信号传至来源探测、Native 读取、Portable 准备及 renderer；取消向上传播 `AbortError` 并释放操作 context，不继续准备后续组。准备信号不保留给已确认的写入。

会话导航待办只保存 `h/H` 意图，不授权丢弃草稿。写入成功后，SessionHost 等待本次操作消费的外部草稿清理，再检查剩余草稿；外部草稿确认绑定内存中的 owner、flow 和 revision。失败或部分成功取消待办并保留结果。历史、诊断和报告是会话级只读页面，不依赖业务状态加载成功，也不因关闭页面而丢弃父流程草稿。返回首页统一复位路由和界面焦点。

下载方式和风险确认层遵守同一局部返回规则：Esc 或 `b` 恢复原上下文；`h`、`H`、`q` 和 Ctrl-C 都通过草稿守卫。有草稿时 Ctrl-C 与 `q` 使用同一退出确认；写入进行中仍等待完成后退出。输入框保留普通字符语义。历史、诊断和报告为会话级只读页面，不依赖业务加载成功，也不因关闭页面丢弃父流程草稿。

## 诊断与脱敏

TUI 在 Controller/ViewModel 层把现有 source、status target、dependency、config 和 Portable blocker 状态投影为统一诊断。该投影只存在于当前进程，不新增诊断数据库、持久状态或 统一状态 字段。产品层必须说明发生的情况、受阻或降级的能力、保留的安装或设置，以及下一步恢复动作；Active snapshot 正常、缺失和损坏必须使用不同影响与恢复动作。

技术层只接受白名单结构字段：安全错误 code、可选 stage、sourceId、requestedRef、resolvedCommit、lastSync 证据，以及有限的 platform、scope、plugin、dependency、field、freshness 或 compatibility context。技术层在显示前再次执行通用凭据脱敏、URL userinfo 和敏感 query 清理、已知 home、cwd、临时目录和来源路径替换，并截断文本。任意 native stderr、未知 `Error.cause`、内部绝对路径、digest、credential 或未证明安全的 status message 不进入诊断 ViewModel；不能证明 cause 安全时省略 cause，只保留 code、stage 和白名单 context。

操作结果诊断在 CLI/runtime 服务边界抽取可信 code、stage、target、exitCode 和已知 cause，再进入 TUI 私有投影；原始异常和返回结果不进入公开历史或报告，未知异常正文、任意 stderr 和未知 cause 不进入公共 snapshot。统一诊断按操作类型适配返回结果与安全异常：

- 来源变更操作（`catalogGeneration`）：分别保留配置提交、Catalog 启用与主来源切换事实。配置保存后启用失败（`partialReason: 'activation'`）保留已提交配置；Catalog 已启用但主来源切换失败（`partialReason: 'primary'`）保留有效 generation 和 `awWrite: 'completed'`、`finalVerification: 'completed'`，明确主来源未改变，绝不简化为全部失败或配置未生效。
- 插件写入与配置应用：分别记录配置提交、AW 写入、preApply 外部影响和最终复核，配置提交后的 apply/status 失败仍显示已保存；preApply 开始后失败时，本目标 AW 写入尚未开始，但外部影响只能标为可能存在。
- 处理现存 `portableInstall` 回执时：现有诊断投影 helper 继续接受该回执，保留安装失败、验证失败和缺失 Skill 事实；失败回执即使缺少完整验证对象或产生 CLI 验证失败，最终验证保留为 `unknown`，未确认不得报验证完成。该规则仅描述现有诊断 helper 的回执处理契约，不表示或恢复独立 Portable TUI 安装入口。

SessionHost 持有最多 20 条安全内存记录并跨会话重载复用，记录 ID 绑定 session epoch 和 operation ID；公共 snapshot 只包含小摘要和记录 ID。单次诊断正文最多 256 KiB 或 1000 行，截断必须明确标记。完整正文与短摘要共用脱敏规则，但不先按短摘要的 240 字符限额删除尾部；详情、技术信息和报告按终端显示宽度换行，再按显示行分页，CJK 和长行尾部仍可阅读。安全报告先预览，再由用户显式保存到本地唯一文件；不自动上传，也不建立持久诊断状态或改变 Receipt、Status JSON schema。

## 能力覆盖

本表用于新增或修改消费能力时核对入口和失败恢复。每项精确条件由上面的当前主题定义；新增路由同时接入生产路由定义、渲染、实体失效处理和按键合同。

| 用户任务 | CLI 能力 | TUI 入口与当前定义 |
| --- | --- | --- |
| 添加一个或多个插件 | `plugin install` | 插件详情或插件库多选 → 需求范围 → 操作汇总 → 结果；见[安装与批量目标](#安装与批量目标)。 |
| 同步、重建、移除、普通清理 | `plugin sync`、`sync --rebuild`、`remove`、`cleanup` | 详情常用动作或精确平台维护；见[安装与批量目标](#安装与批量目标)。 |
| 按完整清单同步或同步勾选根 | `plugin sync --context user\|project` | 首页 → 插件清单 → 同步全部或所选；见[清单与位置状态](#清单与位置状态)及[确认与结果](#确认与结果)。 |
| 查看个人或项目完整清单 | `plugin intent list`、`plugin status --context` | 首页 → 插件清单；targets 为空仍显示需求，见[清单与位置状态](#清单与位置状态)。 |
| 设置本机 Agent 或插件排除 | `plugin targets set` | 首页 → Agent 管理；详情中的入口只对直接需求开放。见[安装与批量目标](#安装与批量目标)。 |
| 停用已删除插件 | `plugin intent retire --scope` | 健康 Active 已删除 root 的独立退出管理入口；见[清单与位置状态](#清单与位置状态)，精确删除合同见[生命周期](lifecycle.md#停用已从-catalog-移除的插件)。 |
| 处理受阻、未确认或修复当前 scope | 精确 selector 的 `plugin sync` 或 `sync --rebuild` | 清单或问题 → 安全处理动作；见[清单与位置状态](#清单与位置状态)及[确认与结果](#确认与结果)。 |
| 更新一个或多个插件 | `plugin sync` | 可更新筛选、详情“更新到 X”或恢复任务；来源切换与插件升级分开确认，见[来源与插件更新](#来源与插件更新)。 |
| 手动批量维护与范围调整 | 多 selector | 插件库 `m` → 选择工具 → 查看全部已选 → 操作汇总；见[安装与批量目标](#安装与批量目标)。 |
| 按实际位置筛选 | `plugin status` | 插件列表 `f`；见[浏览与完整阅读](#浏览与完整阅读)。 |
| 批量部分失败和共享依赖 | 精确 selector 的新写入 | 结果 → 仅处理剩余项 → 新确认；见[确认与结果](#确认与结果)。 |
| 查看关系与移除影响 | dependency overview | 插件详情 → 依赖关系 → 统一详情或 Reader；见[依赖关系](#依赖关系)。 |
| 查看、编辑设置和有序列表 | `plugin config`、`config set --platform` | Tab 选择 profile，左右选择分组；见[设置保存与应用](#设置保存与应用)。 |
| 选择引用值、unset、reset、保存后应用 | `plugin config … --apply`、`unset`、`reset` | 字段编辑、设置选项或保存提示；见[设置保存与应用](#设置保存与应用)。 |
| 来源检查、编辑与修复 | `catalog source …` | 插件来源 → 详情、编辑或完整草稿；见[来源与插件更新](#来源与插件更新)。 |
| Catalog Store | `catalog store status/prune` | Store 页面 → 精确预览 → 显式确认；见[来源与插件更新](#来源与插件更新)。 |
| 状态、诊断、操作记录和报告 | `plugin status`、安全诊断 | 问题详情、更多操作或帮助 → 操作记录 → 详情、报告预览与显式保存；见[诊断与脱敏](#诊断与脱敏)。 |
| 安装前脚本超时 | `--script-timeout` | 会运行脚本的单插件、批量或 apply 操作汇总 → 高级选项；改值重新准备，执行只用确认值，见 [preApply](lifecycle.md#preapply)。 |
| 受限 ownership 修复 | `plugin cleanup --force` | 单目标受限清理检查 → 新确认；见[受限 force cleanup](lifecycle.md#受限-force-cleanup)。 |
| 插件托管命令及包变化 | 插件写入、`config … --apply` | 设置编辑保留 custom-managed 分支；见[确认与结果](#确认与结果)。 |

### 明确保留的 CLI 范围

| 范围 | 原因 |
| --- | --- |
| JSON、stdin 精确值、debug、日志路径、非交互授权和自动化参数 | 机器接口；TUI 不模拟输出模式。 |
| 任意目录 Skill materialize、validate 和 Eval | 作者工具；不属于向 Agent 安装插件的消费流程。 |
| `review inspect` 和 `review prepare` | 作者审核工具，由 CLI 和 Review Skill 编排；不复用 TUI 安装的准备、确认或进度流程。 |
| 插件 init、add-skill、validate、test、build、requirements | 单插件作者工作区由开发技能调用 CLI。 |
| Catalog Workspace、开发来源、Catalog 发布、单插件作者流程和 CLI npm 发布 | 作者及发布流程继续由开发技能和 CLI 承担。 |
| `command install/update/remove/list/show/run` 与 `command package sync/remove` | 工具目录托管、透明进程调用和独立包维护通过 CLI 提供；插件安装及 apply 中的命令变化仍在现有 Review、Progress、Result 展示。 |
| 自描述和任意文件维护 | TUI 不复制机器输出或任意文件操作接口。 |

## 实现与验证入口

[`controller.ts`](../../../packages/cli/src/tui/controller.ts) 维护动作、证据与公开 snapshot；[`controller-runtime.ts`](../../../packages/cli/src/tui/controller-runtime.ts) 连接已有后端服务。[`console-app-v4.tsx`](../../../packages/cli/src/tui/console-app-v4.tsx) 处理生产页面、动作与键盘，[`router.ts`](../../../packages/cli/src/tui/router.ts) 维护 route/flow；[`session-host.ts`](../../../packages/cli/src/tui/session-host.ts) 管理重载、退出和 epoch。[`reader.tsx`](../../../packages/cli/src/tui/reader.tsx) 负责换行分页，[`diagnostic-projection.ts`](../../../packages/cli/src/tui/diagnostic-projection.ts) 和 [`diagnostics.ts`](../../../packages/cli/src/tui/diagnostics.ts) 定义安全诊断投影。

修改测试或选择验证命令前读取[测试指南与 Test Value Gate](../testing.md)。测试通过真实 Controller、runtime 和 Ink 入口观察行为，不读取本文或源码字符串锁定文案。相关入口：

- [`tui-plugin-updates-v7.test.tsx`](../../../packages/cli/tests/unit/tui-plugin-updates-v7.test.tsx)
- [`tui-plugin-write-task-v7.test.tsx`](../../../packages/cli/tests/unit/tui-plugin-write-task-v7.test.tsx)
- [`tui-plugin-write-task-backend.test.ts`](../../../packages/cli/tests/unit/tui-plugin-write-task-backend.test.ts)
- [`rebuild-task-command.test.ts`](../../../packages/cli/tests/unit/rebuild-task-command.test.ts)
- [`tui-dependency-graph-v7.test.tsx`](../../../packages/cli/tests/unit/tui-dependency-graph-v7.test.tsx)
- [`tui-config-experience-v7.test.tsx`](../../../packages/cli/tests/unit/tui-config-experience-v7.test.tsx)
- [`tui-console-app-v5-navigation.test.tsx`](../../../packages/cli/tests/unit/tui-console-app-v5-navigation.test.tsx)
- [`tui-console-app-v5-batch.test.tsx`](../../../packages/cli/tests/unit/tui-console-app-v5-batch.test.tsx)
- [`tui-console-app-v5-operations.test.tsx`](../../../packages/cli/tests/unit/tui-console-app-v5-operations.test.tsx)
- [`tui-route-registry-v7.test.ts`](../../../packages/cli/tests/unit/tui-route-registry-v7.test.ts)
- [`tui-scoped-inventory.test.tsx`](../../../packages/cli/tests/unit/tui-scoped-inventory.test.tsx)

[`scripts/test/tui-pty.py`](../../../scripts/test/tui-pty.py) 提供 scoped-inventory 等真实终端场景。单元、PTY 和静态检查分别报告其范围，不替代真实客户端验证。
