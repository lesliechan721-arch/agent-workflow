import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

const statusCommandV7 = vi.hoisted(() => vi.fn(async () => ({
  payload: {
    targets: [{
      pluginName: 'claude-native-only',
      pluginId: 'claude-native-only',
      sourceId: 'fixture',
      sourceIdentity: 'identity:fixture',
      platform: 'claude' as const,
      scope: 'project' as const,
      cwd: '/workspace',
      state: 'ready' as const,
      components: [{
        kind: 'intent' as const,
        key: 'desired',
        state: 'desired',
        metadata: { enabled: true, scopes: ['project'], relation: 'root' },
      }],
      reasons: [],
      recoveryActions: [],
    }],
  },
})));

vi.mock('../../src/commands/status-v6.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/status-v6.js')>(),
  statusCommandV7,
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
    description: 'Claude project renderer config fixture',
    schemaVersion: 3,
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
      fields: {
        mode: {
          type: 'string',
          choices: {
            allowCustom: false,
            presets: [
              { id: 'fast', title: 'Fast', value: 'fast' },
              { id: 'safe', title: 'Safe', value: 'safe' },
            ],
          },
          default: 'safe',
        },
      },
    },
    scripts: {
      artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
    },
    artifacts: {
      targets: [{
        id: 'project-skill',
        platform: 'claude',
        target: 'claude.skill',
        kind: 'skill',
        scopes: ['project'],
        states: ['present'],
        refreshKeys: ['mode'],
        skillKey: 'project-skill',
      }],
    },
  };
  await fs.outputJson(manifestPath, manifest);
  return {
    cwd,
    env: {
      AW_HOME: path.join(root, 'aw-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    },
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
    receiptTargets: [{
      pluginName: target.pluginName,
      platform: target.platform,
      scope: target.scope,
    }],
  };
}

function createNativeRunner(): NativeCliRunner {
  return vi.fn(async () => { throw new Error('claude CLI missing'); });
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

describe('Claude project renderer config apply', () => {
  it.each([
    ['user' as const, ['project']],
    ['project' as const, ['project']],
  ])('applies a %s config write to the visible current-project renderer target', async (scope, expectedScopes) => {
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
    expect(receipt.apply.state).toBe('succeeded');
    if (receipt.apply.state !== 'succeeded') throw new Error('Expected config apply to succeed.');
    expect(receipt.apply.targetResults.map((entry) => entry.target.scope)).toEqual(expectedScopes);
    expect(receipt.apply.targetResults.map((entry) => entry.target.platform)).toEqual(['claude']);
    expect(statusCommandV7).toHaveBeenCalledWith(expect.objectContaining({ nativeCliRunner }));
    expect(reinstallCommandImpl).toHaveBeenCalledTimes(1);
    expect(reinstallCommandImpl).toHaveBeenCalledWith(
      ['claude-native-only'],
      expect.objectContaining({ platform: 'claude', scope: 'project', cwd: fixture.cwd }),
      expect.any(Object),
    );
  });
});
