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

## 4. 消费 Review 结果

- `clean`：Spec Review 后进入批准；Code Review 后进入交付。
- `blocked`：根据主要 finding 的类型选择一个修复能力。实现问题进入实现；Spec 问题先修订 Spec，并重新完成规格审查和批准。
- `incomplete`：补足缺失的 reviewer、稳定目标或必要证据，然后重新执行同一 Review。
- Review 要求停止，或下一步需要新的材料决定、风险授权或用户选择：停在人类检查点，不继续自动修复。

只有存在 `blocked` 的正式 Review，并且用户已经授权自动继续时，才读取 [Review 修复](references/review-repair.md)。Fast、首次 Review 和直接专业调用不读取该文件。

## 5. 人类检查点

只在材料决定、Prototype 反馈、Spec 批准、高风险动作授权和 Review 修复升级处暂停。用户原始请求已经授权后续非人类阶段时，可以在其它检查点之间继续推进。

## 输出

```text
保障等级：Fast / Standard / Assured
当前阶段：<阶段>
任务目录：<路径 / 无>
下一能力：<Skill / 无>
原因：<关键缺口或风险>
人类检查点：<无 / 材料决定 / 原型反馈 / Spec 批准 / 高风险授权 / Review 修复升级>
```

选择能力后加载并执行它。进入人类检查点时，不再加载后续实现或复审能力。
