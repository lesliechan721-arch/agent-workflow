import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

const inspectRebuildTarget = vi.hoisted(() => vi.fn(async () => ({
  target: {},
  inspection: { state: 'present', components: [], errors: [] },
})));

vi.mock('../../src/commands/rebuild-integration.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/rebuild-integration.js')>(),
  inspectRebuildTarget,
}));

vi.mock('../../src/utils/project-boundary.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/project-boundary.js')>(),
  assertProjectSharedConfigPathVisible: vi.fn(async () => undefined),
  ensureProjectPrivateStateIgnore: vi.fn(async () => ({ updated: false })),
}));

import type { RebuildCommandResult } from '../../src/commands/rebuild-command.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import type { PluginMeta, ReceiptTargetIdentity, Scope } from '../../src/types.js';
import { applyPluginConfigWrite } from '../../src/utils/plugin-config-write.js';
import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function createFixture(): Promise<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  plugin: PluginMeta;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-claude-project-native-'));
  tempDirs.push(root);
  registerCurrentTestWritableStateRoot(root);
  const cwd = path.join(root, 'repo');
  await fs.ensureDir(cwd);
  await execFileAsync('git', ['init', '-q'], { cwd });
  const pluginRoot = path.join(root, 'plugin');
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest: PluginMeta['manifest'] = {
    name: 'claude-native-only',
    version: '1.0.0',
    description: 'Claude native-only config fixture',
    compatibility: { aw: { minVersion: '0.0.0' } },
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CLAUDE'],
      },
    },
    config: {
      schema: {
        mode: { type: 'enum', values: ['fast', 'safe'], default: 'safe' },
      },
    },
  };
  await fs.outputJson(manifestPath, manifest);
  return {
    cwd,
    env: { AW_HOME: path.join(root, 'aw-home') },
    plugin: { rootDir: pluginRoot, manifestPath, manifest },
  };
}

function rebuildResult(target: ReceiptTargetIdentity): RebuildCommandResult {
  return {
    platforms: [target.platform],
    plugins: [target.pluginName],
    warnings: [],
    rebuildResults: [],
    targetResults: [{ target, action: 'reinstall', state: 'completed' }],
    overallState: 'succeeded',
    nativePlugins: {},
    repoManagedArtifacts: [],
    receiptTargets: [{
      plugin: target.pluginName,
      platform: target.platform,
      scope: target.scope,
    }],
  };
}

function createNativeRunner(): NativeCliRunner {
  return vi.fn(async (invocation) => {
    const project = invocation.args.join(' ') === 'plugin list --scope project';
    return {
      exitCode: 0,
      stdout: project ? 'claude-native-only@aw\n' : '',
      stderr: '',
    };
  });
}

function createReinstallMock() {
  return vi.fn(async (pluginNames, rawOptions) => {
    const target: ReceiptTargetIdentity = {
      pluginName: pluginNames[0]!,
      platform: rawOptions.platform as 'claude',
      scope: rawOptions.scope as Scope,
    };
    return rebuildResult(target);
  });
}

afterEach(async () => {
  vi.clearAllMocks();
  while (tempDirs.length > 0) await fs.remove(tempDirs.pop()!);
});

describe('Claude project native-only config apply', () => {
  it.each([
    ['user' as const, ['project']],
    ['project' as const, ['project']],
  ])('applies a %s config write to the visible current-project native target', async (scope, expectedScopes) => {
    const fixture = await createFixture();
    const nativeCliRunner = createNativeRunner();
    const reinstallCommandImpl = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope,
      cwd: fixture.cwd,
      env: fixture.env,
      nativeCliRunner,
      reinstallCommandImpl,
      request: { updates: { mode: 'fast' } },
    });

    expect(receipt.overallState).toBe('succeeded');
    expect(receipt.targetResults.map((entry) => entry.target.scope)).toEqual(expectedScopes);
    expect(receipt.targetResults.map((entry) => entry.target.platform)).toEqual(['claude']);
    expect(reinstallCommandImpl).toHaveBeenCalledTimes(1);
    expect(reinstallCommandImpl).toHaveBeenCalledWith(
      ['claude-native-only'],
      expect.objectContaining({ platform: 'claude', scope: 'project', cwd: fixture.cwd }),
      expect.any(Object),
    );
  });
});
