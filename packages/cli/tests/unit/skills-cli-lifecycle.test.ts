import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as demandService from '../../src/recovery/demand.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import * as portableRecovery from '../../src/portable/recovery.js';
import { addSkills, listInstalledSkills, probeSkillsCli, verifySkillTargets } from '../../src/portable/skills-cli.js';
import * as nativeCli from '../../src/utils/native-cli.js';
import { projectThrownOperationDiagnostic } from '../../src/tui/diagnostic-projection.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { waitForProcessExit } from '../support/process-tree.js';

afterEach(() => vi.restoreAllMocks());

describe('Skills CLI process lifecycle', () => {
  // Test Value Gate: cleanup failures must retain their cause and bypass version/install/verification and cancellation fallbacks.
  it.each(['aborted', 'timeout'] as const)('preserves unconfirmed cleanup after %s through public adapters', async (reason) => {
    const failure = new nativeCli.NativeCliError({ invocation: { command: 'skills', args: [] },
      reason, exitCode: 1, stdout: '', stderr: '', cleanupError: new Error('child exit unconfirmed') });
    vi.spyOn(nativeCli, 'execFileNativeCliRunner').mockRejectedValue(failure);
    const options = { cwd: getCurrentSourceTestIsolation().layout.fixtureCwd };
    for (const invoke of [
      () => probeSkillsCli(options),
      () => listInstalledSkills({ ...options, global: true }),
      () => addSkills({ ...options, rootDir: options.cwd, skills: ['alpha'], global: true }),
      () => verifySkillTargets({ ...options, targets: [{ skill: 'alpha' }], global: true }),
    ]) {
      const error = await invoke().catch((error: unknown) => error);
      expect(error).toMatchObject({ name: 'SkillsCliError', code: 'portableSkillsCliCleanupFailed', cause: failure });
      expect(projectThrownOperationDiagnostic({ error, id: 'cleanup-failure', stage: 'session-reload',
        fallbackCode: 'tuiSessionReloadFailed' })).toMatchObject({ code: 'portableSkillsCliCleanupFailed',
        safeMessage: 'Skills CLI process cleanup could not be confirmed.' });
    }
  });

  // Test Value Gate: a settled provider read must mean the child has exited before User status removes its neutral cwd.
  it.skipIf(process.platform === 'win32').each([
    ['cancel', 'slow'], ['cancel', 'ignore'], ['timeout', 'slow'], ['timeout', 'ignore'],
  ] as const)('waits for exit after %s with a %s SIGTERM handler', async (mode, handler) => {
    const isolation = getCurrentSourceTestIsolation();
    const bin = path.join(isolation.env.AW_HOME!, 'bin');
    const log = path.join(isolation.env.AW_HOME!, 'provider.jsonl');
    await fs.ensureDir(bin);
    await fs.writeFile(path.join(bin, 'skills'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('1.5.23'); process.exit(0); }
const cwd = process.cwd();
const record = (event) => fs.appendFileSync(process.env.PROVIDER_LOG,
  JSON.stringify({ event, pid: process.pid, cwd, cwdExists: fs.existsSync(cwd) }) + '\\n');
process.on('SIGTERM', () => {
  record('term');
  if (process.env.PROVIDER_HANDLER === 'slow') setTimeout(() => process.exit(0), 50);
});
process.on('exit', () => record('exit'));
setTimeout(() => process.exit(2), 10_000);
record('ready');
`);
    await fs.chmod(path.join(bin, 'skills'), 0o755);
    const env = { ...isolation.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      PROVIDER_LOG: log, PROVIDER_HANDLER: handler };
    vi.spyOn(demandService, 'readDemand').mockResolvedValue({ scope: 'user',
      intent: { state: 'absent' }, preferences: { state: 'absent' }, errors: [], plugins: [],
      roots: [{ pluginId: 'local/root', sourceId: 'local', sourceState: 'ready', blockers: [],
        plugin: { manifest: { name: 'root', marketplace: { policy: { products: ['CODEX'] } },
          distributions: { agentSkills: { sourceDirs: ['./skills'] } } } } }],
    } as unknown as demandService.DemandSnapshot);
    const abort = new AbortController();
    let settled = false;
    let exitedAtRunnerEnd = false;
    let runnerFailure: unknown;
    let pid: number | undefined;
    let neutralCwd: string | undefined;
    vi.spyOn(portableRecovery, 'inspectPortableRecovery').mockImplementation(async (options) => {
      neutralCwd = options.context.executionCwd;
      try {
        await listInstalledSkills({ cwd: neutralCwd, env, global: true,
          signal: options.signal, timeoutMs: mode === 'timeout' ? 500 : undefined });
        return { targets: [], blockers: [] } as unknown as portableRecovery.PortablePreparation;
      } catch (error) {
        runnerFailure = error;
        throw error;
      } finally {
        try { process.kill(pid!, 0); } catch { exitedAtRunnerEnd = true; }
        expect(await fs.pathExists(neutralCwd)).toBe(true);
      }
    });
    const read = readRecoveryStatus({ scope: 'user', cwd: isolation.layout.fixtureCwd, env,
      nativeObservations: [], targets: ['cursor'], signal: abort.signal });
    const outcome = read.then(() => undefined, (error: unknown) => error).then((error) => {
      settled = true;
      return error;
    });
    try {
      await vi.waitFor(async () => expect(await fs.pathExists(log)).toBe(true), { timeout: 2_000 });
      pid = JSON.parse((await fs.readFile(log, 'utf8')).trim().split('\n')[0]!).pid;
      expect(await fs.pathExists(neutralCwd!)).toBe(true);
      if (mode === 'cancel') abort.abort();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 6_000 });
      expect(runnerFailure).toMatchObject({ name: mode === 'cancel' ? 'AbortError' : 'SkillsCliError' });
      if (mode === 'cancel') expect(await outcome).toMatchObject({ name: 'AbortError' });
      expect(exitedAtRunnerEnd).toBe(true);
      expect(() => process.kill(pid!, 0)).toThrow();
      expect(await fs.pathExists(neutralCwd!)).toBe(false);
      const events = (await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(events.some((event) => event.event === 'term')).toBe(true);
      expect(events.every((event) => event.cwdExists)).toBe(true);
      if (handler === 'slow') expect(events.some((event) => event.event === 'exit')).toBe(true);
    } finally {
      abort.abort();
      if (pid !== undefined) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* The runner already stopped its child. */ }
        await waitForProcessExit(pid);
      }
      await outcome;
    }
  });
});
