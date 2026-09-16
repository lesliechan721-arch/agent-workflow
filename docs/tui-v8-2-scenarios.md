# TUI v8.2 设计场景对照清单

## 使用方式与证据状态

本清单把 v8.2 `page-catalog.csv` 的 156 个 fixture ID 映射到实施的六个阶段。catalog 没有阶段字段；阶段归属是按 [实施记录](tui-v8-2-implementation.md) 的范围和 v8.2 页面族作出的实施映射。每个 ID 只出现一次：阶段 1 有 6 个、阶段 2 有 20 个、阶段 3 有 43 个、阶段 4 有 23 个、阶段 5 有 48 个、阶段 6 有 16 个，总计 156 个。

阶段 1–6 已按当前生产测试复核。这里的“行为已验证”只表示测试实际断言的行为；它不等于该 catalog fixture 的完整验收。“双尺寸”只在同一测试明确运行 80×24 和 60×18 时使用。HTML 原型、原型截图、`layout-validation.json` 和 `interaction-validation.json` 只说明设计参照，**不是生产证据**。

执行结果另见[实施记录](tui-v8-2-implementation.md)：阶段 1–4 checkpoint 为 `73e6cb11`、`9b374adb`、`da0aa01a`、`38b1c3b4`、`0585675f`；记录的最终 Console 为 358/358，controller、session-host 和配置组合为 224/224，`pnpm build` 与 `git diff --check` 退出 0。该结果证明相应套件在当时通过，不把任何总数归因到本表的单个 fixture 或 312 份双尺寸证据。

阶段 5 的 Console 定向套件和阶段 6 的组合套件已分别记录为 358 与 447/447、退出 0。最终集成门禁为 499 项集成及 3 项进程生命周期测试，全部通过。首轮旧导航断言已按原安全目的迁移，最终评审发现的 UI 阅读、配置结果与诊断问题已修复并定向验证。完整单元门禁 2,979 通过、2 跳过，真实 PTY 的 80×24 22 帧及 60×18 23 帧均通过，详见实施记录；本表不以总测试数声明 312 项设计状态已逐一验证。

| 标记 | 含义 |
| --- | --- |
| `双尺寸` | 当前生产 Ink 测试以 80×24 和 60×18 覆盖所列行为；仍需 catalog fixture 的独立记录。 |
| `行为` | 当前生产 Ink、控制器或 integration 测试覆盖所列行为，但缺少另一尺寸、完整 fixture，或两者。 |
| `待补验` | 没有与设计状态直接对应的测试证据；相关实现或其他行为测试不能补足。 |
| `待验` | 尚未对其现有证据完成本轮场景复核，或等待最终评审回归回填。 |
| `基线` | 阶段 5–6 表中阶段 1–4 时记录的定位线索，不是对当前生产能力不存在的断言。 |

设计清单来源：`.tmp/agent-workflow-tui-v8-2/page-catalog.csv:2-157`。设计明确说明这 156 项是页面/状态参照，不是 156 个必经用户路径，且每项应有 80×24 与 60×18 的独立参照（`.tmp/agent-workflow-tui-v8-2/design.md:398-425`）。

## 阶段 1：布局与键盘（6）

**分组行为标准。** 正常尺寸保留页头、内容和 HelpBar；60×18 是最小可用尺寸，较小终端只显示尺寸提示。必要路径使用方向键、Enter、Space、Tab、Esc；长列表可一次 Tab 到固定操作栏；文本输入时不把普通文字当全局快捷键。设计依据：`.tmp/agent-workflow-tui-v8-2/design.md:28-60,337,418-426`。

**已复核生产测试。** `L1` `packages/cli/tests/unit/tui.test.tsx` 的 `renders the ScreenFrame header, content, and footer hierarchy at supported sizes`（80×24、60×18）；`L2` 同文件的 `maps global navigation keys without consuming normal text input` 和 `maps exact session navigation keys without consuming character input`；`L3` `packages/cli/tests/unit/tui-console-app-v5.test.tsx` 的 `moves from the 200th real plugin card to the pinned action bar with one Tab`（60×18）；`L4` 同文件的 `uses G04 when leaving a dirty config layer and can discard its draft`；`L5` `renders only the minimum-size hint and ignores business input below 60x18`。

| 设计 ID | 设计状态 | 生产测试 | 证据状态 |
| --- | --- | --- | --- |
| G01 | 首页 / 正常导航 | L1, L2 | 行为：frame 双尺寸、键盘映射；待补首页导航 fixture。 |
| G09 | 兼容快捷键帮助 | L2 | 行为：全局键不吞输入；待补帮助页及双尺寸。 |
| G10 | 草稿 / 离开守卫 | L4 | 行为：配置草稿离开守卫；待补该全局 fixture 的双尺寸。 |
| G11 | 终端空间不足 | L5 | 行为：低于 60×18 仅尺寸提示且不接受业务输入；待补 60×18 恢复后的 fixture。 |
| P01 | 长列表 / 固定操作栏 | L3 | 行为：205 项列表的固定栏、Tab、四向键和 Enter（60×18）；待补 80×24。 |
| P02 | 第 36 项 / 一次 Tab 到操作栏 | L3 | 行为：第 200 项一次 Tab，覆盖更长列表（60×18）；待补 36 项和 80×24。 |

## 阶段 2：统一库与详情（20）

**分组行为标准。** Browse 与已安装项目共用 canonical `pluginId` 的插件库；来源、查询和安装状态筛选不改变详情身份。详情、内容、依赖和更多操作都属于同一插件路由族；恢复、升级、安装、设置和卸载等常用动作直接可达，手动同步、重装及受限清理等低频维护放在“更多操作”。批量选择保持固定继续栏，并允许返回调整。设计依据：`.tmp/agent-workflow-tui-v8-2/design.md:62-157,337-338`。

