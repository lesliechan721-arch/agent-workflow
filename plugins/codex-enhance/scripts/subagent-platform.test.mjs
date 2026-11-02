import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { assertNoReparsePath, currentUserIdentity, protectPrivatePath, protectPrivatePaths, resolveSafeCommand, safeSpawn, verifyPrivatePath, verifyPrivatePaths, windowsOperation } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { observeTree, ownsProcess, processIdentity, processTable, stopOwnedTree } from '../skills/codex-subagent-guide/scripts/runtime/processes.mjs';
import { resolveWindowsNativeHelper, windowsNativeOperation } from '../skills/codex-subagent-guide/scripts/runtime/windows-native.mjs';
import { createRun, removeScratch, storeContext } from '../skills/codex-subagent-guide/scripts/runtime/store.mjs';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

// Only this test uses the static platform-module alias directly. Other moved
// fixtures copy the complete resource source, including bundle-local PE files.
const require = createRequire(import.meta.url);
const platformEntry = require.resolve('../skills/codex-subagent-guide/scripts/runtime/platform.mjs');
const helperSource = path.join(guideRuntimeScripts(import.meta.url), 'runtime/native');
const helperTarget = path.join(path.dirname(platformEntry), 'native');
if (helperSource !== helperTarget && !await fs.lstat(helperTarget).catch((error) => { if (error.code === 'ENOENT') return null; throw error; })) await fs.cp(helperSource, helperTarget, { recursive: true });

async function temporary(t, beforeRemove = async () => {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-subagent-platform-'));
  t.after(async () => { await beforeRemove(); await fs.rm(directory, { recursive: true, force: true }); });
  return directory;
}

// Test Value Gate: actual owner permissions and link rejection protect private
// run state. Windows executes the ACL implementation, never a chmod substitute.
test('native private resources verify owner access and reject links', { timeout: 40000 }, async (t) => {
  const directory = await temporary(t);
  const identityStarted = performance.now();
  const owner = await currentUserIdentity();
  if (process.platform === 'win32') t.diagnostic(`Windows identity query: ${Math.round(performance.now() - identityStarted)} ms (inherited home)`);
  assert.equal(owner.kind, process.platform === 'win32' ? 'windows' : 'posix');
  if (owner.kind === 'windows') {
    assert.equal(owner.sid, await windowsOperation('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value | ConvertTo-Json -Compress', {}, 'identity'));
  }
  await protectPrivatePath(directory);
  assert.equal(await verifyPrivatePath(directory, 'directory', owner), true);
  const file = path.join(directory, '中文 😀.json');
  await fs.writeFile(file, '{}\n', { mode: 0o600 });
  const resources = [{ target: directory, kind: 'directory' }, { target: file, kind: 'file' }];
  await protectPrivatePaths(resources);
  assert.equal(await verifyPrivatePath(file, 'file', owner), true);
  assert.equal(await verifyPrivatePaths(resources, owner), true);
  const link = path.join(directory, 'link');
  await fs.symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertNoReparsePath(link, 'directory'), { code: 'pathSymlink' });
  await assert.rejects(protectPrivatePath(link, 'directory'), { code: 'pathSymlink' });
  await assert.rejects(protectPrivatePaths([...resources, { target: link, kind: 'directory' }]), { code: 'pathSymlink' });
  await assert.rejects(verifyPrivatePath(link, 'directory'), { code: 'pathSymlink' });
  await assert.rejects(verifyPrivatePaths([...resources, { target: link, kind: 'directory' }], owner), { code: 'pathSymlink' });
  if (owner.kind === 'posix') {
    await fs.chmod(file, 0o644);
    await assert.rejects(verifyPrivatePath(file, 'file'), { code: 'resourceNotPrivate' });
    await assert.rejects(verifyPrivatePaths(resources, owner), { code: 'resourceNotPrivate' });
    await protectPrivatePath(file, 'file');
    await assert.rejects(verifyPrivatePath(file, 'file', { kind: 'posix', uid: owner.uid + 1 }), { code: 'resourceOwnerMismatch' });
  } else {
    await assert.rejects(verifyPrivatePath(file, 'file', { kind: 'windows', sid: 'S-1-0-0' }), { code: 'resourceOwnerMismatch' });
    for (const mutation of [
      '$acl.SetAccessRuleProtection($false, $true)',
      '$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new("S-1-1-0"), [Security.AccessControl.FileSystemRights]::ReadData, [Security.AccessControl.AccessControlType]::Allow))',
    ]) {
      // Real unsafe ACLs must still fail after combining native operations.
      await windowsOperation(['$acl = Get-Acl -LiteralPath $data.target', mutation, 'Set-Acl -LiteralPath $data.target -AclObject $acl', '$true | ConvertTo-Json -Compress'].join('\n'), { target: file });
      await assert.rejects(verifyPrivatePath(file, 'file'), { code: 'platformOperationFailed' });
      await assert.rejects(verifyPrivatePaths(resources, owner), { code: 'platformOperationFailed' });
      await protectPrivatePaths(resources);
      assert.equal(await verifyPrivatePath(file, 'file', owner), true);
    }
  }
});

