#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// Explicit native diagnostics only. No product import, backend, or model runs.
// Test Value Gate: real system commands distinguish stdin EOF, host environment,
// ACL, and CIM failures that the product's generic error cannot distinguish.
const timeoutMs = 15000;
const outputLimit = 65536;
const prefix = 'AW_SUBAGENT_WINDOWS_DIAGNOSTICS';
const emit = (value) => process.stdout.write(`${prefix} ${JSON.stringify(value)}\n`);

function environmentValue(environment, name) {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function withoutModulePaths(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !['psmodulepath', 'winpsmodulepath'].includes(key.toLowerCase())));
}

const secretValues = Object.entries(process.env)
  .filter(([key, value]) => /token|secret|password|credential|cookie|authorization|api.?key/i.test(key) && value.length >= 4)
  .map(([, value]) => value)
  .sort((left, right) => right.length - left.length);

function safeSystemError(value) {
  let result = String(value ?? '');
  for (const secret of secretValues) result = result.split(secret).join('[REDACTED]');
  return result.slice(0, 8192);
}

function safeOutput(stage, value) {
  if (value?.stage !== stage) return null;
  if (stage === 'sid') return { stage, sidValid: value.sidValid === true };
  if (stage === 'acl') return { stage, directoryPrivate: value.directoryPrivate === true, filePrivate: value.filePrivate === true };
  if (stage === 'cim') return { stage, samePid: value.samePid === true, ownerMatches: value.ownerMatches === true, creationPresent: value.creationPresent === true };
  const allowed = new Set(['ConvertTo-Json', 'Get-Acl', 'Set-Acl', 'Get-CimInstance', 'Invoke-CimMethod']);
  if (stage === 'modules' && Array.isArray(value.commands)) return {
    stage,
    commands: value.commands.filter((row) => allowed.has(row?.command)).map((row) => ({ command: row.command, version: /^\d+(?:\.\d+){1,3}$/.test(row.version) ? row.version : null })),
  };
  return null;
}

const stages = [
  {
    name: 'sid',
    source: [
      '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      "if ($sid -notmatch '^S-1-\\d+(-\\d+)+$') { throw 'The current SID is invalid.' }",
      "[PSCustomObject]@{ stage = 'sid'; sidValid = $true } | ConvertTo-Json -Compress",
    ].join('\n'),
  },
  {
    name: 'modules',
    source: [
      "$commands = @('ConvertTo-Json', 'Get-Acl', 'Set-Acl', 'Get-CimInstance', 'Invoke-CimMethod')",
      '$found = @($commands | ForEach-Object { $command = Get-Command -Name $_ -ErrorAction Stop; [PSCustomObject]@{ command = $command.Name; version = $command.Version.ToString() } })',
      "[PSCustomObject]@{ stage = 'modules'; commands = $found } | ConvertTo-Json -Depth 4 -Compress",
    ].join('\n'),
  },
  {
    name: 'acl',
    source: [
      '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
      '$directoryAcl = [Security.AccessControl.DirectorySecurity]::new()',
      '$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit',
      '$directoryRule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)',
      '$directoryAcl.SetOwner($sid); $directoryAcl.SetAccessRuleProtection($true, $false); $directoryAcl.AddAccessRule($directoryRule)',
      'Set-Acl -LiteralPath $data.directory -AclObject $directoryAcl',
      '$fileAcl = [Security.AccessControl.FileSecurity]::new()',
      '$fileRule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)',
      '$fileAcl.SetOwner($sid); $fileAcl.SetAccessRuleProtection($true, $false); $fileAcl.AddAccessRule($fileRule)',
      'Set-Acl -LiteralPath $data.file -AclObject $fileAcl',
      'foreach ($target in @($data.directory, $data.file)) {',
      '  $entry = Get-Item -Force -LiteralPath $target',
      "  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The diagnostic resource is a reparse point.' }",
      '  $acl = Get-Acl -LiteralPath $target',
      "  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$acl.AreAccessRulesProtected) { throw 'The private ACL owner or inheritance is invalid.' }",
      '  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
      '  $allow = $false',
      '  foreach ($rule in $rules) {',
      "    if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'The private ACL contains a foreign or inherited rule.' }",
      '    if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $allow = $true }',
      '  }',
      "  if (!$allow) { throw 'The private ACL has no owner full-control rule.' }",
      '}',
      "[PSCustomObject]@{ stage = 'acl'; directoryPrivate = $true; filePrivate = $true } | ConvertTo-Json -Compress",
    ].join('\n'),
  },
  {
    name: 'cim',
    source: [
      '$item = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$data.pid)',
      "if ($null -eq $item -or $null -eq $item.CreationDate) { throw 'The diagnostic Node process is not observable.' }",
      '$owner = Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid',
      '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
      "if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { throw 'The observed process owner does not match.' }",
      "[PSCustomObject]@{ stage = 'cim'; samePid = ([int]$item.ProcessId -eq [int]$data.pid); ownerMatches = $true; creationPresent = ($item.CreationDate.ToUniversalTime().Ticks -gt 0) } | ConvertTo-Json -Compress",
    ].join('\n'),
  },
];

