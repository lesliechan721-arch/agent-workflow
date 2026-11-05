# CLI 与 TUI 能力覆盖

本表记录当前 TUI 的用户任务、确认边界和恢复路径。TUI 调用 CLI 的规划、来源、配置和写入服务，不循环启动 CLI 子进程；不同来源可部分成功，不承诺跨来源回滚。详细状态和安全合同见[架构说明](architecture.md)。

## 插件消费

| 用户任务 | CLI 能力 | TUI 入口、确认和恢复 |
| --- | --- | --- |
| 添加一个或多个插件 | `aw plugin install` | 插件详情 → 添加插件 → 需求范围 → 操作汇总 → 结果。目标使用唯一本机 Agent 选择，只选择所有项目或当前项目；完整依赖闭包自动安排位置，不提供依赖 scope 覆盖。空 targets 禁用单项和批量安装并引导独立 Agent 管理，配置后重新发起安装。 |
| 同步、重装、移除和普通清理 | `aw plugin sync`、`sync --rebuild`、`remove`、`cleanup` | 插件详情的常用动作或精确维护入口。同步按 context 联合处理用户及当前项目，移除和清理按显式 scope；来源不可用仍保留安全离线清理。 |
| 按当前清单准备 | `aw plugin sync --context user|project` | 首页 → 插件清单 → 同步。项目 context 读取完整用户和当前项目需求；筛选不缩小完整闭包。操作汇总按插件、Agent和位置说明新增、同步、移除及跳过原因；共享影响另行确认。失败保留已保存需求和成功输出，剩余目标可重新准备。 |
| 查看个人或项目完整清单 | `aw plugin intent list`、`aw plugin status --context` | 首页 → 插件清单。即使 targets 为空也显示已有需求；合并范围徽标与 Agent 状态，未知不当未安装。插件详情用连续状态表显示实际位置和版本，技术路径按需阅读。 |
| 设置本机 Agent | `aw plugin targets set` | 首页 → Agent 管理。七 Agent 选择只写一份本机策略；保存菜单和 s 等价，成功后默认询问同步，Esc 仅保留保存。插件详情中的 Agent 管理仅对直接需求开放，编辑该插件的排除。必需依赖排除不可保存；目录冲突可保存，但同步阻止冲突组合并显示影响插件和目录依据。 |
| 整体清理已删除插件 | `aw plugin intent retire --scope` | 健康 Active 已删除的 root 提供独立退出管理入口。操作汇总说明需求、共享输出及残留；默认保留配置，明确选择删除配置时删除该插件全部本机 common/平台值。失败保留可重试的残留。 |
| 处理当前 scope 受阻或未确认位置 | 来源管理、插件详情与安全诊断 | 插件清单 → 统一插件详情或对应问题 → 已有安全处理动作。来源、配置和输出冲突分别沿问题动作处理，不把所有受阻项都引向来源。未确认位置及无效或不可读的当前范围声明提供安全详情和重新检查；当前 scope 重新检查不自动安装、恢复或清理 foreign 内容。返回后可继续查看剩余位置。 |
| 修复当前 scope 或所选异常插件 | 精确 selector 的 `aw plugin sync` 或 `sync --rebuild` | 清单中勾选 root 后用“同步所选插件”发起精确同步；`c` 对当前 scope 全部声明发起同步。准备、Review、进度和结果沿同一 coordinator，Review 取消不写入。结果以实际回执显示变更；带诊断的未确认目标仍可只读重查，只有可靠缺失且失败或部分完成的精确 plugin/Agent pair 可重新准备，冲突和未知不会变成重试。插件维护入口也进入同一流程。项目 context 联合计划用户与当前项目，精确清理仍保留 scope 边界。 |
| 插件托管命令与包变化 | 插件写入、`config … --apply` | 现有设置编辑支持 custom-managed 分支；安装/配置 Review 展示 producer、固定参数、共享影响、权限与沙箱例外，Progress/Result 同时投影 commandResults 和平台结果。平台卸载报告保留的共享包及显式移除入口。 |
| 处理受阻修复项 | 设置、来源、状态检查和精确维护 | 恢复任务 → 对应问题的处理入口。版本改变需明确选择更新并重新显示操作汇总；无法确认版本时可重新检查和查看诊断。可执行子集完成后，剩余目标继续提供处理入口，不自动升级或删除。 |
| 更新一个或多个插件 | `sync` | 插件库的可更新筛选、插件详情的“更新到 X”或恢复任务。只有已验证的 Active 或 session 候选清单、严格版本比较和 capability 兼容都成立时才显示目标版本；Catalog 版本本身不构成插件更新。候选需要启用时，先确认来源切换，再重新规划并确认精确插件更新。 |
| 手动批量维护 | 多个 selector | 插件库 → 选择多个插件（`m`）。批量添加只选需求范围，并按唯一本机 Agent 策略准备联合恢复。维护批次固定一种 action，沿用每个已选目标的精确 scope 和平台；更新和恢复任务复用既有目标，不把失败目标扩张为统一范围。 |
| 按安装位置筛选 | `status` 的实际安装目标 | 插件列表 `f` 在同一来源、query 和快照中轮转非零候选；当前项目匹配 project 安装，所有项目匹配 user 安装，未知不算未安装。当前筛选变零仍保留上下文，离开后才隐藏；筛选不改变已选集合。 |
| 调整批量选择 | 会话内选择与操作汇总 | 插件库原位多选（`m`）→ 选择工具 → 查看全部已选。插件行显示用途和版本，工具行不显示复选标记。失效或消失项仍可逐项取消；继续及最终准备都会检查选择资格。维护的“修改处理范围”只删减或恢复本次已有位置，并重新显示操作汇总；初次安装只选择需求范围，Agent 使用本机策略。窄屏保留显式继续动作，`c` 仅作加速键。 |
| 批量部分失败 | 精确 selector 的新写入 | 结果 → 仅处理剩余项 → 新确认。只从失败 requested target，或失败依赖的 `requiredBy` 根计算新的精确目标；无法定位时只保留诊断。重试重新读取状态、Intent、Catalog 和依赖，并显示新的操作汇总。 |
| 被共用的依赖和平台输出 | 依赖计划与 rebuild | 同一来源的恢复或更新任务以一次 typed write 处理全部根目标；被共用的依赖和平台输出只处理一次，并保留非本次目标的有效动态输出。不同来源独立执行。 |
| 查看关系与移除影响 | 依赖 overview | 插件详情 → 依赖关系。任一方向有已知边才提供入口；正反向图同时保留已知声明和已验证关系，边证据与节点状态分别显示。Enter 打开统一插件详情，返回保留图中上下文；完整引用使用公共 Reader。检查范围只含当前项目和个人位置，其他项目未检查；有声明但本次尚未确认依赖可用的关系仍可阅读。内部 `availablePlacementReferences` 只由 Status v8 的 `ready` 依赖和现场 consumer 证据生成；它不是历史已应用绑定，也不改变现有移除或清理保护。 |
| 查看和修改设置 | `aw plugin config`、`config set`、`--platform` | 插件设置用 Tab 选择通用或 Agent profile，分组用左右键；各 profile 独立保留草稿。值仅写用户 Store v6，项目 context 只决定来源和已有输出范围。字段按当前编译 schema 编辑，实际值、来源、待保存与无效状态分别显示。 |
| 编辑有序配置列表 | `config set` 的完整 JSON 数组 | 数组编辑器本地增删改排，使用进入编辑前选定的 profile，不再选择 user/project 值层。完整列表通过 Core 校验后保存；取消元素保留其它草稿。128 项、262144 字节和对象 32 属性限制保持，不按索引写盘。 |
| 选择引用配置值 | `valueRef` 与同平台候选校验 | 候选来自当前 profile 的有效来源配置，同一 profile 已确认草稿可使用；跨 profile 未保存来源须先保存。无候选、失效原值或来源无效时显示原因并允许返回修复；普通保存保护此前有效的未安装 consumer 引用。 |
| 保存、应用、unset 和 reset 设置 | `aw plugin config … --apply`、`unset`、`reset` | 保存菜单或 s 先校验并直接保存，成功后弹窗默认更新插件；Esc 仅保留保存。更新进入已有输出的 Review，不新增 Intent、targets 或缺失安装。apply 失败保留已保存值。u 恢复默认值仅清当前 profile 覆盖，危险动作为红色；字段 unset 可清 stale 值。 |
| 修复或管理来源 | `catalog source …` | 插件来源 → 详情、编辑或完整草稿。统一检查按真实状态选择验证深度，显示处理对象与结果，不启用候选；添加、更新、设主、移除和来源切换各自显示操作汇总。设置页中的来源修复返回原草稿并重新验证，绝不自动提交。 |
| 状态、诊断和操作记录 | `status`、安全诊断 | 问题详情、更多操作或帮助 → 操作记录 → 详情、报告预览与显式保存。长安全详情先按终端宽度换行，再按显示行分页；`←/→` 翻页，`y` 复制完整安全文档，不含终端软换行。记录只在当前控制台进程内保存最近 20 条，并跨会话重载复用；不建立持久诊断状态。 |
| 调整安装前脚本超时 | `--script-timeout` | 会运行脚本的单插件、批量和设置 apply 操作汇总 → 高级选项。改值后重新准备票据，执行只使用确认的值。 |
| 有限所有权修复 | `cleanup --force` | 单目标受限清理检查 → 新确认。必须有唯一、精确、非空的专属内容证据；没有批量 force cleanup，也不能绕过依赖、非插件内容或被共用内容的保护。 |

