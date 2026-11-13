import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { downloadInterfaceArchive, extractInterfaceArchive, interfaceDistributions,
  parseInterfaceProbeArgs, probeClientInterfaces } from './native-platform-interface-probes.mjs';
import { prepareEnvironment } from './native-platform-runtime.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-interface-probe-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, project: path.join(root, 'target'), neutral: path.join(root, 'neutral'), env: await prepareEnvironment(root) };
}

function completed(stdout, exitCode = 0, stderr = '') {
  return { stdout, stderr, exitCode, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false,
    terminationReason: 'complete', containmentMode: 'verified-observed', gradingEvidenceAccepted: true,
    descendantCleanupGuaranteed: false };
}

function parserOutput(platform, args) {
  if (args[0] === '--version') return interfaceDistributions[platform].version;
  if (args[0] === '--help') return 'Usage: client [command]\nCommands:\n  plugin  Manage plugins\n';
  if (args.length === 2) return platform === 'antigravity'
    ? 'Usage: antigravity plugin <command> [arguments]\n\nCommands:\n  list [--json]          List installed plugins\n'
    : 'Usage: client plugin [command]\nCommands:\n  list  List plugins\n';
  if (args.at(-1) === '--help') return 'Usage: agy plugin list [options]\nOptions:\n  --json  Print JSON\n';
  return '[]';
}

// Test Value Gate: parser-only observations must not start an account command,
// model/session, change process containment, or claim lifecycle/scope evidence.
test('limits Cursor to version and parser help with EOF and blocked client network', async (t) => {
  const context = await fixture(t);
  const launcher = { executable: path.join(context.root, 'dist-package/node'),
    prefix: [path.join(context.root, 'dist-package/index.js')] };
  const calls = [];
  const report = await probeClientInterfaces('cursor', launcher, context, async (entry, args, options) => {
    calls.push(args); assert.equal(entry, launcher); assert.equal(options.env, context.env);
    assert.equal(options.stdin, ''); assert.equal(options.timeoutMs, 30_000);
    assert.equal(options.nativeClient, 'cursor'); assert.equal(options.env.HTTPS_PROXY, 'http://127.0.0.1:1');
    return completed(parserOutput('cursor', args));
  });
  assert.deepEqual(calls, [['--version'], ['--help'], ['plugin', '--help'], ['plugin', 'marketplace', '--help']]);
  assert.equal(report.status, 'observed'); assert.equal(report.scope.status, 'unverified');
  assert.match(report.nativeQualification, /^unverified/u);
  assert(report.commands.every(command => command.processManagement.mode === 'verified-observed'));
});

test('queries Antigravity empty inventories in new target and neutral calls only after parser confirmation', async (t) => {
  const context = await fixture(t);
  const calls = [];
  const report = await probeClientInterfaces('antigravity', { executable: '/fixed/antigravity', prefix: [] }, context,
    async (launcher, args, options) => {
      calls.push({ args, cwd: options.cwd });
      if (args.join(' ') === 'plugin list --help') return completed('', 1, 'Error: unknown list option "--help": only --json is supported');
      return completed(parserOutput('antigravity', args));
    });
  assert.deepEqual(calls.slice(3), [context.project, context.neutral].map(cwd => ({ args: ['plugin', 'list', '--json'], cwd })));
  assert.equal(report.commands.length, 5); assert.equal(report.scope.status, 'unverified');
  assert.equal(report.status, 'observed');
});

test('does not try inventory when fixed version or the JSON parser flag is unconfirmed', async (t) => {
  for (const missing of ['version', 'json']) await t.test(missing, async (subtest) => {
    const context = await fixture(subtest);
    const calls = [];
    const report = await probeClientInterfaces('antigravity', { executable: '/fixed/antigravity', prefix: [] }, context,
      async (launcher, args) => {
        calls.push(args);
        let output = parserOutput('antigravity', args);
        if (missing === 'version' && args[0] === '--version') output = '1.3.40';
        if (missing === 'json' && args.at(-1) === '--help') output = output.replace('--json', '--text');
        return completed(output);
      });
    assert.equal(calls.length, 3); assert.equal(report.inventory.status, 'unverified');
    assert.equal(report.scope.status, 'unverified');
    if (missing === 'version') assert.equal(report.status, 'failed');
  });
});

// Test Value Gate: an actual client authentication exit remains a failed command
// with its output; no login or interaction is added to obtain a green result.
test('records authentication failures for both inventories without logging in', async (t) => {
  const context = await fixture(t);
  const report = await probeClientInterfaces('antigravity', { executable: '/fixed/antigravity', prefix: [] }, context,
    async (launcher, args) => args.at(-1) === '--json' ? completed('', 7, 'Authentication required: sign in')
      : completed(parserOutput('antigravity', args)));
  assert.equal(report.status, 'failed'); assert.equal(report.commands.length, 5);
  assert(report.commands.slice(3).every(command => command.exitCode === 7 && command.stderr === 'Authentication required: sign in'));
  assert.equal(report.authentication.failurePossible, true); assert.equal(report.authentication.login, 'not-requested');
  assert.equal(report.scope.status, 'unverified');
});