// Test Value Gate: a native tree walk must reject a linked descendant before
// deletion, preserve its target, and remove the same ordinary tree after repair.
test('native scratch cleanup preserves a linked sibling and rechecks repaired descendants', { timeout: 40000 }, async (t) => {
  const directory = await temporary(t);
  await protectPrivatePath(directory);
  const scratch = path.join(directory, 'adapter');
  const nested = path.join(scratch, 'nested');
  const sibling = path.join(directory, 'sibling');
  for (const target of [scratch, nested, sibling]) await fs.mkdir(target, { mode: 0o700 });
  await protectPrivatePaths([scratch, nested, sibling].map((target) => ({ target, kind: 'directory' })));
  await fs.writeFile(path.join(nested, '中文 😀.txt'), 'scratch');
  await fs.writeFile(path.join(sibling, 'preserved.txt'), 'preserve');
  const linked = path.join(nested, 'linked');
  await fs.symlink(sibling, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const run = { directory, meta: { localTreeStopped: true, owner: await currentUserIdentity() } };
  await assert.rejects(removeScratch(run), { code: process.platform === 'win32' ? 'platformOperationFailed' : 'pathSymlink' });
  assert.equal(await fs.readFile(path.join(nested, '中文 😀.txt'), 'utf8'), 'scratch');
  assert.equal(await fs.readFile(path.join(sibling, 'preserved.txt'), 'utf8'), 'preserve');
  await fs.unlink(linked);
  assert.equal(await removeScratch(run), true);
  assert.equal(await fs.lstat(scratch).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(sibling, 'preserved.txt'), 'utf8'), 'preserve');
});

// Test Value Gate: prompts, Unicode, shell metacharacters and embedded line
// endings must arrive as argv data, with no shell expansion or re-encoding.
test('safe native launch preserves argument bytes and observes rapid exit', { timeout: 40000 }, async (t) => {
  const directory = await temporary(t);
  const args = ['中文 😀', 'one\r\ntwo\n', '$(touch unwanted)', '`touch unwanted`', '& | > < ^ %PATH%', 'a"b\\'];
  const child = await safeSpawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  assert.deepEqual(await closed, [0, null]);
  await child.identityReady;
  assert.deepEqual(JSON.parse(stdout), args);
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(safeSpawn(process.execPath, [], { shell: true }), { code: 'unsafeLaunchOptions' });
  await assert.rejects(resolveSafeCommand(process.execPath, ['bad\0arg']), { code: 'executableInvalid' });
});

