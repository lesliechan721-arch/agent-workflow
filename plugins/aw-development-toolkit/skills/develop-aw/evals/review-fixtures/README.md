# Review navigation test double

Only the commands explicitly implemented in bin/aw.mjs are available. It logs argv to _review-log/commands.jsonl and writes prepared fixture files only when the case grants that operation. Source and supplied existing finals are review inputs.

The binding file is marked testDouble and contains fixtureSourceDigest/fixtureFinalDigest. These are deterministic test fingerprints, not production AWSourceBinding or canonical AW digests. The compact response models the designed CLI view; the fake service is the trusted fixture boundary for agent-routing tests. It does not prove real renderer isolation, official validation, source closure hashing.

Use existing real CLI integration tests and design/EVAL-AND-ACCEPTANCE.md for production verification. Keep this PATH fixture in Eval assets, outside runtime Skill installation.

## R1 selector and workspace-check correction

This fixture supports one selected `demo-skill`, Codex/project, and manifest defaults only. Omitted platform/scope enumerates that single declared profile; it is not a production platform default. Explicit conflicting/unsupported selectors, missing or unsupported config, unknown flags, duplicate single-value flags and extra positional arguments are rejected. Repeated --skill/--materialization values are all checked. Config `{}` and `{"demo-plugin":{}}` are equivalent default overrides here; nonempty fields are not implemented and must fail instead of being ignored.

The optional `fixtureProfile` in a test-only binding lets offline regression tests represent a self-valid but nonmatching profile/config. It does not implement real effective-config rendering or production source-binding verification. Such a binding cannot satisfy the default selected item. Multiple real materializations, Claude/Portable rendering and release view remain production integration tests, not capabilities silently simulated by this fixture.

The log now records `cwd` as well as `args`, so the mechanical checker can normalize paths rather than search substrings. The trusted fixture controls are the files under the case's declared `pathPrepend` directories and the bundle's existing README; changing them or adding arbitrary files under the fixture directory is not permitted.
