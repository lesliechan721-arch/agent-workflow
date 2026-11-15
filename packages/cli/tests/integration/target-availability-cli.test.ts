import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/index.js';
import { observePreferences } from '../../src/intent/deployment-preferences.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Test Value Gate: the real CLI must preserve one JSON stdout object, exit-code semantics, and atomic target selection.
describe('target CLI availability protocol', () => {
  it('lists all targets and requires force only for unavailable additions', async () => {
    const isolated = getCurrentSourceTestIsolation();
    const cwd = isolated.layout.fixtureCwd;
    const bin = path.join(cwd, 'bin'); await fs.ensureDir(bin);
    const executable = path.join(bin, 'codex'); await fs.writeFile(executable, 'controlled external probe'); await fs.chmod(executable, 0o755);
    const env = { ...isolated.env, PATH: bin };
    const execute = async (argv: string[]) => {
      let stdout = '', stderr = '';
      const exitCode = await runCli(argv, { cwd, env, interactive: false,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.155.0', stderr: '' }),
        io: { stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; } } });
      return { exitCode, result: JSON.parse(stdout), stderr };
    };
    const listed = await execute(['target', 'list', '--json']);
    expect(listed.exitCode).toBe(0); expect(listed.result.data.availability).toHaveLength(10);
    expect(listed.result.data.availability.find((item: { id: string }) => item.id === 'codex')).toMatchObject({ availability: 'available', selected: false });
    const blocked = await execute(['target', 'set', 'codex', 'copilot', '--json']);
    expect(blocked.exitCode).toBe(3); expect(blocked.result.status).toBe('blocked');
    expect((await observePreferences({ cwd, env, scope: 'user' })).state).toBe('absent');
    const saved = await execute(['target', 'set', 'codex', 'copilot', '--force', '--json']);
    expect(saved.exitCode).toBe(0); expect(saved.result.data.policy.targets).toEqual(['codex', 'copilot']);
    expect(saved.result.data.availability.find((item: { id: string }) => item.id === 'copilot').availability).toBe('missing');
    expect((await execute(['target', 'set', 'codex', 'copilot', '--json'])).exitCode).toBe(0);
    expect((await execute(['target', 'set', 'not-a-target', '--force', '--json'])).exitCode).toBe(2);
    expect((await execute(['target', 'set', '--none', '--json'])).result.data.policy.targets).toEqual([]);
  });
});