// Test Value Gate: observer, cleanup, cancellation, deadline, output, and mode
// failures must stop this client and remain separate from authentication gaps.
test('does not downgrade process failures to an authentication observation', async (t) => {
  const failures = [
    ['cleanup throw', () => { throw Object.assign(new Error('cleanup-unconfirmed'), {
      result: completed('1.3.4', 0, 'authentication prompt'), processTreeDiagnostics: [{ code: 'marker-unreadable' }],
    }); }],
    ['deadline', () => ({ ...completed('1.3.4'), timedOut: true, terminationReason: 'timeout' })],
    ['cancelled', () => ({ ...completed('1.3.4'), cancelled: true, terminationReason: 'abort' })],
    ['output limit', () => ({ ...completed('1.3.4'), maxBufferExceeded: true })],
    ['ordinary observed mode', () => ({ ...completed('1.3.4'), containmentMode: 'observed', gradingEvidenceAccepted: false })],
  ];
  for (const [name, fail] of failures) await t.test(name, async (subtest) => {
    const context = await fixture(subtest);
    const report = await probeClientInterfaces('antigravity', { executable: '/fixed/antigravity', prefix: [] }, context, fail);
    assert.equal(report.status, 'failed'); assert.equal(report.processContract, 'failed');
    assert.equal(report.commands.length, 1); assert.equal(report.scope.status, 'unverified');
    assert.equal(report.authentication.failurePossible, false);
  });
});

test('retains bounded redacted output and its original size', async (t) => {
  const context = await fixture(t);
  const output = `1.3.4 ${context.root} ${'x'.repeat(6000)}`;
  const report = await probeClientInterfaces('antigravity', { executable: '/fixed/antigravity', prefix: [] }, context,
    async () => completed(output));
  assert.equal(report.commands[0].stdoutBytes, Buffer.byteLength(output));
  assert.equal(report.commands[0].stdoutPreviewTruncated, true);
  assert.equal(report.commands[0].stdout.length, 4000); assert(!JSON.stringify(report).includes(context.root));
});

// Test Value Gate: only the pinned bytes may become an executable bundle, and a
// bounded failed download must retain its actual digest rather than appear valid.
test('verifies downloaded bytes and retains a hash mismatch', async (t) => {
  const { root } = await fixture(t);
  const bytes = Buffer.from('fixed archive fixture');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const distribution = { url: 'https://example.com/fixed.tar.gz', sha256: digest, digestSource: 'fixture' };
  const fetchFixture = async (url, options) => {
    assert.equal(url, distribution.url); assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.signal.aborted, false); return new Response(bytes);
  };
  const evidence = await downloadInterfaceArchive(distribution, path.join(root, 'valid.tgz'), fetchFixture);
  assert.equal(evidence.actualSha256, digest); assert.equal(evidence.archiveBytes, bytes.length);
  await assert.rejects(downloadInterfaceArchive({ ...distribution, sha256: '0'.repeat(64) }, path.join(root, 'wrong.tgz'), fetchFixture),
    error => error.message === 'archive-sha256-mismatch' && error.evidence.actualSha256 === digest);
  await assert.rejects(downloadInterfaceArchive(distribution, path.join(root, 'large.tgz'), async () =>
    new Response(bytes, { headers: { 'content-length': String(256 * 1024 * 1024 + 1) } })), /archive-download-limit/u);
});

function tarEntry(name, type = '0', body = 'fixture', declaredSize) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100); header.write('0000755\0', 100);
  header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write((declaredSize ?? Buffer.byteLength(body)).toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136); header.fill(0x20, 148, 156); header.write(type, 156);
  if (type === '2') header.write('/outside', 157);
  header.write('ustar\0', 257); header.write('00', 263);
  header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  const bytes = Buffer.from(body);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

// Test Value Gate: archive paths, links, and expanded sizes cannot write outside
// the new temporary distribution root or introduce an unbounded extraction.
test('extracts regular files and rejects escaping, linked, and oversized archive entries', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { root, env } = await fixture(t);
  const good = path.join(root, 'good.tgz');
  await fs.writeFile(good, gzipSync(Buffer.concat([tarEntry('dist-package/index.js'), Buffer.alloc(1024)])));
  const destination = path.join(root, 'good');
  const evidence = await extractInterfaceArchive(good, destination, env);
  assert.equal(evidence.archiveEntries, 1); assert.equal(await fs.readFile(path.join(destination, 'dist-package/index.js'), 'utf8'), 'fixture');
  for (const [name, entry] of [
    ['escape', tarEntry('../escaped')], ['link', tarEntry('linked', '2', '')],
    ['expanded', tarEntry('oversized', '0', '', 768 * 1024 * 1024 + 1)],
  ]) {
    const archive = path.join(root, `${name}.tgz`);
    await fs.writeFile(archive, gzipSync(Buffer.concat([entry, Buffer.alloc(1024)])));
    await assert.rejects(extractInterfaceArchive(archive, path.join(root, name), env));
  }
  await assert.rejects(fs.stat(path.join(root, 'escaped')), { code: 'ENOENT' });
});

test('requires source-bound candidate and report arguments', () => {
  assert.deepEqual(parseInterfaceProbeArgs(['--candidate', 'candidate.json', '--report', 'report.json']),
    { candidate: 'candidate.json', report: 'report.json' });
  for (const args of [[], ['--report', 'report.json'], ['--candidate', 'one', '--candidate', 'two', '--report', 'out'],
    ['--candidate', 'one', '--report', 'out', '--login', 'yes']]) assert.throws(() => parseInterfaceProbeArgs(args), /invalid-interface-probe-arguments/u);
});
