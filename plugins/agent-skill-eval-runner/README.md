# agent-skill-eval-runner

Manual orchestration plugin for independently audited Agent Skill evals.

Current plugin contract version: `0.3.0`.

It checks the human authorization gate and preflight `EvalAuditResult`, then calls the shared
`aw-skill-eval` command to validate and run an `EvalExecutionPlan`. It hands the resulting
`EvalRunBundle` to `audit-agent-skill-evals(result-triage)`. It does not implement providers,
snapshots, process control, timeout handling, evidence grading, machine schemas, or validators.

## Dependency

Before use, manually install:

- `agent-skill-toolkit >= 0.5.0`
- `@lesliechan721/agent-skill-eval >= 0.1.0-beta.2`, with `aw-skill-eval` on `PATH`

Do not use `npx`. This plugin does not install dependencies or access the network implicitly.

## Use

Use `$run-agent-skill-evals` explicitly and provide the plan path. The Skill stops unless the user
has authorized model cost, external processes, credentials, network access, and temporary output
that the plan requires.

The package follows the AW lockstep version, so it has no independent SemVer upper bound. The Skill
fails closed unless the bin exists and runtime capabilities v1 and plan/audit/bundle schema v2 are
compatible. It does not use a
Skill-local script, provider, schema copy, or validator as the execution path.

## Boundary

- The preflight audit must come from `audit-agent-skill-evals` and match the current Skill and case
  corpus digests.
- The shared package owns provider execution, runtime snapshots, process cleanup, timeout,
  capture, bundle validation, and evidence-level calculation.
- Result interpretation and failure attribution belong to a fresh-context
  `audit-agent-skill-evals(result-triage)` handoff.
- This plugin does not modify production Skills or publish final reviews.
