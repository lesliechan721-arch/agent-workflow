import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fail } from './contracts.mjs';

const execFileAsync = promisify(execFile);
const launches = new Map();
let userIdentity;

function windowsPowerShell() {
  const root = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1];
  if (!root || !path.isAbsolute(root)) fail('platformUnavailable', 'The Windows system directory is unavailable.');
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const windowsJobHelper = fileURLToPath(new URL('./windows-job.ps1', import.meta.url));

function isPowerShellModulePath(name) {
  return ['psmodulepath', 'winpsmodulepath'].includes(name.toLowerCase());
}

function windowsHostEnvironment(environment, input) {
  // A Node process launched by pwsh inherits PowerShell 7 module paths. Windows
  // PowerShell 5.1 uses only its fixed system modules for native operations.
  return { ...Object.fromEntries(Object.entries(environment).filter(([name]) => !isPowerShellModulePath(name))), ...input };
}

// Only fixed program text reaches PowerShell. Paths, identities and arguments
// are JSON data in an environment value, never executable command text.
export async function windowsOperation(source, input = {}) {
  const executable = windowsPowerShell();
  const timeoutMs = 15000;
  const started = performance.now();
  let phase = 'execute';
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Environment]::SetEnvironmentVariable("PSModulePath", [IO.Path]::Combine($PSHOME, "Modules"), "Process")',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    "$data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AW_SUBAGENT_PLATFORM_INPUT)) | ConvertFrom-Json",
    source,
  ].join('\n');
  try {
    const { stdout } = await execFileAsync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      env: windowsHostEnvironment(process.env, { AW_SUBAGENT_PLATFORM_INPUT: Buffer.from(JSON.stringify(input)).toString('base64') }),
    });
    phase = 'parse';
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (error) {
    const systemCode = ['ENOENT', 'EACCES', 'EPERM', 'ENOMEM', 'EAGAIN', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error.code) ? error.code : null;
    const reason = phase === 'parse' ? 'invalidJson'
      : systemCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'outputLimit'
        : error.killed === true ? 'timeout'
          : systemCode !== null ? 'launchFailed'
            : Number.isSafeInteger(error.code) ? 'processExit' : 'executionFailed';
    // Native errors contain the encoded command, input and raw output. Keep only
    // fixed categories and scalar process evidence in the public error message.
    const diagnostic = {
      operation: 'windowsOperation', phase, reason,
      elapsedMs: Math.round(performance.now() - started), timeoutMs,
      exitCode: Number.isSafeInteger(error.code) ? error.code : null,
      systemCode,
      signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGBREAK'].includes(error.signal) ? error.signal : null,
      killed: error.killed === true,
    };
    fail('platformOperationFailed', `A native Windows identity, access-control, or process operation failed. ${JSON.stringify(diagnostic)}`);
  }
}

export async function currentUserIdentity() {
  if (!userIdentity) userIdentity = (async () => {
    if (process.platform === 'win32') {
      const sid = await windowsOperation('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value | ConvertTo-Json -Compress');
      if (typeof sid !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(sid)) fail('userIdentityUnavailable', 'The current Windows user identity is unavailable.');
      return { kind: 'windows', sid };
    }
    if (!['darwin', 'linux'].includes(process.platform) || typeof process.getuid !== 'function') fail('platformUnsupported', 'External runs require macOS, Linux, or native Windows.');
    return { kind: 'posix', uid: process.getuid() };
  })().catch((error) => {
    // Share an in-flight read and cache success, but let a later caller recover
    // from a failed native query. The original callers still receive the error.
    userIdentity = undefined;
    throw error;
  });
  return { ...await userIdentity };
}

const windowsReparseCheck = [
  'foreach ($item in $data.chain) {',
  '  $entry = Get-Item -Force -LiteralPath $item',
  "  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'A reparse point is not allowed.' }",
  '}',
];

