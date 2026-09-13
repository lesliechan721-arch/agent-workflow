# simplify-agent-skill Eval

本测试资产使用 AW Selected Cases v1 / Manifest v1，由当前项目公开 parser 核验格式。适配字段的权威说明在 Runner 的 `references/aw-eval-profile.md`，真实 parser 高于本包辅助校验器。

通用方法不绑定此测试适配格式。需要格式的作者/审核任务由 fixture 或 caller 提供合同；结构通过不代表语义通过。

Trigger 只检查任意加载；不以不是顶层 owner 禁止合法下游组合。发布候选与 diagnostic 按 manifest 区分；标为 required 不等于已通过。全体模型运行状态为 NOT_RUN。

| Case | 层 | 观测依据 | 模型状态 |
| --- | --- | --- | --- |
| `simplify_plan` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `ablation` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `reduce_controls` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `reduce_context` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `simple_typo` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `add_feature` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `readonly_score` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `run_only` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `plan_without_eval` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `comparison_evidence_gap` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `unsafe_short_candidate` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `standalone_skill_uses_direct_candidate` | candidate-routing | 独立标准 Skill 的真实候选文件 | NOT_RUN |
| `reuse_supplied_adapter_context` | candidate-routing | 已提供适配上下文的真实候选 source | NOT_RUN |

## 运行与审定

`candidate-routing` 不属于 release 必需项。先用实际 parser 和独立 Oracle 审核确认用例可执行；结构和文件断言只证明 fixture 合同，未运行模型时两个候选仍是未验证状态。额外模型运行遵守现有预算和授权。

一般格式示例属于测试输入，不要求模型采用 AW 作为所有消费者格式；未知外部事实不由 prompt 自称证明。真实集成责任与未验证项见[迁移记录](../../../../../docs/skill-toolkit-migration.md)。
