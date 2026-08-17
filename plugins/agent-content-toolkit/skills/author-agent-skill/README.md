# author-agent-skill

创建、重写或变更一个通用 Agent Skill 包。

## 什么时候使用

- 你要创建或修改 `SKILL.md`、description、references、scripts、assets 或平台调用元数据。
- 你需要为 Skill 定义真实任务、边界、成功标准和 Eval strategy。

不要用于 `agent-workflows` 仓库的 `plugins/<name>/` 项目工作，也不要用它给自己的结果出独立评审结论。

## 怎样调用

模型可以按任务自动调用，也可以显式使用 `$author-agent-skill`。

示例请求：

- “创建一个只读检查数据库迁移计划的 Agent Skill。”
- “收紧这个 Skill 的 description，并把确定性逻辑移到脚本。”

## 会发生什么

1. Agent 建立 Skill 目标、调用策略、范围和可观察成功标准。
2. Agent 选择最小包结构，写入或修改目标文件。
3. Agent 运行适用的确定性检查，并交付需要独立 Reviewer 判断的 unknown。

## 权限和边界

- 可以修改用户授权的 Skill 包并运行安全的确定性检查。
- 不处理 AW 项目专有版本、materialization 或发布，也不输出独立 release verdict。
