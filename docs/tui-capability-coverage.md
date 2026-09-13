# CLI 与 TUI 能力覆盖

本表记录当前 TUI 的用户任务、确认边界和恢复路径。TUI 调用 CLI 的规划、来源、配置和写入服务，不循环启动 CLI 子进程；不同来源可部分成功，不承诺跨来源回滚。详细状态和安全合同见[架构说明](architecture.md)。

## 插件消费

| 用户任务 | CLI 能力 | TUI 入口、确认和恢复 |
| --- | --- | --- |
| 添加一个或多个插件 | `install` | 添加插件 → 预览 → 位置/平台 → 操作汇总 → 结果。多选添加共用新安装的位置和平台；依赖会自动安排合适位置，并在操作汇总中显示。 |
| 同步、重装、移除和普通清理 | `sync`、`reinstall`、`uninstall`、`cleanup` | 我的插件 → 插件详情 → 更多操作 → 目标选择与确认。来源不可用时仍保留普通离线清理。 |
| 按项目清单准备 | `sync --all --scope project` | 我的插件 → 按项目清单准备，或快捷键 `a`。操作汇总保存当前项目的根集合，允许准备尚未安装的根；不新增个人启用意图，被共用的内容与版本影响仍需确认。 |
| 修复当前项目或所选异常插件 | 精确 selector 的 `sync` 或 `reinstall` | 我的插件或需要处理 → 修复异常。任务保留既有 `(pluginId, platform, scope)`；同一根因合并为一次修复及其受影响根插件。证据不足、版本已变或需要手动处理的目标不自动执行。 |
| 处理受阻修复项 | 设置、来源、状态检查和精确维护 | 恢复任务 → 对应问题的处理入口。版本改变需明确选择更新并重新显示操作汇总；无法确认版本时可重新检查和查看诊断。可执行子集完成后，剩余目标继续提供处理入口，不自动升级或删除。 |
| 更新一个或多个插件 | `sync` | 已安装列表的可更新筛选、插件详情的“更新到 X”或恢复任务。只有已验证的 Active 或 session 候选清单、严格版本比较和 capability 兼容都成立时才显示目标版本；Catalog 版本本身不构成插件更新。候选需要启用时，先确认来源切换，再重新规划并确认精确插件更新。 |
| 手动批量维护 | 多个 selector | 已安装列表 → 选择多个或更多操作。手动批次固定一种 action；`selected` 使用共同 scope 和平台，`targets` 沿用各自的精确 scope 和单个平台。更新和恢复任务复用已存在的精确目标，不把失败目标扩张为统一范围。 |
| 调整批量选择 | 会话内选择与操作汇总 | 选择多个 → 选择工具 → 查看全部已选。插件行显示用途和版本，工具行不显示复选标记。失效或消失项仍可逐项取消；继续及最终准备都会检查选择资格。维护的“修改处理范围”只删减或恢复本次已有位置，并重新显示操作汇总；初次安装分别选择范围和工具。窄屏保留显式继续动作，`c` 仅作加速键。 |
| 批量部分失败 | 精确 selector 的新写入 | 结果 → 仅处理剩余项 → 新确认。只从失败 requested target，或失败依赖的 `requiredBy` 根计算新的精确目标；无法定位时只保留诊断。重试重新读取状态、Intent、Catalog 和依赖，并显示新的操作汇总。 |
| 被共用的依赖和平台输出 | 依赖计划与 rebuild | 同一来源的恢复或更新任务以一次 typed write 处理全部根目标；被共用的依赖和平台输出只处理一次，并保留非本次目标的有效动态输出。不同来源独立执行。 |
| 查看关系与移除影响 | 依赖 overview | 插件详情 → 查看关系。正向显示声明的依赖；反向显示本次检查中具有现场位置、所需依赖当前可用且同时满足依赖声明的插件。检查范围只含当前项目和个人位置，其他项目未检查；有声明但本次尚未确认依赖可用的关系仍可阅读。内部 `availablePlacementReferences` 只由 Status v8 的 `ready` 依赖和现场 consumer 证据生成；它不是历史已应用绑定，也不改变现有移除或清理保护。 |
| 查看和修改设置 | `config`、`config set`、`--preset` | 插件设置先显示实际 effective 值和来源；选择字段后显式选择 user 或 project 写入层。支持标量、对象属性和 Manifest 声明的预设；仅 user 字段不会在 project 层提供编辑。 |
| 保存、应用、unset 和 reset 设置 | `config … --apply`、`config unset`、`config reset` | 保存汇总只列 config impact 分析返回的实际 target。已确认无消费者时只保存；范围未知时明确说明并允许仅保存或重查；检查报错时只提供重查或返回。apply 失败后设置仍已保存，重新应用需要新确认。无来源或 schema 时可从已保存设置进入精确整层 reset。 |
| 修复或管理来源 | `catalog source …` | 插件来源 → 详情、编辑或完整草稿。检查是只读，不启用候选；添加、更新、设主、移除和来源切换各自显示操作汇总。设置页中的来源修复返回原草稿并重新验证，绝不自动提交。 |
| 安装通用 Skills | `skill install` | 插件预览或详情 → 通用 Skills → Skill、Agent、scope → 确认与结果。 |
| 状态、诊断和操作记录 | `status`、安全诊断 | 需要处理、更多操作或帮助 → 操作记录 → 详情、报告预览与显式保存。记录只在当前控制台进程内保存最近 20 条，并跨会话重载复用；不建立持久诊断状态。 |
| 调整安装前脚本超时 | `--script-timeout` | 会运行脚本的单插件、批量和设置 apply 操作汇总 → 高级选项。改值后重新准备票据，执行只使用确认的值。 |
| 有限所有权修复 | `cleanup --force` | 单目标受限清理检查 → 新确认。必须有唯一、精确、非空的专属内容证据；没有批量 force cleanup，也不能绕过依赖、非插件内容或被共用内容的保护。 |

