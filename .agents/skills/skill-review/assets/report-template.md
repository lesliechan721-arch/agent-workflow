# Skill Review Report

Use only sections required by the selected mode. quick omits deep audits that cannot be supported; delta emphasizes change closure and stop decision; release includes every applicable gate and evidence section.

## Executive verdict

- **Skill:**
- **Mode:** quick | full | release | delta
- **Direction:** aligned | at-risk | drifted
- **Release:** pass | pass-after-fixes | provisional | redesign | fail
- **Weighted score:**
- **Coverage:**
- **Confidence:**
- **One-line conclusion:**

## Review contract

| Item | Source-derived statement | Status |
| --- | --- | --- |
| Target problem | | known / unknown |
| Observed failures | | known / unknown |
| Success criteria | | known / unknown |
| Intended environment/client | | known / unknown |
| Out of scope | | known / unknown |
| Adjacent skills | | known / unknown |
| Release requirement | | known / unknown |

## Release gates

| Gate | Status | Severity | Evidence | Reason |
| --- | --- | --- | --- | --- |
| package-validity | | | | |
| critical-artifacts | | | | |
| goal-alignment | | | | |
| capability-validity | | | | |
| safety-permissions | | | | |
| architecture-ownership | | | | |
| release-evidence | | | | |

## Dimension scorecard

| Dimension | Weight | Score | Confidence | Evidence | Summary |
| --- | ---: | ---: | --- | --- | --- |
| Specification & package integrity | 7 | | | | |
| Problem grounding & value | 8 | | | | |
| Invocation, triggering & pointers | 12 | | | | |
| Scope, boundaries & composition | 8 | | | | |
| Program, completion bounds & calibration | 12 | | | | |
| Information hierarchy & disclosure | 12 | | | | |
| Architecture ownership | 10 | | | | |
| Scripts & deterministic automation | 8 | | | | |
| Resource reachability & co-location | 5 | | | | |
| Evals & evidence-driven iteration | 10 | | | | |
| Reliability, safety & compatibility | 4 | | | | |
| Pruning, source of truth & change discipline | 4 | | | | |

## Strengths

List only strengths supported by package, normative or observed evidence.

## Required findings

Only P0/P1.

| Severity | Evidence types | Dimension | Location | Problem | Correct owner | Minimal change | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Non-blocking findings

| Severity | Evidence types | Dimension | Location | Observation | Recommendation |
| --- | --- | --- | --- | --- | --- |

## Invocation and Pointer Audit

Use in full/release, and in quick when triggering is the stated focus.

| Pointer | Target material | Trigger branches | Intent front-loaded? | Duplicate synonym branch? | Repeats body identity? | Eval evidence | Recommendation |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |

## Information Hierarchy Map

Use in full/release or when progressive disclosure is disputed.

| Content | Type | Applicable branch | Current location | Needed every run? | Reaching pointer / environment source | Completion boundary | Recommendation |
| --- | --- | --- | --- | ---: | --- | --- | --- |

Type is one of: `in-file-step`, `in-file-reference`, `disclosed-reference`, `environment-lookup`.

## Completion Boundary Audit

Use in full/release, or when steps are skipped, rushed or over-executed.

| Step or rule set | Current criterion | Clear? | Checkable? | Demand sufficient? | Exhaustive? | Premature-completion risk | Recommendation |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |

## Architecture and ownership

- **Skill-owned policy:**
- **Schema/client-owned facts:**
- **Runtime-owned state:**
- **Script candidates:**
- **Role-only constraints:**
- **Eval/issue-only concerns:**
- **Natural-language state-machine risk:** low | medium | high

## Scripts and resources

- **Scripts present or correctly omitted:**
- **Interface/dependency/safety quality:**
- **Deterministic logic still repeated by the model:**
- **References/assets reachability:**
- **Duplication:**
- **Scattering / co-location:**
- **Environment facts unnecessarily cached:**
- **Stale or orphaned resources:**

## Evals and evidence

- **Trigger eval and rates:**
- **Behavior/regression eval:**
- **Runtime traces:**
- **Baseline:** no skill | minimal skill | previous version | none
- **Ablation / no-op evidence:**
- **Token/time/variance cost:**
- **Evidence missing for release:**

## Delta and sediment

Required in delta mode; optional elsewhere.

- **Previous P0/P1 closure:**
- **Affected dimensions:**
- **Direct regressions:**
- **SKILL.md / pointer / branch / resource delta:**
- **Behavior metric delta:**
- **Rules added and what they replaced:**
- **Sediment candidates:**
- **Net required change:** smaller | neutral | larger

## Minimal improvement roadmap

### Now — release blockers

1.

### Next — high-value quality improvements

1.

### Later — heuristic, eval or product/runtime work

1.

## Unknowns

List missing artifacts or facts that reduced coverage. Do not convert them into findings.

## Stop decision

State why review should stop now, or name the exact new observed/normative/structural evidence required before another iteration.
