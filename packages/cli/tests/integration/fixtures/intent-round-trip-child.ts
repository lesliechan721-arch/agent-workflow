import { expect, it, vi } from 'vitest';

import { installNativeTestQualification, isolateCodexAppDiscoveryQueries } from '../../helpers/native-execution-fixture.js';

import { setCodexDiscoveryOverridesForTests } from '../../../src/utils/codex-executable-discovery.js';
import { discoverPlatform } from '../../../src/platforms/discovery.js';

import { runCli } from '../../../src/index.js';
import { createCommandTestTiming } from '../../helpers/command-timing.js';

it('runs one public write command from argv in an isolated process', async (test) => {
  const timing = createCommandTestTiming(test);
  const argv = await timing.measure('fixture', 'child setup', async () => {
    const serializedArgv = process.env.AW_INTENT_CHILD_ARGV;
    const cwd = process.env.AW_INTENT_CHILD_CWD;
    if (!serializedArgv || !cwd) throw new Error('Missing child CLI input.');
    const argv = JSON.parse(serializedArgv) as unknown;
    if (!Array.isArray(argv) || !argv.every((value) => typeof value === 'string')) {
      throw new Error('Child CLI argv must be a string array.');
    }

    globalThis.fetch = async (input) => {
      throw new Error(`Network access is disabled in the CLI child: ${String(input)}`);
    };
    // This isolated child is a test process. Parent spies do not cross this boundary.
    installNativeTestQualification({ platforms: ['codex'], trust: true });
    setCodexDiscoveryOverridesForTests({ macApplicationsDirectories: [] });
    const appQuery = isolateCodexAppDiscoveryQueries();
    // Test Value Gate: the public adapter must keep OS App inventory isolated
    // even when the CLI supplies an explicit runner. This probe starts no process.
    const externalQuery = vi.fn(async () => ({ exitCode: 0, stdout: '[]', stderr: '' }));
    await discoverPlatform('codex', { platform: 'win32', cwd,
      env: { ...process.env, PATH: '', SystemRoot: cwd }, runner: externalQuery });
    expect(externalQuery).not.toHaveBeenCalled();
    expect(appQuery).toHaveBeenCalled();
    process.chdir(cwd);
    return argv;
  });
  const exitCode = await timing.measure('command', 'isolated CLI', () => runCli(argv));
  expect(exitCode).toBe(Number(process.env.AW_INTENT_CHILD_EXIT_CODE ?? '0'));
});
