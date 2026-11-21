# Audit Agent Skill Evals

只读审核 Skill Eval 的前提、Oracle 与错误代价，归因已有运行中的失败、混合结果和回归，并按运行器合同执行正式准入（`preflight`）。

源用例可直接审核；正式运行准入需要实际运行器提供输入、格式与校验能力，参与了同一 Oracle 设计的上下文不能签发独立通过。

例如：“先审核这些用例的 Oracle 和 fixture 是否成立，不运行模型。”或“归因这组 Eval 的失败与回归，不改生产 Skill。”此能力不修改生产 Skill、不运行模型，也不作发布决定。