**已复核生产测试。** `P1` `packages/cli/tests/unit/tui-console-app-v5.test.tsx` 的 `keeps source tabs out of the vertical focus and searches same-name plugins by canonical identity`；`P2` `distinguishes global, source, query, and update empty plugin lists`；`P3` `keeps four scoped platform conclusions and all detail actions reachable at %ix%i`（80×24、60×18）；`P4` `keeps an installed plugin visible when its source is unavailable`；`P5` `keeps the plugin detail default small and exposes full maintenance through More`；`P6` `shows dependency installation content, opens the single relation route, and keeps a plugin without dependencies on P04`（60×18）；`P7` `reaches the last dependency relation at 60x18`；`P8` `[batch-selection/update-hidden-selected] keeps canonical selections across source and query changes and exposes the complete selected set`（先 60×18，后 80×24）；`P9` `keeps the select-many entry and explicit confirmation reachable at %ix%i`（80×24、60×18）；`P10` `adds only missing exact targets and requires an explicit executable subset choice`；`P11` `opens the recommended update task with exact targets from two roots`；`P12` `keeps a select-many task draft for retry and clears it only when partial work is finished`；`B13` `moves through batch install placement actions in visual order at %ix%i`（80×24、60×18）。

| 设计 ID | 设计状态 | 生产测试 | 证据状态 |
| --- | --- | --- | --- |
| P03 | 来源过滤 / 相同详情 | P1 | 行为：canonical identity 的同名来源搜索；待补同一详情的 catalog fixture 与双尺寸。 |
| P04 | 无搜索结果 | P2 | 行为：全局、来源、查询、更新四类空列表；待补双尺寸。 |
| P05 | 来源选择弹窗 | — | 待补验：未定位来源选择弹窗的生产 Ink 测试。 |
| P06 | 状态筛选弹窗 | P2 | 行为：状态筛选导致的空列表；待补筛选弹窗和双尺寸。 |
| P07 | 未安装插件详情 | P10 | 行为：只添加缺失精确目标；待补未安装详情的独立双尺寸。 |
| P08 | 健康插件 / 完整菜单 | P3, P5 | 行为：详情动作、More 菜单；P3 为双尺寸混合状态，待补健康 fixture。 |
| P09 | 异常和升级同时可见 | P3 | 双尺寸：混合范围、异常和更新状态及详情动作；待补 catalog fixture 记录。 |
| P10 | 来源失效 / 已安装记录保留 | P4 | 行为；待补双尺寸。 |
| P11 | 插件内容清单 / 无教程 | P6 | 行为：内容页可达（60×18）；待补无教程断言及 80×24。 |
| P12 | 统一上下游依赖图 | P6 | 行为：安装内容至单一关系路由（60×18）；待补完整图双尺寸。 |
| P13 | 依赖节点详情 | P7 | 行为：最后关系节点可达（60×18）；待补 80×24。 |
| P14 | 更多操作 / 没有第二个 Skills 入口 | P5 | 行为：More 可达；待补“无第二入口”断言和双尺寸。 |
| B01 | 多选 / 固定继续与隐藏选择 | P8, P9 | 双尺寸：固定确认及隐藏选择集合；待补 catalog fixture 记录。 |
| B02 | 多选工具弹窗 | P8 | 双尺寸：完整已选集合工具；待补设计弹窗 fixture。 |
| B03 | 选择多个 / 零选择反馈 | P9 | 双尺寸：0/1 选择及显式确认；待补 catalog fixture 记录。 |
| B04 | 批量任务选择 | P10 | 行为：精确目标及可执行子集选择；待补双尺寸。 |
| B05 | 批量升级确认 | P11 | 行为：两根的精确升级目标和确认；待补双尺寸。 |
| B06 | 批量原生安装 / 先平台 | `tui-console-app-v5.test.tsx` | 双尺寸：平台页→目标页，Enter/c/固定栏三路径共 6 项；方向键确认菜单保留。 |
| B07 | 批量原生安装 / 再目标 | `tui-console-app-v5.test.tsx` | 双尺寸：目标页→精确目标 Review；Esc 返回保留草稿；固定按钮和 c 共用准备动作。 |
| B08 | 批量部分失败 | P12 | 行为：部分完成后保留草稿并只处理剩余项；待补双尺寸。 |

## 阶段 3：安装、维护与 Portable（43）

**分组行为标准。** 原生流按平台、范围、汇总、必要风险确认、执行和结果推进。维护路径包含同步、重新安装、移除、清理、范围扩展和恢复。Portable 单独选择 Skills、Agent 和范围，不能被表示成第三个原生平台；工具缺失、冲突、敏感配置、验证未知和部分失败必须有明确状态和恢复入口。设计依据：`.tmp/agent-workflow-tui-v8-2/design.md:62-157,338`。

**已复核生产测试。** `N1` `packages/cli/tests/unit/tui-console-app-v5.test.tsx` 的 `shows the scope choice only after a platform is confirmed`（80×24、60×18）；`N2` `selects one legal scope per native platform when no common scope exists at %ix%i`（80×24、60×18）；`N3` `uses Enter for each target and only confirms from the visible confirmation action`；`N4` `invalidates the old Review and binds a first script-timeout value to a new Review`；`N5` `runs the normal install chain through Controller review and execute, then renders a partial result`；`N6` `keeps accepted Progress non-cancellable by Esc`（80×24）；`N7` `selects actual installed locations before uninstall Review and keeps settings`；`N8` `returns a successful single-plugin %s task to stable detail with a notice` 和 `returns a successful one-plugin multi-location uninstall batch to stable detail`；`N9` `does not expose force cleanup from a dependency removal blocker`（60×18）；`B13` `moves through batch install placement actions in visual order at %ix%i`（80×24、60×18）；`U1` `packages/cli/tests/unit/tui-portable-skills-v1.test.tsx` 的 `uses Space to toggle a Portable Skill and Enter to open its content summary`、`uses the fixed Continue action and c as the same Portable selection confirmation for %s`、`filters selected Portable Skills, clears them, and restores all candidates`、`advertises only the manifest capability before entry, then selects candidates and executes the reviewed subset`；`U2` `renders typed blocker %s as %s with its recovery action`（missing、incompatible、validation-failed 各 case，60×18）；`U3` `renders Agent choice selection independently from focus`；`U4` `validates explicit Agent IDs and preserves the draft when the terminal is too small`（60×18，另测 59×17）；`U5` `renders bounded evidence-derived Portable technical progress at $columns x $rows`（80×24、60×18）；`U6` `prioritizes a missing Skill and keeps recovery actions visible in a $columns x $rows partial result`（80×24、60×18）；`U7` `renders per-Skill result evidence and hides diagnostics until requested`；`U8` `renders unknown verification for %s` 和 `rechecks an unknown result without running Skills add again`；`U9` `keeps the focused portable Skill and Continue visible at $columns x $rows`（80×24、60×18）；`U10` `packages/cli/tests/integration/portable-skill-commands.test.ts` 的 `installs all candidates by default, reports collisions, and verifies automatic mode`、`reprepares and retries only the exact failed skill and agent pairs`。

