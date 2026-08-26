# Plugin Manifest Capabilities

Generated from `@aw/cli/plugin-authoring-capabilities` (sha256:9bca86f3e18dc8d3a3524f3966cb51b8e3623e68819259a5ff0b1440a4759035).
Verified source: `packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs`.

| Field | Type | Required | Product/profile | Accepted values | Requires | Conflicts | Verified source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `name` | kebab-case string | true | all supported | — | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `version` | stable strict SemVer | true | all supported | — | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `description` | non-empty string | true | all supported | — | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `compatibility.aw.minVersion` | strict SemVer | true | all supported | — | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `dependencies` | unique plugin-name[] | false | all supported | same-source plugin names | — | self, cycles, missing provider | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `skills\|slashCommands\|mcpServers\|apps` | single ./ relative path | false | all supported | — | declared path exists; apps requires CODEX | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `distributions.agentSkills` | {skills?: ./ relative path} | false | agent-skills | — | strict compatibility.aw.minVersion and at least one non-empty native capability in V1 | portable-only plugin or implicit promotion of native skills | packages/cli/src/utils/manifest.ts validateSourcePluginManifest |
| `distributions.agentSkills.skills` | ./ plugin-relative directory | for static portable Skills | agent-skills static | — | each direct child is a valid portable-agent-skills Skill with production README.md | native skills root inference | packages/cli/src/utils/manifest.ts validateSourcePluginManifest |
| `marketplace.category` | non-empty string | true | all supported | — | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `marketplace.strict` | boolean | true | all supported | — | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `marketplace.policy.installation` | enum | true | all supported | AVAILABLE, NOT_AVAILABLE, INSTALLED_BY_DEFAULT | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `marketplace.policy.authentication` | enum | true | all supported | ON_INSTALL, ON_USE | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `marketplace.policy.products` | unique enum[] | false | omitted means both | CODEX, CLAUDE | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `interface` | display-only object | false | all supported | — | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
