# Stage handoffs

`ReviewInputBundle.orchestration.providedStages` is an index, not evidence by itself. A caller cannot establish completion by writing the expected fields. Reuse a stage only after the bundled validator proves the target, producer, schema, result and digests agree.

## Generic review-stage envelope

`reference-audit`, `source-skill-review` and `materialized-profile-review` use one workspace-local envelope:

```json
{
  "schemaVersion": 1,
  "stageId": "reference-audit",
  "producer": "review-agent-content",
  "independentContext": true,
  "target": {
    "path": "plugins/example/skills/example",
    "digest": "sha256:..."
  },
  "resultSchema": "ReferenceAuditResult",
  "result": {}
}
```

Create the target digest with the same deterministic implementation used by validation:

```bash
node scripts/validate-review-stage-result.mjs \
  --digest-only <target> \
  --repo-root <workspace-root>
```

Store the envelope outside the target it hashes. Then validate it:

```bash
node scripts/validate-review-stage-result.mjs \
  <stage-envelope.json> \
  --repo-root <workspace-root> \
  --format json
```

Only the returned `stage` object may be inserted into `providedStages`. The validator enforces the stage-specific producer and result schema, requires `independentContext=true`, hashes the current target, validates the embedded result, and binds `ReviewResult.target.digest` where applicable.

## Eval stages

`eval-audit` and `eval-result-triage` continue to point directly to a schema-valid `EvalAuditResult`. Their mode, producer, independent-context declaration, corpus digest and file digest are checked when the bundle is verified.

## Consumer gate

Before a Reviewer reuses any provided stage, validate the complete bundle:

```bash
node scripts/validate-review-stage-result.mjs \
  --verify-bundle <review-input-bundle.json> \
  --repo-root <workspace-root> \
  --format json
```

Bundle verification rejects stale targets, changed result files, mismatched stage metadata, duplicate stage/target pairs, paths outside the workspace, false independent-context claims and invalid Eval handoffs. A rejected stage is missing evidence: follow `stageOwner` and either have the correct owner reproduce it or record the affected branch as blocked/unknown. Do not convert rejection into a production-Skill finding.
