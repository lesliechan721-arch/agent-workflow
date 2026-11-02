import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { fail } from './contracts.mjs';
import { resolveWindowsNativeHelper, windowsNativeOperation } from './windows-native.mjs';

const execFileAsync = promisify(execFile);
const launches = new Map();
let userIdentity;

function windowsSystemExecutable(...parts) {
  const root = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1];
  if (!root || !path.isAbsolute(root)) fail('platformUnavailable', 'The Windows system directory is unavailable.');
  return path.join(root, 'System32', ...parts);
}

const windowsPowerShell = () => windowsSystemExecutable('WindowsPowerShell', 'v1.0', 'powershell.exe');

function isPowerShellModulePath(name) {
  return ['psmodulepath', 'winpsmodulepath'].includes(name.toLowerCase());
}

function windowsHostEnvironment(environment, input) {
  // A Node process launched by pwsh inherits PowerShell 7 module paths. Windows
  // PowerShell 5.1 uses only its fixed system modules for native operations.
  return { ...Object.fromEntries(Object.entries(environment).filter(([name]) => !isPowerShellModulePath(name))), ...input };
}

function nativeFailure(error, operation, started, timeoutMs, phase = 'execute') {
  const systemCode = ['ENOENT', 'EACCES', 'EPERM', 'ENOMEM', 'EAGAIN', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error.code) ? error.code : null;
  const reason = phase === 'parse' ? 'invalidJson'
    : systemCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'outputLimit'
      : error.killed === true ? 'timeout'
        : systemCode !== null ? 'launchFailed'
          : Number.isSafeInteger(error.code) ? 'processExit' : 'executionFailed';
  // Native errors can contain commands, inputs and raw output. Expose only
  // fixed categories and scalar process evidence.
  const diagnostic = {
    operation, phase, reason, elapsedMs: Math.round(performance.now() - started), timeoutMs,
    exitCode: Number.isSafeInteger(error.code) ? error.code : null, systemCode,
    signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGBREAK'].includes(error.signal) ? error.signal : null,
    killed: error.killed === true,
  };
  fail('platformOperationFailed', `A native Windows identity, access-control, or process operation failed. ${JSON.stringify(diagnostic)}`);
}

// Only fixed program text reaches PowerShell. Paths, identities and arguments
// are JSON data in an environment value, never executable command text.
export async function windowsOperation(source, input = {}, operation = 'other') {
  const executable = windowsPowerShell();
  // Cold PowerShell startup and ACL operations can exceed 15 seconds on CI.
  const timeoutMs = 30000;
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
      env: windowsHostEnvironment(process.env, { AW_SUBAGENT_PLATFORM_INPUT: Buffer.from(JSON.stringify(input)).toString('base64'), AW_SUBAGENT_NATIVE_OPERATION: operation }),
    });
    phase = 'parse';
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (error) {
    nativeFailure(error, 'windowsOperation', started, timeoutMs, phase);
  }
}

export async function currentUserIdentity() {
  if (!userIdentity) userIdentity = (async () => {
    if (process.platform === 'win32') {
      // whoami reads the current access token without starting PowerShell.
      // Select the system executable directly; never trust PATH or a host SID.
      let stdout;
      const executable = windowsSystemExecutable('whoami.exe');
      const started = performance.now();
      try {
        ({ stdout } = await execFileAsync(executable, ['/user', '/fo', 'csv', '/nh'], {
          shell: false, windowsHide: true, timeout: 15000, maxBuffer: 65536,
          env: { ...process.env, AW_SUBAGENT_NATIVE_OPERATION: 'identity' },
        }));
      } catch (error) { nativeFailure(error, 'identity', started, 15000); }
      // The account name can use a non-UTF-8 console encoding. Only the ASCII
      // SID column is consumed; require exactly one header-free CSV record.
      const sid = stdout.trim().match(/^"(?:[^"\r\n]|"")*","(S-1-\d+(?:-\d+)+)"$/)?.[1];
      if (!sid) fail('userIdentityUnavailable', 'The current Windows user identity is unavailable.');
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
  if (process.platform === 'win32') await windowsNativeOperation('pathCheck', { target, kind, chain });
  return target;
}

export async function assertNoReparseTree(directory) {
  const chain = await checkedPathChain(directory, 'directory');
  if (process.platform === 'win32') {
    await windowsNativeOperation('pathTree', { target: directory, kind: 'directory', chain });
    await checkedPathChain(directory, 'directory');
  } else {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      await assertNoReparsePath(target, entry.isDirectory() ? 'directory' : 'file');
      if (entry.isDirectory()) await assertNoReparseTree(target);
      else if (!entry.isFile()) fail('cleanupUnsafe', 'The run contains a foreign resource.');
    }
  }
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
    const inputFor = (resources) => ({
      chain: [...new Set(resources.flatMap((resource) => resource.chain))],
      resources: resources.map(({ target, kind }) => ({ target, kind, sid: owner.sid })),
    });
    const verifyBatch = async (resources) => {
      const input = inputFor(resources);
      if (Buffer.byteLength(JSON.stringify(input)) > 18 * 1024) fail('platformOperationFailed', 'A native Windows path verification input is too large.');
      await windowsNativeOperation('aclVerify', input);
    };
    let batch = [];
    for (const resource of checked) {
      // Keep the existing 18 KiB batch bound for predictable native work.
      const candidate = [...batch, resource];
      if (batch.length && Buffer.byteLength(JSON.stringify(inputFor(candidate))) > 18 * 1024) {
        await verifyBatch(batch);
        batch = [resource];
      } else batch = candidate;
    }
    await verifyBatch(batch);
  }
  return true;
}

