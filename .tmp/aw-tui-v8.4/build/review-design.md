# 需求与设计符合度审查

结论：固定候选存在 2 项 P2 问题。该结论只覆盖需求与设计轴，不代表工程轴或发布批准。

## 范围与依据

- 基线：`0d806ea851a88a36cc0f6d72271fc0a8f2dc08c8`。
- 候选：`a961974f4cd63f42d6200816f3f819e32baefe09`，包含 Core 提交 `a598d07b`。
- 本审查者未参与设计或实施。只读取产品、测试、规格和既有验证产物；只写本报告，未启动其它代理。
- 以 `implementation-spec.md` 为最终权威。原始 README、`spec/01-design.md`、`02-array-contract.md`、`03-implementation-map.md`、`prototype.html`、`route-mapping.json`、`page-catalog.json` 用于追溯。旧提案中的 v4 兼容读取、按需升级和降级导出不作为要求。
- 读取项目 AGENTS 指令、架构、编码及测试规范，并按 `dev-review-code` 的 design-fidelity 方法对照实现。
- 固定提交的源码行号用于以下 finding。审查中工作区出现作者正在进行的修复；没有把未提交修复当作固定候选的一部分，也没有还原这些修改。

## Findings

### D1 · P2：统一保存汇总遗漏对象子属性差异

位置：`packages/cli/src/tui/console-app-v4.tsx:8828`。

依据：规格第 5.2 节要求保存汇总直接显示字段及差异，简要和完整差异属于同一操作文档；第 2.2 节要求 `y` 复制当前完整阅读文档。

实际：`configSaveBatch` 分支重新构造 `changesText`，只消费每个 change 的 `title/before/after`。随后从 `review.changes` 排除 `configChanges`。对象属性的新增、修改和删除细节因此没有进入实际分页正文，也没有进入 `readingText`。当对象摘要为“已设置”时，用户只能看到顶层状态变化，不能在最终写入确认中检查具体键值。

证据：直接读取固定候选的上述分支；对照已有 mixed fixed/dynamic object 测试，其场景修改 `owner: Alice → Bob`、删除 `legacy`、增加 `new_key`，Controller Review 保留这些差异，但页面拼接没有消费它们。主代理另报告该用例在全量 unit 中失败；本审查未重跑该测试，不以此转述代替源码证据。

影响：用户不能在唯一保存确认中核对即将提交的完整对象修改；复制全文同样遗漏。该问题破坏本次页面收敛应保留的确认能力。

关闭条件：同一安全操作文档包含三类属性差异；两尺寸通过翻页可读取全部差异，`y` 在首页和末页复制同一完整正文，不包含敏感值。保存仍只提交一个完整顶层对象，不增加重复 Review。等价的更小修改可满足该条件。

### D2 · P2：数组对象属性卡宽度超出正文，导致无标记裁剪

位置：`packages/cli/src/tui/console-app-v4.tsx:7072`，相关容器 `packages/cli/src/tui/components.tsx:118`、`components.tsx:576`。

依据：规格第 5.1 节要求两行内能显示完整的值不截断；第 1.2、2.3 节要求 80×24 和 60×18 保持卡片关系、可读性及完整值能力。

实际：数组对象 Editor 向 `SequenceRows` 传 `columns={size.columns}`，但 ScreenFrame 正文具有左右各一列 padding。ConfigTile 以这个过大的宽度创建外框，并以 `width - 2` 切分值行；父容器随后裁剪超出的列。正常配置总览已经使用 `size.columns - 2`。

证据：直接观察 `build/page-frames/array-object-item-60x18.json` 和 `array-object-item-80x24.json`：属性卡右边框消失，底边尾部被截断。对照已打开的 config-array / responsive 设计总览，设计中的属性卡具有完整边框。源码表明贴近行宽的值也按过大宽度换行，尾字会落入被裁列，且不是有省略标记的受控预览。当前保存帧使用短值，直接帧证据只证明外框裁剪；长值内容影响由同一宽度计算确定。

影响：数组对象的属性显示不满足采用的 ConfigTile 合同；用户可能把没有省略标记的裁剪值当作完整属性值。

关闭条件：按实际正文宽度计算卡片与换行。两尺寸观察接近行宽的 ASCII、中文属性值，确认两行内完整值和边框均未被父容器裁掉；完整编辑入口保持可达。无需新模板或宽度状态机。

## 七主题与公共合同核对

