# Changelog

## v4.1

- Made unspecified review requests default to quick; full now requires an explicit complete or scored review request.
- Made revision review select delta before the unspecified-depth quick default.
- Made report publication, batch sealing, and README registration explicit user-authorized actions.
- Kept draft persistence in `.tmp` separate from formal publication and batch sealing.
- Prevented a seal-only request from implicitly authorizing formal report publication.
- Kept target-specific publication commands in the static and plugin references instead of the always-loaded workflow.
- Added a self-review controller/data boundary and regression cases for review depth, publication authorization, and self-review isolation.

## v4

- Added a minimum-effective-control audit before completion-boundary scoring.
- Replaced the standalone resource dimension with minimum necessary control and merged resource checks into context disclosure.
- Added independent complexity and reducibility verdicts plus effective quality caps.
- Enforced bidirectional score/verdict consistency and the full/release minimum-control audit requirement.
- Added advisory control-surface metrics and over-specification regression cases.
- Required current pruning evidence instead of only future stop discipline.

## v3.1

- Added an untrusted-object boundary and a strong-evidence-first review phase.
- Added P0/P1 counterevidence admission and failed-gate finding links.
- Made every deduction traceable to one finding or unknown without duplicate primary penalties.
- Decoupled aggregate scores from release; quick/delta omit aggregate scores.
- Localized the compact report to Chinese and added artifact-versus-executed-evidence rules with targeted evals.

## v3

- Reframed `description` and all external references as context pointers with explicit trigger branches.
- Reweighted the existing 12 dimensions instead of adding more dimensions.
- Added completion-boundary, information-hierarchy and invocation/pointer audits.
- Added `environment-lookup` as an information tier and separated context load from cognitive load.
- Added co-location and scattering checks alongside duplication.
- Replaced `documented` evidence with `normative`, `structural`, `heuristic` and `inferred` authority classes.
- Restricted P0/P1 to observed, normative or structural evidence.
- Replaced the cached official-summary reference with a dated source map; third-party writing guidance is explicitly heuristic.
- Integrated trigger/eval guidance into the main dimensions reference to reduce scattered authority.
- Added sediment, no-op ablation and environment-as-source-of-truth checks to delta review.
- Expanded behavior and scoring evals for weak pointers, completion bounds, flat references, scattering, source caching and client-specific invocation.
- Updated scorecard validation and static diagnostics for the new weights and evidence model.
