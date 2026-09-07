# CLI 与 TUI 能力覆盖

本表记录当前 TUI 的用户任务、确认边界和恢复路径。TUI 调用 CLI 的规划、来源、配置和写入服务，不循环启动 CLI 子进程；不同来源可部分成功，不承诺跨来源回滚。详细状态和安全合同见[架构说明](architecture.md)。

## 插件消费

| 用户任务 | CLI 能力 | TUI 入口、确认和恢复 |
| --- | --- | --- |
| 添加一个或多个插件 | `install` | 添加插件 → 预览 → 位置/平台 → 确认 → 结果。多选添加共用新安装的位置和平台；依赖由计划生成，不伪装成用户选择。 |
| 同步、重装、移除和普通清理 | `sync`、`reinstall`、`uninstall`、`cleanup` | 我的插件 → 插件详情 → 更多操作 → 目标选择与确认。来源不可用时仍保留普通离线清理。 |
| 恢复当前项目或所选异常插件 | 精确 selector 的 `sync` 或 `reinstall` | 我的插件或需要处理 → 恢复。任务保留既有 `(pluginId, platform, scope)`；同一根因合并为一次修复及其受影响根插件。证据不足、版本已变或需要手动处理的目标不自动执行。 |
| 更新一个或多个插件 | `sync` | 已安装列表的可更新筛选、插件详情的“更新到 X”或恢复任务。只有已验证的 Active 或 session 候选清单、严格版本比较和 capability 兼容都成立时才显示目标版本；Catalog 版本本身不构成插件更新。候选需要启用时，先确认来源切换，再重新规划并确认精确插件更新。 |
| 手动批量维护 | 多个 selector | 已安装列表 → 选择多个或更多操作。手动批次固定一种 action、共同 scope 和平台；更新和恢复任务复用已存在的精确目标，不把失败目标扩张为统一范围。 |
| 批量部分失败 | 精确 selector 的新写入 | 结果 → 仅处理剩余项 → 新确认。只从失败 requested target，或失败依赖的 `requiredBy` 根计算新的精确目标；无法定位时只保留诊断。重试重新读取状态、Intent、Catalog 和依赖，不复用旧 Review。 |
| 共享依赖和 native 输出 | 依赖计划与 rebuild | 同一来源的恢复或更新任务以一次 typed write 处理全部根目标；共享依赖和 native projection 只处理一次，并保留非本次目标的有效动态输出。不同来源独立执行。 |
| 查看关系与移除影响 | 依赖 overview | 插件详情 → 查看关系。正向显示声明依赖，反向只显示实际 placement reference；已声明但未安装的使用者标为未知。图不由 depth 推断边；无效图显示 blocker，不提供已安装依赖迁移或绕过依赖保护。 |
| 查看和修改设置 | `config`、`config set`、`--preset` | 插件设置先显示实际 effective 值和来源；选择字段后显式选择 user 或 project 写入层。支持标量、对象属性和 Manifest 声明的预设；仅 user 字段不会在 project 层提供编辑。 |
| 保存、应用、unset 和 reset 设置 | `config … --apply`、`config unset`、`config reset` | 保存汇总只列 config impact 分析返回的实际 target。无消费者时只保存；apply 失败后设置仍已保存，重新应用需要新确认。无来源或 schema 时可从已保存设置进入精确整层 reset。 |
| 修复或管理来源 | `catalog source …` | 插件来源 → 详情、编辑或完整草稿。检查是只读，不启用候选；添加、更新、设主、移除和来源切换各自经过 Review。设置页中的来源修复返回原草稿并重新验证，绝不自动提交。 |
| 安装通用 Skills | `skill install` | 插件预览或详情 → 通用 Skills → Skill、Agent、scope → 确认与结果。 |
| 状态、诊断和操作记录 | `status`、安全诊断 | 需要处理、更多操作或帮助 → 操作记录 → 详情、报告预览与显式保存。记录只在当前控制台进程内保存最近 20 条，并跨会话重载复用；不建立持久诊断状态。 |
| 调整安装前脚本超时 | `--script-timeout` | 会运行脚本的单插件、批量和设置 apply Review → 高级选项。改值后重新准备票据，执行只使用确认的值。 |
| 有限所有权修复 | `cleanup --force` | 单目标受限清理检查 → 新确认。必须有唯一、精确、非空的专属内容证据；没有批量 force cleanup，也不能绕过依赖、foreign 或 shared 保护。 |