| 设计 ID | 设计状态 | 生产测试 | 证据状态 |
| --- | --- | --- | --- |
| N01 | 安装平台 / 新增通用 Skills | U1, N1 | 行为：通用分发由 manifest 能力进入，原生范围在确认平台后显示；待补同页三分支和双尺寸。 |
| N02 | 补充安装 / 同平台页标记已安装 | N1 | 行为：平台确认后进入范围；待补已安装标记和双尺寸。 |
| N03 | 原生安装 / 当前项目或所有项目 | N1 | 双尺寸：确认平台后选择范围；待补 catalog fixture 记录。 |
| N04 | 多平台没有共同范围 | N2 | 双尺寸：无共同范围时逐平台选择。 |
| N05 | 逐平台选择范围 | N2 | 双尺寸：Codex/project、Claude/user 的精确目标进入 Review。 |
| N06 | 安装确认汇总 | N3 | 行为：仅可见确认动作提交；待补双尺寸。 |
| N07 | 风险确认弹窗 | N3 | 行为：最终确认不由前页 Enter 绕过；待补风险 fixture 和双尺寸。 |
| N08 | 旧确认失效 | N4 | 行为：旧 Review 失效并生成新 Review；待补双尺寸。 |
| N09 | 原生安装进度 | N6 | 行为：真实 native install intent 的 Progress 不可由 Esc 取消（80×24）；待补进度内容和 60×18。 |
| N10 | 安装成功 / 同详情页 | N8 | 行为：单插件成功回稳定详情；待补双尺寸。 |
| N11 | 安装部分失败 / 保留结果 | N5 | 行为：正常链路的部分结果与失败重试；待补双尺寸。 |
| N12 | 恢复正常 / 推荐计划汇总 | N8 | 行为：restore 成功回稳定详情；待补推荐计划汇总和双尺寸。 |
| N13 | 升级 / 精确目标汇总 | P11 | 行为：精确升级目标的 Review；待补双尺寸。 |
| N14 | 卸载 / 选择实际位置 | N7 | 行为：按实际安装位置建立卸载 Review；待补双尺寸。 |
| N15 | 卸载确认 / 保留设置 | N7 | 行为：卸载 Review 保留设置；待补双尺寸。 |
| N16 | 卸载失败 / 再提供清理 | `tui-console-app-v5.test.tsx` | 双尺寸：单插件卸载全失败→精确 cleanup Review；混合 partial 逐位置排除 dependencyStillRequired，不提供 force。 |
| U01 | 工具缺失 | U2 | 行为：typed missing blocker 显示“查看安装说明”（60×18）；待补 80×24。 |
| U02 | 工具不兼容 | U2 | 行为：typed incompatible blocker 显示“查看安装说明”（60×18）；待补 80×24。 |
| U03 | 工具准备要求 | U2 | 行为：工具 blocker 有安装说明入口（60×18）；待补说明正文和 80×24。 |
| U04 | Skills 选择 / 零预选 | U1 | 行为：Skills 选择入口；待补零预选不可继续和双尺寸。 |
| U05 | Skills 选择 / 多项已选 | U1 | 行为：选择候选并执行 reviewed subset；待补双尺寸。 |
| U06 | Skills 选择工具 | U1 | 行为：Space 切换与固定继续；待补工具菜单和双尺寸。 |
| U07 | Skill 内容摘要 | U1 | 行为：Enter 打开内容摘要；待补双尺寸。 |
| U08 | Agent 自动或手动选择 | U3 | 行为：Agent 选择独立于焦点；待补双尺寸。 |
| U09 | 手动 Agent ID 输入 | U4 | 行为：输入多个 Agent ID 并保留草稿（60×18）；待补 80×24。 |
| U10 | 手动 Agent / 输入无效 | U4 | 行为：空输入拒绝；待补 80×24。 |
| U11 | 安装范围 / 当前项目或所有项目 | U4 | 行为：手动 Agent 后选择 project/user 范围（60×18）；待补 80×24。 |
| U12 | 只读准备 / 不执行安装 | U1 | 行为：manifest 能力和候选选择在 Review 前完成；待补明确“未执行安装”断言和双尺寸。 |
| U13 | 自动依赖说明 | U5 | 双尺寸：进度显示依赖和候选来源；待补设计 fixture。 |
| U14 | 同名 Skill 冲突 | U10 | 行为：integration 覆盖 collision receipt；待补 TUI 呈现和双尺寸。 |
| U15 | 敏感配置风险阻断 | `tui-portable-skills-v1.test.tsx` | 双尺寸：portableSensitiveOutput 明示敏感值或未解析模板，保留阻断与真实 code。 |
| U16 | 未声明引用阻断 | `tui-portable-skills-v1.test.tsx` | 双尺寸：引用缺失、未解析或无效均阻断；仅按现有 portableRuntimeImportMissing 证据说明，不假称已证明未声明。 |
| U17 | 仅 Skills 安装确认 | U1 | 行为：候选进入 reviewed subset；待补确认文案和双尺寸。 |
| U18 | 所有项目 / 风险确认 | U4 | 行为：所有项目范围进入 Review（60×18）；待补风险确认和 80×24。 |
| U19 | 独立工具执行进度 | U5 | 双尺寸：Portable 的证据化进度与技术详情。 |
| U20 | 成功 / 实际 Agent 与 Skills | U7 | 行为：逐 Skill、Agent 验证结果；待补双尺寸。 |
| U21 | 部分缺失 / 可精确重试 | U6, U10 | 双尺寸：缺失项和恢复操作可见；integration 覆盖精确 Skill/Agent retry。 |
| U22 | 验证未知 / 不能当未安装 | U8 | 行为：未知不显示成功；待补双尺寸。 |
| U23 | 未知结果先复查 | U8 | 行为：复查不再运行 Skills add；待补双尺寸。 |
| U24 | 插件未提供通用分发 | U1 | 行为：仅 manifest 能力可进入；待补无分发状态和双尺寸。 |
| U25 | 长 Skills 列表 / 固定继续 | U9 | 双尺寸：焦点 Skill 与 Continue 始终可见。 |
| U26 | 零选择不能继续 | U1 | 行为：清到 0 后提示至少选择一个 Skill（80×24）；待补 60×18。 |
| U27 | 安装分发定义不可用 | U2 | 行为：typed validation-failed blocker 可恢复（60×18）；待补真实分发定义不可用链路和 80×24。 |

