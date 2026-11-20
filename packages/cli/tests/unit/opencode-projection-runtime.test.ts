import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import YAML from 'yaml';
import { afterEach, expect, it } from 'vitest';
import type { PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';
import type { ProjectionInput, StageContext } from '../../src/platforms/contracts.js';
import { projectPlatform } from '../../src/platforms/projection.js';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.remove(root)));
});

it.each([
  ['ordinary', '', undefined],
  ['manual-only', 'disable-model-invocation: true\n', false],
  ['explicit model access', 'disable-model-invocation: false\n', true],
  ['metadata-only', 'metadata:\n  opencode/autoinvoke: "false"\n', undefined],
] as const)('registers the OpenCode %s Skill at its absolute location without an SDK install', async (_case, policy, autoinvoke) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-opencode-projection-'));
  temporaryRoots.push(root);
  const skillText = `---\nname: check\ndescription: Check the input.\n${policy}---\nRun the check.\n`;
  const skill: PluginComponent = { id: 'skill:check', kind: 'skill', name: 'check', content: { files: {
    'SKILL.md': { text: skillText },
  } } };
  const input: ProjectionInput = {
    binding: {
      id: 'binding', platform: 'opencode', route: 'opencode-directory',
      plugin: { sourceId: 'source', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'source/example', version: '1.2.3' },
      scope: { kind: 'project', projectRoot: path.join(root, 'project') }, consumers: [],
      physicalKey: 'physical', activationKey: 'activation', renderUnitIds: ['unit'],
    },
    renderUnit: { id: 'unit', physicalKey: 'physical', renderScope: { kind: 'project', projectRoot: path.join(root, 'project') },
      output: 'package', kinds: ['skill'], consumers: [] },
    capabilities: {
      schemaVersion: 2, platform: 'opencode', scope: 'project', basis: 'profile',
      kinds: {
        skill: { status: 'supported', reasonCodes: [], delivery: ['native-package'] },
        mcp: { status: 'unsupported', reasonCodes: [], delivery: [] },
        agent: { status: 'unsupported', reasonCodes: [], delivery: [] },
        hook: { status: 'unsupported', reasonCodes: [], delivery: [] },
        instruction: { status: 'unsupported', reasonCodes: [], delivery: [] },
      },
      features: {
        'skill.invocation.manual': { status: 'supported', reasonCodes: [], values: ['true'] },
        'skill.invocation.model': { status: 'supported', reasonCodes: [], values: ['true', 'false'] },
      },
    },
    components: [skill], policy: { platform: 'opencode', permissions: [] },
    resources: { resources: [], files: [], bundleFiles: [], commandResources: [], digest: 'closure' },
  };
  const ctx: StageContext = { cwd: root, stagingRoot: path.join(root, 'stage'), env: { HOME: path.join(root, 'home') } };
  const result = await projectPlatform(ctx, input);
  const bundle = result.bundle!.stagingRoot;
  expect(await fs.pathExists(path.join(bundle, 'node_modules'))).toBe(false);
  const manifest = await fs.readJson(path.join(bundle, 'package.json'));
  expect(manifest.dependencies).toBeUndefined();
  const entrypoint = path.resolve(bundle, manifest.exports['.']);
  const extension = await import(/* @vite-ignore */ pathToFileURL(entrypoint).href);
  const registered: Array<{ id: string; name: string; description: string; content: string; location: string; autoinvoke?: boolean }> = [];
  const cleanup = await extension.default.setup({ skill: {
    transform: async (edit: (editor: {
      get: (id: string) => typeof registered[number] | undefined;
      add: (definition: typeof registered[number]) => void;
    }) => void) => {
      edit({ get: (id) => registered.find((definition) => definition.id === id), add: (definition) => { registered.push(definition); } });
      return { dispose: async () => {} };
    },
  } });
  expect(extension.default.id).toBe('aw-source-example');
  expect(registered).toEqual([{ id: 'check', name: 'check', description: 'Check the input.', content: 'Run the check.\n',
    location: path.join(bundle, 'skills/check/SKILL.md'), ...(autoinvoke === undefined ? {} : { autoinvoke }) }]);
  expect(path.isAbsolute(registered[0]!.location)).toBe(true);
  const final = await fs.readFile(registered[0]!.location, 'utf8');
  if (autoinvoke !== undefined) {
    expect(YAML.parse(final.split('---')[1]!)).toEqual({
      name: 'check', description: 'Check the input.', metadata: { 'opencode/autoinvoke': String(autoinvoke) },
    });
  } else {
    expect(final).toBe(skillText);
  }
  await cleanup();
});
