#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';
import { qualificationAdapter, waitForCommunication, field } from './fixtures/windows-qualification.mjs';

// Explicit fake-only qualification. Product source is copied unchanged.
const emit = (phase, pass, code, details = {}) => process.stdout.write(`AW_SUBAGENT_WINDOWS_QUALIFICATION ${JSON.stringify({ phase, pass, code, ...details })}\n`);
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const source = guideRuntimeScripts(import.meta.url);
const safeCodes = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'ETIMEDOUT', 'platformOperationFailed', 'qualificationFailed', 'differentVolumeUnavailable', 'commandFailed', 'commandTimeout', 'protocolMismatch', 'treeStopUnconfirmed', 'lockUnavailable', 'atomicWriteDidNotFail', 'readinessFailed']);
const safeCode = (error) => safeCodes.has(error?.code) ? error.code : 'qualificationFailed';
function fail(code) { throw Object.assign(new Error(code), { code }); }
function requireTrue(value, code = 'protocolMismatch') { if (!value) fail(code); }
function blocks(text, kind) { return [...text.matchAll(/^BEGIN_(MESSAGE|FINAL):([a-f0-9]{8})\n([\s\S]*?)\nEND_\1:\2\n/gm)].filter((match) => match[1] === kind).map((match) => match[3]); }

