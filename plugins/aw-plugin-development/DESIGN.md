# AW adapter design

## Why two skills

`author-aw-plugin` and `review-aw-plugin` remain separate because they have independent user intents, different permissions, different evidence lifecycles and a deliberate clean-context boundary. A single `aw-plugin` Skill would recreate the former overload.

## Three-layer dependency

- `agent-content-toolkit` owns Agent-facing prose authoring and read-only content/reference review.
- `agent-skill-toolkit` owns generic Agent Skill authoring, review and Eval design/audit.
- this plugin owns only AW manifest, source/final mapping, build, materialization, project Eval runtime and report publication adaptation.

Both adapters check the required generic Skills and stop if any are missing. They do not carry fallback rubrics.

## Isolated stages

The following stages use a fresh context when non-trivial:

- generic Skill authoring;
- Eval design;
- Eval Oracle preflight;
- reference/content audit;
- source and materialized final review;
- Eval result triage.

The current harness or delegation Skill chooses the concrete subagent mechanism. Stage output must be a schema-valid artifact, not a prose recap in the parent context. Artifact availability is not stage completion: a final Skill tree does not mean it has already been reviewed.
