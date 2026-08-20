# AW ReviewInputBundle

The adapter accepts an AW plugin root containing `.agents-plugin/plugin.json`.

```bash
node scripts/prepare-aw-review-bundle.mjs <plugin-root> \
  --repo-root <workspace-root> \
  --source agent-content-toolkit=<path> \
  --source agent-skill-toolkit=<path> \
  --final codex-project=<materialized-dir> \
  --eval-audit <eval-audit-result.json> \
  --eval-case <trigger-cases.json> \
  --eval-result <eval-run-bundle.json>
```

Artifact roles are `source`, `final`, `evidence`, and `project-profile`. Every artifact records
path, profile, digest, currentness and owner.

`providedStages` records only completed stages. Each result file must exist inside the handoff root
and pass `validate-review-input-bundle.mjs`; a non-empty path or final artifact does not prove
review completion.

After plugin-level evidence is prepared, use `prepare-aw-review-targets.mjs` to create one
deterministic generic review target per source Skill and materialized profile.

`prepare-aw-review-targets.mjs --bundle <plugin-bundle.json>` 按 `targetSkillDigest` 将 audit/run
evidence 投影到对应 source/final Skill；不匹配证据不会复制。Stage `resultPath`
使用可验证的本地路径，handoff validator 仍要求它位于显式 handoff root 内。
