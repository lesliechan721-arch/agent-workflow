import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Diagnostic only: baseline uses the unchanged product helper. Candidate helper
// copies add fixed module initialization and never replace product files.
const execFileAsync = promisify(execFile);
const timeoutMs = 15_000;
const phases = new Set([
  'entered', 'modulePath', 'importUtility', 'importManagement', 'importSecurity',
  'importCim', 'newObject', 'jsonDecode', 'jsonEncode', 'identity', 'getItem',
  'aclSet', 'aclVerify', 'cim', 'addType', 'complete',
]);
const emit = (value) => console.log(JSON.stringify(value));
const readHost = (name) => Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const setEnvironment = (environment, name, value) => ({
  ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== name.toLowerCase())),
  [name]: value,
});

const fixedModulePath = [
  '[Environment]::SetEnvironmentVariable("PSModulePath", [IO.Path]::Combine($PSHOME, "Modules"), "Process")',
].join('\n');
const fixedImports = [
  fixedModulePath,
  "$PSModuleAutoLoadingPreference = 'None'",
  ...[
    ['Utility', 'Microsoft.PowerShell.Utility'],
    ['Management', 'Microsoft.PowerShell.Management'],
    ['Security', 'Microsoft.PowerShell.Security'],
    ['Cim', 'CimCmdlets'],
  ].flatMap(([phase, name]) => [
    `$diagnosticPhase = 'import${phase}'; Emit $diagnosticPhase 'begin'`,
    `Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', '${name}', '${name}.psd1')) -ErrorAction Stop`,
    "Emit $diagnosticPhase 'ok'",
  ]),
].join('\n');

function probeSource(initialization) {
  return [
    '$watch = [Diagnostics.Stopwatch]::StartNew()',
    'function Emit([string]$phase, [string]$code) { [Console]::Out.WriteLine("AW_MODULE_PHASE|" + $phase + "|" + $watch.ElapsedMilliseconds + "|" + $code); [Console]::Out.Flush() }',
    "$ErrorActionPreference = 'Stop'",
    "$diagnosticPhase = 'entered'; Emit $diagnosticPhase 'ok'",
    'try {',
    "  $diagnosticPhase = 'modulePath'; Emit $diagnosticPhase 'begin'",
    initialization,
    "  $diagnosticPhase = 'modulePath'; Emit $diagnosticPhase 'ok'",
    "  $diagnosticPhase = 'newObject'; Emit $diagnosticPhase 'begin'",
    '  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    "  Emit $diagnosticPhase 'ok'",
    "  $diagnosticPhase = 'jsonDecode'; Emit $diagnosticPhase 'begin'",
    '  $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AW_SUBAGENT_PLATFORM_INPUT)) | ConvertFrom-Json',
    "  Emit $diagnosticPhase 'ok'",
    "  $diagnosticPhase = 'jsonEncode'; Emit $diagnosticPhase 'begin'",
    '  $encoded = $data | ConvertTo-Json -Compress',
    '  if ([String]::IsNullOrEmpty($encoded)) { throw "The JSON probe failed." }',
    "  Emit $diagnosticPhase 'ok'",
    "  $diagnosticPhase = 'identity'; Emit $diagnosticPhase 'begin'",
    '  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
    '  if ($sid.Value -notmatch "^S-1-") { throw "The identity probe failed." }',
    "  Emit $diagnosticPhase 'ok'",
    "  $diagnosticPhase = 'getItem'; Emit $diagnosticPhase 'begin'",
    '  $entry = Get-Item -Force -LiteralPath $data.target',
    '  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "The path probe failed." }',
    "  Emit $diagnosticPhase 'ok'",
    "  $diagnosticPhase = 'aclSet'; Emit $diagnosticPhase 'begin'",
    '  $acl = [Security.AccessControl.DirectorySecurity]::new()',
    '  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit',
    '  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)',
    '  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $acl.AddAccessRule($rule)',
    '  Set-Acl -LiteralPath $data.target -AclObject $acl',
    "  Emit $diagnosticPhase 'ok'",
    "  $diagnosticPhase = 'aclVerify'; Emit $diagnosticPhase 'begin'",
    '  $entry = Get-Item -Force -LiteralPath $data.target',
    '  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "The path probe failed." }',
    '  $acl = Get-Acl -LiteralPath $data.target',
    '  if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw "The ACL probe failed." }',
    '  $allow = $false',
    '  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {',
    '    if ($rule.IsInherited -or $rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw "The ACL probe failed." }',
    '    if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $allow = $true }',
    '  }',
    '  if (!$allow) { throw "The ACL probe failed." }',
    "  Emit $diagnosticPhase 'ok'",
    "  $diagnosticPhase = 'cim'; Emit $diagnosticPhase 'begin'",
    '  $item = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID)',
    '  $owner = Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid',
    '  if ($item.ProcessId -ne $PID -or !$item.CreationDate -or $owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid.Value) { throw "The CIM probe failed." }',
    "  Emit $diagnosticPhase 'ok'",
    "  $diagnosticPhase = 'addType'; Emit $diagnosticPhase 'begin'",
    "  Add-Type -TypeDefinition 'public static class AwModuleProbe { public static int Value() { return 7; } }'",
    '  if ([AwModuleProbe]::Value() -ne 7) { throw "The compiler probe failed." }',
    "  Emit $diagnosticPhase 'ok'",
    "  Emit 'complete' 'ok'",
    "} catch { Emit $diagnosticPhase 'failed'; exit 1 }",
  ].join('\n');
}

function safePhases(stdout) {
  return String(stdout ?? '').split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^AW_MODULE_PHASE\|([A-Za-z]+)\|(\d{1,9})\|(begin|ok|failed)$/);
    if (!match || !phases.has(match[1])) return [];
    return [{ phase: match[1], elapsedMs: Number(match[2]), code: match[3] }];
  });
}

