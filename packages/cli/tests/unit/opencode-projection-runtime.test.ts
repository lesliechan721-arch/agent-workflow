import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';
import type { PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';
import type { ProjectionInput, StageContext } from '../../src/platforms/contracts.js';
import { projectPlatform } from '../../src/platforms/projection.js';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.remove(root)));
});

it('loads an OpenCode local package without an SDK install and registers a Skill at its absolute location', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-opencode-projection-'));
  temporaryRoots.push(root);
  const skillText = '---\nname: check\ndescription: Check the input.\n---\nRun the check.\n';
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
      schemaVersion: 1, platform: 'opencode', scope: 'project', basis: 'profile', profileId: 'test', consumers: [],
      kinds: {
        skill: { status: 'supported', reasonCodes: [], delivery: ['native-package'] },
        mcp: { status: 'unsupported', reasonCodes: [], delivery: [] },
        agent: { status: 'unsupported', reasonCodes: [], delivery: [] },
        hook: { status: 'unsupported', reasonCodes: [], delivery: [] },
        instruction: { status: 'unsupported', reasonCodes: [], delivery: [] },
      },
      features: {},
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
  const registered: Array<{ id: string; name: string; description: string; content: string; location: string }> = [];
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
    location: path.join(bundle, 'skills/check/SKILL.md') }]);
  expect(path.isAbsolute(registered[0]!.location)).toBe(true);
  expect(await fs.readFile(registered[0]!.location, 'utf8')).toBe(skillText);
  await cleanup();
});
