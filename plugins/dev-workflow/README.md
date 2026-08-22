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
| `dev-workflow` | 可选宏入口；按风险和现有产物选择当前阶段 |
| `dev-spec` | 把稳定决定整理为 Spec |
| `dev-review-spec` | 用独立 reviewer 审查 Spec，并说明修订与复审条件 |
| `dev-implement` | 实现明确请求、已批准 Spec 或 Review 修复 |
| `dev-review-code` | 用两个独立 reviewer 分轴审查实现，并说明修复与复审条件 |

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

### Standard

```text
decision-grill / decision-prototype
→ dev-spec
→ dev-review-spec
→ blocked 时修订并重新审查
→ 用户批准
→ dev-implement
→ dev-review-code
→ blocked 时修复并重新审查
→ clean 后交付
```

### Assured

沿用 Standard 路径，并按项目风险增加持久证据、回滚点、隔离、授权和独立最终审查。

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

文件按需创建。Fast 路径不为流程本身创建文档。

## Review 报告

- `spec-review.md` 和 `code-review.md` 保存当前正式结果；新一轮 Review 默认覆盖旧结果。
- 报告写明本次审查的目标与版本。目标发生变化后，需要重新 Review。
- Assured 模式或用户明确要求保留历史时，额外归档到 `reviews/spec/` 或 `reviews/code/`。
- Spec Review 使用一个 fresh 独立 reviewer；Code Review 并行使用两个 fresh 独立 reviewer。

专业 Skill 返回中性的建议动作；具体 Skill 选择由用户或 `dev-workflow` 完成。
