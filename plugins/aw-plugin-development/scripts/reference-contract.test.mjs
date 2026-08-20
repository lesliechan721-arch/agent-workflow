import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const pluginRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('AW author maps every supported component to a direct reference',async()=>{const root=path.join(pluginRoot,'skills','author-aw-plugin');const skill=await readFile(path.join(root,'SKILL.md'),'utf8');const refs=['plugin-manifest-spec.md','aw-skill-integration.md','skill-frontmatter-capabilities.generated.md','extensions-spec.md','slash-commands.md','mcp-and-apps.md','claude-only-capabilities.md','build-config-spec.md','aw-script-testing.md','aw-config-and-helper.md','aw-artifact-renderer.md','aw-lifecycle.md','aw-readme-authoring.md'];for(const ref of refs){const content=await readFile(path.join(root,'references',ref),'utf8');assert.ok(content.length>200,ref+' must contain focused guidance');assert.match(skill,new RegExp('references/'+ref.replaceAll('.','\\.'),'u'));}await assert.rejects(readFile(path.join(root,'references','aw-scripts-config-lifecycle.md'),'utf8'));});
