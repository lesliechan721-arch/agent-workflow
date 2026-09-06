# AW Eval runtime 适配

AW 负责 materialization 和 target/profile 选择，不负责通用模型执行语义。本 reference 只用于用户明确要求的 Release Check；普通 Quality Review 不运行或消费 Eval 执行结果，也不声明 Eval 执行事实。

- Release Check 缺少 required Eval 证据时，把已有 EvalSpec+EvalAudit，或 plugin/Skill/suite/profile/case/split 条件交给 Runner；Reviewer 不复制其准备、授权或执行规则。
- Runner 返回已验证的 Eval 证据链，或明确的阻断结果。Eval 分支被阻断时，静态 Review 可以继续。
- 把证据交给公开 Release Check，并以其 receipt 为机器结论。Reviewer 不重算绑定、运行数量、通过率、baseline 或执行模式规则。
- clean success 不需要 triage。异常结果可交给 Runner 诊断，但诊断不是 Release Check 证据。
- AW 不会把旧项目报告 publish/release、README 登记、旧 batch/report 或 currentness 迁移到 Runner。
