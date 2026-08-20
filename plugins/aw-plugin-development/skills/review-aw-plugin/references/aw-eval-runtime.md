# AW Eval runtime adaptation

AW owns materialization and target/profile selection. It does not own generic model execution semantics.

- Preflight uses `audit-agent-skill-evals` and binds current Skill and case corpus digests.
- A compatible optional runner consumes `EvalExecutionPlan` and returns `EvalRunBundle`.
- Missing runner means `evalEvidenceLevel=structural` and provisional release evidence, not a Skill defect.
- AW does not migrate old project report publish/release, README registration, static batch or currentness into the generic runner.
- Provider limitations such as missing Claude execution, tool trace, token usage or sandbox remain explicit in the evidence bundle.