const windowsPrivateAclCheck = [
  '$acl = Get-Acl -LiteralPath $data.target',
  '$sid = [Security.Principal.SecurityIdentifier]::new($data.sid)',
  "if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $data.sid -or !$acl.AreAccessRulesProtected) { throw 'The resource owner or ACL is unsafe.' }",
  '$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
  '$full = [Security.AccessControl.FileSystemRights]::FullControl',
  '$allow = $false',
  'foreach ($rule in $rules) {',
  "  if ($rule.IdentityReference.Value -ne $data.sid -or $rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'A foreign or inherited ACL rule is present.' }",
  '  if (($rule.FileSystemRights -band $full) -eq $full) { $allow = $true }',
  '}',
  "if (!$allow) { throw 'The owner has no full resource access.' }",
];

const windowsPrivateAclSet = [
  '$sid = [Security.Principal.SecurityIdentifier]::new($data.sid)',
  'if ($data.kind -eq "directory") {',
  '  $acl = [Security.AccessControl.DirectorySecurity]::new()',
  '  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit',
  '  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)',
  '} else {',
  '  $acl = [Security.AccessControl.FileSecurity]::new()',
  '  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)',
  '}',
  '$acl.SetOwner($sid)',
  '$acl.SetAccessRuleProtection($true, $false)',
  '$acl.AddAccessRule($rule)',
  'Set-Acl -LiteralPath $data.target -AclObject $acl',
];

async function checkedPathChain(target, kind) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0') || path.normalize(target) !== target || !['file', 'directory'].includes(kind)) fail('pathInvalid', 'A runtime path must be absolute, normalized, and have a supported node type.');
  let current = path.parse(target).root;
  const chain = [current];
  for (const part of path.relative(current, target).split(path.sep).filter(Boolean)) { current = path.join(current, part); chain.push(current); }
  for (const item of chain) {
    const stat = await fs.lstat(item).catch(() => fail('pathMissing', 'A required runtime path is missing or unreadable.'));
    if (stat.isSymbolicLink()) fail('pathSymlink', 'Links are not allowed in private runtime resources.');
    if (item === target ? (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) : !stat.isDirectory()) fail('pathInvalid', 'A runtime path has an unsupported node type.');
  }
  return chain;
}

export async function assertNoReparsePath(target, kind = 'file') {
  const chain = await checkedPathChain(target, kind);
  if (process.platform === 'win32') await windowsOperation([...windowsReparseCheck, '$true | ConvertTo-Json -Compress'].join('\n'), { chain });
  return target;
}

export async function verifyPrivatePath(target, kind = 'directory', expectedOwner) {
  return verifyPrivatePaths([{ target, kind }], expectedOwner);
}

export async function verifyPrivatePaths(resources, expectedOwner) {
  const checked = [];
  for (const { target, kind = 'directory' } of resources) {
    checked.push({ target, kind, chain: await checkedPathChain(target, kind) });
  }
  if (checked.length === 0) return true;
  const owner = await currentUserIdentity();
  if (expectedOwner !== undefined && (expectedOwner?.kind !== owner.kind || (owner.kind === 'posix' ? expectedOwner.uid !== owner.uid : expectedOwner.sid !== owner.sid))) fail('resourceOwnerMismatch', 'The runtime resource belongs to a different user.');
  if (owner.kind === 'posix') {
    for (const { target, kind } of checked) {
      const stat = await fs.lstat(target);
      if (stat.uid !== owner.uid || (stat.mode & 0o777) !== (kind === 'directory' ? 0o700 : 0o600)) fail('resourceNotPrivate', 'A runtime resource must have private owner access.');
    }
  } else {
    // Shared ancestors need one reparse check in this native call. Every
    // resource still gets its own owner/ACL check; no evidence survives the call.
    await windowsOperation([
      ...windowsReparseCheck,
      'function Assert-PrivateResource($data) {',
      ...windowsPrivateAclCheck,
      '}',
      'foreach ($resource in $data.resources) { Assert-PrivateResource $resource }',
      '$true | ConvertTo-Json -Compress',
    ].join('\n'), {
      chain: [...new Set(checked.flatMap((resource) => resource.chain))],
      resources: checked.map(({ target, kind }) => ({ target, kind, sid: owner.sid })),
    });
  }
  return true;
}