const volumeSource = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QualificationVolume {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetVolumePathName(string path, StringBuilder volume, uint capacity);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetVolumeNameForVolumeMountPoint(string path, StringBuilder name, uint capacity);
  public static string Id(string path) {
    var volume = new StringBuilder(1024); var name = new StringBuilder(1024);
    if (!GetVolumePathName(path, volume, 1024) || !GetVolumeNameForVolumeMountPoint(volume.ToString(), name, 1024)) throw new InvalidOperationException();
    return name.ToString();
  }
}
'@
$leftRoot = [IO.Path]::GetPathRoot($data.left)
$rightRoot = [IO.Path]::GetPathRoot($data.right)
$fixed = ([IO.DriveInfo]::new($leftRoot).DriveType -eq [IO.DriveType]::Fixed) -and ([IO.DriveInfo]::new($rightRoot).DriveType -eq [IO.DriveType]::Fixed)
@{ differentRoots = $leftRoot -ine $rightRoot; differentVolumes = [QualificationVolume]::Id($data.left) -ine [QualificationVolume]::Id($data.right); fixed = $fixed } | ConvertTo-Json -Compress
`;

async function lockedAtomic(directory, platform, files, transient = false) {
  const root = path.join(directory, transient ? 'transient-atomic' : 'locked-atomic');
  await fs.mkdir(root); await platform.protectPrivatePath(root);
  const target = path.join(root, 'state.json');
  const original = { state: 'original', text: '原值\r\n完整。' };
  await files.atomicJson(target, original);
  const systemRoot = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1];
  requireTrue(path.isAbsolute(systemRoot ?? ''), 'lockUnavailable');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FIXTURE_LOCK_TARGET))',
    '$stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)',
    "try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }",
  ].join('\n');
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !['psmodulepath', 'winpsmodulepath'].includes(name.toLowerCase()))), FIXTURE_LOCK_TARGET: Buffer.from(target).toString('base64') };
  const child = spawn(path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = once(child, 'close'); closed.catch(() => {});
  child.stdin.on('error', () => {});
  const timeout = setTimeout(() => child.kill(), 30000);
  const rename = fs.rename;
  let failed, observedConflict = false;
  try {
    let text = '';
    await Promise.race([
      new Promise((resolve) => child.stdout.on('data', (chunk) => { text += chunk.toString('utf8'); if (text.includes('locked\n') || text.includes('locked\r\n')) resolve(); })),
      closed.then(() => fail('lockUnavailable')),
    ]);
    if (transient) {
      // Release a real native lock only after the real rename observes it.
      // The production retry must then publish the same protected temporary file.
      fs.rename = async (source, destination) => {
        try { return await rename(source, destination); }
        catch (error) {
          if (destination === target && !observedConflict && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
            observedConflict = true;
            child.stdin.end('\n');
            const [exit, signal] = await closed;
            requireTrue(exit === 0 && signal === null, 'lockUnavailable');
          }
          throw error;
        }
      };
    }
    try { await files.atomicJson(target, { state: 'replacement', text: '新值' }); }
    catch (error) { failed = error; }
    if (transient) {
      if (failed) throw failed;
      requireTrue(observedConflict, 'lockUnavailable');
      assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { state: 'replacement', text: '新值' });
      emit('atomic.transient-lock-recovered', true, 'ok');
    } else {
      requireTrue(!!failed, 'atomicWriteDidNotFail');
      requireTrue(['EPERM', 'EACCES', 'EBUSY'].includes(failed.code));
      requireTrue(child.exitCode === null && child.signalCode === null, 'lockUnavailable');
      emit('atomic.locked-write', true, safeCode(failed));
    }
    assert.deepEqual(await fs.readdir(root), ['state.json']);
  } finally {
    fs.rename = rename;
    if (!child.stdin.writableEnded) child.stdin.end('\n');
    try { const [exit, signal] = await closed; requireTrue(exit === 0 && signal === null, 'lockUnavailable'); } finally { clearTimeout(timeout); }
  }
  if (transient) return;
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), original);
  assert.deepEqual(await fs.readdir(root), ['state.json']);
  emit('atomic.original-preserved', true, 'ok');
  await files.atomicJson(target, { state: 'updated', text: '正常更新\r\n成功。' });
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { state: 'updated', text: '正常更新\r\n成功。' });
  assert.deepEqual(await fs.readdir(root), ['state.json']);
  emit('atomic.release-and-update', true, 'ok');
}

async function main() {
  if (process.platform !== 'win32') { emit('native-windows', false, 'notApplicable'); return; }
  const platform = await import(pathToFileURL(path.join(source, 'runtime/platform.mjs')));
  const files = await import(pathToFileURL(path.join(source, 'runtime/files.mjs')));
  const { ownsProcess } = await import(pathToFileURL(path.join(source, 'runtime/processes.mjs')));
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-native-qualification-'));
  const installed = path.join(directory, 'installed');
  const temporary = path.join(directory, 'runtime');
  const scripts = path.join(installed, 'scripts');
  const observed = path.join(directory, 'observed.json');
  const input = path.join(directory, 'input.json');
  const finish = path.join(directory, 'finish');
  let workspace, command, completed = false;
  const runDirectories = new Set();
  const handles = new Set();
  async function discover() {
    for (const root of await fs.readdir(temporary).catch(() => [])) {
      if (!/^aw-subagent-v5-[a-f0-9]{16}$/.test(root)) continue;
      for (const id of await fs.readdir(path.join(temporary, root))) {
        if (!/^[a-f0-9]{32}$/.test(id)) continue;
        const location = path.join(temporary, root, id);
        const meta = JSON.parse(await fs.readFile(path.join(location, 'owner.json'), 'utf8'));
        requireTrue(meta.id === id && /^[a-f0-9]{32}$/.test(meta.key ?? ''));
        runDirectories.add(location); handles.add(`aw5-${id}-${meta.key}`);
      }
    }
  }
  try {
    await platform.protectPrivatePath(directory);
    await lockedAtomic(directory, platform, files);
    await lockedAtomic(directory, platform, files, true);
    const systemRoot = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1];
    for (const parent of [process.cwd(), ...(path.isAbsolute(systemRoot ?? '') ? [path.join(systemRoot, 'Temp')] : [])]) {
      let candidate;
      try {
        if (!(await fs.stat(parent)).isDirectory()) continue;
        candidate = await fs.mkdtemp(path.join(parent, 'aw-cross-volume-'));
        const result = await platform.windowsOperation(volumeSource, { left: await fs.realpath(directory), right: await fs.realpath(candidate) });
        if (result?.differentRoots && result?.differentVolumes && result?.fixed) { workspace = await fs.realpath(candidate); break; }
      } catch (error) {
        if (candidate) { await fs.rm(candidate, { recursive: true, force: true }); throw error; }
      }
      if (candidate) await fs.rm(candidate, { recursive: true, force: true });
    }
    requireTrue(!!workspace, 'differentVolumeUnavailable');
    await platform.protectPrivatePath(workspace);
    emit('cross-volume.real-roots', true, 'ok');
    await Promise.all([fs.mkdir(installed), fs.mkdir(temporary)]);
    await fs.cp(source, scripts, { recursive: true });
    const adapterFile = path.join(directory, 'fake-adapter.mjs');
    await fs.writeFile(adapterFile, qualificationAdapter);
    const configuration = { installedIdentity: { source: 'fixture', plugin: 'fixture', platform: 'codex', scope: 'user' }, resourceRoot: installed,
      effectiveValues: { subagentCommands: [{ key: 'fixture', adapter: 'custom', mode: 'workspace', command: await fs.realpath(process.execPath), entrypoint: adapterFile }] } };
    await fs.writeFile(path.join(installed, 'effective.json'), JSON.stringify(configuration));
    await fs.writeFile(path.join(scripts, 'aw-runtime-config.mjs'), "import fs from 'node:fs/promises';export async function readRuntimeConfig(){return JSON.parse(await fs.readFile(new URL('../effective.json',import.meta.url),'utf8'));}\n");
    const environment = { ...Object.fromEntries(Object.entries(process.env).map(([name, value]) => [name.toUpperCase(), value])), HOME: directory, USERPROFILE: directory, CODEX_HOME: directory,
      AW_HOME: directory, AW_CODEX_HOME: directory, AW_CLAUDE_HOME: directory, TMPDIR: temporary, TMP: temporary, TEMP: temporary, FIXTURE_OBSERVED: observed, FIXTURE_INPUT: input, FIXTURE_FINISH: finish };
    command = (args, stdin) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(scripts, 'subagent.mjs'), ...args], { cwd: workspace, env: environment, stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks = []; let bytes = 0, timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
      child.stdin.on('error', () => {}); child.stdin.end(stdin);
      child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes <= 131072) chunks.push(chunk); });
      child.once('error', () => { clearTimeout(timeout); reject(Object.assign(new Error(), { code: 'commandFailed' })); });
      child.once('close', (exit) => {
        clearTimeout(timeout);
        if (timedOut) { reject(Object.assign(new Error(), { code: 'commandTimeout' })); return; }
        const stdout = Buffer.concat(chunks).toString('utf8');
        const handle = field(stdout, 'run'); if (/^aw5-[a-f0-9]{32}-[a-f0-9]{32}$/.test(handle ?? '')) handles.add(handle);
        resolve({ exit, stdout, handle });
      });
    });
    const prompt = '跨卷任务。\r\n保留中文与换行。\n';
    const message = '父输入。\r\n第二行。\n';
    const final = '跨卷最终答案。\r\n第二行。\n';
    const started = await command(['start', '--executor', 'fixture', '--workspace', workspace, '--prompt', '-'], Buffer.from(prompt));
    requireTrue(!!started.handle);
    const handle = started.handle;
    await waitForCommunication(started, command);
    const received = JSON.parse(await fs.readFile(observed, 'utf8'));
    requireTrue(received.prompt === prompt && await fs.realpath(received.workspace) === workspace && await fs.realpath(received.cwd) === workspace);
    emit('cross-volume.start-and-text', true, 'ok');
    const sent = await command(['send', '--run', handle, '--text', '-'], Buffer.from(message));
    requireTrue(sent.exit === 0 && field(sent.stdout, 'delivery') === 'queued');
    let echo = false;
    const echoDeadline = Date.now() + 60000;
    while (!echo) {
      const waited = await command(['wait', '--run', handle, '--timeout-ms', '1000']);
      requireTrue(waited.exit === 0);
      echo = blocks(waited.stdout, 'MESSAGE').includes(message);
      if (!echo && Date.now() >= echoDeadline) fail('commandTimeout');
    }
    requireTrue(JSON.parse(await fs.readFile(input, 'utf8')).text === message);
    emit('cross-volume.send-wait-crlf', true, 'ok');
    await fs.writeFile(finish, '');
    let result;
    const resultDeadline = Date.now() + 60000;
    do { result = await command(['result', '--run', handle]); if (field(result.stdout, 'code') !== 'resultNotReady') break; if (Date.now() >= resultDeadline) fail('commandTimeout'); } while (true);
    requireTrue(result.exit === 0 && field(result.stdout, 'state') === 'completed' && blocks(result.stdout, 'FINAL').includes(final));
    const exported = await command(['result', '--run', handle, '--export']);
    requireTrue(exported.exit === 0 && field(exported.stdout, 'state') === 'completed' && blocks(exported.stdout, 'FINAL').includes(final));
    emit('cross-volume.result-export', true, 'ok');
    requireTrue((await command(['stop', '--run', handle])).exit === 0);
    await fs.unlink(finish);
    const active = await command(['start', '--executor', 'fixture', '--workspace', workspace, '--prompt', '-'], Buffer.from(prompt));
    requireTrue(!!active.handle);
    await waitForCommunication(active, command);
    const stopped = await command(['stop', '--run', active.handle]);
    requireTrue(stopped.exit === 0 && field(stopped.stdout, 'state') === 'cancelled');
    emit('cross-volume.active-stop', true, 'ok');
    completed = true;
  } finally {
    await discover();
    if (command) for (const handle of handles) await command(['stop', '--run', handle]).catch(() => {});
    let safe = false;
    const until = Date.now() + 60000;
    do {
      const records = await Promise.all([...runDirectories].map(async (location) => JSON.parse(await fs.readFile(path.join(location, 'owner.json'), 'utf8'))));
      if (records.every((meta) => meta.localTreeStopped === true) && (await Promise.all(records.map((meta) => meta.worker ? ownsProcess(meta.worker, meta.token) : true))).every((alive) => !alive)) { safe = true; break; }
      await pause(500);
    } while (Date.now() < until);
    emit('cleanup.owned-trees', safe, safe ? 'ok' : 'treeStopUnconfirmed');
    if (safe) { if (workspace) await fs.rm(workspace, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true }); }
    if (!safe) fail('treeStopUnconfirmed');
  }
  emit('qualification.complete', completed, completed ? 'ok' : 'qualificationFailed');
}

main().catch((error) => { emit('qualification.failed', false, safeCode(error), error.details); process.exitCode = 1; });
