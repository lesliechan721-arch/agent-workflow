import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

if (process.platform !== 'win32') throw new Error('This diagnostic requires native Windows.');
const { buildPluginScriptSpawnEnv, preparePluginScriptDirectories } = await import(pathToFileURL(
  path.resolve('packages/cli/dist/src/utils/plugin-scripts.js'),
));
const execFileAsync = promisify(execFile);
const systemKeys = [
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
];
const profileKeys = ['HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'];
const readHost = (name) => Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-env-diagnostic-'));
try {
  const fixtureInput = Object.fromEntries([...systemKeys, 'PATH'].flatMap((name) => {
    const value = readHost(name);
    return value === undefined ? [] : [[name, value]];
  }));
  fixtureInput.AW_HOME = path.join(root, 'aw-home');
  fixtureInput.AW_CODEX_HOME = path.join(root, 'codex-home');
  fixtureInput.AW_CLAUDE_HOME = path.join(root, 'claude-home');
  await preparePluginScriptDirectories(root);
  const production = buildPluginScriptSpawnEnv({
    commandEnv: fixtureInput,
    contextPath: path.join(root, 'context.json'),
    tempDir: root,
    plugin: { name: 'diagnostic', version: '1.0.0' },
    event: 'test', platform: 'codex', scope: 'user', bundleRoot: root,
  });
  const minimal = Object.fromEntries(Object.entries(production).filter(([name]) => !systemKeys.includes(name) && !profileKeys.includes(name)));
  minimal.SystemRoot = production.SystemRoot;
  minimal.ComSpec = production.ComSpec;
  const platformModule = pathToFileURL(path.resolve('plugins/codex-enhance/skills/codex-subagent-guide/scripts/runtime/platform.mjs')).href;
  const source = [
    'const { currentUserIdentity, protectPrivatePath, verifyPrivatePath } = await import(process.argv[1]);',
    'const owner = await currentUserIdentity();',
    'if (owner.kind !== "windows") throw new Error("Native Windows identity was unavailable.");',
    'await protectPrivatePath(process.argv[2]);',
    'await verifyPrivatePath(process.argv[2], "directory", owner);',
    'process.stdout.write(JSON.stringify({ identity: true, privateAcl: true }));',
  ].join('\n');
  const variants = process.argv.includes('--compare-minimal') ? [['minimal', minimal], ['production', production]] : [['production', production]];
  for (const [name, env] of variants) {
    const started = performance.now();
    let succeeded = false;
    let timedOut = false;
    try {
      const probe = path.join(root, `${name}-probe`);
      await fs.mkdir(probe);
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', source, platformModule, probe], {
        env, cwd: root, windowsHide: true, shell: false, timeout: 60_000, maxBuffer: 64 * 1024,
      });
      const receipt = JSON.parse(stdout);
      succeeded = receipt.identity === true && receipt.privateAcl === true;
    } catch (error) {
      timedOut = error.killed === true;
    }
    console.log(JSON.stringify({ name, succeeded, timedOut, elapsedMs: Math.round(performance.now() - started) }));
    if (name === 'production' && !succeeded) process.exitCode = 1;
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
