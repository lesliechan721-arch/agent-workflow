# agent-skill-eval-runner

Optional execution plugin for audited Agent Skill evals.

It consumes `EvalExecutionPlan`, runs each admitted case in a fresh provider process, and emits `EvalRunBundle`. It does not design cases, approve Oracle, attribute failures to the Skill, modify production Skills, publish reports, or maintain project batch/currentness state.

## Dependency

Install `agent-skill-toolkit >= 0.4.0` manually until plugin dependencies are supported.

## Provider

The first provider is a portable command provider. The plan supplies an executable and argv template; the runner never invokes a shell. Environment inheritance is explicit and disabled by default. Supported placeholders are `{prompt}`, `{caseId}`, `{configuration}`, `{skillPath}`, and `{outputDir}`.

## Built-in providers

- `command`: portable explicit argv provider; makes no clean-context or baseline claims.
- `codex-trigger`: reuses the installed AW CLI Codex app-server driver for strict, with-skill trigger discovery. Set `AW_CODEX_EVAL_DRIVER_ROOT` to the built `packages/cli/dist/scripts` directory. Behavior and baseline runs remain provider-specific.

## Validation

```bash
node scripts/validate-eval-execution-plan.mjs <plan.json>
node scripts/run-agent-skill-evals.mjs <plan.json> --validate-only
pnpm plugin:test agent-skill-eval-runner
```
