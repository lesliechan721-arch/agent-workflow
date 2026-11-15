import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';
import { preparePlatformComponents, resolveArtifactRenderConfig } from '../../src/utils/artifact-renderer.js';
import { finalizePlatformSkillProducers } from '../../src/utils/component-command-preparation.js';
import { readInstalledCommandProducer } from '../../src/utils/managed-command-store.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createIsolatedTestEnv } from '../helpers/test-isolation.js';

// Protect the shared prepare boundary with actual component and agent-command renderer requests.
describe('component command preparation', () => {
  it.each([false, true])('freezes one complete Skill before its command request (missing entry: %s)', async (missingEntry) => {
    const isolated = await createIsolatedTestEnv();
    try {
      const root = path.join(isolated.layout.fixtureCwd, 'plugin');
      const trace = path.join(isolated.layout.fixtureCwd, 'render-trace.jsonl');
      await fs.outputJson(path.join(root, '.agents-plugin', 'plugin.json'), {
        schemaVersion: 4, name: 'command-profile', version: '1.0.0', description: 'Command closure fixture.',
        platforms: ['codex'],
        marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        requires: { aw: { capabilities: ['aw.managed-commands.v1', 'aw.native-tools.v2'] } },
        nativeTools: {
          definitions: [{ key: 'job', protocol: 'aw.windows-job.v1' }],
          consumers: [{ kind: 'managed-command-set', key: 'tools', tools: [{ key: 'job', platforms: ['win32'], policy: 'required' }] }],
        },
        artifacts: { configKeys: [] },
        scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
        managedCommands: { sets: [{ set: 'tools', producer: { kind: 'artifact', platform: 'codex', artifactId: 'provider' },
          mode: 'dynamic', refreshKeys: [] }] },
      });
      await fs.outputFile(path.join(root, 'render.mjs'), `
import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(context.surface) + '\\n');
if (context.surface === 'agent-plugin') {
 console.log(JSON.stringify({version:3,components:[{id:'provider',kind:'skill',name:'provider',content:{files:{
  'SKILL.md':{text:'---\\nname: provider\\ndescription: Command closure fixture.\\n---\\n{{aw.command:tools/run}} check\\n'},
  'README.md':{text:'# Provider\\n'},
  'scripts/run.mjs':{text:'process.stdout.write("ok");\\n'}
 }}},{id:'unrelated',kind:'skill',name:'unrelated',content:{files:{'SKILL.md':{text:'---\\nname: unrelated\\ndescription: Independent Skill.\\n---\\nNo commands.\\n'},'README.md':{text:'# Independent\\n'}}}}],omitted:[],unmet:[]}));
} else if (context.surface === 'agent-commands') {
 if (!fs.existsSync(context.producers[0].resourceRoot + '/scripts/run.mjs')) process.exit(32);
 console.log(JSON.stringify({version:2,artifacts:[{id:'command-set.tools',target:'aw.command-set',kind:'commandSet',platform:'codex',state:'present',refreshKeys:[],entries:[{key:'run',runner:'node',entry:'scripts/${missingEntry ? 'missing' : 'run'}.mjs'}]}]}));
} else process.exit(33);
`);
      const source = { ...await readPluginManifest(root), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}`,
        pluginId: 'fixture/command-profile' };
      const bundleRoot = path.join(isolated.layout.fixtureCwd, 'bundle');
      await bundleLocalPlugin(source, bundleRoot, { buildMode: 'staging', commandEnv: isolated.env });
      const plugin = { ...await readPluginManifest(bundleRoot, { mode: 'bundle' }), sourceId: source.sourceId,
        sourceIdentity: source.sourceIdentity, pluginId: source.pluginId };
      // This lower boundary takes already qualified facts. It does not qualify a real client.
      const capabilities = getAuthoringPlatformCapabilities('codex', 'user');
      capabilities.kinds.skill = { status: 'supported', reasonCodes: [], delivery: ['native-package'] };
      const config = await resolveArtifactRenderConfig({ pluginName: plugin.manifest.name, manifest: plugin.manifest,
        platform: 'codex', scope: 'user', cwd: isolated.layout.fixtureCwd, env: isolated.env });
      const prepared = await preparePlatformComponents({ plugin, platform: 'codex', renderScope: 'user', kinds: ['skill'],
        capabilities, config, cwd: isolated.layout.fixtureCwd, commandEnv: isolated.env });
      const finalize = () => finalizePlatformSkillProducers({ plugin, platform: 'codex', prepared,
        renderUnit: { physicalKey: `sha256:${'b'.repeat(64)}`, renderScope: { kind: 'user' }, kinds: ['skill'] },
        skillWorkRoot: path.join(isolated.layout.fixtureCwd, 'skill-candidates'), cwd: isolated.layout.fixtureCwd, env: isolated.env });
      const finalized = await finalize();
      try {
        if (missingEntry) {
          expect(finalized.skills.map((skill) => skill.tree.skillKey)).toEqual(['unrelated']);
          expect(finalized.commandCandidates).toEqual([]);
          expect(finalized.producerResolutions).toContainEqual(expect.objectContaining({state:'failed',componentId:'provider'}));
          expect(finalized.prepared.expected.unmet).toContainEqual(expect.objectContaining({id:'provider',reasonCode:'dependency-unmet'}));
        } else {
          expect(finalized.commandCandidates).toHaveLength(1);
          expect(finalized.commandCandidates[0]?.producer.placementKey).toBe(`sha256:${'b'.repeat(64)}`);
          expect(finalized.skills[0]?.tree.files['SKILL.md']?.toString('utf8')).toMatch(/aw command run cmdp_[0-9a-f]{16} -- check/u);
          expect(finalized.skills[0]?.tree.files['aw-plugin-requirements.json']).toBeDefined();
          expect(await readInstalledCommandProducer(finalized.skills[0]!.resourceRoot)).toMatchObject({
            producer: { placementKey: `sha256:${'b'.repeat(64)}` }, sets: [{ set: 'tools', state: 'present' }],
            nativeTools: { definitions: [{ key: 'job', protocol: 'aw.windows-job.v1' }] },
          });
          expect(finalized.commandResolver?.({ set: 'tools', key: 'run', variant: 'default' })).toMatch(/^cmdp_[0-9a-f]{16}$/u);
        }
      } finally { await finalized.cleanup(); }
      expect((await fs.readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
        .toEqual(['agent-plugin', 'agent-commands']);
    } finally { await isolated.cleanup(); }
  });
});