// Test Value Gate: CLI initialization must distinguish a missing command from
// an installed non-executable file, without hiding a later executable PATH entry.
test('PATH discovery distinguishes non-executable files and continues to a runnable entry', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await temporary(t);
  const first = path.join(directory, 'first'); const second = path.join(directory, 'second');
  await fs.mkdir(first); await fs.mkdir(second);
  const blocked = path.join(first, 'fixture-cli'); const runnable = path.join(second, 'fixture-cli');
  await fs.writeFile(blocked, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  await fs.writeFile(runnable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await assert.rejects(resolveSafeCommand('missing-cli', [], { cwd: directory, env: { PATH: first } }), { code: 'executableNotFound' });
  await assert.rejects(resolveSafeCommand('fixture-cli', [], { cwd: directory, env: { PATH: first } }), { code: 'executableNotRunnable' });
  assert.equal((await resolveSafeCommand('fixture-cli', [], { cwd: directory, env: { PATH: [first, second].join(path.delimiter) } })).command, runnable);
});

// Test Value Gate: a package shim must select its verified bin without running
// batch syntax. This test supplies evidence only on native Windows.
test('native Windows package shim preserves argv and rejects injected batch text', { skip: process.platform !== 'win32', timeout: 40000 }, async (t) => {
  const directory = await temporary(t);
  const packageRoot = path.join(directory, 'node_modules', 'fixture-cli');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-cli', bin: { fixture: 'cli.js' } }));
  await fs.writeFile(path.join(packageRoot, 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const shim = path.join(directory, 'fixture.cmd');
  const contents = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '', 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fixture-cli\\cli.js" %*', ''].join('\r\n');
  await fs.writeFile(shim, contents);
  const expected = ['中文 😀', 'one\r\ntwo', '& echo injected > unwanted'];
  const child = await safeSpawn(shim, expected, { cwd: directory, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], packageName: 'fixture-cli', binName: 'fixture' });
  const closed = once(child, 'close');
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  assert.deepEqual(await closed, [0, null]);
  await child.identityReady;
  assert.deepEqual(JSON.parse(stdout), expected);
  await fs.appendFile(shim, '\r\necho injected > unwanted\r\n');
  await assert.rejects(resolveSafeCommand(shim, [], { cwd: directory }), { code: 'executableShimUnsupported' });
  assert.equal(await fs.stat(path.join(directory, 'unwanted')).catch(() => null), null);
});

// Test Value Gate: the native Job must preserve module-path values and absence
// in the backend environment, without starting a PowerShell host.
test('native Windows job preserves backend module paths and their absence', { skip: process.platform !== 'win32', timeout: 120000 }, async (t) => {
  const directory = await temporary(t);
  await protectPrivatePath(directory, 'directory');
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['psmodulepath', 'winpsmodulepath'].includes(name.toLowerCase())));
  for (const expected of [
    { PSModulePath: 'C:\\fixture modules 中文;C:\\other modules', WinPSModulePath: 'C:\\saved fixture modules' },
    {},
  ]) {
    const code = 'process.stdin.once("data",()=>{process.stdout.write(JSON.stringify({PSModulePath:process.env.PSModulePath,WinPSModulePath:process.env.WinPSModulePath}));process.exit(0)});';
    const child = await safeSpawn(process.execPath, ['-e', code], { cwd: directory, resourceDirectory: directory, env: { ...base, ...expected, AW_SUBAGENT_PROCESS_TOKEN: randomBytes(24).toString('hex') }, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    assert.equal((await child.identityReady)?.scope?.kind, 'windows-job');
    child.stdin.end('go\n');
    assert.deepEqual(await closed, [0, null], stderr);
    assert.deepEqual(JSON.parse(stdout), expected);
  }
});

// Test Value Gate: a fresh plugin home must initialize the real identity,
// private ACL and Job boundary without resources from another installation.
test('native Windows isolated home loads platform and job APIs without a host cache', { skip: process.platform !== 'win32', timeout: 120000 }, async (t) => {
  const directory = await temporary(t);
  const home = path.join(directory, 'home');
  const temp = path.join(directory, 'tmp');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const probe = path.join(directory, 'private-probe');
  await Promise.all([home, temp, appData, localAppData, probe].map((entry) => fs.mkdir(entry, { recursive: true })));
  const systemKeys = new Set([
    'systemroot', 'windir', 'systemdrive', 'comspec', 'pathext', 'path',
    'programfiles', 'programfiles(x86)', 'programw6432',
    'commonprogramfiles', 'commonprogramfiles(x86)', 'commonprogramw6432',
  ]);
  const drive = path.parse(home).root.replace(/[\\/]$/, '');
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => systemKeys.has(name.toLowerCase()))),
    HOME: home, USERPROFILE: home, HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length),
    APPDATA: appData, LOCALAPPDATA: localAppData, TEMP: temp, TMP: temp,
    AW_SUBAGENT_PROCESS_TOKEN: randomBytes(24).toString('hex'),
  };
  const safeCodes = [
    'platformUnavailable', 'platformOperationFailed', 'userIdentityUnavailable',
    'pathInvalid', 'pathMissing', 'pathSymlink', 'resourceOwnerMismatch',
    'resourceNotPrivate', 'executableNotFound', 'executableInvalid',
    'processScopeUnavailable', 'ERR_ASSERTION', 'unexpectedFailure',
  ];
  const safePhases = ['import', 'identity', 'protect', 'verify', 'jobSpawn', 'jobIdentity', 'backendExit', 'backendEnvironment'];
  const source = [
    'import assert from "node:assert/strict";',
    'import { once } from "node:events";',
    'const { safeError } = await import(new URL("./contracts.mjs", process.argv[1]));',
    'let phase = "import"; let backendExitCode = null;',
    'let identityElapsedMs = null;',
    'try {',
    'const api = await import(process.argv[1]);',
    'phase = "identity";',
    'const identityStarted = performance.now();',
    'const owner = await api.currentUserIdentity();',
    'identityElapsedMs = Math.round(performance.now() - identityStarted);',
    'assert.equal(owner.kind, "windows");',
    'phase = "protect";',
    'await api.protectPrivatePath(process.argv[2]);',
    'phase = "verify";',
    'assert.equal(await api.verifyPrivatePath(process.argv[2], "directory", owner), true);',
    `const backend = ${JSON.stringify('process.stdin.once("data",()=>{process.stdout.write(JSON.stringify({PSModulePath:process.env.PSModulePath,WinPSModulePath:process.env.WinPSModulePath}));process.exit(0)});')};`,
    'phase = "jobSpawn";',
    'const child = await api.safeSpawn(process.execPath, ["-e", backend], { cwd: process.argv[2], resourceDirectory: process.argv[2], env: process.env, stdio: ["pipe", "pipe", "pipe"] });',
    'const closed = once(child, "close");',
    'let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });',
    'child.stderr.resume();',
    'phase = "jobIdentity";',
    'assert.equal((await child.identityReady)?.scope?.kind, "windows-job");',
    'child.stdin.end("go\\n");',
    'phase = "backendExit";',
    'const exit = await closed; backendExitCode = Number.isInteger(exit[0]) ? exit[0] : null;',
    'assert.deepEqual(exit, [0, null]);',
    'phase = "backendEnvironment";',
    'assert.deepEqual(JSON.parse(stdout), {});',
    'process.stdout.write(JSON.stringify({ identity: true, privateAcl: true, job: true, backendEnvironment: true, identityElapsedMs }));',
    '} catch (error) {',
    `const code = ${JSON.stringify(safeCodes)}.includes(error.code) ? error.code : "unexpectedFailure";`,
    'const message = code === "platformOperationFailed" ? safeError(error).message : undefined;',
    'process.stdout.write(JSON.stringify({ phase, code, backendExitCode, message }), () => process.exit(1));',
    '}',
  ].join('\n');
  let receipt;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, pathToFileURL(platformEntry).href, probe], {
      cwd: directory, env: environment, shell: false, windowsHide: true,
      timeout: 90000, maxBuffer: 64 * 1024,
    });
    receipt = JSON.parse(stdout);
  } catch (error) {
    let failure;
    try { failure = JSON.parse(error.stdout ?? ''); } catch {}
    const diagnostic = {
      phase: safePhases.includes(failure?.phase) ? failure.phase : 'launchOrReceipt',
      code: safeCodes.includes(failure?.code) ? failure.code : (error.killed === true ? 'timeout' : 'unexpectedFailure'),
      exitCode: Number.isInteger(error.code) ? error.code : null,
      backendExitCode: Number.isInteger(failure?.backendExitCode) ? failure.backendExitCode : null,
      message: typeof failure?.message === 'string' && Buffer.byteLength(failure.message) <= 768 ? failure.message : undefined,
    };
    assert.fail(`The native isolated platform and Job probe failed: ${JSON.stringify(diagnostic)}`);
  }
  const { identityElapsedMs, ...checks } = receipt;
  assert.deepEqual(checks, { identity: true, privateAcl: true, job: true, backendEnvironment: true });
  assert.ok(Number.isSafeInteger(identityElapsedMs) && identityElapsedMs >= 0);
  t.diagnostic(`Windows identity query: ${identityElapsedMs} ms (isolated home)`);
});

