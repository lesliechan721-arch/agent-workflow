# Lightweight Skill Review migration

## Goal

Quality review is a model judgment aided by deterministic checks. It is not a release workflow engine.

The default path is:

```text
check target
→ human quality review
→ optional ReviewResultLite
```

Project release validation remains a separate machine-owned operation.

## Contracts

### Machine check

`aw skill validate` is the shared source of truth for frontmatter profiles and Codex metadata. `check-agent-skill.mjs` adds runtime closure, local path and package checks. Both outputs are cheap to recompute and are not persisted as a handoff state machine.

### Quality review

`ReviewResultLite` v2 stays one layer and contains:

- target digest;
- `quick | full | delta`;
- one design decision and one complexity conclusion;
- a concise summary;
- findings with severity, area, evidence type, evidence, issue and action;
- decision-relevant unknowns;
- the available Eval evidence level;
- for `full`, the fixed 12 dimensions with score, confidence and one-line basis.

The validator computes weighted score, coverage and overall confidence from the 12 dimensions. This score is diagnostic only. It does not create findings or override the design decision. Without an admitted critical finding or an `over-engineered` conclusion, incomplete coverage or low confidence makes a full review `not-assessed`.

Generic release gates, stage owners, producers, independent-context declarations and machine-evidence copies are not part of the review contract.

### AW adapter

`review-aw-plugin` evaluates source and materialized Skills by unique production digest. Ordinary quality review does not produce release readiness. An explicitly requested release check uses `check-aw-plugin-release.mjs` to recompute supported profiles and machine checks. It accepts only a complete full review with medium or high confidence. A target with required Eval also needs an actual Audit v3 preflight → RunBundle v2 → Audit v3 result-triage digest chain. A review's `evalEvidence` text is not release evidence.

## Compatibility

`ReviewResultLite` v1 is not accepted. The former `ReviewInputBundle v5`, `ReviewResult v4`, `AWReviewTargetPlan` and `AWReviewSummary v2` implementations remain transitional source-only tools for the existing publication command. They must not be projected into Agent-visible Review Skills or extended for new integrations.
