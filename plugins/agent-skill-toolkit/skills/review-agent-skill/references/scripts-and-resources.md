# Scripts and deterministic resources

Read this only when the target contains scripts or repeatedly reimplements deterministic logic.

## Script ownership

Good script candidates: parsing, transformation, generation, computation, format validation, static
consistency, repetitive batch operations and mechanically checkable assertions.

Do not use ordinary scripts to infer live agent state, mailbox delivery, cancellation, concurrency,
permissions or runtime lifecycle through files, Git or shell polling.

## Agent-facing script checks

- use paths relative to the Skill root and state the branch that invokes the script;
- declare runtime and dependencies; keep the interface non-interactive;
- provide `--help`, actionable errors and meaningful exit codes;
- keep stdout stable and structured; write diagnostics to stderr;
- bound inputs, outputs, timeouts, path traversal, overwrites and sensitive data;
- prefer idempotence and dry-run for destructive work;
- provide a fixture, test or safe sample.

Before claiming an interface defect, read imports, argument parsing, side-effect calls and main
dispatch. Run `--help` only after static inspection proves the help branch exits before side
effects. Environment failure is `unknown`, not proof that an interface is absent.

## References and Agent-facing prose

The canonical reference, pointer, active-path, co-location and progressive-disclosure audit belongs
to `review-agent-content`. This Skill only checks package-specific reachability and consumes its
`ReferenceAuditResult`; it does not maintain a second reference checklist.
