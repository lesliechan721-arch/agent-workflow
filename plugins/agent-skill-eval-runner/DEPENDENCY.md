# Manual dependency contract

Plugin contract version: `0.3.1`.

Required plugin: `agent-skill-toolkit >= 0.5.0`.

Required package: `@lesliechan721/agent-skill-eval >= 0.1.0-beta.2`.
The package must expose the stable `aw-skill-eval` command on `PATH` before this Skill starts.
Do not use `npx`, and do not install or download the package implicitly.

Required capability: an `audit-agent-skill-evals` preflight result whose target Skill digest and
case corpus digest match the execution plan.

The package version follows the AW lockstep version and has no independent upper bound. Runtime
compatibility requires the bin to exist, capabilities schema v1, and plan, audit, and bundle schema v2. The
orchestration Skill fails closed when the command, compatible schemas, audit, or contracts are
unavailable. It does not contain a fallback runner, validator, Oracle, or review rules.
Standalone process observation does not guarantee descendant cleanup or produce comparative or
release-grade evidence. Preserve the generated bundle evidence level and limitations.
