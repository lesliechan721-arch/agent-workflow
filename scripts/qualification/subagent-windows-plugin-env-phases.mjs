import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Diagnostic only. This script neither qualifies the platform nor changes the
// product environment contract. It prints fixed phases, codes and timings only.
async function main() {
if (process.platform !== 'win32') throw new Error('Native Windows is required.');
const execFileAsync = promisify(execFile);
const { buildPluginScriptSpawnEnv, preparePluginScriptDirectories } = await import(pathToFileURL(
  path.resolve('packages/cli/dist/src/utils/plugin-scripts.js'),
));
const moduleUrl = pathToFileURL(path.resolve('plugins/codex-enhance/skills/codex-subagent-guide/scripts/runtime/platform.mjs')).href;
const readHost = (name) => Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const overlay = (base, names) => ({ ...base, ...Object.fromEntries(names.flatMap((name) => {
  const value = readHost(name);
  return value === undefined ? [] : [[name, value]];
})) });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-env-phases-'));
try {
  await preparePluginScriptDirectories(root);
  const production = buildPluginScriptSpawnEnv({
    commandEnv: {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
    },
    contextPath: path.join(root, 'context.json'), tempDir: root,
    plugin: { name: 'diagnostic', version: '1.0.0' },
    event: 'test', platform: 'codex', scope: 'user', bundleRoot: root,
  });
  const probe = path.join(root, 'private-probe');
  await fs.mkdir(probe);
  const actualSource = [
    'import { performance } from "node:perf_hooks";',
    'let phase = "import"; let started = performance.now();',
    'const report = (state, code) => console.log(JSON.stringify({ phase, state, code, elapsedMs: Math.round(performance.now() - started) }));',
    'try {',
    '  const api = await import(process.argv[1]);',
    '  phase = "identity"; started = performance.now(); report("begin", "none");',
    '  const owner = await api.currentUserIdentity();',
    '  if (owner.kind !== "windows") throw new Error("Unexpected platform.");',
    '  report("done", "ok");',
    '  phase = "protect"; started = performance.now(); report("begin", "none");',
    '  await api.protectPrivatePath(process.argv[2]); report("done", "ok");',
    '  phase = "verify"; started = performance.now(); report("begin", "none");',
    '  await api.verifyPrivatePath(process.argv[2], "directory", owner); report("done", "ok");',
    '} catch (error) {',
    '  const allowed = ["platformOperationFailed", "userIdentityUnavailable", "platformUnavailable", "pathInvalid", "pathMissing", "pathSymlink", "resourceNotPrivate", "resourceOwnerMismatch"];',
    '  report("failed", allowed.includes(error.code) ? error.code : "unexpectedFailure");',
    '  process.exitCode = 1;',
    '}',
  ].join('\n');
  const safeRecords = (stdout) => String(stdout ?? '').split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      if (!['import', 'identity', 'protect', 'verify'].includes(value.phase)
        || !['begin', 'done', 'failed'].includes(value.state)
        || !/^[A-Za-z]+$/.test(value.code)
        || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0) return [];
      return [{ phase: value.phase, state: value.state, code: value.code, elapsedMs: value.elapsedMs }];
    } catch { return []; }
  });
  let actualOutput = '';
  let actualSuccess = false;
  try {
    const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', actualSource, moduleUrl, probe], {
      env: production, cwd: root, shell: false, windowsHide: true, timeout: 55_000, maxBuffer: 64 * 1024,
    });
    actualOutput = result.stdout;
    actualSuccess = true;
  } catch (error) { actualOutput = error.stdout ?? ''; }
  console.log(JSON.stringify({ kind: 'actual-platform', variant: 'production', succeeded: actualSuccess, phases: safeRecords(actualOutput) }));

  // The PowerShell text is fixed. Environment values and probe paths enter only
  // as JSON data. All comparison operations below only read identity and ACLs.
  const psSource = [
    '$watch = [Diagnostics.Stopwatch]::StartNew()',
    'function Emit([string]$phase, [string]$code) { [Console]::Out.WriteLine("AW_ENV_PHASE|" + $phase + "|" + $watch.ElapsedMilliseconds + "|" + $code); [Console]::Out.Flush() }',
    'Emit "entered" "ok"',
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  Emit "newObject" "begin"',
    '  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '  Emit "newObject" "ok"',
    '  Emit "inputDecode" "begin"',
    '  $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AW_SUBAGENT_PLATFORM_INPUT))',
    '  Emit "inputDecode" "ok"',
    '  Emit "convertFromJson" "begin"',
    '  $data = $decoded | ConvertFrom-Json',
    '  Emit "convertFromJson" "ok"',
    '  Emit "identity" "begin"',
    '  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '  if ($sid -notmatch "^S-1-") { throw "Identity unavailable." }',
    '  Emit "identity" "ok"',
    '  Emit "convertToJson" "begin"',
    '  $encoded = $sid | ConvertTo-Json -Compress',
    '  Emit "convertToJson" "ok"',
    '  Emit "getItem" "begin"',
    '  $entry = Get-Item -Force -LiteralPath $data.target',
    '  Emit "getItem" "ok"',
    '  Emit "getAcl" "begin"',
    '  $acl = Get-Acl -LiteralPath $data.target',
    '  if ($null -eq $acl) { throw "ACL unavailable." }',
    '  Emit "getAcl" "ok"',
    '  Emit "complete" "ok"',
    '} catch { Emit "error" $_.Exception.GetType().Name; exit 1 }',
  ].join('\n');
  const executable = path.join(readHost('SystemRoot'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const full = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['psmodulepath', 'winpsmodulepath'].includes(key.toLowerCase())));
  const variants = [
    ['production', production],
    ['identity-variables', overlay(production, ['USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE'])],
    ['real-appdata', overlay(production, ['APPDATA', 'LOCALAPPDATA'])],
    ['machine-data', overlay(production, ['ProgramData', 'ALLUSERSPROFILE', 'PUBLIC'])],
    ['computer-metadata', overlay(production, ['COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS'])],
    ['real-profile', overlay(production, ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'])],
    ['full-host-fixed-probe', full],
  ];
  for (const [variant, baseEnv] of variants) {
    const started = performance.now();
    let succeeded = false;
    let timedOut = false;
    let stdout = '';
    try {
      const result = await execFileAsync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(psSource, 'utf16le').toString('base64')], {
        env: { ...baseEnv, AW_SUBAGENT_PLATFORM_INPUT: Buffer.from(JSON.stringify({ target: probe })).toString('base64') },
        cwd: root, shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
      });
      stdout = result.stdout;
      succeeded = true;
    } catch (error) {
      stdout = error.stdout ?? '';
      timedOut = error.killed === true;
    }
    const phases = String(stdout).split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^AW_ENV_PHASE\|(entered|newObject|inputDecode|convertFromJson|identity|convertToJson|getItem|getAcl|complete|error)\|(\d+)\|([A-Za-z]{1,80})$/);
      return match ? [{ phase: match[1], elapsedMs: Number(match[2]), code: match[3] }] : [];
    });
    console.log(JSON.stringify({ kind: 'fixed-powershell', variant, succeeded, timedOut, elapsedMs: Math.round(performance.now() - started), phases }));
  }
  // Diagnostic exit is intentionally independent of product qualifications.
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
}

await main().catch(() => {
  console.log(JSON.stringify({ kind: 'diagnostic', code: 'diagnosticSetupOrCleanupFailed' }));
  process.exitCode = 1;
});
