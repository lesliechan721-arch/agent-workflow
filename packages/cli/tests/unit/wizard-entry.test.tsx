import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import { toWizardCandidates } from '../../src/commands/wizard.js';
import { addRoot, observeIntent, resolveIntentPath } from '../../src/intent/intent-store.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('scoped write command entry', () => {
  // Test Value Gate: complete CLI requests use shared services without mounting the interactive TUI.
  it('removes an exact requirement without mounting a wizard', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { cwd: isolation.layout.fixtureCwd, env: isolation.env, scope: 'user' as const };
    await addRoot(location, 'team/demo', 'team-identity');
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    expect(await runCli([
      'plugin', 'remove', 'team/demo', '--scope', 'user', '--only', 'requirements', '--json',
    ], { ...location, interactive: true, io: captured.io, tuiRunner: { launch } as never })).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.remove', status: 'success',
      data: { request: { scope: 'user', mode: 'requirements-only' }, requirements: { roots: [] },
        changes: { requirements: 'changed', outputs: 'none' }, targetResults: [] },
    });
    expect(await observeIntent(location)).toMatchObject({ state: 'valid', value: { roots: [] } });
    expect(launch).not.toHaveBeenCalled();
  });

  it('reports missing deployment targets without saving a requirement or mounting a wizard', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    expect(await runCli([
      'plugin', 'install', 'team/demo', '--scope', 'user', '--context', 'user', '--json',
    ], { cwd: isolation.layout.fixtureCwd, env: isolation.env,
      interactive: true, io: captured.io, tuiRunner: { launch } as never })).toBe(3);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      command: 'plugin.install', status: 'blocked', data: { changes: { requirements: 'none' } },
      diagnostics: [{ code: 'noTargetsEnabled' }],
    });
    expect(await fs.pathExists(await resolveIntentPath({ scope: 'user', env: isolation.env }))).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects an omitted output removal scope before any output changes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    expect(await runCli([
      'plugin', 'remove', 'team/demo', '--only', 'outputs', '--target', 'codex', '--json',
    ], { cwd: isolation.layout.fixtureCwd, env: isolation.env,
      interactive: false, io: captured.io })).toBe(2);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      command: 'plugin.remove', status: 'failed', data: {}, diagnostics: [{ code: 'invalidArguments' }],
    });
  });

  it('keeps namespaced config candidates for the config wizard', () => {
    expect(toWizardCandidates([{
      pluginName: 'team/demo',
      pluginSummary: { description: 'Namespaced summary',
        configSchema: { mode: { type: 'string', title: 'Mode' } } },
      targets: [],
    }])).toEqual([expect.objectContaining({
      pluginName: 'team/demo', pluginId: 'team/demo', description: 'Namespaced summary',
      configSchema: { mode: { type: 'string', title: 'Mode' } },
    })]);
  });

  it('rejects missing install selectors without mounting a wizard', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    expect(await runCli(['plugin', 'install', '--scope', 'user'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      interactive: true, io: captured.io, tuiRunner: { launch } as never,
    })).toBe(2);
    expect(captured.readStdout()).toContain('FAILED');
    expect(captured.readStderr()).toContain("missing required argument 'plugins'");
    expect(launch).not.toHaveBeenCalled();
  });
});
