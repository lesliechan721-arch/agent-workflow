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
its canonical POSIX path relative to `environment.repositoryRoot`, normalized regular-file mode,
content digest, profile, currentness and owner. Production source identity binds path, mode and
content SHA-256 in a versioned, length-prefixed record stream. Records use one global POSIX path
sort before hashing. `target.currentness` is required and aggregates production artifacts. Git
status, ignored production files, and index/worktree mode differences must match artifact reasons
and target dirty reasons; when Git cannot prove currentness, the value is `unknown`. Any path
segment with basename `.DS_Store` is excluded from the artifact set, digest, and currentness;
other hidden production files use the normal production rules. Ignored direct Skill Eval/report evidence
remains historical and does not dirty production source.

`providedStages` records only completed stages. Each result file must exist inside the handoff root
and pass `validate-review-input-bundle.mjs`; a non-empty path or final artifact does not prove
review completion. An `eval-result-triage` stage must bind exactly one `eval-execution` stage by
target Skill, corpus, preflight audit, plan and complete result digest. Orphan, stale and reused
triage evidence is invalid.

After plugin-level evidence is prepared, use `prepare-aw-review-targets.mjs` to create one
deterministic generic review target per source Skill and materialized profile.

`prepare-aw-review-targets.mjs --bundle <plugin-bundle.json>` 按 `targetSkillDigest` 将 audit/run
evidence 投影到对应 source/final Skill；不匹配证据不会复制。Stage `resultPath`
使用可验证的本地路径，handoff validator 仍要求它位于显式 handoff root 内。