// Test Value Gate: a persisted PID requires its original start identity.
// Cleanup of one native scope must preserve an unrelated sibling.
test('native ownership and tree stop preserve an unrelated sibling', { timeout: 40000 }, async (t) => {
  const cleanup = [];
  const directory = await temporary(t, async () => { for (const operation of cleanup.reverse()) await operation(); });
  const token = randomBytes(24).toString('hex');
  const environment = { ...process.env, AW_SUBAGENT_PROCESS_TOKEN: token };
  const siblingToken = randomBytes(24).toString('hex');
  const sibling = await safeSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: directory, env: { ...environment, AW_SUBAGENT_PROCESS_TOKEN: siblingToken }, stdio: 'ignore' });
  const siblingClosed = once(sibling, 'close');
  cleanup.push(async () => { await stopOwnedTree(sibling.pid, [sibling.processIdentity].filter(Boolean), siblingToken); await siblingClosed; });
  const root = await safeSpawn(process.execPath, ['-e', "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(() => {}, 20000)'],{stdio:'ignore',env:process.env});process.stdout.write(JSON.stringify({pid:child.pid})+'\\n');setTimeout(() => {},20000)"], { cwd: directory, env: environment, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
  const rootClosed = once(root, 'close');
  cleanup.push(async () => { await stopOwnedTree(root.pid, [root.processIdentity].filter(Boolean), token); await rootClosed; });
  let line = '';
  const spawned = new Promise((resolve) => root.stdout.on('data', (chunk) => { line += chunk; if (line.includes('\n')) resolve(JSON.parse(line.trim())); }));
  const descendant = await spawned;
  const rootIdentity = await root.identityReady;
  const siblingIdentity = await sibling.identityReady;
  assert.ok(rootIdentity);
  assert.ok(siblingIdentity);
  assert.equal(await ownsProcess({ ...rootIdentity, started: 'invalid-start-identity' }, token), false);
  assert.equal(await ownsProcess(rootIdentity, randomBytes(24).toString('hex')), false);
  assert.equal(await ownsProcess(rootIdentity, token), true);
  const started = performance.now();
  const tracked = await observeTree(root.pid, [rootIdentity], token);
  t.diagnostic(`native process observation: ${Math.round(performance.now() - started)} ms (${process.platform}/${process.arch})`);
  assert.ok(tracked.some((row) => row.pid === descendant.pid));
  const stopped = await stopOwnedTree(root.pid, tracked, token);
  assert.equal(stopped.stopped, true);
  assert.equal(await ownsProcess(siblingIdentity, siblingToken), true);
  const table = await processTable();
  assert.ok(table.some((row) => row.pid === process.pid));
  assert.equal(table.some((row) => row.pid === rootIdentity.pid && row.started === rootIdentity.started), false);
});

