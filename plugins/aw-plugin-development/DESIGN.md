# AW adapter design

## Why two skills

`author-aw-plugin` and `review-aw-plugin` remain separate because they have independent user intents, different permissions, different evidence lifecycles and a deliberate clean-context boundary. A single `aw-plugin` Skill would recreate the current overload.

## Manual generic dependency

Both adapters require the generic plugin. They must check that the requested generic Skill is available and stop if it is missing. They do not carry fallback copies of the rubric.

## Isolated stages

The following stages should use a fresh context when non-trivial:

- generic Skill authoring;
- Eval design;
- Eval Oracle preflight;
- reference/content audit;
- source vs materialized final review;
- Eval result triage.

The current harness or delegation Skill chooses the concrete subagent mechanism. Stage output must be a stable artifact, not a prose recap in the parent context.
