---
name: dev-workflow
description: 当用户明确要求使用结构化开发流程、启动或继续跨步骤开发任务，或已有决策记录、Prototype、Spec、Review、work、diff、branch 或 PR 需要自动选择当前阶段时使用。它是可选宏入口；普通明确的小改动或用户直接请求某个专业能力时不要使用。
---

# Dev Workflow

你是可选的开发流程编排器。专业 Skill 可以独立调用；只有用户需要风险分级、自动选路或跨阶段继续时才使用本 Skill。

## 1. 选择最低足够保障

- **Fast**：请求明确、范围小、可逆、预计一个上下文完成，并且有可靠验证。
- **Standard**：中等范围、存在材料决定、需要 Prototype、跨会话、正式批准或 Review。
- **Assured**：安全、权限、支付、持久数据、迁移、生产副作用、不可逆操作、多 Agent 或缺少可靠测试。

## 2. 确定任务目录

优先使用用户路径或仓库约定。Standard 和 Assured 都没有约定时使用：

```text
docs/dev/<task-slug>/
```

文件按需出现。Fast 路径不创建流程文档。

## 3. 选择当前能力

从最早未完成阶段继续：

- 相互依赖的材料决定需要讨论 → `decision-grill`。
- 决定必须通过体验、实验或测量取得证据 → `decision-prototype`。
- 决定稳定但没有 Spec，或 Spec 需要修订 → `dev-spec`。
- Spec 尚未正式审查，或修订后需要复审 → `dev-review-spec`。
- Spec Review 为 `clean` 但尚未批准 → 请求用户明确批准。
- 请求已明确、走 Fast、Spec 已批准，或 Code Review 需要修复 → `dev-implement`。
- 实现和验证完成，或修复后需要复审 → `dev-review-code`。

## 4. 处理 Review 循环

- 初次 Review 应一次列出当前目标和证据支持的全部 blocker；偏好性改进和没有材料影响的更优写法不进入交付门槛。
- 修复范围只包含当前 blocker、解决它们必需的影响面，以及修复直接引入的 regression。
- 一轮自动修复是 `blocked Review → 修复 → 完整复审`。Fast 不自动循环；Standard 最多两轮；Assured 最多三轮。
- Standard Code Review 默认由一个 fresh reviewer 覆盖两个审查轴；Assured 或用户明确要求时，由两个 fresh reviewer 分轴完成。
- 复审必须与上一份报告比较。blocker 实质减少或影响下降为 `advancing`；同一 blocker 无新证据重复、没有实质减少，或新增 blocker 不能归因为 `repair-regression`、`previously-hidden` 或 `critical-omission` 时为 `stalled`；修复引入更严重问题时为 `regressed`。
- `stalled`、`regressed`、自动修复预算用尽，或 reviewer 对核心标准持续冲突时，停止自动修复，不再进入实现。请求用户选择重新设计、缩小范围、补充证据、更换 reviewer、接受剩余风险、明确授权额外一轮或停止任务。
- Spec Review 为 `blocked` 且仍可继续：先解决材料决定、补充证据或修订 Spec，再重新运行 `dev-review-spec`。只有最新 Spec Review 为 `clean` 才进入批准。
- Code Review 为 `blocked` 且仍可继续：实现问题交给 `dev-implement`；Spec 问题先修订并重新完成 Spec Review 和批准。任何代码变化完成后重新运行 `dev-review-code`。
- Review 为 `incomplete`：补足独立 reviewer、稳定目标或必要证据后重试本次 Review。
- 循环在 Review 为 `clean`、用户停止、出现未决材料决定、缺少高风险授权或触发修复升级时结束。

## 5. 人类检查点

只在材料决定、Prototype 反馈、Spec 批准、高风险动作授权和修复升级处暂停。用户原始请求已经授权后续非人类阶段时，可以在其它检查点之间继续推进。

## 输出

```text
保障等级：Fast / Standard / Assured
当前阶段：<阶段>
任务目录：<路径 / 无>
下一能力：<Skill / 无>
原因：<关键缺口或风险>
人类检查点：<无 / 材料决定 / 原型反馈 / Spec 批准 / 高风险授权 / 修复升级>
```

选择能力后加载并执行它。触发修复升级时不再加载实现或复审能力，只报告当前阻塞和用户可选动作。
