# AW Eval runtime 适配

AW 负责 materialization 和 target/profile 选择，不负责通用模型执行语义。本 reference 只用于用户明确要求的 Release Check；普通 Quality Review 不运行或消费 Eval 执行结果，也不声明 Eval 执行事实。

- Release Check 缺少 required Eval 三件套时，Runner 可接受已有 EvalSpec+EvalAudit，或 plugin/Skill/suite/profile/case/split 条件。后者先调用 `aw skill eval prepare`，为一个 suite/profile 生成 `EvalSpec v1` 和 selected cases。
- Runner 在全新上下文取得 exact 绑定的 `EvalAudit v1`。Audit fail 时停止 Eval 分支，静态 Review 可以继续。
- Engine 只执行 Audit 已通过的 Spec：`aw-skill-eval run <spec.json> --audit <audit.json>`，并生成绑定 Spec、Audit、target、cases 和 provider 的 `EvalResult v1`。
- Release Check 对每个适用的 release-required profile×suite 检查 EvalSpec、EvalAudit、EvalResult，以及当前 manifest corpus、required case 的 minimum runs、完成状态、grade 通过率和 baseline 回归。任一链缺失时阻止发布；这本身不是 Skill 缺陷。
- clean success 不需要 triage。失败结果可交给 Runner triage 诊断，但 triage 不作为 Release Check 输入、证据或 machine gate。
- AW 不会把旧项目报告 publish/release、README 登记、旧 batch/report 或 currentness 迁移到 Runner。
