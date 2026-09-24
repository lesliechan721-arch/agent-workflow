# 工程质量与项目标准审查

## 范围与依据

- 基线：`0d806ea851a88a36cc0f6d72271fc0a8f2dc08c8`。
- 固定候选：`a961974f4cd63f42d6200816f3f819e32baefe09`，包含 Core 数组提交。
- 本审查者未参与设计、实施或修复，只负责工程质量与项目标准轴；未委派其它代理。
- 依据：`implementation-spec.md`、设计包 README、仓库 AGENTS.md、architecture、coding-conventions、testing、plugin-maintenance，以及实际变更和相关调用链。

## 工程质量与项目标准

结论：固定候选存在 1 项实质问题。除以下问题外，已检查路径未发现需要增加锁、台账或恢复状态机的问题。

### E1 · P2：统一配置 Review 丢失对象子字段差异

位置：固定候选 `packages/cli/src/tui/console-app-v4.tsx:8828`，配置批次的 `changesText` 构造。

可达触发：编辑具有安全子字段投影的对象，或删除对象覆盖以恢复继承，然后从配置页按 `s` 进入新的统一 Review。上游 `configChanges` 已生成 `change.children`，其中包含逐属性的安全前后值。

实际行为：该位置只拼接顶层 `title / before / after`，没有消费 `children`。新的统一内容又替换原 Review 的内容；用户因此只能看到例如“未设置 → 已设置”，无法检查实际变化的公开属性。`readingText` 也使用同一不完整字符串，所以左右翻页和 `y` 复制不能找回缺失信息。问题不改变 writer 的最终值，但削弱了保存前确认，用户可能批准无法充分检查的整对象覆盖。

证据：直接读取候选代码，并追踪 `configChanges` 的子字段生成和 Reader 的复制入口。主代理另报告全量 unit 中的既有对象差异用例失败；这是沿用记录，不是本审查者实跑。

关闭条件：统一 Review 的完整文档包含现有安全投影中的子属性差异；屏幕分页和 `y` 使用同一完整文档；敏感子字段继续隐藏。通过真实 Ink 保存流程证明公开属性及恢复继承差异可达，且复制包含这些差异、不包含敏感值。无需增加另一套差异模型。

## 已核对路径

- Core：数组仅在 Definition v3 中启用；标量、固定对象和 KV 对象元素；本地引用展开；默认值及 presets 验证；稠密数组、同类型元素、非有限数、危险键、128 项、256 KiB 和 32 属性边界；完整值规范化、排序敏感性、对象键排序及唯一性；Schema、生成类型、capability registry 和 derive 的贯通。
- 配置存储：namespaced envelope v5、旧版本拒绝、写前现有文件检查、source/catalog binding、原子提交及显式 reset 的既有路径；未发现新增自动迁移或隐式删除旧 v4 的路径。
- 数组 TUI：本地完整工作副本、rowId、元素及整列取消、scope 候选、一次完整值 staging、批次保存、已保存组剔除、source/schema/store 编辑证据与执行前重新核验。
- 项目投影：完整声明根、不可解析根保留、来源失效的安装证据来源、依赖的同平台共用证明、unknown 判定、额外安装、同步目标限制和局部只读 refetch。
- 列表和 Skills：实际安装范围筛选、selected-zero、同一查询范围计数、短描述 metadata 与安全清理、既有选择草稿。
- Reader 和路由：统一 Review、项目/插件详情、portable 依赖阅读、左右/PgUp/PgDown、完整复制、弹窗拦截、树交互分支、原有执行器与返回上下文。
- 测试价值：新增核心、文件系统和 Ink 用例主要观察输入、输出、状态及失败边界；没有据此提出仅为内部结构或低影响假设增加复杂度的建议。

## 验证与覆盖限制

- 直接观察：上述源码、测试、规格及调用链。未修改被审产品代码或测试，未运行安装或发布。
- 已有记录：读取 `build/build-final.log`，结尾记录正式 build 完成；读取 `build/pty-final.log`，其证据边界明确为生产 Ink PTY 与 Controller side channel，第三方 native compatibility 为 false。
- 实际运行：本审查者只运行只读 Git、检索和文件读取；没有重复运行 build、全量测试或定向测试，以避免与主代理的串行验证冲突。
- 未验证：真实第三方 native 安装、人工输入法体验、真实剪贴板及所有终端环境。PTY 合成会话不能替代这些证据。完整 unit/integration/产物结果由主代理汇总，不能用本报告宣称全部通过。
- 结束时 `HEAD` 仍为固定候选 `a961974f4cd63f42d6200816f3f819e32baefe09`。工作区已有作者对 E1 的未提交修复及相应测试改动；本报告的问题绑定固定候选，不把正在修改的工作区视为已完成复审。
