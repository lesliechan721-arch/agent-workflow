# Review AW Plugin

只读评审 AW 插件源码、最终物化产物和 Eval 证据，并给出发布准备度结论。

## 检查重点

- manifest、平台能力和 invocation 是否一致。
- Codex 与 Claude Code 最终产物是否符合源码意图。
- Author 与 Reviewer 权限是否分离。
- 确定性测试和真实模型证据是否支持结论。
- 报告中的未知项和未运行项是否明确。

该 Skill 不修改生产源码、README 或 manifest。正式报告发布需要单独授权；报告登记和版本更新交给 `author-aw-plugin` 或项目 release 工具。

repo-local 或 portable Agent Skill 直接使用 `review-agent-skill`。

主要指令见 [`SKILL.md`](SKILL.md)。
