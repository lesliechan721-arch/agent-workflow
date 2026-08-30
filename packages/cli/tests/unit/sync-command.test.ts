import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/commands/write-commands.js', () => ({
  installWriteCommand: vi.fn(async () => ({
    platforms: ['codex'],
    plugins: ['demo'],
    warnings: [],
    rebuildResults: [],
    targetResults: [],
    overallState: 'succeeded',
    nativePlugins: {},
    repoManagedArtifacts: [],
    receiptTargets: [],
  })),
}));

import { syncCommand } from '../../src/commands/sync-command.js';
import { installWriteCommand } from '../../src/commands/write-commands.js';
import {
  createEmptyPluginIntentState,
  upsertPluginIntentRoot,
  widenPluginIntentManagedCodexOwnership,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const mockedInstall = vi.mocked(installWriteCommand);

describe('public Codex sync command', () => {
  beforeEach(() => mockedInstall.mockClear());

  it('rejects selectors with --all and non-interactive missing selection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const base = {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex' as const,
      scope: 'project' as const,
      interactive: false,
    };
    await expect(syncCommand(['official/demo'], { ...base, all: true }))
      .rejects.toMatchObject({ code: 'syncSelectorConflict' });
    await expect(syncCommand([], base))
      .rejects.toMatchObject({ code: 'syncSelectionRequired' });
    expect(mockedInstall).not.toHaveBeenCalled();
  });

  it('uses the existing prompt and reconciles selected desired roots without changing them', async () => {
    const isolation = getCurrentSourceTestIsolation();
    let intent = createEmptyPluginIntentState();
    intent = upsertPluginIntentRoot(intent, {
      pluginId: 'official/demo',
      platforms: ['codex'],
    });
    intent = {
      ...intent,
      dependencyScopeOverrides: [{
        pluginId: 'official/leaf',
        platform: 'codex',
        scope: 'user',
      }],
    };
    await writePluginIntentState({
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    }, intent);
    const multiSelect = vi.fn(async () => ({
      cancelled: false as const,
      value: ['official/demo'],
    }));

    await expect(syncCommand([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      interactive: true,
      prompt: { multiSelect },
      yes: true,
    })).resolves.toMatchObject({ overallState: 'succeeded' });

    expect(multiSelect).toHaveBeenCalledOnce();
    expect(mockedInstall).toHaveBeenCalledWith(
      ['official/demo'],
      expect.objectContaining({
        platform: 'codex',
        scope: 'project',
        yes: true,
      }),
      expect.objectContaining({
        reconcileIntentOnly: true,
        directCli: true,
      }),
    );
    expect(mockedInstall.mock.calls[0]?.[1]).not.toHaveProperty('dependencyScopeOverrides');
  });

  it('uses managed inventory for --all recovery after the last root is removed', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const intent = widenPluginIntentManagedCodexOwnership(
      createEmptyPluginIntentState(),
      ['leaf@aw', 'root@aw'],
    );
    await writePluginIntentState({
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    }, intent);

    await syncCommand([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      all: true,
      interactive: false,
    });

    expect(mockedInstall).toHaveBeenCalledWith(
      ['leaf', 'root'],
      expect.objectContaining({ platform: 'codex', scope: 'project' }),
      expect.objectContaining({ reconcileIntentOnly: true }),
    );
  });
});
