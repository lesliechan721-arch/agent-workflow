# Audit Agent Skill Evals

只读审核 Skill Eval 的 Oracle、用例质量和运行后失败归因。

## 适合使用

- 真实模型运行前，检查 case 是否有效、可判定且没有把实现细节当结果。
- 运行后区分 Skill 缺陷、环境问题、runner 问题、grader 问题和正常方差。
- 判断某次失败是否足以驱动 Skill 修改。

该 Skill 不修改 Skill 或 Eval。需要修复用例时使用 `design-agent-skill-evals`，需要修改 Skill 时使用 `author-agent-skill`。

主要指令见 [`SKILL.md`](SKILL.md)。
