import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import type { CommandManagementResult } from '../../src/commands/managed-commands.js';
import { syncManagedCommandPackage } from '../../src/utils/managed-command-store.js';
import { normalizeCommandDefinition, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';

describe('managed command CLI', () => {
  let isolated: IsolatedTestEnvironment;
  let source: string;
  beforeEach(async () => {
    isolated = await createIsolatedTestEnv();
    source = path.join(isolated.layout.fixtureCwd, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'entry.mjs'), 'import fs from "node:fs"; fs.writeFileSync(process.env.REPORT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), host: JSON.parse(process.env.AW_COMMAND_HOST), source: process.env.COPY, worker: process.env.AW_SUBAGENT_WORKER, author: process.env.AW_PLUGIN_CONTEXT })); process.exit(17);\n');
  });
  afterEach(async () => { await isolated.cleanup(); });

  async function invoke(args: string[], extraEnvironment: NodeJS.ProcessEnv = {}): Promise<{ exitCode: number; stdout: string; stderr: string; receipt: CommandManagementResult }> {
    let stdout = '';
    let stderr = '';
    const exitCode = await runCli(['command', ...args], { cwd: isolated.layout.fixtureCwd, env: { ...isolated.env, ...extraEnvironment }, interactive: false, io: { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } } });
    return { exitCode, stdout, stderr, receipt: stdout ? JSON.parse(stdout) : undefined };
  }

  // Protects one-object JSON receipts, pre-write argument rejection, and the full public management path.
  it('requires confirmation before writes and returns schema 1 receipts for install/list/show/remove', async () => {
    const refused = await invoke(['install', source, '--name', 'tool', '--runner', 'node', '--entry', 'entry.mjs', '--json']);
    expect(refused.exitCode).toBe(2);
    expect(refused.receipt).toMatchObject({ schemaVersion: 1, command: 'command.install', ok: false, overallState: 'failed', commands: [], packages: [], changes: [], recoveryActions: [] });
    await expect(fs.lstat(path.join(isolated.layout.awHomeDir, 'commands'))).rejects.toMatchObject({ code: 'ENOENT' });
    const invalid = await invoke(['install', source, '--name', 'tool', '--runner', 'shell', '--entry', 'entry.mjs', '--yes', '--json']);
    expect(invalid.exitCode).toBe(2);
    const installed = await invoke(['install', source, '--name', '工具', '--runner', 'node', '--entry', 'entry.mjs', '--yes', '--json']);
    expect(installed.exitCode).toBe(0);
    expect(installed.stderr).toBe('');
    expect(installed.stdout.endsWith('\n')).toBe(true);
    const id = installed.receipt.commands[0]!.id;
    expect(installed.receipt.changes).toEqual([{ kind: 'command', id, action: 'created' }]);
    expect((await invoke(['list', '--json'])).receipt.commands.map((command) => command.id)).toEqual([id]);
    expect((await invoke(['show', id, '--json'])).receipt.commands[0]).toMatchObject({ id, name: '工具', availability: 'ready', owner: { kind: 'user' } });
    const removed = await invoke(['remove', id, '--yes', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.receipt.commands).toEqual([]);
    expect(removed.receipt.changes).toEqual([{ kind: 'command', id, action: 'removed' }]);
    expect((await invoke(['list', '--json'])).receipt).toMatchObject({ ok: true, commands: [], packages: [] });
    const missing = await invoke(['show', id, '--json']);
    expect(missing.exitCode).toBe(1);
    expect(missing.receipt.errors[0]!.code).toBe('commandNotFound');
  });

  // Protects child argv/exit/environment through the real CLI bridge, without invoking any model or native host.
  it('requires the literal separator and forwards every following argument to a real short Node child', async () => {
    const report = path.join(isolated.layout.fixtureCwd, 'report.json');
    const installed = await invoke(['install', source, '--name', 'tool', '--runner', 'node', '--entry', 'entry.mjs', '--args-json', '[""]', '--env-json', JSON.stringify({ REPORT: report }), '--env-from-json', '{"COPY":"INPUT"}', '--cwd', 'resource', '--yes', '--json']);
    const id = installed.receipt.commands[0]!.id;
    const invalid = await invoke(['run', id]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).toContain('aw: invalidArguments:');
    await expect(fs.lstat(report)).rejects.toMatchObject({ code: 'ENOENT' });
    const ran = await invoke(['run', id, '--', '--json', '-h', '', '换行\n参数'], { INPUT: '', AW_SUBAGENT_WORKER: 'preserved', AW_PLUGIN_CONTEXT: 'removed' });
    expect(ran.exitCode).toBe(17);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toBe('');
    const observed = JSON.parse(await fs.readFile(report, 'utf8'));
    expect(observed).toMatchObject({ args: ['', '--json', '-h', '', '换行\n参数'], cwd: installed.receipt.commands[0]!.resourceRoot, source: '', worker: 'preserved', host: { schemaVersion: 1, nodeExecutable: process.execPath, awHome: await fs.realpath(isolated.layout.awHomeDir) } });
    expect(observed.author).toBeUndefined();
  });

  // Protects producer lifecycle ownership and visible unavailability instead of silently accepting damaged definitions.
  it('reports damaged user definitions as partial and keeps plugin IDs outside manual mutation', async () => {
    const installed = await invoke(['install', source, '--name', 'tool', '--runner', 'node', '--entry', 'entry.mjs', '--yes', '--json']);
    const id = installed.receipt.commands[0]!.id;
    await fs.writeFile(path.join(isolated.layout.awHomeDir, 'commands', 'users', id, 'definition.json'), '{broken');
    const listed = await invoke(['list', '--json']);
    expect(listed.exitCode).toBe(1);
    expect(listed.receipt).toMatchObject({ ok: false, overallState: 'partial', commands: [{ id, availability: 'unavailable' }] });
    const pluginId = `cmdp_${'0'.repeat(64)}`;
    const refused = await invoke(['remove', pluginId, '--yes', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(refused.receipt.errors[0]!.code).toBe('commandOwnerMismatch');
    expect((await invoke(['remove', id, '--force', '--yes', '--json'])).exitCode).toBe(0);
  });

  // Protects the public offline recovery selector after a project or source is no longer available.
  it('removes an exact package ID without Catalog access and rejects conflicting owner evidence', async () => {
    const producer: ProducerIdentity = { sourceId: 'retired', sourceIdentity: `sha256:${'b'.repeat(64)}`, pluginName: 'toolkit', kind: 'package', key: 'tool', platform: null, scope: 'project', projectRoot: path.join(isolated.layout.fixtureCwd, 'removed-project') };
    const entry = normalizeCommandDefinition({ key: 'run', runner: 'node', entry: 'entry.mjs' });
    const installed = await syncManagedCommandPackage({ producer, sourceDirectory: source, sets: [{ set: 'tools', state: 'present', entries: [entry] }], env: isolated.env });
    const packageRoot = path.dirname(installed.resourceRoot);
    const ownerPath = path.join(packageRoot, 'owner.json');
    const owner = await fs.readFile(ownerPath, 'utf8');
    await fs.writeFile(path.join(installed.resourceRoot, '.aw-command-producer.json'), '{broken');
    const invalid = await invoke(['package', 'remove', installed.id, '--scope', 'project', '--yes', '--json']);
    expect(invalid.exitCode).toBe(2);
    await fs.writeFile(ownerPath, owner.replace('agent-workflows', 'foreign'));
    const blocked = await invoke(['package', 'remove', installed.id, '--force', '--yes', '--json']);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.receipt.errors[0]!.code).toBe('commandOwnerMismatch');
    await fs.writeFile(ownerPath, owner);
    const removed = await invoke(['package', 'remove', installed.id, '--force', '--yes', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.receipt.changes).toEqual([{ kind: 'package', id: installed.id, action: 'removed' }, { kind: 'command', id: installed.commandIds[0], action: 'removed' }]);
    await expect(fs.lstat(packageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Protects the distributed CLI boundary: stdin/stdout/stderr bytes belong to the target.
  it('passes binary stdio through the built CLI without a receipt or progress envelope', async () => {
    await fs.writeFile(path.join(source, 'stdio.mjs'), 'const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk); process.stdout.write(Buffer.concat(chunks)); process.stderr.write(Buffer.from([101,114,114,0,255])); process.exitCode=19;\n');
    const installed = await invoke(['install', source, '--name', 'stdio', '--runner', 'node', '--entry', 'stdio.mjs', '--yes', '--json']);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), 'command', 'run', installed.receipt.commands[0]!.id, '--'], { cwd: isolated.layout.fixtureCwd, env: isolated.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const completion = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const bytes = Buffer.from([0, 255, 10, 65, 0, 13]);
    child.stdin.end(bytes);
    expect(await completion).toBe(19);
    expect(Buffer.concat(stdout)).toEqual(bytes);
    expect(Buffer.concat(stderr)).toEqual(Buffer.from([101, 114, 114, 0, 255]));
  });

  // Protects POSIX direct-child signal forwarding and matching wrapper termination.
  it.skipIf(process.platform === 'win32')('forwards SIGTERM and exits with the same child signal', async () => {
    const marker = path.join(isolated.layout.fixtureCwd, 'forwarded');
    await fs.writeFile(path.join(source, 'signal.mjs'), 'import fs from "node:fs"; process.once("SIGTERM",()=>{fs.writeFileSync(process.env.SIGNAL_MARKER,"forwarded"); process.kill(process.pid,"SIGTERM");}); const expiry=setTimeout(()=>process.exit(98),5000); process.stdout.write("ready\\n");\n');
    const installed = await invoke(['install', source, '--name', 'signal', '--runner', 'node', '--entry', 'signal.mjs', '--env-json', JSON.stringify({ SIGNAL_MARKER: marker }), '--yes', '--json']);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), 'command', 'run', installed.receipt.commands[0]!.id, '--'], { cwd: isolated.layout.fixtureCwd, env: isolated.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    const ready = new Promise<void>((resolve) => { child.stdout.on('data', (chunk) => { output += String(chunk); if (output.includes('ready\n')) resolve(); }); });
    child.stderr.on('data', (chunk) => { errors += String(chunk); });
    try {
      const first = await Promise.race([ready.then(() => 'ready' as const), closed]);
      expect(first, errors).toBe('ready');
      child.kill('SIGTERM');
      expect(await closed).toEqual({ code: null, signal: 'SIGTERM' });
      expect(await fs.readFile(marker, 'utf8')).toBe('forwarded');
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  });
});
