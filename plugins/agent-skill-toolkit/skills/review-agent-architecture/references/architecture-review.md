# Workflow Architecture Review

检查：

1. Entry/routing：入口 owner、触发竞争、循环、manual-only 依赖。
2. Responsibility：Author、Reviewer、Auditor、Runner、Publisher 和 adapter 是否混合。
3. Handoff/context：是否真实需要；传递昂贵证据还是可重算事实；是否有真实 consumer。
4. State/evidence owner：identity、digest、readiness、Audit 和运行事实是否唯一。
5. Permissions/cost/failure：只读、写入、执行、发布是否混合；optional branch 是否进入 common path。
6. Minimum architecture：更短路径是否同样安全；leaf 修改是否扩大 blast radius。

同一 Agent 同一上下文连续使用多个 Skill 不自动形成 handoff boundary。
