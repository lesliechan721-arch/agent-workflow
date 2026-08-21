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

`check-agent-skill.mjs` is the source of truth for frontmatter, runtime closure, local paths and package errors. Its output is cheap to recompute and is not persisted as a handoff state machine.

### Quality review

`ReviewResultLite` v1 contains only:

- target digest;
- `quick | full | delta`;
- one design decision and one complexity conclusion;
- a concise summary;
- findings with severity, area, evidence, issue and action;
- decision-relevant unknowns;
- the available Eval evidence level.

Weighted scores, generic release gates, stage owners, producers, independent-context declarations and machine-evidence copies are not part of the lightweight model contract.

### AW adapter

`review-aw-plugin` evaluates source and materialized Skills by unique production digest. Ordinary quality review does not produce profile coverage or release readiness. An explicitly requested release check uses `check-aw-plugin-release.mjs` to recompute supported profiles, machine checks and accepted quality reviews.

## Compatibility

The former `ReviewInputBundle v5`, `ReviewResult v4`, `AWReviewTargetPlan` and `AWReviewSummary v2` implementations remain transitional source-only compatibility tools for the existing publication command. They must not be projected into Agent-visible Review Skills or extended for new integrations.
