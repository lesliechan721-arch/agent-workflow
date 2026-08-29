# Dev Workflow

用轻量、可组合的 Skill 组织中大型开发任务。每个专业 Skill 都可以直接使用；`dev-workflow` 只在需要保障分级、生命周期选路或跨阶段继续时充当宏入口。

## 安装

`dev-workflow` 依赖 `ask-me`，CLI 安装依赖时会一并处理：

```bash
aw install dev-workflow -p both
```

## 生命周期

```text
Shape
→ Spec
→ Spec Review
→ 用户批准
→ Build
→ Code Review
→ 交付
```

Fast / Standard / Assured 只决定必需 gate 和保障强度。当前阶段由现有工件和最早未满足 gate 决定。

## Skill

| Skill | 作用 |
| --- | --- |
| `dev-workflow` | 可选宏入口；选择保障等级并从最早未满足 gate 继续 |
| `dev-spec` | 把当前 Shape 和已确认决定整理为 Spec |
| `dev-review-spec` | 用 fresh 独立 reviewer 审查 Spec |
| `dev-implement` | 实现明确请求、批准 Spec 或 Review 修复 |
| `dev-review-code` | 用 fresh reviewer 双轴审查实现 |

Shape 阶段由 `ask-me` 的 `decision-shape` 完成。`dev-workflow` 不直接选择 `decision-grill` 或 `decision-prototype`。

## 使用方式

知道当前需要什么时，可以直接调用专业 Skill：

```text
把当前 Shape 整理成 Spec。
正式审查这份 Spec 是否可以批准。
按已批准 Spec 开始实现。
审查当前 diff 的规格符合度和工程质量。
```

需要自动选择保障等级和当前 gate 时，显式使用 `dev-workflow`。

## Fast readiness

只有以下条件全部明确时才可以直接实现：

- 用户可观察结果；
- 范围和非目标；
- 没有材料未决项；
- 不需要体验、实验或测量；
- 风险低、可逆、影响小；
- 验证方式可靠；
- 一个上下文可以完成。

用户使用“实现”“开发”或“做一个功能”只表达最终目标，不表示可以跳过前置 gate。

## 默认任务目录

优先使用用户路径或仓库约定。Standard 和 Assured 都没有约定时使用：

```text
docs/dev/<task-slug>/
├── decisions.md
├── prototypes/
├── spec.md
├── spec-review.md
├── work.md
└── code-review.md
```

路径由 `dev-workflow` 提供给各专业 Skill。`decision-shape` 本身不内置该目录。

## Review

- `clean`：Spec Review 后进入批准；Code Review 后进入交付。
- `blocked`：根据 finding 的实质修订 Shape、Spec 或实现。
- `incomplete`：补足 reviewer、稳定目标或证据后重试。
- 自动修复仍按条件加载 `review-repair.md`，一次自动循环后未 clean 就停在人类检查点。
- 每个 blocker 必须说明材料影响和可验证关闭条件；偏好性改进不进入批准或交付门槛。

## 输出与工件

- 路由摘要是给用户看的说明，不是 Skill 间函数返回。
- Spec、work 和 Review 报告是跨会话工件。
- Review 报告保留 `clean / blocked / incomplete`，因为它是实际门槛。
- 非 Review Skill 不维护状态枚举或固定下一 Skill 字段。