## Catalog 全生命周期

目录管理只在用户进入该页后读取所选 Workspace、Store、开发来源或发布记录；普通首页和插件来源浏览不扫描这些对象。

| 用户任务 | CLI 能力 | TUI 入口、确认和恢复 |
| --- | --- | --- |
| 选择或创建 Catalog Workspace | `catalog status`、`catalog init` | 插件来源 → 目录管理 → Catalog 工作区 → 选择目录或创建。路径只作为本地草稿；创建进入独立 Review。 |
| 状态、版本、构建和完整验证 | `catalog status/version/build/validate` | Catalog 工作区 → 状态、版本、构建或完整验证。状态和验证只读；版本和构建各自确认。构建只替换已证明为生成物的 `.aw/catalog` 输出。 |
| 开发来源 | `catalog dev activate/status/deactivate` | 目录管理 → 开发来源。snapshot 未就绪时先构建，再单独确认启用；停用保留引用影响和 replacement primary 检查。 |
| 本地 Catalog Store | `catalog store status/prune` | 目录管理 → 本地存储 → 选择可回收项 → 确认 → 实际结果。Review 授权精确 store item；实际 prune 仍在锁内重新检查，结果分别显示 deleted 和 retained。 |
| 准备发布计划 | `catalog publish plan` | 目录管理 → 发布 → remote 或 direct remote URL 与 branch → 独立确认。确认后才写 version-scoped journal 和隔离发布仓库；取消不写 journal。 |
| 应用或恢复计划 | `catalog publish apply` | 发布结果或可信 `prepared`/`uncertain` 记录 → 独立应用确认 → 远端结果。apply 以既有 plan digest 定位 journal，不按当前 metadata 版本重建计划；若 direct remote 未留在 journal，重新输入 remote 或 URL 后由后端核对 identity。pending journal 或 repository 缺失、损坏或不匹配时停止并要求提高 Catalog 版本。 |

## 会话、确认和结果

所有写任务先经过 `ReviewPreparing → Review → Progress → Result`。`ReviewPreparing` 只采集证据；只有显式“刷新并同步”会先更新可重建的 Active 弱状态。来源启用成功与插件更新成功是两个结果，前者不会宣称插件已经升级。

`h` 回唯一首页并保留当前状态快照；`H` 在保护草稿且安全结束读操作后重建会话。它们不安装插件、不清理磁盘，也不自动启用 Catalog 候选。失败、部分成功或未确认的结果停留在结果页。完成流程的选择、准备、确认和进度页不留在可返回历史；显式重试总是新 preparation 和新 Review。

## 明确保留的 CLI 范围

| 范围 | 原因 |
| --- | --- |
| JSON、stdin 精确值、debug、日志路径、非交互授权和自动化参数 | 这些是机器接口，TUI 不模拟其输出模式。 |
| `sync --all --scope user` 一键恢复 | 当前 TUI 提供用户选择既有个人目标的批量维护；不提供独立的个人全量一键入口。 |
| 任意目录的 Skill materialize、validate 和 Eval | 它们属于作者工具，不是向 Agent 安装插件的消费流程。 |
| 插件 init、add-skill、validate、test、build、requirements | 不建设单插件作者工作区；开发技能调用 CLI。 |
| Catalog 插件作者 init/add-skill/test/requirements 和 CLI npm 发布 | TUI 覆盖 Catalog Workspace、Store、开发来源和 Catalog 发布；单插件作者流程及 CLI npm 发布继续由开发技能和 CLI 承担。 |
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
- `packages/cli/tests/unit/tui-catalog-management-v7.test.tsx`
- `packages/cli/tests/unit/tui-catalog-management-backend.test.ts`
- `packages/cli/tests/unit/catalog-store.test.ts` 与 `packages/cli/tests/unit/catalog-publish.test.ts`
- `packages/cli/tests/unit/tui-console-app-v5.test.tsx` 与 `packages/cli/tests/unit/tui-route-registry-v7.test.ts`

新增或改变消费能力时，必须更新本表，说明 TUI 入口和失败恢复路径，或说明保留 CLI 的理由。新增 TUI 路由必须同时接入生产路由定义、渲染、实体失效处理和按键合同。
