# Slash Command Capabilities

Generated from `@aw/cli/plugin-authoring-capabilities` (sha256:9bca86f3e18dc8d3a3524f3966cb51b8e3623e68819259a5ff0b1440a4759035).
Verified source: `packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs`.

| Field | Type | Required | Product/profile | Accepted values | Requires | Conflicts | Verified source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `description` | string | true | all supported | — | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `claude` | frontmatter object | false | CLAUDE | description, allowed-tools, model, argument-hint, shell | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `claude.shell` | enum | false | all supported | bash, powershell | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `codex.description` | string | false | CODEX | — | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `codex.interface` | display metadata | false | all supported | — | default_prompt includes $command-name | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `codex generated invocation` | fixed policy | true | all supported | allow_implicit_invocation=false | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