async function run(executable, args, environment, cwd, receipt) {
  const started = performance.now();
  let stdout = '';
  let succeeded = false;
  let code = 'nativeFailure';
  try {
    const result = await execFileAsync(executable, args, {
      env: environment, cwd, shell: false, windowsHide: true,
      timeout: timeoutMs, maxBuffer: 64 * 1024,
    });
    stdout = result.stdout;
    succeeded = receipt(stdout);
    code = succeeded ? 'ok' : 'invalidReceipt';
  } catch (error) {
    // stdout is parsed through a fixed allowlist; stderr is never disclosed.
    stdout = error.stdout ?? '';
    code = error.killed === true ? 'timeout' : 'nativeFailure';
  }
  return { succeeded, code, elapsedMs: Math.round(performance.now() - started), phases: safePhases(stdout) };
}

async function main() {
  if (process.platform !== 'win32') {
    emit({ phase: 'setup', succeeded: false, code: 'nativeWindowsRequired' });
    process.exitCode = 1;
    return;
  }
  const { buildPluginScriptSpawnEnv, preparePluginScriptDirectories } = await import(pathToFileURL(
    path.resolve('packages/cli/dist/src/utils/plugin-scripts.js'),
  ));
  const systemRoot = readHost('SystemRoot');
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('System directory unavailable.');
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const originalHelper = path.resolve('plugins/codex-enhance/skills/codex-subagent-guide/scripts/runtime/windows-job.ps1');
  const helperSource = await fs.readFile(originalHelper, 'utf8');
  const helperBoundary = "$ErrorActionPreference = 'Stop'";
  if (helperSource.split(helperBoundary).length !== 2) throw new Error('Helper boundary unavailable.');
  const hostCache = readHost('PSModuleAnalysisCachePath');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-module-loading-'));
  try {
    const variants = [
      { name: 'productionBaseline', initialization: '', provenance: 'unchangedProductHelper' },
      { name: 'hostCacheOnly', initialization: '', provenance: 'unchangedProductHelper', hostCache: true },
      { name: 'fixedSystemPath', initialization: fixedModulePath, provenance: 'candidateCopy' },
      { name: 'explicitSystemImports', initialization: fixedImports, provenance: 'candidateCopy' },
    ];
    for (const variant of variants) {
      if (variant.hostCache && !hostCache) {
        emit({ variant: variant.name, phase: 'setup', succeeded: false, code: 'hostCacheUnavailable' });
        continue;
      }
      for (const operation of ['fixedOperations', 'actualJobHelper']) {
        // Every probe, including the helper, starts with its own empty home.
        const directory = await fs.mkdtemp(path.join(root, 'probe-'));
        await preparePluginScriptDirectories(directory);
        const target = path.join(directory, 'private-probe');
        await fs.mkdir(target);
        let environment = buildPluginScriptSpawnEnv({
          commandEnv: { ...process.env, AW_HOME: path.join(directory, 'aw-home'), AW_CODEX_HOME: path.join(directory, 'codex-home'), AW_CLAUDE_HOME: path.join(directory, 'claude-home') },
          contextPath: path.join(directory, 'context.json'), tempDir: directory,
          plugin: { name: 'diagnostic', version: '1.0.0' },
          event: 'test', platform: 'codex', scope: 'user', bundleRoot: directory,
        });
        if (variant.hostCache) environment = setEnvironment(environment, 'PSModuleAnalysisCachePath', hostCache);
        let result;
        if (operation === 'fixedOperations') {
          environment.AW_SUBAGENT_PLATFORM_INPUT = Buffer.from(JSON.stringify({ target })).toString('base64');
          result = await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(probeSource(variant.initialization), 'utf16le').toString('base64')], environment, directory,
            (stdout) => safePhases(stdout).some((record) => record.phase === 'complete' && record.code === 'ok'));
        } else {
          let helper = originalHelper;
          if (variant.initialization) {
            helper = path.join(directory, 'candidate-windows-job.ps1');
            // The import probe emits fixed records. Keep these available in the
            // candidate helper without changing the shipped helper's body.
            const initialization = [
              '$watch = [Diagnostics.Stopwatch]::StartNew()',
              'function Emit([string]$phase, [string]$code) { [Console]::Out.WriteLine("AW_MODULE_PHASE|" + $phase + "|" + $watch.ElapsedMilliseconds + "|" + $code); [Console]::Out.Flush() }',
              variant.initialization,
            ].join('\n');
            await fs.writeFile(helper, helperSource.replace(helperBoundary, `${helperBoundary}\n${initialization}`));
          }
          // Inspect only a fresh random name. No Job or backend is created and
          // no existing process is stopped. A missing Job needs no owner SID.
          environment.AW_SUBAGENT_JOB_CONTROL = Buffer.from(JSON.stringify({
            name: `Local\\aw-subagent-${randomBytes(16).toString('hex')}`, sid: 'S-1-0-0',
          })).toString('base64');
          result = await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-Action', 'observe'], environment, directory, (stdout) => {
            const payload = String(stdout).split(/\r?\n/).filter((line) => !line.startsWith('AW_MODULE_PHASE|')).join('\n').trim();
            try { const value = JSON.parse(payload); return Array.isArray(value) && value.length === 0; } catch { return false; }
          });
        }
        emit({ variant: variant.name, provenance: variant.provenance, phase: operation, ...result });
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main().catch(() => {
  emit({ phase: 'setupOrCleanup', succeeded: false, code: 'diagnosticFailed' });
  process.exitCode = 1;
});