配置存储统一使用用户 Store v6 的 common 与 platforms。旧格式及历史项目值文件不自动迁移或合并，保留文件和明确恢复诊断。数组能力和存储格式检查在受影响写操作前完成。

## 会话、确认和结果

首页有插件、插件清单、插件来源、Agent 管理四个领域入口，状态各自附在入口卡内，不设重复全局统计。通用页面复用首页、集合列表、实体详情、编辑器、操作流程、完整阅读六类模板；业务路由和权限阶段仍按实际需要保留。

部署写任务先经过准备 → 操作汇总 → 进度 → 结果。Agent 选择和插件设置有独立保存动作，保存后可再确认同步或更新。操作汇总中的四类影响来自准备计划，结果中的四类变更来自执行回执。准备只采集证据；只有显式“刷新并同步”会先更新可重建的 Active 弱状态。来源启用成功与插件更新成功是两个结果，前者不会宣称插件已经升级。

操作汇总优先显示插件、版本和范围，完整影响与技术详情仍可分页；结果先按插件显示，再阅读所属位置和依赖结果。需要额外授权时，主动作打开独立风险确认层，默认返回检查；普通操作不增加第二次确认。Esc 关闭确认层并保留原汇总，旧操作汇总失效后必须重新准备，连按输入不能重复执行。