export async function protectPrivatePath(target, kind = 'directory') {
  await protectPrivatePaths([{ target, kind }]);
  return target;
}

export async function protectPrivatePaths(resources) {
  const checked = [];
  for (const { target, kind = 'directory' } of resources) {
    checked.push({ target, kind, chain: await checkedPathChain(target, kind) });
  }
  if (checked.length === 0) return true;
  const owner = await currentUserIdentity();
  if (owner.kind === 'posix') {
    for (const { target, kind } of checked) {
      if ((await fs.lstat(target)).uid !== owner.uid) fail('resourceOwnerMismatch', 'The runtime resource belongs to a different user.');
      await fs.chmod(target, kind === 'directory' ? 0o700 : 0o600);
      await verifyPrivatePath(target, kind, owner);
    }
  } else {
    let batch = [];
    const protectBatch = async (resources) => {
      const input = { resources: resources.map((resource) => ({ ...resource, sid: owner.sid })) };
      if (Buffer.byteLength(JSON.stringify(input)) > 18 * 1024) fail('platformOperationFailed', 'A native Windows path protection input is too large.');
      await windowsNativeOperation('aclProtect', input);
    };
    for (const resource of checked) {
      const candidate = [...batch, resource];
      if (batch.length && Buffer.byteLength(JSON.stringify({ resources: candidate.map((item) => ({ ...item, sid: owner.sid })) })) > 18 * 1024) {
        await protectBatch(batch);
        batch = [resource];
      } else batch = candidate;
    }
    await protectBatch(batch);
    for (const { target, kind } of checked) await checkedPathChain(target, kind);
  }
  return true;
}

function environmentValue(environment, name) {
  return Object.entries(environment).find(([key]) => process.platform === 'win32' ? key.toLowerCase() === name.toLowerCase() : key === name)?.[1];
}

async function findCommand(command, cwd, environment) {
  if (path.isAbsolute(command) || /[/\\]/.test(command)) return path.resolve(cwd, command);
  const extensions = process.platform === 'win32' && !path.extname(command) ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  let notRunnable = false;
  for (const directory of (environmentValue(environment, 'PATH') ?? '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(cwd, directory.replace(/^"|"$/g, ''), `${command}${extension}`);
      try {
        if (!(await fs.stat(candidate)).isFile()) continue;
        try { await fs.access(candidate, constants.X_OK); return candidate; }
        catch { notRunnable = true; }
      } catch { /* Try the next PATH candidate. */ }
    }
  }
  if (notRunnable) fail('executableNotRunnable', 'The selected command was found on PATH but is not executable.');
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
  try { return await windowsNativeOperation(stop ? 'jobStop' : 'jobObserve', scope); }
  catch { fail('processScopeObservationFailed', 'The native job could not be observed or stopped.'); }
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
    await fs.writeFile(configuration, JSON.stringify({ schemaVersion: 1, executable: invocation.command, args: invocation.args, parentPid: process.pid, name: scope.name, status, sid: owner.sid }), { mode: 0o600, flag: 'wx' });
    await protectPrivatePath(configuration, 'file');
    const helper = await resolveWindowsNativeHelper();
    return {
      command: helper, args: ['--plugin-config', configuration],
      env: { ...environment }, directory, status, scope,
    };
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

async function waitForJob(child, launch) {
  const deadline = Date.now() + 20000;
  while (true) {
    try {
      const stat = await fs.lstat(launch.status);
      if (stat.size > 4096) fail('processScopeUnavailable', 'The native job readiness information is invalid.');
      await verifyPrivatePath(launch.status, 'file', { kind: 'windows', sid: launch.scope.sid });
      const value = JSON.parse(await fs.readFile(launch.status, 'utf8'));
      if (value?.ready === true && Number.isSafeInteger(value.pid) && value.pid > 0 && Object.keys(value).length === 2) return;
      fail('processScopeUnavailable', 'The native job readiness information is invalid.');
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
