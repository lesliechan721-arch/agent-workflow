# Review Agent Skill

独立、只读、轻量评审 Agent Skill 的职责、触发边界、信息层级、最小控制和 Eval 证据。

默认流程只有两类产物：

- `SkillCheckResult`：机器检查包和 runtime closure；
- 人类可读 Review，可选附带 `ReviewResultLite`。

本 Skill 不计算项目发布资格，不维护 profile coverage、多阶段 handoff 或加权评分。发布工具在需要时重新计算机器事实。

该 Skill 不修改生产 Skill；修复由 `author-agent-skill` 完成。主要指令见 [`SKILL.md`](SKILL.md)。