## 阶段 4：配置（23）

**分组行为标准。** 流程是值、保存目标、分组总览、保存或保存并应用。显示有效值和字段来源，支持布尔、数字、文字、文件、目录、敏感和对象值；敏感值只可保存到个人层。离开草稿、层 reset、来源定义不可用和部分失败必须保留可理解状态。设计依据：`.tmp/agent-workflow-tui-v8-2/design.md:278-297,396-425`、`.tmp/agent-workflow-tui-v8-1/design.md:300-374`。

**已复核生产测试。** `C1` `packages/cli/tests/unit/tui-config-experience-v7.test.tsx` 的 `starts with effective values, edits before choosing an explicit legal destination`；`C2` `keeps a user-only field out of the project destination list`；`C3` `keeps the project target visible in the compact batch save summary`（60×18）；`C4` `submits the explicit apply choice as a project batch` 和 `submits the explicit save-only choice as a project batch`；`C5` `packages/cli/tests/unit/tui-console-app-v5.test.tsx` 的 `uses visible group tabs and edits a focused effective field before selecting its save target`；`C6` `uses preset-first scalar choices and retains invalid Core-validated input`；`C7` `keeps a multi-field config summary and its complete final change reachable at %ix%i`（80×24、60×18）；`C8` `shows a committed config write with one failed target as partial`（60×18）；`C9` `uses G04 when leaving a dirty config layer and can discard its draft`；`C10` `keeps top-level boolean presets closed or open and saves the actual value`；`C11` `renders a %s removal as a redacted inherited change`（secret、path，80×24）；`C12` `edits a mixed fixed and dynamic object from the effective seed and reviews one full top-level update`；`C13` `opens source-missing saved settings only for their recorded reset scope`；`C14` `lists two invalid stores in user-project order and can review either exact reset`；`C15` `packages/cli/tests/unit/tui-config-save-batch-result.test.tsx` 的 `keeps drafts for the same field in two scopes and submits project before user`、`shows each scope result and retries only apply for the saved failed-apply scope`；`C16` `packages/cli/tests/unit/tui-config-save-batch-backend.test.ts` 的 `prepares one redacted review and preserves a successful project write when user fails`、`keeps the saved project layer and refuses to overwrite a user layer changed after it`；`C17` `clears the mounted C12 settings flow for $label and preserves the original Back stack`（preview primary action、detail Esc，80×24）；`C18` `offers invalid-layer reset through Review and keeps its details private at $columns x $rows`（80×24、60×18）；`C19` `keeps one object focus and its add/save actions visible at $columns x $rows`（80×24、60×18）。

| 设计 ID | 设计状态 | 生产测试 | 证据状态 |
| --- | --- | --- | --- |
| C01 | 分组当前值 / 固定保存栏 | C5, C7 | 行为：分组 tabs、字段及保存汇总；C7 双尺寸覆盖汇总，待补固定保存栏 fixture。 |
| C02 | 选择分组 / 基础键回退 | C5 | 行为：可见分组 tabs 和焦点字段；待补基础键回退与双尺寸。 |
| C03 | 先选择字段值 | C1 | 行为：从 effective 字段开始编辑；待补双尺寸。 |
| C04 | 数值输入与约束 | C6 | 行为：Core 校验错误保留编辑值；待补数值专用 fixture 和双尺寸。 |
| C05 | 数值错误 / 保留编辑 | C6 | 行为：无效 Core 值不丢失；待补数值专用 fixture 和双尺寸。 |
| C06 | 文字输入 | C1 | 行为：文字编辑后才选保存目标；待补双尺寸。 |
| C07 | 值确定后再选保存位置 | C1 | 行为；待补双尺寸。 |
| C08 | 分组总览 / 多保存目标草稿 | C15, C16 | 行为：project/user 草稿分离、project 先提交；待补双尺寸。 |
| C09 | 保存与保存并应用选择 | C3, C4 | 行为：save-only、apply 两个显式选择；C3 为 60×18，待补同一行为 80×24。 |
| C10 | 配置变更汇总 | C7 | 双尺寸：多字段汇总及完整变化可达。 |
| C11 | 配置保存进度 | `tui-v8-2-config-coverage.test.tsx` | 双尺寸：同 fixture 延迟执行保留 Progress，完成后进入 Result；4 项补验整文件退出 0。 |
| C12 | 配置成功 / 返回总览 | C17；`tui-v8-2-config-coverage.test.tsx` | 双尺寸：Progress → 成功 Result；返回原 origin/Back stack 为 80×24 已验。 |
| C13 | 多层保存部分失败 | C8, C15, C16 | 行为：每层结果、仅 retry apply、成功 project 写不被 user 失败回滚；C8 为 60×18，待补 80×24。 |
| C14 | 离开未保存草稿 | C9 | 行为：G04 守卫和放弃草稿；待补双尺寸。 |
| C15 | 布尔字段 / 友好值 | C10 | 行为：布尔 preset 和实际写入；待补双尺寸。 |
| C16 | 文件字段 / 路径约束 | C11；Core `plugin-config.test.ts` | 合同不适用：现有 Core 明确拒绝文件类型。路径仍按字符串编辑；不声称支持文件专用约束。 |
| C17 | 目录字段 / 目标可移植性 | Core `plugin-config.test.ts` | 合同不适用：现有 Core 明确拒绝目录/path 类型。用户已确认保留公开合同，专用控件不适用。 |
| C18 | 敏感输入 / 不采集真实值 | C11, C16；`tui-v8-2-config-coverage.test.tsx` | 双尺寸：同 fixture 输入、目标页、Review 及 snapshot 不泄露值；私有写入 intent 保留必要值。 |
| C19 | 敏感值只有个人保存位置 | C2；`tui-v8-2-config-coverage.test.tsx` | 双尺寸：敏感字段只提供 user 目标。 |
| C20 | 对象字段 / 组合值 | C12, C19 | 行为：完整对象编辑/Review（80×24）；双尺寸仅覆盖 object 动作可达，待补完整组合值的 60×18。 |
| C21 | 来源定义不可用时的设置恢复 | C13 | 行为：仅以记录的 reset scope 打开来源缺失设置；待补双尺寸。 |
| C22 | 清空一个设置层的确认 | C14, C18 | 双尺寸：invalid-layer reset 经 Review，且详情保持私有；待补 catalog fixture 记录。 |
| C23 | 设置层 reset 结果 | C15, C16 | 行为：各层结果和 partial retry；待补 reset 结果专用双尺寸。 |

