# develop-aw Eval

本测试资产使用 AW Selected Cases v1 / Manifest v1，由当前项目公开 parser 核验格式。适配字段的权威说明在 Runner 的 `references/aw-eval-profile.md`，真实 parser 高于本包辅助校验器。

项目与 Runner 案例只证明实际执行的范围。`simplify-fixtures` 会真实写出两个隔离 final 和两个 test-only binding，但只证明命令路由、同 profile 选择与文件范围；它不证明生产 renderer、canonical binding、Audit、模型行为或生产 apply。

Trigger 只检查任意加载；不以不是顶层 owner 禁止合法下游组合。发布候选与 diagnostic 按 manifest 区分；标为 required 不等于已通过。全体模型运行状态为 NOT_RUN。

| Case | 层 | 观测依据 | 模型状态 |
| --- | --- | --- | --- |
| `init_catalog` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `edit_plugin` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `remove_plugin` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `activate_local` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `review_only` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `generic_skill` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `run_only` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `plain_project` | trigger | 观测期是否加载，不测试首个入口 | NOT_RUN |
| `cli_unavailable_stops` | diagnostic | 方法或明确拒绝替身，仅限诊断 | NOT_RUN |
| `publisher_not_auto_dependency` | diagnostic | 方法或明确拒绝替身，仅限诊断 | NOT_RUN |
| `prepare_isolated_unverified_candidate` | simplification | 真实候选 source、受控 CLI 路由与隔离 final 文件 | NOT_RUN |
| `only_final_has_no_production_source` | simplification | only-final 来源缺口与不写边界 | NOT_RUN |
| `shorter_source_same_final` | simplification | 给定 source/final 的关键对照 | NOT_RUN |
| `second_candidate_provider_drift` | simplification | provider 变化后的绑定停止条件 | NOT_RUN |

## 运行与审定

新 simplification suite 不属于 release 必需项。先用实际 parser 和独立 Oracle 审核确认用例可执行；只有得到模型运行授权后才能建立行为结果。CLI deny fixture 只证明拒绝边界，simplify fixture 只证明明确列出的路由副作用。

一般格式示例属于测试输入，不要求模型采用 AW 作为所有消费者格式；未知外部事实不由 prompt 自称证明。真实集成责任与未验证项见[迁移记录](../../../../../docs/skill-toolkit-migration.md)。