// Test Value Gate: neither a short-lived middle process nor the original root
// need survive until the next sample. Native scope emptiness must prove cleanup.
test('native scope stops an orphan after its middle process and root have exited', { timeout: 120000 }, async (t) => {
  const directory = await temporary(t);
  await protectPrivatePath(directory, 'directory');
  const pidFile = path.join(directory, 'orphan.json');
  const token = randomBytes(24).toString('hex');
  const middle = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore',env:process.env}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:child.pid})); child.unref();`;
  const rootCode = `process.stdin.once('data',()=>{const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'ignore',env:process.env});child.once('exit',()=>process.exit(0));});`;
  const root = await safeSpawn(process.execPath, ['-e', rootCode], { cwd: directory, resourceDirectory: directory, env: { ...process.env, AW_SUBAGENT_PROCESS_TOKEN: token }, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'pipe'] });
  const closed = once(root, 'close');
  const identity = await root.identityReady;
  assert.ok(identity?.scope);
  root.stdin.end('go\n');
  assert.deepEqual(await closed, [0, null]);
  const orphan = JSON.parse(await fs.readFile(pidFile, 'utf8'));
  t.after(async () => { try { process.kill(orphan.pid, 'SIGKILL'); } catch {} });
  const result = await stopOwnedTree(root.pid, [identity], token);
  assert.equal(result.stopped, true);
  const table = await processTable();
  assert.equal(table.some((row) => row.pid === orphan.pid), false);
});

// Test Value Gate: a caller's shared group has no private scope. Missing
// ancestry samples must yield unconfirmed cleanup and must preserve siblings.
test('POSIX shared group never claims complete stop from an empty sampled tree', { skip: process.platform === 'win32', timeout: 40000 }, async (t) => {
  const directory = await temporary(t);
  const token = randomBytes(24).toString('hex');
  const env = { ...process.env, AW_SUBAGENT_PROCESS_TOKEN: token };
  const sibling = await safeSpawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { cwd: directory, env, stdio: 'ignore' });
  const root = await safeSpawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { cwd: directory, env, stdio: 'ignore' });
  const rootClosed = once(root, 'close'), siblingClosed = once(sibling, 'close');
  t.after(async () => { root.kill('SIGKILL'); sibling.kill('SIGKILL'); await Promise.all([rootClosed, siblingClosed]); });
  const identity = await root.identityReady;
  const siblingIdentity = await sibling.identityReady;
  assert.equal(identity.scope, undefined);
  const result = await stopOwnedTree(root.pid, [identity], token);
  assert.equal(result.stopped, false);
  assert.equal(await ownsProcess(siblingIdentity, token), true);
});