## 阶段 5：来源、存储与诊断（48）

**分组行为标准。** 来源卡片显示类型、健康、版本和新鲜度，详情区分可用、可检查失败、目录损坏和本地来源。检查只做连接、目录和候选验证，不激活、升级、修复、清理、安装或执行生命周期脚本。编辑支持完整草稿、离线保存、启用失败后重试、原版本恢复、替换确认和移除影响。存储显示保留规则、安全清理预览和结果；诊断和导出只显示安全字段。设计依据：`.tmp/agent-workflow-tui-v8-2/design.md:159-228,278-297,396-425`、`.tmp/agent-workflow-tui-v8-1/design.md:300-374`。

**来源证据范围。** 阶段 5 的新双尺寸文件是 `packages/cli/tests/unit/tui-stage5-v8-2.test.tsx`；既有来源行为主要在 `packages/cli/tests/unit/tui-console-app-v5.test.tsx`、`tui-controller-v5.test.ts` 和 `tui-controller-runtime-v5.test.ts`。后两类不含 Ink 尺寸，不能填作双尺寸 UI 证据。下表列出实际测试全名；`E14`–`E16` 只保留为阶段 1–4 的历史定位线索。

| 设计 ID | 设计状态 | 可用基础证据 | 状态 |
| --- | --- | --- | --- |
| S01 | 来源卡片列表 / 固定操作栏 | `tui-stage5-v8-2.test.tsx` | 双尺寸：长来源列表末项一次 Tab 到固定栏，Enter 检查或查看存储。 |
| S02 | 详情 / 有更新且当前可用 | `tui-console-app-v5.test.tsx`：`keeps all source detail actions reachable at %ix%i and opens the focused technical route`；`shows structured candidate capability diagnostics while preserving the old Active` | 行为：前者在 60×18、80×24 验证详情动作和技术页可达；后者在 100×28 验证候选能力异常时旧 Active 保留。待补有更新详情字段的同 fixture 双尺寸。 |
| S03 | 详情 / 正常无更新 | `tui-console-app-v5.test.tsx`：`keeps all source detail actions reachable at %ix%i and opens the focused technical route`；`renders safe source detail and technical data without raw path, credentials, or failure text` | 行为：动作可达为双尺寸；正常详情和安全技术字段为 80×24。待补完整详情字段的同 fixture 双尺寸。 |
| S04 | 详情 / 检查失败但旧版本可用 | `tui-stage5-v8-2.test.tsx` | 双尺寸：失败来源数量保持未知；当前健康与检查失败分离另由来源测试覆盖。 |
| S05 | 详情 / 当前目录损坏 | `tui-console-app-v5.test.tsx`：`[source-detail/damaged-default] keeps damaged Active unavailable when its freshness check also fails` | 行为：80×24 区分损坏 Active 与检查失败，且不误报为可用；待补 60×18。 |
| S06 | 详情 / 本地来源 | — | 待补验：没有直接打开本地来源详情的完整 Ink 场景。 |
| S07 | 统一检查进度 / 无写入 | `tui-stage5-v8-2.test.tsx` | 双尺寸：按钮和 r 共用检查动作，重复请求合并，检查不执行启用。 |
| S08 | 检查全部 / 逐来源隔离 | `tui-stage5-v8-2.test.tsx` | 双尺寸：固定栏和 r 共用检查全部；各来源隔离由 controller/source 测试覆盖。 |
| S09 | 检查后 / 就地显示新版本 | `tui-controller-v5.test.ts`：`keeps a healthy Active source available when its background check fails`；`tui-console-app-v5.test.tsx`：`shows structured candidate capability diagnostics while preserving the old Active` | 待补验：已有 controller/Ink 证据只证明检查结果不替换旧 Active；没有“新版本就地显示”的直接双尺寸场景。 |
| S10 | 检查后 / 保留错误和旧版本 | `tui-stage5-v8-2.test.tsx` | 双尺寸：检查后刷新同一页面；来源失败不误报插件数为零。 |
| S11 | 完整来源草稿 | `tui-console-app-v5.test.tsx`：`keeps a multi-field source summary and its complete final change reachable at %ix%i` | 双尺寸：编辑两项来源字段、汇总、完整变化和四个后续动作均可达；逐字段输入另有 80×24 覆盖。 |
| S12 | 官方下载方式 / 单字段弹窗 | `tui-console-app-v5.test.tsx`：`[source-edit/official/https] reviews an official HTTPS to SSH transport switch before any source write` | 双尺寸：同一测试显式在 80×24 和 60×18 显示下载方式、说明和 Review 前无写入。 |
| S13 | 添加来源 / 类型 | `tui-console-app-v5.test.tsx`：`reaches S01-S13 through the real Git wizard and treats b as input text` | 行为：60×18 真实 Git 向导经过来源类型；历史 screen ID 只用于测试内部，不等同本表 ID。 |
| S14 | 添加 Git / 来源 ID | 同上：`reaches S01-S13 through the real Git wizard and treats b as input text` | 行为：60×18 输入来源 ID 并进入地址步骤；待补双尺寸。 |
| S15 | 添加 Git / 地址 | 同上：`reaches S01-S13 through the real Git wizard and treats b as input text` | 行为：60×18 输入 Git 地址并进入版本策略；待补双尺寸。 |
| S16 | 版本策略 | 同上：`reaches S01-S13 through the real Git wizard and treats b as input text` | 行为：60×18 选择策略并显示 CLI channel 对应目录；待补双尺寸。 |
| S17 | 固定 Git 引用 | `tui-console-app-v5.test.tsx`：`cancels a fixed-ref field without changing its parent source draft` | 行为：80×24 取消固定引用不会修改父草稿；待补固定引用输入的双尺寸。 |
| S18 | 子目录 / 合法空值 | `tui-console-app-v5.test.tsx`：`shows an explicitly cleared Catalog subdirectory as the repository root` | 行为：60×18 清空子目录显示仓库根，完整变化可分页读取；待补 80×24。 |
| S19 | 添加 Path / 绝对目录 | `tui-console-app-v5.test.tsx`：`saves a changed path source when the private path display has the same basename` | 行为：80×24 保留实际绝对 Path 写入意图，同时显示脱敏路径；待补添加 Path 的双尺寸。 |
| S20 | 添加 Path / 路径错误 | — | 待补验：没有直接的 Path 输入错误 Ink 场景。 |
| S21 | 添加来源确认 | `tui-console-app-v5.test.tsx`：`reaches S01-S13 through the real Git wizard and treats b as input text` | 行为：60×18 到达 Review，确认后调用 `catalogGeneration/activate`；待补双尺寸。 |
| S22 | 编辑确认 / 只保存或启用 | `tui-console-app-v5.test.tsx`：`keeps a multi-field source summary and its complete final change reachable at %ix%i` | 双尺寸：汇总中“保存并启用”“只保存”和完整变化均可聚焦；该 fixture 未执行写入。 |
| S23 | 离线只保存成功 | `tui-console-app-v5.test.tsx`：`saves a changed path source when the private path display has the same basename` | 待补验：已有 80×24 只到精确 `update` prepare；没有离线只保存 Result 的直接场景。 |
| S24 | 保存成功 / 启用失败 | `tui-console-app-v5.test.tsx`：`keeps a source draft and reports uncertainty after a sanitized command failure` | 待补验：80×24 覆盖写入未确认和草稿保留，不等于“保存成功、启用失败”的结果合同。 |
| S25 | 插件目录更新确认 | `tui-controller-runtime-v5.test.ts`：`prepares an Active update without following a newer source and rejects an Active version change` | 行为：后端 Review/evidence 约束已验；没有直接 Ink 更新确认双尺寸。 |
| S26 | 完整引用与影响 | `tui-console-app-v5.test.tsx`：`opens the damaged Active replacement Review and requires explicit impact confirmation`；`tui-controller-runtime-v5.test.ts`：`uses one source mutation preflight for review validation and evidence` | 行为：80×24 显示替换影响确认，后端保留 preflight 引用证据；待补双尺寸。 |
| S27 | 来源执行进度 | `tui-console-app-v5.test.tsx`：`renders real feed phase changes and bounded technical messages for source %s` | 行为：60×18 覆盖 add/update 的真实 Progress feed 和安全技术消息；待补 80×24。 |
| S28 | 来源更新成功 | — | 待补验：没有来源更新成功 Result 的直接 Ink 场景。 |
| S29 | 优先恢复原版本 | `tui-console-app-v5.test.tsx`：`shows structured candidate capability diagnostics while preserving the old Active` | 待补验：该测试只证明旧 Active 保留；没有原版本恢复计划的直接场景。 |
| S30 | 原版本不可取得 / 决定替换 | `tui-console-app-v5.test.tsx`：`opens the damaged Active replacement Review and requires explicit impact confirmation` | 行为：80×24 覆盖损坏 Active 的替换 Review 与影响确认；待补“原版本不可取得”决定的直接双尺寸。 |
| S31 | 更多操作 / 非检查菜单堆叠 | `tui-console-app-v5.test.tsx`：`keeps all source detail actions reachable at %ix%i and opens the focused technical route` | 双尺寸：详情动作及“技术详情”路径可达；待补非检查菜单全部项目的逐项证据。 |
| S32 | 设为主来源确认 | `tui-console-app-v5.test.tsx`：`reaches edit, primary, and safe removal Review pages through mounted keyboard actions`；`tui-controller-runtime-v5.test.ts`：`passes reviewed primary impact to execution and surfaces lock-time stale` | 行为：80×24 到达主来源 Review；后端重验 impact/stale，待补双尺寸。 |
| S33 | 主来源移除受限 | `tui-console-app-v5.test.tsx`：`reaches the last blocked source reference at 60x18` | 行为：60×18 阻断引用可达；待补主来源专用限制的直接双尺寸。 |
| S34 | 最后来源移除受限 | — | 待补验：没有最后来源移除限制的直接场景。 |
| S35 | 移除来源影响确认 | `tui-console-app-v5.test.tsx`：`opens removal Review without consulting an incomplete reference inventory`；`reaches edit, primary, and safe removal Review pages through mounted keyboard actions` | 行为：80×24 可达安全移除 Review；待补双尺寸和完整影响清单。 |
| S36 | 移除结果 / 不删除插件设置 | — | 待补验：没有移除 Result 与插件设置保留的同一直接场景。 |
| S37 | 来源技术详情 | `tui-console-app-v5.test.tsx`：`renders safe source detail and technical data without raw path, credentials, or failure text` | 行为：80×24 技术字段脱敏；基本键分页已加入真实 UI，完整诊断双尺寸测试见 D01–D03；本条独立 fixture 尚未双尺寸执行。 |
| S38 | 来源全局配置无法读取 | `tui-console-app-v5.test.tsx`：`shows no-Active recovery and redacts every unavailable-source technical field` | 行为：80×24 来源不可用的恢复和技术字段脱敏；待补全局配置读取失败的双尺寸入口。 |
| L01 | 存储概览 | `tui-stage5-v8-2.test.tsx` | 双尺寸：从真实来源固定栏进入存储概览。 |
| L02 | 存储保留规则 | `tui-stage5-v8-2.test.tsx` | 双尺寸：可达保留规则并返回预览。 |
| L03 | 安全清理预览 | `tui-stage5-v8-2.test.tsx` | 双尺寸：实际 prepare 证据进入统一 Review。 |
| L04 | 安全清理确认弹窗 | `tui-stage5-v8-2.test.tsx` | 双尺寸：风险确认后才执行；后端锁内精确目标由 catalog-store/helper 测试覆盖。 |
| L05 | 清理成功 | `tui-stage5-v8-2.test.tsx` | 双尺寸：清理成功结果与已删除数量。 |
| L06 | 清理部分失败 | `tui-stage5-v8-2.test.tsx` | 双尺寸：部分失败保留已完成结果和安全诊断。 |
| D01 | 完整安全诊断 / 第一页 | `tui-stage5-v8-2.test.tsx` | 双尺寸：完整诊断所有行可阅读，不依赖特殊翻页键。 |
| D02 | 完整安全诊断 / 后续页 | `tui-stage5-v8-2.test.tsx` | 双尺寸：后续页与上一页连续覆盖，无遗漏行。 |
| D03 | 报告预览 | `tui-stage5-v8-2.test.tsx` | 双尺寸：报告预览连续分页；实际导出另由诊断测试覆盖。 |
| D04 | 报告结果 / 明示模拟 | `tui-console-app-v5.test.tsx`：`keeps all diagnostics and the oldest of 20 reports after a failed save at 60 × 18` | 行为：60×18 覆盖报告保存路径输入、保存调用、默认报告和私有路径不泄露；待补 80×24。 |

