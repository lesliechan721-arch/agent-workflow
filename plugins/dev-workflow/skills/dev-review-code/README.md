# 代码审查

独立审查代码改动、阶段结果、diff、branch 或 PR 的需求符合度和工程质量。可以单独调用，审查期间不修改代码、测试、Spec 或共享工作状态。

Fast、Standard 或未指定保障时，一个独立 reviewer 覆盖两个审查轴；Assured 或用户要求独立双轴时，由两个 reviewer 分别审查。必需 reviewer 不可用、未完成或目标变化时，报告 incomplete。

报告给出 clean、blocked 或 incomplete，说明范围、版本、证据和 blocker 的关闭条件。阶段 clean 只支持相关下游继续；最终审查覆盖原始任务的完整集成结果。复审会核对旧问题的实际关闭证据。

默认在对话中报告；需要持久记录时遵循用户路径或仓库约定。阶段报告与最终报告分开保存。Assured 或用户要求保留历史时额外保存报告版本。

```text
使用 dev-review-code 审查当前权限核心阶段，判断是否可以开展下游工作，不修复代码。
```

审查不授予修复、提交或后续执行权限。执行说明见 [SKILL.md](SKILL.md)。
