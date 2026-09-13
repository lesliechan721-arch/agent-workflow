# Simplification routing test double

`bin/aw.mjs` implements only `self check`, `review inspect`, `review prepare --help` and the exact Codex/project prepare path used by `prepare_isolated_unverified_candidate`.

The fixture checks that baseline and candidate are complete isolated Workspace copies before it copies the selected source and provider into separate final directories. Its binding JSON uses test-only digests. It does not implement the production renderer, canonical source binding, Eval preparation, Audit, model execution or production apply.

Unknown commands, targets, profiles, existing outputs and incomplete snapshots fail closed. The command log and prepared files are routing evidence only.