function probe(executable, environment, stage, input, stdinMode) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AW_SUBAGENT_DIAGNOSTIC_INPUT)) | ConvertFrom-Json',
    stage.source,
  ].join('\n');
  const began = performance.now();
  return new Promise((resolve) => {
    const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: outputLimit,
      env: { ...environment, AW_SUBAGENT_DIAGNOSTIC_INPUT: Buffer.from(JSON.stringify(input)).toString('base64') },
    }, (error, stdout, stderr) => {
      let output = null;
      try { output = safeOutput(stage.name, JSON.parse(stdout.trim())); } catch {}
      resolve({
        stage: stage.name, stdin: stdinMode, elapsedMs: Math.round(performance.now() - began),
        exit: child.exitCode, signal: child.signalCode ?? error?.signal ?? null,
        killed: child.killed || error?.killed === true,
        errorCode: error && typeof error.code === 'string' ? error.code : null,
        ok: !error && output !== null,
        stdoutBytes: Buffer.byteLength(stdout), output,
        stderr: safeSystemError(stderr),
      });
    });
    child.stdin?.on('error', () => {});
    // The open case intentionally matches a caller that never closes stdin.
    if (stdinMode === 'end') child.stdin?.end();
  });
}

async function main() {
  if (process.platform !== 'win32') {
    emit({ type: 'skipped', reason: 'Native Windows is required.', platform: process.platform });
    return;
  }
  const systemRoot = environmentValue(process.env, 'SystemRoot');
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('The Windows system directory is unavailable.');
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await fs.access(executable);
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-subagent-win-diagnostic-'));
  const results = [];
  try {
    const fixtureHome = path.join(directory, 'fixture-home');
    const fixtureTemp = path.join(directory, 'fixture-temp');
    await fs.mkdir(fixtureHome); await fs.mkdir(fixtureTemp);
    const fixtureEnvironment = {
      PATH: environmentValue(process.env, 'PATH') ?? '',
      HOME: fixtureHome, USERPROFILE: fixtureHome, CODEX_HOME: fixtureHome,
      AW_HOME: fixtureHome, AW_CODEX_HOME: fixtureHome, AW_CLAUDE_HOME: fixtureHome,
      TMPDIR: fixtureTemp, TMP: fixtureTemp, TEMP: fixtureTemp, SystemRoot: systemRoot,
    };
    const environments = [
      ['complete', { ...process.env }],
      ['runtimeFixture', fixtureEnvironment],
      ['cleanModulePaths', withoutModulePaths(process.env)],
    ];
    emit({ type: 'begin', platform: process.platform, arch: process.arch, node: process.version, timeoutMs, probes: environments.length * (stages.length + 1) });
    for (const [environmentName, environment] of environments) {
      for (const stage of stages) {
        // SID compares open and explicit EOF. All later stages use EOF so an
        // input-handle problem cannot hide their independent host evidence.
        for (const stdinMode of stage.name === 'sid' ? ['open', 'end'] : ['end']) {
          const resource = await fs.mkdtemp(path.join(directory, 'resource-'));
          const file = path.join(resource, 'private.json');
          await fs.writeFile(file, '{}\n');
          const result = await probe(executable, environment, stage, { directory: resource, file, pid: process.pid }, stdinMode);
          results.push({ environment: environmentName, ...result });
          emit({ type: 'probe', environment: environmentName, ...result });
        }
      }
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    emit({ type: 'cleanup', removed: true });
  }
  emit({ type: 'summary', probes: results.length, passed: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length });
}

main().catch((error) => {
  emit({ type: 'error', message: safeSystemError(error.message) });
  process.exitCode = 1;
});