// Test Value Gate: the worker remains alive while an attached backend exits.
// Native observers must not become task members and block scratch cleanup.
test('POSIX stopped backend is confirmed while its private-group caller stays alive', { skip: process.platform === 'win32', timeout: 40000 }, async (t) => {
  const directory = await temporary(t);
  const platformUrl = pathToFileURL(platformEntry).href;
  const processesUrl = pathToFileURL(path.join(path.dirname(platformEntry), 'processes.mjs')).href;
  const code = `
    import { once } from 'node:events';
    import { safeSpawn } from ${JSON.stringify(platformUrl)};
    import { observeTree, stopOwnedTree } from ${JSON.stringify(processesUrl)};
    const token = process.env.AW_SUBAGENT_PROCESS_TOKEN;
    const child = await safeSpawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.once("end",()=>process.exit(0))'], { env: process.env, stdio: ['pipe','ignore','ignore'] });
    const closed = once(child, 'close');
    const identity = await child.identityReady;
    const known = await observeTree(child.pid, [identity], token);
    child.stdin.end();
    await closed;
    const result = await stopOwnedTree(child.pid, known, token);
    process.stdout.write(JSON.stringify({ stopped: result.stopped, caller: process.pid, backend: child.pid, tracked: result.tracked.map(row => row.pid), excluded: identity.scope?.excluded.map(row => row.pid) }));
  `;
  const child = await safeSpawn(process.execPath, ['--input-type=module', '-e', code], { cwd: directory, env: { ...process.env, AW_SUBAGENT_PROCESS_TOKEN: randomBytes(24).toString('hex') }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  assert.deepEqual(await closed, [0, null], stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.tracked, [result.backend]);
  assert.ok(result.excluded.includes(result.caller));
});

// Test Value Gate: independent Windows ACL inspection must confirm the owner,
// protected DACL and distinct directory/file inheritance after native protection.
test('native Windows ACL protection matches independent system ACL evidence', { skip: process.platform !== 'win32', timeout: 90000 }, async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, 'private.txt');
  await fs.writeFile(file, 'private');
  const owner = await currentUserIdentity();
  const resources = [{ target: directory, kind: 'directory' }, { target: file, kind: 'file' }];
  await protectPrivatePaths(resources);
  const rows = await windowsOperation([
    '$rows = @($data.resources | ForEach-Object {',
    '  $acl = Get-Acl -LiteralPath $_.target',
    '  $rules = @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {',
    '    @{ sid=$_.IdentityReference.Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString(); mask=[int]$_.FileSystemRights; inheritance=[int]$_.InheritanceFlags; propagation=[int]$_.PropagationFlags }',
    '  })',
    '  @{ kind=$_.kind; owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected=$acl.AreAccessRulesProtected; rules=$rules }',
    '})',
    'ConvertTo-Json -Depth 8 -InputObject $rows -Compress',
  ].join('\n'), { resources });
  for (const row of rows) {
    assert.equal(row.owner, owner.sid);
    assert.equal(row.protected, true);
    assert.equal(row.rules.length, 1);
    const [rule] = row.rules;
    assert.deepEqual({ sid: rule.sid, inherited: rule.inherited, type: rule.type, inheritance: rule.inheritance, propagation: rule.propagation }, { sid: owner.sid, inherited: false, type: 'Allow', inheritance: row.kind === 'directory' ? 3 : 0, propagation: 0 });
    assert.equal(rule.mask & 0x001f01ff, 0x001f01ff);
  }
  const sddl = await windowsOperation('(Get-Acl -LiteralPath $data.target).Sddl | ConvertTo-Json -Compress', { target: file });
  for (const mutation of ['deny', 'empty', 'null', 'objectAce', 'owner']) await t.test(mutation, async (t) => {
    try {
      const state = await windowsOperation([
        '$acl = [IO.File]::GetAccessControl($data.target)',
        '$raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)',
        '$sid = [Security.Principal.SecurityIdentifier]::new($data.sid)',
        'switch ($data.mutation) {',
        '  "deny" { $raw.DiscretionaryAcl.InsertAce(0,[Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessDenied,2,$sid,$false,$null)) }',
        '  "empty" { $raw.DiscretionaryAcl = [Security.AccessControl.RawAcl]::new(2,0) }',
        '  "null" { $raw.DiscretionaryAcl = $null }',
        '  "objectAce" { $raw.DiscretionaryAcl = [Security.AccessControl.RawAcl]::new(4,1); $raw.DiscretionaryAcl.InsertAce(0,[Security.AccessControl.ObjectAce]::new([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessAllowed,2032127,$sid,[Security.AccessControl.ObjectAceFlags]::None,[Guid]::Empty,[Guid]::Empty,$false,$null)) }',
        '  "owner" { $raw.Owner = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544") }',
        '}',
        '$bytes = New-Object byte[] $raw.BinaryLength; $raw.GetBinaryForm($bytes,0)',
        '$acl.SetSecurityDescriptorBinaryForm($bytes)',
        'try { [IO.File]::SetAccessControl($data.target,$acl) } catch { @{ supported=$false } | ConvertTo-Json -Compress; return }',
        '$actual = [IO.File]::GetAccessControl($data.target)',
        '$raw = [Security.AccessControl.RawSecurityDescriptor]::new($actual.GetSecurityDescriptorBinaryForm(),0)',
        '@{ supported=$true; owner=$raw.Owner.Value; nullDacl=($null -eq $raw.DiscretionaryAcl); aceTypes=@($raw.DiscretionaryAcl | ForEach-Object { [int]$_.AceType }); count=$raw.DiscretionaryAcl.Count } | ConvertTo-Json -Depth 4 -Compress',
      ].join('\n'), { target: file, sid: owner.sid, mutation });
      if (!state.supported) { t.skip('The current Windows token cannot create this ACL fixture.'); return; }
      if (mutation === 'null') assert.equal(state.nullDacl, true);
      if (mutation === 'empty') { assert.equal(state.nullDacl, false); assert.equal(state.count, 0); }
      if (mutation === 'deny') assert.ok(state.aceTypes.includes(1));
      if (mutation === 'objectAce') assert.ok(state.aceTypes.includes(5));
      if (mutation === 'owner') assert.notEqual(state.owner, owner.sid);
      await assert.rejects(verifyPrivatePath(file, 'file', owner));
    } finally {
      await windowsOperation('$sections=[Security.AccessControl.AccessControlSections]::Access; if ($data.owner) { $sections=$sections -bor [Security.AccessControl.AccessControlSections]::Owner }; $acl=[Security.AccessControl.FileSecurity]::new(); $acl.SetSecurityDescriptorSddlForm($data.sddl,$sections); [IO.File]::SetAccessControl($data.target,$acl); $true | ConvertTo-Json -Compress', { target: file, sddl, owner: mutation === 'owner' });
    }
    assert.equal(await verifyPrivatePath(file, 'file', owner), true);
  });
});

