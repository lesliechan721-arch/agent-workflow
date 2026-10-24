import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
import { assertNoReparsePath, currentUserIdentity, protectPrivatePath, resolveSafeCommand, safeSpawn, verifyPrivatePath, verifyPrivatePaths, windowsOperation } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { observeTree, ownsProcess, processTable, stopOwnedTree } from '../skills/codex-subagent-guide/scripts/runtime/processes.mjs';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

// Only this test uses the static platform-module alias directly. Other moved
// fixtures copy the complete resource source. Core does not scan .ps1 imports.
const require = createRequire(import.meta.url);
const platformEntry = require.resolve('../skills/codex-subagent-guide/scripts/runtime/platform.mjs');
const helperSource = path.join(guideRuntimeScripts(import.meta.url), 'runtime/windows-job.ps1');
const helperTarget = path.join(path.dirname(platformEntry), 'windows-job.ps1');
if (helperSource !== helperTarget) await fs.copyFile(helperSource, helperTarget);

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
  await protectPrivatePath(directory);
  assert.equal(await verifyPrivatePath(directory, 'directory', owner), true);
  const file = path.join(directory, '中文 😀.json');
  await fs.writeFile(file, '{}\n', { mode: 0o600 });
  await protectPrivatePath(file, 'file');
  assert.equal(await verifyPrivatePath(file, 'file', owner), true);
  const resources = [{ target: directory, kind: 'directory' }, { target: file, kind: 'file' }];
  assert.equal(await verifyPrivatePaths(resources, owner), true);
  const link = path.join(directory, 'link');
  await fs.symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertNoReparsePath(link, 'directory'), { code: 'pathSymlink' });
  await assert.rejects(protectPrivatePath(link, 'directory'), { code: 'pathSymlink' });
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
      await protectPrivatePath(file, 'file');
      assert.equal(await verifyPrivatePath(file, 'file', owner), true);
    }
  }
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

// Test Value Gate: the fixed Windows host must load native modules even when
// the backend has custom module paths. The backend must retain those settings.
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

// Test Value Gate: a fresh plugin home has no host module-analysis cache. The
// real identity, private ACL and Job boundary must initialize in that state.
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