无分歧的恢复任务自动进入只读准备和一次影响操作汇总；可信且完整的推荐更新也直接进入操作汇总，并允许在本次插件集合内调整后重新取证。取消或返回后不会自动重新进入。需要决定的目标保留具体处理入口。依赖节点详情返回时恢复当前会话中对应根和方向的展开、焦点与滚动位置。

`h` 回唯一首页并保留当前状态快照；`H` 在保护草稿且安全结束读操作后重建会话。它们不安装插件、不清理磁盘，也不自动启用 Catalog 候选。草稿存在时，`q` 和 Ctrl-C 显示相同的退出确认；下载方式和风险确认层中的 Ctrl-C 也回到父草稿守卫。失败、部分成功或未确认的结果停留在结果页。完成流程的选择、准备、确认和进度页不留在可返回历史；显式重试总是新的准备和操作汇总。

## 明确保留的 CLI 范围

| 范围 | 原因 |
| --- | --- |
| JSON、stdin 精确值、debug、日志路径、非交互授权和自动化参数 | 这些是机器接口，TUI 不模拟其输出模式。 |

| 任意目录的 Skill materialize、validate 和 Eval | 它们属于作者工具，不是向 Agent 安装插件的消费流程。 |
| `review inspect` 和 `review prepare` | 它们属于作者审核工具，由 CLI 和 Review Skill 编排；不复用 TUI 安装操作的准备、确认或进度流程。 |
| 插件 init、add-skill、validate、test、build、requirements | 不建设单插件作者工作区；开发技能调用 CLI。 |
| Catalog Store | TUI 提供只读概览、保留规则、精确预览和显式确认清理。实际删除复用 CLI 的安全清理服务、AW_HOME 写锁和逐项复核。 |
| Catalog Workspace、开发来源、Catalog 发布、单插件作者流程和 CLI npm 发布 | 这些是作者和发布流程，继续由开发技能和 CLI 承担；TUI 不提供这些入口。 |
| `command install/update/remove/list/show/run` 与 `command package sync/remove` | 工具目录托管、透明进程调用和独立包维护通过 CLI 提供；不增加命令管理页面。插件安装和配置 apply 中的命令变化继续由现有 Review、Progress、Result 展示。 |
| 自描述和任意文件维护 | TUI 不复制机器输出或任意文件操作接口。 |

## 实现验证索引

测试不读取本文件或源码字符串锁定文案。TUI 行为由真实 Controller、runtime 和 Ink 入口覆盖，重点路径在：

- `packages/cli/tests/unit/tui-plugin-updates-v7.test.tsx`
- `packages/cli/tests/unit/tui-plugin-write-task-v7.test.tsx`
- `packages/cli/tests/unit/tui-plugin-write-task-backend.test.ts`
- `packages/cli/tests/unit/tui-plugin-write-task-runtime.test.ts`
- `packages/cli/tests/unit/rebuild-task-command.test.ts`
- `packages/cli/tests/unit/tui-dependency-graph-v7.test.tsx`
- `packages/cli/tests/unit/tui-config-experience-v7.test.tsx`
- `packages/cli/tests/unit/tui-console-app-v5-*.test.tsx` 中的导航、插件、配置、来源、依赖和操作场景，以及 `packages/cli/tests/unit/tui-route-registry-v7.test.ts`
- `packages/cli/tests/unit/tui-scoped-inventory.test.tsx` 与 `scripts/test/tui-pty.py` 的 scoped-inventory 场景

新增或改变消费能力时，必须更新本表，说明 TUI 入口和失败恢复路径，或说明保留 CLI 的理由。新增 TUI 路由必须同时接入生产路由定义、渲染、实体失效处理和按键合同。