export async function protectPrivatePath(target, kind = 'directory') {
  const chain = await checkedPathChain(target, kind);
  const owner = await currentUserIdentity();
  if (owner.kind === 'posix') {
    if ((await fs.lstat(target)).uid !== owner.uid) fail('resourceOwnerMismatch', 'The runtime resource belongs to a different user.');
    await fs.chmod(target, kind === 'directory' ? 0o700 : 0o600);
    await verifyPrivatePath(target, kind, owner);
  } else {
    // One fixed native host checks the full chain before and after the ACL
    // change, then reads the ACL back. Every private write uses this boundary.
    await windowsOperation([
      ...windowsReparseCheck,
      ...windowsPrivateAclSet,
      ...windowsReparseCheck,
      ...windowsPrivateAclCheck,
      '$true | ConvertTo-Json -Compress',
    ].join('\n'), { target, chain, kind, sid: owner.sid });
    await checkedPathChain(target, kind);
  }
  return target;
}

function environmentValue(environment, name) {
  return Object.entries(environment).find(([key]) => process.platform === 'win32' ? key.toLowerCase() === name.toLowerCase() : key === name)?.[1];
}

async function findCommand(command, cwd, environment) {
  if (path.isAbsolute(command) || /[/\\]/.test(command)) return path.resolve(cwd, command);
  const extensions = process.platform === 'win32' && !path.extname(command) ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  for (const directory of (environmentValue(environment, 'PATH') ?? '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(cwd, directory.replace(/^"|"$/g, ''), `${command}${extension}`);
      try { if ((await fs.stat(candidate)).isFile()) { await fs.access(candidate, constants.X_OK); return candidate; } } catch { /* Try the next PATH candidate. */ }
    }
  }
  fail('executableNotFound', 'The selected executable was not found on PATH.');
}

