# Review Agent Skill evals

The eval package separates routing from review behavior.

- `trigger-cases.json` checks whether `review-agent-skill` is selected for explicit Skill-review requests and excluded from authoring, generic prose review and project-adapter work.
- `behavior-cases.json` is a diagnostic conversation suite for four review invariants: selective bundle consumption, stale-stage rejection, canonical standard ownership and provisional release evidence.

The behavior suite is deliberately non-release-weighted: `requiredForRelease=false` and `releaseSplits=[]`. Its cases define regressions to execute, not observed evidence. Do not convert their expected outputs into findings or claim the behavior is proven until repeated model runs, traces and grading artifacts exist.
