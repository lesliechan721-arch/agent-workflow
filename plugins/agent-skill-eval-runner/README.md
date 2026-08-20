# agent-skill-eval-runner

Optional execution plugin for independently audited Agent Skill evals.

It consumes `EvalExecutionPlan`, runs each admitted case in a provider process against a per-run
Skill snapshot, and emits `EvalRunBundle`. It does not design cases, approve Oracle, attribute
failures to the Skill, modify production Skills, publish reports, or maintain project
batch/currentness state.

## Dependency

Install `agent-skill-toolkit >= 0.4.0` manually until plugin dependencies are supported.

## Evidence boundary

- `with-skill` uses the plan target digest.
- `without-skill` has no Skill path or digest.
- `previous-version` requires a separately bound path and digest.
- `independentContext` reflects provider clean-context capability; a new process or file snapshot
  alone is not enough.
- The runner rechecks source Skill digests after execution. Snapshots reduce accidental mutation,
  but are not an operating-system sandbox.

## Providers

- `command`: explicit executable and argv template; no shell; makes no clean-context, grading, trace
  or baseline claim beyond its capability document.
- `codex-trigger`: reuses the installed AW CLI Codex app-server driver for strict, with-skill
  trigger discovery. Set `AW_CODEX_EVAL_DRIVER_ROOT` to the built `packages/cli/dist/scripts`
  directory. Behavior and baseline runs remain provider-specific.

Supported command placeholders are `{prompt}`, `{caseId}`, `{configuration}`, `{skillPath}`, and
`{outputDir}`. Environment inheritance is explicit and disabled by default.

## Validation

```bash
node skills/run-agent-skill-evals/scripts/validate-eval-execution-plan.mjs <plan.json>
node skills/run-agent-skill-evals/scripts/run-agent-skill-evals.mjs <plan.json> --validate-only
pnpm plugin:test agent-skill-eval-runner
```
