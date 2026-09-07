# review-agent-architecture Eval

本测试资产使用 AW Selected Cases v1 / Manifest v1，由当前项目公开 parser 核验格式。适配字段的权威说明在 Runner 的 `references/aw-eval-profile.md`，真实 parser 高于本包辅助校验器。

通用方法不绑定此测试适配格式。需要格式的作者/审核任务由 fixture 或 caller 提供合同；结构通过不代表语义通过。

Trigger 只检查任意加载；不以不是顶层 owner 禁止合法下游组合。发布候选与 diagnostic 按 manifest 区分；标为 required 不等于已通过。全体模型运行状态为 NOT_RUN。

| Case | 层 | 观测依据 | 模型状态 |
| --- | --- | --- | --- |
| `portfolio` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `workflow` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `public_surface` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `contracts` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `leaf_quality` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `app_architecture` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `implement_plugin` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `read_help` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `public_surface_fragmentation` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `manual_dependency_unreachable` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `validation_loop_not_consumer` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `facade_proportionate_pair` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |
| `standards_placement_not_skill_count` | behavior | 给定文件、修改范围和可观察断言 | NOT_RUN |

## 运行与审定

先用实际 parser 和独立 Oracle 审核确认用例可执行。源行为有真实文件；CLI deny fixture 只证明拒绝边界，不证明产品成功、安全权限或远端发布。额外模型运行遵守现有预算和授权。

一般格式示例属于测试输入，不要求模型采用 AW 作为所有消费者格式；未知外部事实不由 prompt 自称证明。真实集成责任与未验证项见[迁移记录](../../../../../docs/skill-toolkit-migration.md)。
