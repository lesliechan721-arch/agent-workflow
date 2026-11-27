import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import type { PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';
import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';
import type { PluginMeta } from '../../src/types.js';
import { preparePlatformComponents } from '../../src/utils/artifact-renderer.js';
import { finalizePlatformSkillProducers } from '../../src/utils/component-command-preparation.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(markdown: string, output: string, capability: boolean, supportsSkill: boolean) {
  const { layout, env } = getCurrentSourceTestIsolation();
  const root = path.join(layout.fixtureCwd, 'source');
  const manifest: PluginMeta['manifest'] = {
    schemaVersion: 4, name: 'example', version: '1.0.0', description: 'Role bindings.',
    platforms: ['codex'], marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    artifacts: { configKeys: [], sourceDirs: ['./texts'] }, scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
    requires: { aw: { capabilities: capability ? ['aw.skill-agent-placeholder.v1'] : [] } },
    extensions: { agents: [{ name: 'helper', description: 'Help.', prompt: 'Help.' }] },
  };
  const manifestPath = path.join(root, '.agents-plugin/plugin.json');
  await fs.outputJson(manifestPath, manifest);
  await fs.outputFile(path.join(root, 'render.mjs'), 'export {};');
  await fs.outputFile(path.join(root, 'texts/input.md'), markdown, { mode: 0o755 });
  const plugin: PluginMeta = { manifest, manifestPath, rootDir: root, sourceId: 'team', pluginId: 'team/example' };
  const skill: PluginComponent = { kind: 'skill', id: 'guide', name: 'guide', content: { files: {
    'SKILL.md': { text: '---\nname: guide\ndescription: A guide.\n---\nGuide.' },
    'references/aw-team-example-helper.md': { text: 'Role instructions.' },
    [output]: { source: { kind: 'bundle', path: 'texts/input.md' } },
  } } };
  const capabilities = getAuthoringPlatformCapabilities('codex', 'user');
  if (!supportsSkill) capabilities.kinds.skill = { status: 'unsupported', reasonCodes: ['interface-unsupported'], delivery: [] };
  const prepared = await preparePlatformComponents({ plugin, platform: 'codex', renderScope: 'user', kinds: ['skill'],
    capabilities, config: { mode: 'artifact-render', targetScope: 'user', values: {}, sources: {}, issues: [], stores: {} },
    cwd: layout.fixtureCwd, commandEnv: env, runner: { run: async () => ({
      exitCode: 0, signal: null, stdout: JSON.stringify({ version: 3, components: [skill], omitted: [], unmet: [] }), stderr: '', timedOut: false,
    }) },
  });
  return { plugin, prepared, cwd: layout.fixtureCwd, env, capabilities };
}

describe('agent binding in verified Markdown resources', () => {
  it.each([
    ['references/guide.md', '{{aw.agent:helper}}', false],
    ['references/guide.md', '{{aw.agent:helper', true],
    ['SKILL.md', '---\nname: "{{aw.agent:helper}}"\ndescription: Guide.\n---\nGuide.', true],
    ['SKILL.md', '---\nname: guide\ndescription: "Use \\x7B\\x7Baw.agent:helper}}"\nuser-invocable: true\n---\nGuide.', true],
    ['SKILL.md', '---\nname: guide\ndescription: Use {{aw.agent:helper}}.\n---\nGuide.', true],
    ['SKILL.md', '---\nname: guide\ndescription: Guide.\nmetadata:\n  reviewer: {{aw.agent:helper}}\nuser-invocable: true\n---\nGuide.', true],
  ] as const)('rejects invalid %s before an unrelated Skill capability gap skips it', async (output, markdown, capability) => {
    await expect(fixture(markdown, output, capability, false)).rejects.toThrow('agentReferenceInvalid');
  });

  it('still rejects a missing literal link next to a deferred role-dependent link', async () => {
    const markdown = '---\nname: guide\ndescription: Guide.\n---\n'
      + '[Role](references/{{aw.agent:helper}}.md) and [missing](references/absent.md)';
    await expect(fixture(markdown, 'SKILL.md', true, true)).rejects.toThrow(/references\/absent\.md.*missing/u);
  });

  it('checks Markdown links against the bound name and preserves executable source bytes and mode', async () => {
    const markdown = '---\nname: guide\ndescription: Guide.\n---\n[Role](references/{{aw.agent:helper}}.md)\n';
    const { capabilities, ...inputs } = await fixture(markdown, 'SKILL.md', true, true);
    const finalized = await finalizePlatformSkillProducers({ ...inputs, platform: 'codex',
      renderUnit: { kinds: ['skill'], renderScope: { kind: 'user' } },
      skillWorkRoot: path.join(inputs.cwd, 'finalized'), agentBinding: { capabilities, hasApplicableRenderer: true, dynamicAgents: async () => [] },
    });
    const file = path.join(finalized.skills[0]!.resourceRoot, 'SKILL.md');
    expect(await fs.readFile(file, 'utf8')).toContain('[Role](references/aw-team-example-helper.md)');
    expect((await fs.stat(file)).mode & 0o111).not.toBe(0);
    expect(finalized.prepared.resources.files.find((entry) => entry.path === 'SKILL.md')?.source).toBeUndefined();
  });
});
