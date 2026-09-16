# Workflow Architecture Review

检查：

1. Entry/routing：入口 owner、触发竞争、manual-only 依赖，以及普通执行路径。核对 caller 的强制调用是否与 leaf 的默认适用范围相容。
2. Responsibility：区分 Author、Reviewer、Auditor、Runner、Publisher 和 adapter。涉及委派时追踪每层真实角色、目标范围、上下文来源和结论 owner，核对已有隔离与本次缺口。
3. Handoff/context：确认真实消费者及其必要信息；沿上游本次产物和明确可达引用检查信息充分、实际消费与最终结果。既有人工好样本只能支持各自测试范围。
4. State/evidence owner：identity、digest、readiness、Audit 和运行事实是否唯一；任务定义、证据与进度各自用途是否保留。
5. Permissions/cost/failure：只读、写入、执行、发布是否混合；optional branch 是否进入 common path；委派是否取得不同且有价值的工作结果。
6. Minimum architecture：比较适用的直接执行、单 Skill 与组合路径及其实际增益/成本；在保留安全与领域信息前提下选择更短路径，确认 leaf 修改的 blast radius。

按实际范围、角色配置和结果判断工作是否前进；同一上下文连续使用多个 Skill 不自动形成交接，Skill 数量或名称也不证明重复。纯协调和有真实范围差异的子协调可以成立。
