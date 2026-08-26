# MCP and App Capabilities

Generated from `@aw/cli/plugin-authoring-capabilities` (sha256:9bca86f3e18dc8d3a3524f3966cb51b8e3623e68819259a5ff0b1440a4759035).
Verified source: `packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs`.

| Field | Type | Required | Product/profile | Accepted values | Requires | Conflicts | Verified source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mcpServers.<key>.command` | string | stdio only | all supported | — | — | url | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `mcpServers.<key>.args` | string[] | false | all supported | — | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `mcpServers.<key>.env\|headers` | string map | false | all supported | ${ENV_VAR} placeholders for shared assets | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `mcpServers.<key>.url` | URL string | HTTP only | all supported | — | — | command | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `apps.<key>.id` | non-empty connector id | true | CODEX user scope | — | — | CLAUDE-only or Codex project scope | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
