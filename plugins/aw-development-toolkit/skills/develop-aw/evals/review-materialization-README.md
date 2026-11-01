# AW materialization behavior for the explicit Reviewer

The review-materialization suite uses Selected Cases v1 and the current manifest contract. The unit under test is develop-aw; the explicit Reviewer participates and owns quality checks. Assertions focus on the required AW source and materialization facts. Source-routing remains with develop-aw. The materialization suite is non-required until independent Oracle review and client execution are completed.

The normal-path conversation cases provide actual source files, manifest injection, final files and a test-double CLI. Each log directory is an allowed Eval artifact; source/provider and existing finals are immutable inputs. The fake source binding is explicitly test-only, so results only prove the agent's routing and response to a controlled service.

Inspect logs and actual files, not just final prose. New successful preparation requires real files in _review-output/new and reads of the produced policy. Production materialization and binding checks are covered by the CLI preparation/inspection tests; this fixture does not replace them.

## Runner workspace boundary

The production conversation Runner takes trusted snapshots before and after execution. It compares the full prepared workspace, including added, removed, changed, symlinked and special entries, against the exact `allowedWorkspaceChanges` patterns. PATH fixtures are resolved from the Eval root before execution and must be existing, non-symlink trees that do not escape or overlap copied targets.

These mechanical checks do not prove that the Agent read the final or gave a correct semantic finding. Self-check-only can satisfy a no-write constraint but is not a completed Review.