// Test Value Gate: persisted CIM identities and full-precision lock identities
// must remain equal to independent Windows APIs, and mismatches cannot kill.
test('native Windows process identities preserve CIM and full tick precision', { skip: process.platform !== 'win32', timeout: 60000 }, async (t) => {
  const reference = await windowsOperation([
    '$native = [Diagnostics.Process]::GetProcessById([int]$data.pid)',
    '$item = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$data.pid)',
    '@{ full=$native.StartTime.ToUniversalTime().Ticks.ToString(); cim=$item.CreationDate.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress',
  ].join('\n'), { pid: process.pid });
  assert.equal(await windowsNativeOperation('processStart', { pid: process.pid }), reference.full);
  assert.equal((await processIdentity(process.pid)).started, reference.cim);
  assert.equal((await processTable([process.pid])).find((row) => row.pid === process.pid).started, reference.cim);
  const directory = await temporary(t);
  const child = await safeSpawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { cwd: directory, env: {}, stdio: 'ignore' });
  const closed = once(child, 'close');
  t.after(async () => { child.kill(); await closed; });
  const identity = await processIdentity(child.pid);
  const owner = await currentUserIdentity();
  assert.equal(await windowsNativeOperation('processStop', { pid: child.pid, started: (BigInt(identity.started) + 10n).toString(), sid: owner.sid }), false);
  await assert.rejects(windowsNativeOperation('processStop', { pid: child.pid, started: identity.started, sid: 'S-1-0-0' }), { code: 'platformOperationFailed' });
  assert.equal((await processIdentity(child.pid)).started, identity.started);
  assert.equal(await windowsNativeOperation('processStop', { pid: child.pid, started: identity.started, sid: owner.sid }), true);
  await closed;
  assert.equal(await processIdentity(child.pid), null);
  assert.equal(await windowsNativeOperation('processStart', { pid: child.pid }), null);
});

