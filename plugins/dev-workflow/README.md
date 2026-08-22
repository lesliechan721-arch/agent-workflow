# Dev Workflow

用轻量、可组合的 Skill 组织中大型开发任务。每个专业 Skill 都可以直接使用；`dev-workflow` 只在需要风险分级、自动选路或跨阶段继续时充当宏入口。

## 安装

开发工作流依赖决策能力：

```bash
aw install ask-me -p both
aw install dev-workflow -p both
```

## Skill

| Skill | 作用 |
| --- | --- |
| `dev-workflow` | 可选宏入口；按风险和已有产物选择当前阶段 |
| `dev-spec` | 把稳定决定整理为 Spec，并归一为当前有效合同 |
| `dev-review-spec` | 用 fresh 独立 reviewer 审查 Spec |
| `dev-implement` | 以最小完整改动实现明确请求、已批准 Spec 或 Review 修复 |
| `dev-review-code` | 按保障等级用 fresh reviewer 双轴审查实现 |

决策阶段使用：

- `decision-grill`：通过讨论解决相互依赖的材料决定。
- `decision-prototype`：通过可见、可运行或可操作证据解决决定。

## 使用方式

知道当前需要什么时，直接调用专业 Skill：

```text
把这些已确认决定整理成 Spec。
正式审查这份 Spec 是否可以批准。
按当前 Spec 开始实现。
修复 Code Review 中的问题。
重新审查修复后的实现。
```

需要自动选择流程时，再显式使用 `dev-workflow`。

## 默认路径

### Fast

```text
dev-implement → 针对性验证 → 按需 dev-review-code
```

Fast 不为流程本身创建文档，也不自动进入 Review 修复循环。

### Standard

```text
decision-grill / decision-prototype
→ dev-spec
→ dev-review-spec
→ 用户批准
→ dev-implement
→ dev-review-code
→ clean 后交付
```

Review 为 `blocked` 时，入口按报告中的主要问题选择一个修复能力。用户已授权自动继续时，默认只自动完成一次“修复 → 完整复审”；复审仍未 clean 时暂停，由用户决定下一步。

### Assured

沿用 Standard 路径，并按项目风险增加持久证据、回滚点、隔离、授权和独立最终审查。Code Review 使用两个 fresh reviewer 分轴完成。多轮、可恢复的自动修复属于运行时或项目策略，不写成常驻 Skill 协议。

## Review 结果

- `clean`：Spec Review 后进入批准；Code Review 后进入交付。
- `blocked`：按 finding 类型修复材料决定、证据、Spec 或实现。
- `incomplete`：补足 reviewer、稳定目标或证据后重试同一 Review。
- Review 要求停止，或下一步需要新的材料决定、风险授权或用户选择：停在人类检查点。

初次 Review 一次列出当前证据支持的全部 blocker；偏好性改进不进入批准或交付门槛。复审重新检查当前完整目标，不只确认旧 finding。

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

文件按需创建。

## Review 报告

- `spec-review.md` 和 `code-review.md` 保存当前正式结果；新一轮 Review 默认覆盖旧结果。
- 报告写明目标、版本、保障等级、结论、findings、剩余风险和建议动作。
- 复审时按需增加“已解决 / 仍存在 / 新发现”比较，不维护轮次计数或进展状态机。
- Assured 模式或用户明确要求保留历史时，额外归档到 `reviews/spec/` 或 `reviews/code/`。

专业 Skill 返回中性的能力级建议；具体 Skill 选择由用户或 `dev-workflow` 完成。