## 阶段 6：项目提醒与精确同步（16）

**分组行为标准。** 启动只做本地只读扫描。以规范化项目根、项目声明、精确 `pluginId`、平台和 `project` scope 计算待同步目标；未知或读取失败不能当作未安装。提醒不等于写入确认；同步前重新汇总和确认；晚到结果不抢焦点；声明变化使旧确认失效；同步不自动升级来源。设计依据：`.tmp/agent-workflow-tui-v8-2/design.md:230-276,340`。

**已复核生产测试。** `packages/cli/tests/unit/tui-console-app-v5.test.tsx` 包含首页提醒、SessionHost、Result/retry 和新 clone 的连续链；`tui-session-host.test.ts` 覆盖提醒签名跨 reload 去重；`tui-controller-runtime-v5.test.ts` 覆盖精确声明目标与写前声明漂移。无显式 `size` 的 Console/SessionHost 测试不算双尺寸 Ink 证据。

| 设计 ID | 设计状态 | 可用基础证据 | 状态 |
| --- | --- | --- | --- |
| G02 | 启动 / 本地只读检查 | `tui-console-app-v5.test.tsx`：`opens the project reminder with Later focused and keeps the banner at %ix%i`；`opens a Review for a new clone from the saved project roots without adding user targets` | 行为：前者双尺寸证明“稍后”前不 capture evidence；后者 80×24 从新 clone 的已保存项目根到精确 Review，且 user intent 不变。没有启动不调用所有 preApply/activate/网络的独立 spy。 |
| G03 | 首页 / 项目恢复提醒 | `tui-console-app-v5.test.tsx`：`opens the project reminder with Later focused and keeps the banner at %ix%i` | 双尺寸：首页弹出提醒，默认焦点为“稍后处理”。 |
| G04 | 首页 / 稍后处理横幅 | 同上；`tui-session-host.test.ts`：`keeps the same project reminder signature claimed across a reload` | 双尺寸：选择“稍后”后横幅保留；SessionHost 无尺寸测试证明同签名跨 H reload 不重复弹出。 |
| G05 | 启动 / 部分受阻提醒 | `tui-console-app-v5.test.tsx`：`opens the project reminder with Later focused and keeps the banner at %ix%i` | 双尺寸：显示可同步和需先处理的精确数量；待补阻断原因明细的双尺寸。 |
| G06 | 项目 / 无法确认，不提示安装 | `tui-console-app-v5.test.tsx`：`keeps unobserved project targets out of the missing reminder` | 行为：80×24 以“无法确认”单独显示，不显示“尚未就绪”且不 claim 提醒；待补 60×18。 |
| G07 | 当前目录没有项目 | — | 待补验：没有无项目当前目录的直接 Ink fixture。 |
| G08 | 项目没有共享插件声明 | — | 待补验：没有空项目声明的直接 Ink fixture。 |
| T01 | 项目待同步卡片列表 | `tui-console-app-v5.test.tsx`：`opens the project reminder with Later focused and keeps the banner at %ix%i`；`connects the home reminder through SessionHost to an exact project Review`；`opens a Review for a new clone from the saved project roots without adding user targets` | 行为：双尺寸覆盖计数和入口；连续链到精确 project target/Review，但没有逐卡内容的双尺寸断言。 |
| T02 | 受阻子集 / 不静默跳过 | `tui-console-app-v5.test.tsx`：`connects the home reminder through SessionHost to an exact project Review`；`uses real project roots and treats a confirmed incomplete dependency as actionable` | 行为：提醒只授权精确可执行子集；controller projection 排除非真实 project root。阻断原因详情缺双尺寸。 |
| T03 | 同步前汇总 | `tui-console-app-v5.test.tsx`：`connects the home reminder through SessionHost to an exact project Review`；`opens a Review for a new clone from the saved project roots without adding user targets`；`tui-controller-runtime-v5.test.ts`：`syncs only exact declared project intent targets and rejects undeclared targets` | 行为：精确 `pluginId/platform/project` Review 与后端声明门禁已验；待补完整汇总的双尺寸。 |
| T04 | 项目脚本风险确认 | — | 待补验：没有项目脚本风险 fixture、风险弹窗和二次确认的直接测试。 |
| T05 | 同步执行 / 不自动升级来源 | `tui-console-app-v5.test.tsx`：`keeps a partial project result, cancels pending H, and retries with project evidence`；`tui-controller-runtime-v5.test.ts`：`syncs only exact declared project intent targets and rejects undeclared targets` | 行为：执行和 retry 保留精确项目 target；没有“不调用 catalog activate/source upgrade”的独立 spy，也没有 Progress 页双尺寸。 |
| T06 | 同步成功 / 提醒消失 | `tui-console-app-v5.test.tsx`：`clears the project reminder after a successful exact sync reload` | 行为：成功后 controller reminder projection 清空；待补成功 Result 回首页、横幅消失的连续 Ink 双尺寸。 |
| T07 | 部分成功 / 剩余目标 | `tui-console-app-v5.test.tsx`：`keeps a partial project result, cancels pending H, and retries with project evidence` | 行为：连续链保留 partial Result，只重试失败的精确项目 target；测试未显式固定尺寸。 |
| T08 | 声明变化 / 确认失效 | `tui-controller-runtime-v5.test.ts`：`stops exact project intent sync before writes when the complete declaration changes`；`keeps a partial project result, cancels pending H, and retries with project evidence` | 行为：后端覆盖根、删除、平台与 dependency scope 的四类 drift，均 stale 且零写入；连续链证明 retry 不降级普通 target。后端无尺寸。 |
| T09 | 执行中请求重载 | `tui-console-app-v5.test.tsx`：`keeps a partial project result, cancels pending H, and retries with project evidence` | 行为：执行中 H 仅挂起，partial 后取消挂起而不 reload；测试未显式固定尺寸。 |

