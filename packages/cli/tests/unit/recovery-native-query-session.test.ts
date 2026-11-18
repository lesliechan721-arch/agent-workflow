import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';

import { readRecoveryStatus } from '../../src/recovery/status.js';
import type { JointDemandSnapshot } from '../../src/recovery/joint-demand.js';
import type { PluginMeta } from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Test Value Gate: the actual status entry must pass one read-only query session
// through all roots, while a subsequent operation must obtain fresh inventories.
it('shares Claude inventories for two source roots only within one status operation', async () => {
  const isolation = getCurrentSourceTestIsolation();
  const runtime = await createClaudeNativeTestRuntime(isolation);
  const env = { ...isolation.env, PATH: runtime.binRoot };
  const plugins: PluginMeta[] = [];
  for (const name of ['first', 'second']) {
    const rootDir = path.join(isolation.layout.fixtureCwd, 'source', 'plugins', name);
    await fs.outputJson(path.join(rootDir, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 4, name, version: '1.0.0', description: `Native query fixture ${name}.`,
      platforms: ['claude'], skills: './skills',
      marketplace: { category: 'development', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    });
    await fs.outputFile(path.join(rootDir, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Native query fixture.\n---\nFixture.\n`);
    const plugin = await readPluginManifest(rootDir, { mode: 'bundle' });
    Object.assign(plugin, { sourceId: 'team', pluginId: `team/${name}`,
      sourceIdentity: `sha256:${'a'.repeat(64)}`, catalogLogicalIdentity: 'catalog:team' });
    plugins.push(plugin);
  }
  const preferences = { ...createEmptyPreferences(), targets: ['claude' as const] };
  const snapshot: JointDemandSnapshot = {
    context: { context: 'user', cwd: isolation.layout.fixtureCwd, scopes: ['user'] },
    preferences,
    user: {
      scope: 'user', plugins, errors: [],
      intent: { state: 'valid', digest: 'intent', rawDigest: 'intent', rawBytes: Buffer.from('{}'), value: {
        schemaVersion: 3, kind: 'aw-plugin-intents', sources: { team: { logicalIdentity: 'catalog:team' } },
        roots: plugins.map((plugin) => ({ pluginId: plugin.pluginId! })),
      } },
      preferences: { state: 'valid', value: preferences, digest: 'preferences', rawDigest: 'preferences', rawBytes: Buffer.from('{}') },
      roots: plugins.map((plugin) => ({ pluginId: plugin.pluginId!, sourceId: 'team', sourceState: 'ready', blockers: [], plugin })),
    },
  };
  const callsFor = (args: string[]) => runtime.nativeCliRunner.mock.calls.filter(([invocation]) =>
    runtime.isClaudeInvocation(invocation) && invocation.args.slice(invocation.args.indexOf('plugin')).join(' ') === args.join(' '));
  const read = () => readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, context: 'user', env,
    targets: ['claude'], nativeCliRunner: runtime.nativeCliRunner }, snapshot);

  const first = await read();
  expect(first.inventory?.map((entry) => entry.pluginId).sort()).toEqual(['team/first', 'team/second']);
  expect(first.inventory?.every((entry) => entry.targetResults.some((target) => target.agent === 'claude'
    && target.deploymentObservations?.[0]?.after.registration === 'absent'))).toBe(true);
  expect(callsFor(['plugin', 'list', '--json'])).toHaveLength(1);
  expect(callsFor(['plugin', 'marketplace', 'list', '--json'])).toHaveLength(1);
  const firstCwd = callsFor(['plugin', 'list', '--json'])[0]![0].cwd!;
  expect(callsFor(['plugin', 'marketplace', 'list', '--json'])[0]![0].cwd).toBe(firstCwd);
  expect(await fs.pathExists(firstCwd)).toBe(false);

  const second = await read();
  expect(second.inventory?.map((entry) => entry.pluginId).sort()).toEqual(['team/first', 'team/second']);
  expect(callsFor(['plugin', 'list', '--json'])).toHaveLength(2);
  expect(callsFor(['plugin', 'marketplace', 'list', '--json'])).toHaveLength(2);
  const secondCwd = callsFor(['plugin', 'list', '--json'])[1]![0].cwd!;
  expect(secondCwd).not.toBe(firstCwd);
  expect(await fs.pathExists(secondCwd)).toBe(false);
});
