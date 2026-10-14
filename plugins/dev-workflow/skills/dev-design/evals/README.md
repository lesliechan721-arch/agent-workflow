# 设计与规格阶段的 Eval 覆盖

本页说明用例评价的能力和证据边界，不记录通过率，也不是独立 EvalAudit。用例修改由作者完成，正式运行前仍需对实际 EvalSpec 取得独立准入。

## 能力与场景

| 能力 | 主要用例与对照 |
| --- | --- |
| 需求对齐与有效结果复用 | `visible-alignment` 检查缺少决定、明确小任务、受影响主题重开，以及同一完整草稿在未确认／已确认来源下的不同处理；`alignment-handoff` 检查本次原型、实际答复、知识和完整要求进入最终规格 |
| 正式交付与修订协调 | `task-spec-lifecycle` 检查本地任务、现有公共合同及单次范围；`simplified-design` 保留轻量任务、恢复、正式规格、预算耗尽，并用 `authorized-final-round-repairs-spec` 检查实际修复而非仅停止 |
| Spec 独立编写与方法组合 | [reader-structure](../../dev-spec/evals/reader-structure-cases.json) 的 `main-spec-supports-product-decision` 分别检查写入前取得 Explain 方法、实际主文与语义保真；`local-wording-change-keeps-scope` 检查局部修词不重走完整流程 |
| 完整语义与资料生命周期 | Spec 的 `behavior`、`information-fidelity`、`independent-delivery-behavior` 与 `in-place-spec` 检查边界结果、建议强度、接口、接受原型、公共合同、必要附件和明确未决草稿 |
| 设计必要性与正确对照 | Spec／Review 的纯内存预览与有事故依据的外部导入，对照没有当前用途的持久机制和必须保留的恢复要求；不按状态机术语或篇幅判错 |
| 独立审查、复审与人审质量 | [Review 用例](../../dev-review-spec/evals/) 检查未引用来源、隐藏附件变化、主文阅读障碍、真实关闭条件、局部证据复用及原审查版本到当前的累计回归 |

## 运行前提

`strict` 会按被测 Skill 与 `suite.participants` 选择运行时能力；准备目录存在某个 Skill 不代表运行时仍可见。Spec 的用例声明 `explain-for-review`，独立编写不借 Design 取得方法。参与列表表示可用能力，不要求每个用例全部加载；触发用例只判断被测入口是否加载，不推断首次入口、独立性或最终质量。

只读和因缺口停止的 conversation 使用 `workspaceUnchanged: false` 与 `allowedWorkspaceChanges: []`：提供可写工具，但拒绝任何最终业务文件变化。还须查看实际工具轨迹中的写入尝试，最终快照不能单独证明主动只读。写入用例提供明确目标、必要的本地忽略条件及实际 artifact；已存在文件还须核对其语义，不以存在性代替任务完成。

保留两份大型真实材料作为表达保真的输入，不把其历史批准、测试数字和平台描述当作当前产品事实。`complex-spec-topic-reorganization` 直接对照其提供的 `input/original.md`，不依赖未交付的 rubric。结构重排不能丢失完整技术定义；未提供的原始代码或日志不得被声称已重新核验。

## Oracle 与运行证据

普通正文按含义判断，不锁定标题、中文同义词或固定段落。用户明确指定的按钮文案可以精确核对；规范中的时间单位和边界结果必须保留。列出“边界验收”不等于定义了等值时刻的行为，也不能证明旧 finding 已关闭。

角色声明和手工旧报告只构造方法测试的前提，不证明真实执行者独立、旧证据可信或工具已执行。真实独立性、长上下文恢复、Spec 到实施者的运行交接和人审理解效果，须由相应运行轨迹或实际人审补足；不能用静态包检查或用例数代替。

修改 Oracle、fixture、参与能力或写入环境后，旧比较只保留为历史记录。新的版本比较必须对两端使用相同的修订用例、可见依赖、权限、模型和判定规则，分别报告原有能力、新组合行为及未验证项。