// Test Value Gate: a native root publication must preserve every existing
// destination, including when two publishers race to create the same root.
test('native Windows root publication never overwrites a file or directory', { skip: process.platform !== 'win32', timeout: 60000 }, async (t) => {
  const directory = await temporary(t);
  for (const type of ['file', 'directory']) {
    const source = path.join(directory, `source-${type}`);
    const destination = path.join(directory, `destination-${type}`);
    await fs.mkdir(source);
    if (type === 'file') await fs.writeFile(destination, 'foreign');
    else { await fs.mkdir(destination); await fs.writeFile(path.join(destination, 'foreign'), 'foreign'); }
    await assert.rejects(windowsNativeOperation('rootPublish', { source, destination }), { code: 'platformOperationFailed' });
    assert.equal(await fs.readFile(type === 'file' ? destination : path.join(destination, 'foreign'), 'utf8'), 'foreign');
    assert.equal((await fs.lstat(source)).isDirectory(), true);
  }
  const destination = path.join(directory, 'race-root');
  const sources = ['first', 'second'].map((name) => path.join(directory, name));
  for (const source of sources) { await fs.mkdir(source); await fs.writeFile(path.join(source, 'winner'), path.basename(source)); }
  const results = await Promise.allSettled(sources.map((source) => windowsNativeOperation('rootPublish', { source, destination })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const winner = await fs.readFile(path.join(destination, 'winner'), 'utf8');
  const loser = sources.find((source) => path.basename(source) !== winner);
  assert.equal(await fs.readFile(path.join(loser, 'winner'), 'utf8'), path.basename(loser));
});


// Test Value Gate: creating a run must not initialize permissions on an existing
// unsafe root or alter an occupied file, even when fresh resource ACLs can be set.
test('native Windows run creation preserves occupied and unsafe roots', { skip: process.platform !== 'win32', timeout: 60000 }, async (t) => {
  const directory = await temporary(t);
  const identity = { sourceId: 'fixture', sourceIdentity: 'fixture-source', pluginId: 'fixture/codex-enhance', pluginName: 'codex-enhance',
    pluginVersion: '1.0.0', platform: 'codex', scope: 'user', configScope: 'user', artifactId: 'guide', skillKey: 'codex-subagent-guide' };
  for (const kind of ['file', 'directory']) {
    const homeRoot = path.join(directory, kind);
    await fs.mkdir(homeRoot);
    const context = await storeContext({ homeRoot, sourceIdentity: identity });
    let sentinel = context.root;
    if (kind === 'directory') {
      await fs.mkdir(context.root);
      sentinel = path.join(context.root, 'preserve.txt');
      await windowsOperation([
        '$acl = Get-Acl -LiteralPath $data.target',
        '$acl.SetAccessRuleProtection($false, $true)',
        'Set-Acl -LiteralPath $data.target -AclObject $acl',
        '$true | ConvertTo-Json -Compress',
      ].join('\n'), { target: context.root });
    }
    await fs.writeFile(sentinel, 'preserve');
    const readAcl = () => windowsOperation([
      '$acl = Get-Acl -LiteralPath $data.target',
      '$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All) | ConvertTo-Json -Compress',
    ].join('\n'), { target: context.root });
    const before = await readAcl();
    await assert.rejects(createRun(context, 'fixture', homeRoot, identity));
    // Compare without printing SIDs from the security descriptor on failure.
    assert.equal(await readAcl() === before, true);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve');
    assert.deepEqual(await fs.readdir(homeRoot), ['.aw-subagent']);
    if (kind === 'directory') assert.deepEqual(await fs.readdir(context.root), ['preserve.txt']);
  }
});

// Test Value Gate: a second helper cannot adopt an existing Job, and failure
// to publish a new private ready file cannot execute the suspended backend.
test('native Windows Job rejects name collisions and occupied ready paths before execution', { skip: process.platform !== 'win32', timeout: 90000 }, async (t) => {
  const directory = await temporary(t);
  await protectPrivatePath(directory);
  const helper = await resolveWindowsNativeHelper();
  const owner = await currentUserIdentity();
  const name = `Local\\aw-subagent-${randomBytes(16).toString('hex')}`;
  async function launch(label, jobName, code, occupied = false) {
    const configuration = path.join(directory, `${label}.json`);
    const status = path.join(directory, `${label}-ready.json`);
    if (occupied) await fs.writeFile(status, 'preserve');
    await fs.writeFile(configuration, JSON.stringify({ schemaVersion: 1, executable: process.execPath, args: ['-e', code], parentPid: process.pid, name: jobName, status, sid: owner.sid }));
    await protectPrivatePath(configuration, 'file');
    const child = spawn(helper, ['--plugin-config', configuration], { cwd: directory, env: process.env, shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.resume();
    const closed = once(child, 'close');
    return { child, closed, status, configuration };
  }
  const first = await launch('first', name, 'process.stdin.resume();process.stdin.once("end",()=>process.exit(37));');
  t.after(async () => { first.child.kill(); await first.closed; });
  const deadline = Date.now() + 20000;
  let ready;
  while (!ready) {
    try { ready = JSON.parse(await fs.readFile(first.status, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (first.child.exitCode !== null || Date.now() >= deadline) assert.fail('The first native Job did not become ready.');
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(ready.ready, true);
  await verifyPrivatePath(first.status, 'file', owner);
  assert.equal(await fs.lstat(first.configuration).catch(() => null), null);
  const marker = path.join(directory, 'executed');
  const backend = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`;
  const collision = await launch('collision', name, backend);
  assert.deepEqual(await collision.closed, [250, null]);
  assert.equal(await fs.lstat(collision.status).catch(() => null), null);
  assert.equal(await fs.lstat(marker).catch(() => null), null);
  const occupied = await launch('occupied', `Local\\aw-subagent-${randomBytes(16).toString('hex')}`, backend, true);
  assert.deepEqual(await occupied.closed, [250, null]);
  assert.equal(await fs.readFile(occupied.status, 'utf8'), 'preserve');
  assert.equal(await fs.lstat(marker).catch(() => null), null);
  first.child.stdin.end();
  assert.deepEqual(await first.closed, [37, null]);
});
