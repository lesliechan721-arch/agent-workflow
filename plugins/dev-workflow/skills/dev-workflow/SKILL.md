---
name: dev-workflow
description: 当用户明确要求使用结构化开发流程、启动或继续跨步骤开发任务，或已有 Shape、Spec、Review、work、diff、branch 或 PR 需要根据生命周期状态选择下一阶段时使用。它是可选宏入口；普通明确的小改动或用户直接请求某个专业能力时不要使用。
---

# Dev Workflow

你是可选的开发生命周期路由器。保障等级决定必需 gate，当前工件决定最早未满足 gate。

## 1. 识别目标和工件

读取用户最终目标，以及已有的 Shape/决策记录、Prototype verdict、Spec、Spec Review、批准、`work.md`、实现和 Code Review。

用户要求“实现”“开发”或“做一个功能”只表达最终目标，不证明任务已经可以直接实现。

## 2. 选择最低足够保障

- **Fast**：结果、范围和验证均明确，风险低、可逆、一个上下文完成，并且没有材料决定或证据缺口。
- **Standard**：中等范围、需要 Shape、跨会话、正式批准或 Review。
- **Assured**：安全、权限、支付、持久数据、迁移、生产副作用、不可逆操作、多 Agent 或缺少可靠测试。

## 3. 得出必需 gate

- Fast：`ready-to-build → build → verify → code-review`。
- Standard：`shape → spec → spec-review → approval → build → code-review`。
- Assured：Standard 全部 gate，加项目级隔离、证据、授权、回滚和独立最终审查。

Fast 只有以下条件全部成立时才满足 `ready-to-build`：

1. 用户可观察结果清楚；
2. 范围和非目标清楚；
3. 没有未解决材料决定；
4. 不需要 Prototype、实验或测量；
5. 风险低、可逆、影响范围小；
6. 验证方式清楚可靠；
7. 预计一个上下文完成。

任何一项不确定，都不能因为用户使用了“实现”而跳到 Build。

## 4. 进入最早未满足 gate

- Shape 尚不足以支撑后续工作 → `decision-shape`。
- Shape 已完整，但 Spec 不存在或需要修订 → `dev-spec`。
- Spec 尚未正式审查，或修订后需要复审 → `dev-review-spec`。
- Spec Review 为 `clean` 但尚未批准 → 请求用户明确批准。
- Fast 已满足 ready-to-build，当前 Spec 已批准，或 Code Review 需要实现修复 → `dev-implement`。
- 实现和验证完成，或修复后需要复审 → `dev-review-code`。

一次只加载当前 gate 的一个专业 Skill。Shape 内部的问答与 Prototype 选择由 `decision-shape` 负责。

## 5. 任务目录

优先使用用户路径或仓库约定。Standard 和 Assured 都没有约定时使用：

```text
docs/dev/<task-slug>/
```

进入 Shape 时，把需要的持久路径作为调用上下文提供给 `decision-shape`，例如：

```text
需要跨会话保存时，把当前 Shape 写到
`docs/dev/<task-slug>/decisions.md`。
```

Fast 不为流程本身创建文档。

## 6. Review 结果

- `clean`：Spec Review 后进入批准；Code Review 后进入交付。
- `blocked`：按 finding 的实质修订 Shape、Spec 或实现。
- `incomplete`：补足 reviewer、稳定目标或证据后重试。
- 需要材料决定、风险授权或用户选择时停在人类检查点。

只有存在 `blocked` 正式 Review 且用户授权自动继续时，才读取 [Review 修复](references/review-repair.md)。

选择能力后简短说明当前保障等级、阶段、下一能力和主要依据。进入人类检查点时，不加载后续实现或复审能力。
