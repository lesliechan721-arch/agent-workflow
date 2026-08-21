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

- Spec Review 为 `blocked`：先解决材料决定、补充证据或修订 Spec，再重新运行 `dev-review-spec`。只有最新 Spec Review 为 `clean` 才进入批准。
- Code Review 为 `blocked`：实现问题交给 `dev-implement`；Spec 问题先修订并重新完成 Spec Review 和批准。任何代码变化完成后重新运行 `dev-review-code`。
- Review 为 `incomplete`：补足独立 reviewer、稳定目标或必要证据后重试本次 Review。
- 循环在 Review 为 `clean`、用户停止、出现未决材料决定或缺少高风险授权时结束。

## 5. 人类检查点

只在材料决定、Prototype 反馈、Spec 批准和高风险动作授权处暂停。用户原始请求已经授权后续非人类阶段时，可以在检查点之间继续推进。

## 输出

```text
保障等级：Fast / Standard / Assured
当前阶段：<阶段>
任务目录：<路径 / 无>
下一能力：<Skill>
原因：<关键缺口或风险>
人类检查点：<无 / 材料决定 / 原型反馈 / Spec 批准 / 高风险授权>
```

选择能力后加载并执行它，而不是只返回能力清单。
