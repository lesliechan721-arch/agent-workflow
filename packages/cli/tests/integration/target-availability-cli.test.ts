import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/index.js';
import { observePreferences } from '../../src/intent/deployment-preferences.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Test Value Gate: the real CLI must preserve one JSON stdout object, exit-code semantics, and atomic target selection.
describe('target CLI availability protocol', () => {
  // Real signals must reap AW's probes without interrupting another group or replacing a host handler.
  it.skipIf(process.platform === 'win32').each([
    { signal: 'SIGINT', owner: 'default' },
    { signal: 'SIGTERM', owner: 'default' },
    { signal: 'SIGTERM', owner: 'host' },
  ] as const)(
    'handles $signal during parallel native probes ($owner handler)', async ({ signal, owner }) => {
      const { env, layout } = getCurrentSourceTestIsolation();
      const bin = path.join(layout.fixtureCwd, 'bin');
      const stop = path.join(layout.fixtureCwd, 'stop');
      const handled = path.join(layout.fixtureCwd, 'host-signal');
      await fs.ensureDir(bin);
      await fs.symlink(process.execPath, path.join(bin, 'node'));
      await fs.symlink(await fs.pathExists('/bin/ps') ? '/bin/ps' : '/usr/bin/ps', path.join(bin, 'ps'));
      const probes = [{ name: 'codex', version: 'codex-cli 0.155.0' }, { name: 'claude', version: '2.1.292 (Claude Code)' }];
      const markers = probes.map(({ name }) => path.join(layout.fixtureCwd, `${name}.pid`));
      for (const [index, { name, version }] of probes.entries()) {
        await fs.writeFile(path.join(bin, name), `#!/usr/bin/env node
const { existsSync, writeFileSync } = require('node:fs');
setTimeout(() => process.exit(98), 9000);
const check = setInterval(() => {
  if (!existsSync(${JSON.stringify(stop)})) return;
  clearInterval(check);
  process.stdout.write(${JSON.stringify(`${version}\n`)}, () => process.exit(0));
}, 20);
writeFileSync(${JSON.stringify(markers[index])}, String(process.pid));
`, { mode: 0o755 });
      }

      const preload = path.join(layout.fixtureCwd, 'native-fixture.mjs');
      const nativeRunner = new URL('../../dist/src/utils/native-cli.js', import.meta.url).href;
      const allowed = await Promise.all(probes.map(({ name }) => fs.realpath(path.join(bin, name))));
      await fs.writeFile(preload, `
import { writeFileSync } from 'node:fs';
import { execFileNativeCliRunner, setNativeCliRunnerOverrideForTests } from ${JSON.stringify(nativeRunner)};
setNativeCliRunnerOverrideForTests(async (request) => {
  if (!${JSON.stringify(allowed)}.includes(request.command)) throw new Error('Outside the native CLI fixture.');
  return execFileNativeCliRunner(request);
});
${owner === 'host' ? `process.once(${JSON.stringify(signal)}, () => writeFileSync(${JSON.stringify(handled)}, 'handled'));` : ''}
`);
      const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
      const child = spawn(process.execPath, ['--import', preload, entry, 'target', 'list', '--json'], {
        cwd: layout.fixtureCwd, env: { ...env, PATH: bin }, detached: true,
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      const completion = once(child, 'exit');
      const witness = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 9000);'], {
        cwd: layout.fixtureCwd, env: { ...env, PATH: bin }, detached: true, stdio: 'ignore',
      });
      const witnessExit = once(witness, 'exit');
      let nativePids: number[] = [];
      const expectNativeProbesGone = (): void => {
        for (const pid of nativePids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
      };
      try {
        nativePids = await vi.waitFor(async () => {
          const pids = await Promise.all(markers.map((marker) => fs.readFile(marker, 'utf8').then(Number)));
          expect(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
          return pids;
        }, { timeout: 5000 });
        expect(child.pid).toBeGreaterThan(0);
        if (signal === 'SIGINT') process.kill(-child.pid!, signal);
        else expect(child.kill(signal)).toBe(true);
        if (owner === 'host') {
          await vi.waitFor(async () => expect(await fs.readFile(handled, 'utf8')).toBe('handled'));
          for (const pid of nativePids) expect(() => process.kill(pid, 0)).not.toThrow();
          await fs.ensureFile(stop);
          expect(await completion).toEqual([0, null]);
        } else {
          expect(await completion).toEqual([null, signal]);
        }
        expectNativeProbesGone();
        expect(witness.pid).toBeGreaterThan(0);
        expect(() => process.kill(witness.pid!, 0)).not.toThrow();
      } finally {
        if (witness.exitCode === null && witness.signalCode === null) witness.kill('SIGKILL');
        await fs.ensureFile(stop);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await Promise.all([completion, witnessExit]);
        await vi.waitFor(expectNativeProbesGone);
      }
    },
  );

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
    expect(listed.exitCode).toBe(0);
    expect(listed.result.data.availability.map((target: { id: string }) => target.id).sort()).toEqual([
      'antigravity', 'claude', 'codex', 'copilot', 'cursor', 'generic', 'grok', 'opencode', 'pi',
    ]);
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
