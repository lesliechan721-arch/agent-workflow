# author-agent-skill Eval

本测试资产使用 AW Selected Cases v1 / Manifest v1，由当前项目公开 parser 核验格式。适配字段的权威说明在 Runner 的 `references/aw-eval-profile.md`，真实 parser 高于本包辅助校验器。

通用方法不绑定此测试适配格式。需要格式的作者/审核任务由 fixture 或 caller 提供合同；结构通过不代表语义通过。

Trigger 只检查任意加载；不以不是顶层 owner 禁止合法下游组合。发布候选与 diagnostic 按 manifest 区分；标为 required 不等于已通过。全体模型运行状态为 NOT_RUN。

| Case | 层 | 观测依据 | 模型状态 |
| --- | --- | --- | --- |
| `create_package` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `change_description` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `design_cases` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `fix_skill_typo` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `readonly_review` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `audit_cases` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `execute_evals` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `explain_package` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `small_delta_no_new_artifacts` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `create_minimal_package` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `eval_design_only` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `public_composition_without_rpc` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `manual_callee_stays_user_macro` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `same_context_skill_no_rpc` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `consumer_format_not_forced_to_aw` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |

## 运行与审定

先用实际 parser 和独立 Oracle 审核确认用例可执行。源行为有真实文件；CLI deny fixture 只证明拒绝边界，不证明产品成功、安全权限或远端发布。额外模型运行遵守现有预算和授权。

一般格式示例属于测试输入，不要求模型采用 AW 作为所有消费者格式；未知外部事实不由 prompt 自称证明。真实集成责任与未验证项见[迁移记录](../../../../../docs/skill-toolkit-migration.md)。

`eval_design_only` 的 runner-contract.md 是本次 caller 明确提供的 AW profile fixture；`consumer_format_not_forced_to_aw` 用另一种明确 JSONL 合同形成对照。不为通过测试要求 Author 自带 AW 字段。
