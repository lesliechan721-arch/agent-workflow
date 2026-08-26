# Extensions Capabilities

Generated from `@aw/cli/plugin-authoring-capabilities` (sha256:9bca86f3e18dc8d3a3524f3966cb51b8e3623e68819259a5ff0b1440a4759035).
Verified source: `packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs`.

| Field | Type | Required | Product/profile | Accepted values | Requires | Conflicts | Verified source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `instructions[]` | {name,title,content,paths?,agentOverrides?} | false | all supported | — | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `permissions[]` | {name,allow?,ask?,deny?,agentOverrides?} | false | all supported | plain command token prefixes | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `hooks[]` | {event,matcher?,command,agentOverrides?} | false | all supported | before_tool, after_tool, session_start | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `nativeHooks.claude[]` | native event handler | false | all supported | — | CLAUDE | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `nativeHooks.codex[]` | native event handler | false | all supported | — | CODEX | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `agents[]` | {name,description,prompt,tools?,agentOverrides?} | false | all supported | — | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `agentOverrides.<platform>` | object\|null | false | all supported | — | — | non-null override for unsupported product | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