## 会话、确认和结果

所有写任务先经过准备 → 操作汇总 → 进度 → 结果。准备只采集证据；只有显式“刷新并同步”会先更新可重建的 Active 弱状态。来源启用成功与插件更新成功是两个结果，前者不会宣称插件已经升级。

完整操作汇总与技术详情分别分页。需要额外授权时，主动作打开独立风险确认层，默认返回检查；普通操作不增加第二次确认。Esc 关闭确认层并保留原汇总，旧操作汇总失效后必须重新准备，连按输入不能重复执行。

无分歧的恢复任务自动进入只读准备和一次影响操作汇总；可信且完整的推荐更新也直接进入操作汇总，并允许在本次插件集合内调整后重新取证。取消或返回后不会自动重新进入。需要决定的目标保留具体处理入口。依赖节点详情返回时恢复当前会话中对应根和方向的展开、焦点与滚动位置。

`h` 回唯一首页并保留当前状态快照；`H` 在保护草稿且安全结束读操作后重建会话。它们不安装插件、不清理磁盘，也不自动启用 Catalog 候选。草稿存在时，`q` 和 Ctrl-C 显示相同的退出确认；下载方式和风险确认层中的 Ctrl-C 也回到父草稿守卫。失败、部分成功或未确认的结果停留在结果页。完成流程的选择、准备、确认和进度页不留在可返回历史；显式重试总是新的准备和操作汇总。

## 明确保留的 CLI 范围

| 范围 | 原因 |
| --- | --- |
| JSON、stdin 精确值、debug、日志路径、非交互授权和自动化参数 | 这些是机器接口，TUI 不模拟其输出模式。 |
| `sync --all --scope user` 一键恢复 | 当前 TUI 提供用户选择既有个人目标的批量维护；不提供独立的个人全量一键入口。 |
| 任意目录的 Skill materialize、validate 和 Eval | 它们属于作者工具，不是向 Agent 安装插件的消费流程。 |
| `review inspect`、`review prepare` 和 Review 报告归档 | 它们属于作者审核工具，由 CLI 和 Review Skill 编排；不复用 TUI 安装操作的准备、确认或进度流程。 |
| 插件 init、add-skill、validate、test、build、requirements | 不建设单插件作者工作区；开发技能调用 CLI。 |
| Catalog Store | TUI 提供只读概览、保留规则、精确预览和显式确认清理。实际删除复用 CLI 的安全清理服务、AW_HOME 写锁和逐项复核。 |
| Catalog Workspace、开发来源、Catalog 发布、单插件作者流程和 CLI npm 发布 | 这些是作者和发布流程，继续由开发技能和 CLI 承担；TUI 不提供这些入口。 |
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
- `packages/cli/tests/unit/tui-console-app-v5.test.tsx` 与 `packages/cli/tests/unit/tui-route-registry-v7.test.ts`

新增或改变消费能力时，必须更新本表，说明 TUI 入口和失败恢复路径，或说明保留 CLI 的理由。新增 TUI 路由必须同时接入生产路由定义、渲染、实体失效处理和按键合同。