function npmShim(target) {
  return ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '', `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, ''].join('\n');
}

function pnpmShim(target, nodePath, nodeArgs) {
  const lines = ['@SETLOCAL'];
  if (nodePath) lines.push('@IF NOT DEFINED NODE_PATH (', `  @SET "NODE_PATH=${nodePath}"`, ') ELSE (', `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`, ')');
  lines.push('@IF EXIST "%~dp0\\node.exe" (', `  "%~dp0\\node.exe" ${nodeArgs} "%~dp0\\${target}" %*`, ') ELSE (', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', `  node ${nodeArgs} "%~dp0\\${target}" %*`, ')', '');
  return lines.join('\n');
}

async function resolveWindowsShim(shim, args, options) {
  // Batch syntax is not executed. Only a complete known launcher and its
  // package.json bin contract can select an ordinary JavaScript entrypoint.
  await assertNoReparsePath(shim);
  if ((await fs.stat(shim)).size > 65536) fail('executableShimUnsupported', 'The selected Windows launcher is too large.');
  const content = (await fs.readFile(shim, 'utf8')).replaceAll('\r\n', '\n');
  const targets = [...content.matchAll(/"%(?:dp0%|~dp0)\\([^"\r\n]+\.(?:c?js|mjs))"/g)].map((match) => match[1]);
  const target = targets[0];
  const nodePath = content.match(/^  @SET "NODE_PATH=([^"\n]+)"$/m)?.[1];
  const nodeArgs = content.includes('node --preserve-symlinks ') ? '--preserve-symlinks' : '';
  if (!target || targets.some((item) => item !== target) || ![npmShim(target), pnpmShim(target, nodePath, nodeArgs)].includes(content)) fail('executableShimUnsupported', 'The selected Windows launcher is not a supported npm or pnpm shim. Use a native executable or an explicit Node entrypoint.');
  const entrypoint = await fs.realpath(path.resolve(path.dirname(shim), target)).catch(() => fail('executableShimUnsupported', 'The selected launcher entrypoint is missing.'));
  await assertNoReparsePath(entrypoint);
  let directory = path.dirname(entrypoint);
  let metadata;
  let packageRoot;
  while (directory !== path.dirname(directory)) {
    try {
      const metadataPath = path.join(directory, 'package.json');
      await assertNoReparsePath(metadataPath);
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      packageRoot = directory;
      break;
    } catch (error) { if (error.code !== 'pathMissing') fail('executableShimUnsupported', 'The selected launcher package could not be verified.'); }
    directory = path.dirname(directory);
  }
  const binName = options.binName ?? path.basename(shim, path.extname(shim));
  const bin = typeof metadata?.bin === 'string' ? metadata.bin : metadata?.bin?.[binName];
  if (typeof metadata?.name !== 'string' || (options.packageName !== undefined && metadata.name !== options.packageName) || typeof bin !== 'string' || path.resolve(packageRoot, bin) !== entrypoint) fail('executableShimUnsupported', 'The selected launcher does not match its package bin contract.');
  const relative = path.relative(packageRoot, entrypoint);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('executableShimUnsupported', 'The selected launcher entrypoint is outside its package.');
  const environment = { ...(options.env ?? process.env) };
  if (nodePath) {
    // Preserve the validated shim's Node module lookup without executing SET.
    const expanded = nodePath.replaceAll('%~dp0', path.dirname(shim));
    if (expanded.includes('%')) fail('executableShimUnsupported', 'The selected launcher uses unsupported environment expansion.');
    const existing = environmentValue(environment, 'NODE_PATH');
    for (const name of Object.keys(environment)) if (name.toLowerCase() === 'node_path') delete environment[name];
    environment.NODE_PATH = existing ? `${expanded};${existing}` : expanded;
  }
  let node = path.join(path.dirname(shim), 'node.exe');
  try { if (!(await fs.stat(node)).isFile()) throw new Error(); } catch { node = await findCommand('node', options.cwd ?? process.cwd(), environment); }
  const nodeInvocation = await resolveSafeCommand(node, [...(nodeArgs ? [nodeArgs] : []), entrypoint, ...args], { ...options, env: environment });
  return { ...nodeInvocation, env: environment };
}

export async function resolveSafeCommand(command, args = [], options = {}) {
  if (typeof command !== 'string' || !command || command.includes('\0') || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) fail('executableInvalid', 'An executable and its arguments must be strings without NUL.');
  const cwd = options.cwd ?? process.cwd();
  if (!path.isAbsolute(cwd)) fail('pathInvalid', 'The execution directory must be absolute.');
  const resolved = await findCommand(command, cwd, options.env ?? process.env);
  const canonical = await fs.realpath(resolved).catch(() => fail('executableNotFound', 'The selected executable is missing or unreadable.'));
  if (!(await fs.stat(canonical)).isFile()) fail('executableInvalid', 'The selected executable is not a normal file.');
  if (process.platform === 'win32') {
    const extension = path.extname(canonical).toLowerCase();
    if (extension === '.cmd') return resolveWindowsShim(canonical, args, options);
    if (!['.exe', '.com'].includes(extension)) fail('executableShimUnsupported', 'Windows requires a native executable or a verified package-manager shim.');
  } else {
    try { await fs.access(canonical, constants.X_OK); } catch { fail('executableNotRunnable', 'The selected command is not executable.'); }
  }
  return { command: canonical, args: [...args] };
}

export function launchedProcess(pid) { return launches.get(pid); }

export async function windowsJobMembers(scope, stop = false) {
  const owner = await currentUserIdentity();
  if (scope?.kind !== 'windows-job' || !/^Local\\aw-subagent-[a-f0-9]{32}$/.test(scope.name ?? '') || owner.kind !== 'windows' || scope.sid !== owner.sid) fail('processScopeInvalid', 'The native job ownership information is invalid.');
  try {
    const { stdout } = await execFileAsync(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', windowsJobHelper, '-Action', stop ? 'stop' : 'observe'], {
      windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
      env: windowsHostEnvironment(process.env, { AW_SUBAGENT_JOB_CONTROL: Buffer.from(JSON.stringify(scope)).toString('base64') }),
    });
    const pids = JSON.parse(stdout.trim());
    if (!Array.isArray(pids) || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error();
    return pids;
  } catch { fail('processScopeObservationFailed', 'The native job could not be observed or stopped.'); }
}

async function windowsJobLaunch(invocation, options) {
  const parent = options.resourceDirectory ?? await fs.realpath(os.tmpdir());
  if (options.resourceDirectory !== undefined) await verifyPrivatePath(parent, 'directory');
  const directory = await fs.mkdtemp(path.join(parent, 'job-'));
  try {
    await protectPrivatePath(directory, 'directory');
    const configuration = path.join(directory, 'launch.json');
    const status = path.join(directory, 'ready.json');
    const owner = await currentUserIdentity();
    const scope = { kind: 'windows-job', name: `Local\\aw-subagent-${randomBytes(16).toString('hex')}`, sid: owner.sid };
    const environment = invocation.env ?? options.env ?? process.env;
    const modulePaths = Object.entries(environment).filter(([name]) => isPowerShellModulePath(name)).map(([name, value]) => ({ name, value }));
    await fs.writeFile(configuration, JSON.stringify({ executable: invocation.command, args: invocation.args, parentPid: process.pid, name: scope.name, status, modulePaths }), { mode: 0o600, flag: 'wx' });
    await protectPrivatePath(configuration, 'file');
    await assertNoReparsePath(windowsJobHelper, 'file');
    return {
      command: windowsPowerShell(), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', windowsJobHelper, '-Action', 'run'],
      env: windowsHostEnvironment(environment, { AW_SUBAGENT_JOB_CONFIG: configuration }), directory, status, scope,
    };
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

async function waitForJob(child, launch) {
  const deadline = Date.now() + 20000;
  while (true) {
    try {
      const value = JSON.parse(await fs.readFile(launch.status, 'utf8'));
      if (value.ready === true && Number.isSafeInteger(value.pid) && value.pid > 0) return;
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) fail('processScopeUnavailable', 'The native job boundary was not established before backend submission.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function safeSpawn(command, args = [], options = {}) {
  if ((options.shell !== undefined && options.shell !== false) || options.windowsVerbatimArguments) fail('unsafeLaunchOptions', 'External processes require shell-free argument passing.');
  let invocation = await resolveSafeCommand(command, args, options);
  const token = (options.env ?? process.env).AW_SUBAGENT_PROCESS_TOKEN;
  // The detached worker must outlive start. Only its attached adapter/backend
  // scopes use a job whose native handle is held by a long-lived helper.
  const managedJob = process.platform === 'win32' && options.detached !== true && /^[a-f0-9]{48}$/.test(token ?? '');
  if (managedJob) invocation = await windowsJobLaunch(invocation, options);
  const { packageName, binName, resourceDirectory, ...spawnOptions } = options;
  const child = spawn(invocation.command, invocation.args, { ...spawnOptions, ...(invocation.env ? { env: invocation.env } : {}), shell: false, detached: options.detached ?? false, windowsHide: options.windowsHide ?? true });
  const record = { token, identity: null };
  child.identityReady = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', async () => {
      launches.set(child.pid, record);
      try {
        const { processIdentity, captureProcessScope } = await import('./processes.mjs');
        const identity = await processIdentity(child.pid);
        if (managedJob) await waitForJob(child, invocation);
        if (identity?.ppid === process.pid && /^[a-f0-9]{48}$/.test(token ?? '')) {
          const scope = managedJob ? invocation.scope : await captureProcessScope(identity, token);
          record.identity = child.processIdentity = { ...identity, ownership: token, owner: await currentUserIdentity(), ...(scope ? { scope } : {}) };
        }
        resolve(record.identity);
      } catch (error) { reject(error); }
    });
  });
  record.ready = child.identityReady;
  if (Number.isSafeInteger(child.pid)) launches.set(child.pid, record);
  // A caller-supplied runtime directory is removed by that caller after native
  // tree-stop proof. Do not race its recursive cleanup with another remover.
  if (managedJob && resourceDirectory === undefined) child.once('close', () => { child.identityReady.catch(() => {}).then(() => fs.rm(invocation.directory, { recursive: true, force: true })).catch(() => {}); });
  // Consumers still receive the original rejecting promise. This observer only
  // prevents an unhandled rejection before they have installed stream listeners.
  child.identityReady.catch(() => {});
  return child;
}
