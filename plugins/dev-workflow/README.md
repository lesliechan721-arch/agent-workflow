# Dev Workflow

用轻量、可组合的 Skill 组织中大型开发任务。每个专业 Skill 都可以独立调用；`dev-workflow` 只是可选的宏入口，用于选择保障等级、恢复阶段和管理人类检查点。

## 安装

```bash
aw install dev-workflow -p both
```

## Skill

| Skill | 作用 |
| --- | --- |
| `dev-workflow` | 可选宏入口；按风险和已有产物选择当前阶段 |
| `dev-spec` | 把稳定材料决定整理为 Spec |
| `dev-review-spec` | 在 fresh 独立上下文中审查 Spec |
| `dev-implement` | 实现明确请求或已批准 Spec |
| `dev-review-code` | 用两个独立 reviewer 分轴审查实现 |

## 使用方式

知道当前需要什么时，可以直接调用专业 Skill：

```text
审查这份 Spec 是否可以批准。
审查这个 PR 的需求符合度和工程质量。
按当前 Spec 开始实现。
```

需要自动选择流程时，再显式使用 `dev-workflow`。

## 保障等级

- **Fast**：明确、低风险、可逆、单上下文并且有可靠验证。
- **Standard**：中等范围、存在材料决定、需要跨会话或正式 Review。
- **Assured**：安全、权限、支付、数据迁移、生产副作用、不可逆或多 Agent。

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

## Review 与历史

- 正式 Review 必须由 fresh 独立子代理上下文完成；当前调用上下文只负责准备输入和保存结果。
- `dev-review-spec` 使用一个独立 reviewer。
- `dev-review-code` 并行使用 Spec fidelity 与 Engineering quality 两个独立 reviewer。
- 默认覆盖 `spec-review.md` 或 `code-review.md`，Git 保存历史。
- Assured 模式或用户明确要求保留历史时，额外保存到 `reviews/spec/` 或 `reviews/code/`。
- 每份报告绑定实际审查的 Spec revision、commit range 或 diff revision；目标变化后必须重新审查。

插件不创建 `task-state.json`，也不维护 Review pointer、round lineage 或 finding registry。