## 80×24 与 60×18 结构验收

每个 ID 必须以相同 fixture 各运行一次 80×24 和 60×18，并记录生产终端输出或测试断言。两种尺寸必须保留相同的信息顺序、关键状态、焦点顺序、返回路径和写入边界；边框、间距和合理换行可以不同。不能把固定操作栏移到长列表末尾，不能截断错误或主操作，不能删除未保存事实（`.tmp/agent-workflow-tui-v8-2/design.md:418-426`）。

以下是设计验收目标，不是完成声明。全阶段只有表内明确标为“双尺寸”的行为证据；没有按 156 个 catalog ID 分别归档的完整双尺寸记录，也没有“312 项均已验证”的证据。这一事实不要求为每个 ID 机械新增独立测试。

| 区域 | 80×24 验收目标 | 60×18 验收目标 |
| --- | --- | --- |
| 全部场景 | 156 个 fixture 各有一份可复核生产证据。 | 相同 156 个 fixture 各有一份可复核生产证据；总计 312 份。 |
| 插件列表 | 固定头部 4–5 行、3–4 张完整卡片和固定帮助。 | 固定头部 4–5 行、2 张完整卡片和固定帮助。 |
| 插件详情 | 信息卡约 5–7 行，约 8 个动作。 | 信息卡压缩为 4–5 行，保留 4–6 个可滚动动作。 |
| 多选与配置 | 固定继续/选择工具，以及固定分组/保存栏。 | 不需滚到列表末尾才可继续；不删除保存按钮、目标标记或错误。 |
| 依赖图 | 可显示详情和动作。 | 用分支视口与纵向滚动，不用横向滚动破坏 60 列。 |

