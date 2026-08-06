# Official Agent Skills Basis

本文件是基于 Agent Skills 官方文档整理的评审基线，记录日期：2026-08-06。release 评审应再核对当前官方页面，避免规范变化。

## Specification

- Skill 至少包含 `SKILL.md`，由 YAML frontmatter 和 Markdown 正文组成。
- `name` 必填，1–64 字符，小写字母、数字和单连字符，且与父目录一致。
- `description` 必填，1–1024 字符，应说明能力和使用时机。
- `compatibility` 可选，1–500 字符，只在有实际环境要求时使用。
- `metadata` 是字符串键值映射；`allowed-tools` 为实验字段，支持度可能不同。
- `scripts/`、`references/`、`assets/` 为可选组织约定。
- 核心 `SKILL.md` 建议少于 500 行和 5000 token；资源按需加载。
- 文件使用 skill 根目录相对路径，避免深层引用链。
- 可使用 `skills-ref validate <skill-dir>` 验证规范。

## Best practices

- 从真实任务、项目材料和失败案例提炼 Skill。
- 用真实执行结果和 trace 迭代，并持续询问哪些内容可以删除。
- 只添加模型不知道或会稳定做错的内容。
- Skill 应是连贯工作单元；过宽难触发，过窄导致多个 Skill 冲突。
- 保持中等细节；覆盖每个边界可能降低表现。
- 脆弱流程更具体，灵活任务保留判断；提供默认值而非菜单。
- 方法和程序优先于特定实例答案。
- gotcha、短模板、checklist、validation loop 和 plan-validate-execute 可提高可靠性。
- 模型重复重写确定逻辑时，考虑打包经过测试的脚本。

## Description optimization

- Description 承担触发职责，应以用户意图和使用时机为中心。
- 准备现实正负查询，尤其是 near-miss。
- 建议约 20 条、每条多次运行，计算触发率。
- 固定 train/validation 划分，避免针对具体措辞过拟合。

## Scripts

- 简单 one-off 命令可直接引用；复杂命令应移入经过测试的脚本。
- 使用相对路径，明确列出脚本用途。
- 脚本应自包含或清楚声明、固定依赖。
- 必须非交互，提供 `--help` 和可操作错误。
- 优先结构化 stdout，诊断写 stderr。
- 考虑幂等、输入约束、dry-run、安全默认值、退出码和输出大小。

## Source pages

- https://agentskills.io/specification
- https://agentskills.io/skill-creation/best-practices
- https://agentskills.io/skill-creation/optimizing-descriptions
- https://agentskills.io/skill-creation/using-scripts