| 主题 | 直接核对结果与边界 |
| --- | --- |
| 首页与项目 | 首页实现三个领域入口，并在卡内合并独立状态。ProjectInventory 从完整声明和 Status 事实构造，保留无法解析的声明；额外安装分组、依赖归组、共用 user 依赖、exact project 同步集合和局部 refetch 均有实现。检查了对应 unit 的健康、待同步、丢失来源、个人共用、无关 user、额外安装与未知事实场景。未另行运行真实安装现场。 |
| 动态筛选 | 同一 source/query/snapshot 计算各候选，保留 selected-zero，离开零项后隐藏。project/user 来自安装证据；批量选择独立保留。核对了来源失效 Status 的 owner 事实来源，未把仅 intent 的错误目标误认成 owner 证据。 |
| 配置卡片与保存 | ConfigTile 分开值、来源、待保存及 invalid；个人草稿被 project 覆盖时保留有效值；普通字段直接进 Editor，受限字段保留删除。单 Review 路径已接入，但 D1 阻断完整差异验收。 |
| 一维数组 | Core normalizer/validator、local ref 上下文、同质值、完整预设、itemSummary、128 项/256 KiB/32 属性边界、segments 诊断、能力注册及消费者连接均在差异中。TUI 有字段 working value、会话 rowId、增删改排、完整校验、一次 scope 选择和取消路径。数组差异采用前后完整列表，未伪造重复元素身份。D2 影响对象元素显示。 |
| v5 | namespaced envelope 读取和新写入切为 5，保留 source/catalog binding；已有文件在覆盖前重新读取并拒绝不兼容版本；不见 v4 自动迁移或降级路径。读取对应 unit/integration 和消费者变化，但未独立运行文件恢复及 package/Catalog 产物闭环。 |
| Skills | 普通帧确为名称/勾选与短描述两行；例外追加范围原因。候选贯通 short-description/fallback 来源；Enter/Space 选择及 c 继续沿用 Controller 草稿，范围物化安全阶段保留。未独立构造同名来源冲突现场。 |
| 模板、路由与阅读 | 读取 55 项映射并追踪主要 Collection、Detail、Editor、Operation、Reader 分支，pluginPreview 通过 normalize 进入统一详情；配置/来源保存汇总接到 Review，业务路由未被当成仅六枚 enum 删除。项目与插件上下文保留实体焦点；数组子草稿有独立 owner。关系树保留自身方向键，Reader 使用安全正文、换行与分页。未对 55 条路由的每条返回栈逐一实际操作。 |

## 直接观察、测试证据与限制

直接观察：打开了四张设计总览（home-project、config-array、filter-skills、responsive），检查其首页、项目、筛选、配置、Skills、数组和无色关系；读取实际 `page-frames` 两尺寸首页/项目/配置/Skills/数组列表、对象、校验、Review、结果帧。合成数据不同于原型，比较的是内容层级、卡片关系、焦点与动作，不宣称像素一致。

Reader：检查四份 `reader-traces` 的首页、分页及末页。诊断末页保留 `_END_14`，报告末页可达。JSON 的 inputs 数组为空，且没有复制正文；单凭这些帧不能证明键盘输入和复制。

已进一步检查 `tui-console-app-v5.test.tsx` 中实际断言：

- `pages every retained line with equivalent keys` 用 PgDown 收集每页正文，核对诊断原始长行/报告文本，反复 PgUp 回首，再比较左右键与 PageUp/PageDown 的帧等价。
- `copies complete safe operation text` mock 剪贴板，检查帮助弹层阻断 y、长单行末尾可达、失败反馈不暴露错误、重试成功、复制包含未软换行的原行、秘密被替换，且阅读位置保留。
- 工作区新增的对象 Review 回归断言检查三项属性差异、y 正文、80→60 缩放、完整分页和两次复制一致。这属于正在修复中的测试，不能用于宣称固定候选已通过。

以上测试源码确实保护相应行为，不是仅检查文件存在。测试执行由主代理串行负责，本审查没有复跑 unit、integration、build 或 PTY。

已有记录：读取 `build-final.log` 的正式 build 完成记录和 `pty-final.log` 的边界声明。PTY 使用隔离 home、生产 Ink 和 fake native；不证明真实第三方兼容。主代理告知全量 unit 尚有 D1 对应用例失败，后续 integration/产物门禁在进行中。未提前把这些门禁标为通过。

仍未独立验证：真实系统剪贴板、真实 IME/粘贴/终端缩放和 16 色/NO_COLOR 焦点；每条旧路由的返回、失效和流程清理；全部 74 设计状态的实际截图；真实外部平台安装；数组/v5 的完整 package、bundle、Catalog 产物验收。通用 Skills 在项目中的外部记录归属未取得单独运行证据，不据此推定其符合。

## 目标一致性

审查结束读取 HEAD，仍为 `a961974f4cd63f42d6200816f3f819e32baefe09`。工作区有作者修复中的 `console-app-v4.tsx`、相关测试及 work-index 改动；本报告的两项 finding 均用 `git show a961974` 核对，未混用修复后的行号。后续候选需对修复差异与验证结果做有界复审。