列表、详情、多选、配置和依赖图的行数与可见性要求来自 `.tmp/agent-workflow-tui-v8-1/design.md:396-406`；双尺寸 fixture、允许差异和禁止差异来自 `.tmp/agent-workflow-tui-v8-2/design.md:280,398,418-426`。

## 阶段 1–4 的缺口与最小补验

下列是当前已有**双尺寸行为**证据的设计 ID：`P09`、`B01`、`B02`、`B03`、`B07`、`N03`、`N04`、`N05`、`N16`、`U13`、`U15`、`U16`、`U19`、`U21`、`U25`、`C10`、`C11`、`C12`、`C18`、`C19`、`C22`。这些测试仍不是按 `page-catalog.csv` fixture ID 保存的验收记录。

其余阶段 1–4 ID 都至少缺少一个尺寸、或只覆盖了相关行为。优先补验的直接行为缺口是 `P05` 和 `U27`；后者只有 typed validation blocker，不是分发定义不可用的真实入口。`C16`、`C17` 是现有 Core 不接受文件或目录/path 字段的公开合同，不应以新增 TUI 测试伪装为已支持功能。其余缺口由各行“待补”说明确定。

最小可行补验先为上述直接缺口各加一个真实 Ink 场景；这些场景应参数化运行 80×24 和 60×18。随后按组件复用现有双尺寸测试：列表/详情、批量 placement、原生 Progress、Portable blocker/选择/Review/Result、配置保存 Progress/Result 与目录字段。测试记录应列出覆盖的 catalog ID、尺寸、frame 行/列边界、关键状态、焦点路径、返回路径和写入前后状态。只有设计状态的输入或输出不同，才新增专用场景；不要用 HTML 原型、相关测试或总测试通过数填充记录。

## 阶段 5–6 的专用场景证据缺口与补验建议

当前没有直接生产证据的来源状态是 `S20`（Path 输入错误）、`S23`（离线只保存 Result）、`S24`（保存后启用失败）、`S28`（来源更新成功 Result）、`S29`（原版本恢复计划）、`S34`（最后来源移除限制）和 `S36`（移除后插件设置保留）。这表示本表不能确认这些具体合同，不表示生产功能不存在。可按三个参数化组件补验：Path 输入/校验；来源 Result（只保存、启用失败、更新成功、移除）；来源恢复与移除限制。每个组件只需在输入或结果不同处增加分支，并在 80×24、60×18 复用同一测试。

阶段 6 的直接缺口是 `G07`（无项目目录）、`G08`（空项目声明）和 `T04`（项目脚本风险与二次确认）。最小补验是一个项目状态参数化 fixture 覆盖前两项，以及一个带脚本风险的 Review fixture 覆盖 `T04`；其余项目链不需按每个 ID 再造 fixture。现有最强连续链是“首页提醒 → Review → 执行中 H 挂起 → partial Result → 精确失败目标 retry → H reload 后同签名只保留横幅”，但其核心 SessionHost/Result 测试未显式运行两种尺寸。

最终评审的修复已有定向证据：`tui-console-app-v5.test.tsx` 覆盖长内容与风险基本键分页、内容卡、维护固定确认；`tui-portable-skills-v1.test.tsx` 覆盖配置 partial 和带关注消息的成功结果不被自动恢复吞掉；`tui-config-save-batch-diagnostic-projection.test.ts` 覆盖分层写入事实及诊断。依赖完整 ID 与关键 Review 说明保留原断言。两种尺寸的真实生产 CLI 内容页由 `.tmp/tui-v8-2-pty` 记录，不等于全部设计 fixture 的逐页验收。
