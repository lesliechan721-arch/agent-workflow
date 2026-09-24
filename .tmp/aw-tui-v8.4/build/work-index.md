# v8.4 实施记录

## 原始基线与来源

- 原始代码基线：`0d806ea851a88a36cc0f6d72271fc0a8f2dc08c8`，实施准备时工作区无 tracked 改动。
- 当前规范：[implementation-spec.md](../implementation-spec.md)。用户已确认整个修改决策，并于 2026-09-24 请求使用 dev-build 完整实施。
- 接受设计：[prototype.html](../prototype.html)、[index.html](../index.html)、[route-mapping.json](../route-mapping.json)。原型 SHA-256：`25c31a89fb036edfda3e659b5a4f8e96671364fa330617a4b997db5e67cfbf9e`。
- 规格 SHA-256：`962373e318211bcd21ff814ca0e9be2b593b18072131ae5535fe7cd2a659cf34`。
- 保存方式：用户已授权本任务创建本地 checkpoint 提交，不推送。保存已确认规格、任务基线和验证通过的实现阶段；同类保存点无需重复请求。设计包本体保留在当前可访问目录，基线保存上述设计引用和固定摘要。
- 交付包含实现、相关验证、从原始基线开始的双轴独立审查和有界修复。不发布、不操作真实用户安装或配置。

## 共享约束

所有实施者读取规范对应全文、AGENTS.md、docs/architecture.md、docs/coding-conventions.md 和 docs/testing.md；修改作者结构合同者还读 docs/plugin-maintenance.md。使用 dev-implement。测试先通过 Test Value Gate，经仓库 wrapper 运行，使用隔离 homes。

完整保留左右阅读翻页和 y 复制；v5 是所有配置文件的硬切换，不兼容读取或自动迁移 v4；数组最多 128 项、262144 字节，对象元素最多 32 属性。已有单一写锁、安全身份、原子配置、部分成功和恢复合同不变。

多人共用当前工作区；每项只能修改所分配文件，不回退他人修改。公共接口稳定并交接后才启动依赖任务；测试有状态环境或生成产物不能并行争写。子代理不得自行 commit、push 或扩展任务。

## 当前工作项

### T1：一维数组 Core

- 结果：规范第 6 节在真实 Core 中成立，包含 types、normalizer、refs、default/preset、校验、路径、摘要、相等性、redaction、正式 capability、JSON Schema 和生成类型。
- 写入范围：packages/plugin-core 的源码、schema、生成类型源产物及该包测试。不得修改 CLI/TUI。
- 依赖：规范已确认；为 T2/T5 提供受限数组类型、itemSummary、segments 和正式 capability ID。
- 验收：五种合法类型、拒绝嵌套/混合/引用绕过/敏感集合；资源边界；空值和深等序；schema/能力一致；相关 core unit、type contract 和 generate check。
- 状态：array_core 子代理已开始只读准备，基线保存后实施。

### T2：v5-only 存储与 CLI 消费

- 结果：规范第 7 节和第 6.6 节 CLI/消费者合同成立；全新标量/对象/数组文件均 v5；旧 v4 拒绝且原字节保留，显式 reset 后可重建。
- 写入范围：CLI config utils/writer、config 命令及与数组消费直接有关的 CLI 非 TUI 源码和对应测试；跨出范围前协调。
- 依赖：T1 公共合同稳定。不得修改 TUI、portable materializer 或 Core；文档由协调者统一更新。
- 验收：实际 CLI set/unset/读取/应用、绑定身份和原子写入；合法 JSON 同质数组；共享项目不兼容在写入前发现；旧版本错误及恢复。
- 状态：等待 T1。

### T3：项目完整投影与局部刷新

- 结果：规范第 3 节的完整项目列表、根/目标状态和局部只读刷新拥有可供 UI 使用的正式 Controller/runtime 接口。
- 写入范围：tui/model.ts、controller.ts、controller-runtime.ts；必要新增项目投影模块；项目行为相关测试。不得修改 console-app、components、router 或 Core。
- 依赖：现有 Status/Intent/安装事实；不依赖数组实现。
- 验收：健康/异常声明、合法 user 共用、额外 project 安装、来源失效；局部检查不重建会话/运行脚本/写入，保留会话状态；精确同步集合不扩大。
- 状态：project_inventory 子代理已开始只读准备，基线保存后实施。完成后向 T4 交接 API 和 fixture。

### T4：页面、模板和紧凑 Skills

- 结果：规范第 2–5、8–9 节的非数组页面和路由落地，包括 HomeNav、ConfigTile、KeyCap、动态筛选、完整项目页、紧凑 Skills、共享 Reader/Operation 和安全返回路径。
- 写入范围：console-app-v4.tsx、components.tsx、theme.ts、layout/viewport、router/screen-registry、config-value-presentation 及相关 screens/tests；portable shortDescription 的底层贯通单独协调写入。
- 依赖：先接纳 T3 的接口；公共视觉改动先在代表页面验证，再推广。整个 console-app 同时只有一个写入 owner。
- 验收：实际 Ink 交互；80×24/60×18 设计对照；selected-zero；所有阅读按键；不隐藏风险；统一详情/Review/Reader 返回状态；初始选择不改变。
- 状态：等待 T3；可以提前只读准备设计和测试。

### T5：数组编辑器与真实保存集成

- 结果：规范第 5–6 节完整数组体验，合法元素编辑、增删改排、rowId、取消、一次 scope、正确 dirty/差异、完整值与真实保存批次。
- 写入范围：交接后的 TUI 配置路由、控制器/草稿、值显示、编辑器和相关测试；必须先确认 T3/T4 的重叠写入已结束。
- 依赖：T1、T2、T4 接口和相关验证完成。
- 验收：真实 ConsoleApp/Controller 至存储路径，取消不丢草稿，错误索引更新，fixed preset 禁止自定义，v5 与部分成功状态正确。
- 状态：等待前置。

### T6：完整集成、文档、交付审查

- 结果：全部七项范围真实落地；更新架构、作者/消费者说明和 TUI 能力覆盖表；保持原始基线用于完整双轴审查。
- 写入范围：协调者拥有跨项修复、项目文档和本工作记录。修复需协调当前文件 owner。
- 验收：相关定向测试后运行 pnpm test:unit、pnpm test:integration、pnpm build 及适用结构/产物检查；git diff --check；真实 TUI/PTY 设计对照。两个独立干净上下文分别审需求设计和工程质量；关闭实质问题后交付。
- 状态：待集成。

## 验证与问题记录

任务正文保留。后续在此附实际文件、命令结果、证据路径、未关闭问题及审查结果；不把原型自测当生产证据。
