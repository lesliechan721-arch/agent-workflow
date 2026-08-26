# Build Config Capabilities

Generated from `@aw/cli/plugin-authoring-capabilities` (sha256:9bca86f3e18dc8d3a3524f3966cb51b8e3623e68819259a5ff0b1440a4759035).
Verified source: `packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs`.

| Field | Type | Required | Product/profile | Accepted values | Requires | Conflicts | Verified source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cacheable` | literal true | false | all supported | — | deterministic scripts.node.build | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `templates` | include globs + dual-platform vars | false | all supported | string or boolean vars | — | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `fileRules` | platform include/exclude | false | all supported | — | selected product | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `manifestOverrides.claude` | object | false | all supported | outputStyles, lspServers, userConfig, channels | CLAUDE | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `runtimeExports` | {name,source}[] | false | all supported | — | — | Skill/report/eval/generated roots | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `buildImports` | {plugin,export,env}[] | false | all supported | — | AW_PLUGIN_IMPORT_* env | — | packages/cli/src/utils/manifest.ts and packages/cli/authoring/scripts/validate-plugin.mjs |
| `skillRuntimeFiles` | {skill,target,platforms?,distributions?,source\|import}[] | false | all supported | — | declared static Skill and a target below references/, assets/, or scripts/ | — | packages/cli/src/utils/manifest.ts validateSourcePluginManifest |
| `skillRuntimeFiles[].distributions` | unique enum[] | false | agent-skills projection | agent-skills | distributions.agentSkills and a declared static portable Skill key | omission selects native surfaces; platforms plus distributions selects both explicit surface groups | packages/cli/src/utils/manifest.ts validateSourcePluginManifest |
| `generatedSkillRuntimeFiles` | {skill,target,distributions?}[] | false | all supported | — | scripts.node.build creates every final target; omitted distributions apply to all supported native platforms | — | packages/cli/src/utils/manifest.ts validateSourcePluginManifest; packages/cli/src/generators/local-plugin.ts validateGeneratedSkillRuntimeFiles |
| `generatedSkillRuntimeFiles[].distributions` | unique enum[] | false | agent-skills projection | agent-skills | distributions.agentSkills and a declared static portable Skill key | omission selects all supported native platforms; explicit agent-skills selects only the portable surface | packages/cli/src/utils/manifest.ts validateSourcePluginManifest; packages/cli/src/generators/local-plugin.ts validateGeneratedSkillRuntimeFiles |
