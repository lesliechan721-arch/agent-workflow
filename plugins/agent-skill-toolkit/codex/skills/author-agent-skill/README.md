# author-agent-skill

创建或变更一个通用 Agent Skill package，并完成修改范围内的确定性验证。

## 适合使用

- 新建或重写 `SKILL.md`，调整 description、invocation 或职责边界。
- 维护直接 references、scripts、assets、平台元数据或作者期 Eval 资产。
- 对少量已知文件做有界变更，并验证受影响的结构、引用和脚本接口。

维护由 `.agents-plugin/plugin.json` 标识的 AW 插件根时，无论目录布局如何，都使用 `author-aw-plugin` 处理 manifest、构建和插件级合同；它会按需组合本 Skill 修改插件内的 Skill。

## 工作方式与边界

本 Skill 会写入用户允许的 Skill package，并运行修改范围内的确定性自检。它不自动启动独立 Review、Eval Audit 或模型 Eval，也不作发布裁决；这些能力只在用户或上层工作流明确请求时单独组合。
