import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { LIMITS, validateSelectors } from '../skills/codex-subagent-guide/scripts/file-selection/contracts.mjs';

const plugin = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const fixtures = {
  baseline: require.resolve('./fixtures/file-selection/baseline.json'),
  oracle: require.resolve('./fixtures/file-selection/oracle-select.mjs'),
  custom: require.resolve('./fixtures/file-selection/custom-adapter.mjs'),
  audit: require.resolve('./fixtures/file-selection/audit-reads.mjs'),
  api: require.resolve('./fixtures/file-selection/selection-api.mjs'),
};
const sourceScripts = path.dirname(require.resolve('../skills/codex-subagent-guide/scripts/resolve-files.mjs'));
const baseline = JSON.parse(await fs.readFile(fixtures.baseline, 'utf8'));
let temporary; let guide; let helper; let selectionApi;

async function execute(entry, input, { args = [], env = {}, nodeArgs = [] } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, entry, ...args], { shell: false, detached: false,
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.stdin.end(Buffer.isBuffer(input) ? input : JSON.stringify(input));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stdout, stderr };
}

before(async () => {
  temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-file-selection-'));
  const movedPlugin = path.join(temporary, 'moved-plugin');
  guide = path.join(movedPlugin, 'skills/codex-subagent-guide');
  const materialized = process.env.AW_FILE_SELECTION_MATERIALIZED_GUIDE;
  await fs.cp(materialized ? path.join(materialized, 'scripts') : sourceScripts, path.join(guide, 'scripts'), { recursive: true });
  if (!materialized && process.env.AW_PLUGIN_EVENT !== 'test') {
    const bundled = await build({ entryPoints: [path.join(sourceScripts, 'file-selection/selection.mjs')],
      nodePaths: [path.join(plugin, 'scripts/node_modules')], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false,
      banner: { js: "import { createRequire as fixtureCreateRequire } from 'node:module'; const require = fixtureCreateRequire(import.meta.url);" }, logLevel: 'silent' });
    await fs.writeFile(path.join(guide, 'scripts/file-selection/selection.mjs'), bundled.outputFiles[0].contents);
  }
  helper = path.join(guide, 'scripts/resolve-files.mjs');
  selectionApi = path.join(movedPlugin, 'scripts/fixtures/file-selection/selection-api.mjs');
  await fs.mkdir(path.dirname(selectionApi), { recursive: true });
  await fs.copyFile(fixtures.api, selectionApi);
});
after(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

// The fixture keeps a literal, registered import when it moves with the Guide.
// The test process never resolves a computed module name or a host dependency.
async function selectionCall(action, input, options) {
  const result = await execute(selectionApi, { action, input, options });
  if (result.code !== 0) {
    const failure = JSON.parse(result.stderr);
    throw Object.assign(new Error(failure.message), { code: failure.code });
  }
  return JSON.parse(result.stdout);
}
const selection = {
  resolveFiles: (input, options) => selectionCall('resolve', input, options),
  assertNativeSelectionReadable: (workspace, selectors, options) => selectionCall('guard', { workspace, selectors }, options),
};

async function tree(t) {
  const root = await fs.mkdtemp(path.join(temporary, 'tree-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  for (const [relative, body] of Object.entries(baseline.fixtures)) {
    const file = path.join(workspace, relative);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body);
  }
  for (const [relative, target] of Object.entries(baseline.symlinks)) await fs.symlink(target, path.join(workspace, relative));
  await fs.writeFile(path.join(root, 'outside.txt'), 'synthetic outside body');
  return { root, workspace };
}

async function custom(workspace, selectors) {
  const directory = await fs.mkdtemp(path.join(temporary, 'custom-'));
  const resultFile = path.join(directory, 'result.json');
  const boundary = path.join(directory, 'model-boundary');
  const run = await execute(fixtures.custom, {
    protocolVersion: 4, execution: { profile: 'fixture', executor: 'fixture' }, mode: 'bundle', workspace, prompt: 'selection fixture',
    fileSelectors: selectors, fileResolver: { command: process.execPath, args: [helper] }, args: [],
  }, { env: { AW_SUBAGENT_RESULT_FILE: resultFile, AW_TEST_SELECTION_BOUNDARY: boundary } });
  const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  const submitted = await fs.readFile(boundary, 'utf8').catch(() => '');
  await fs.rm(directory, { recursive: true, force: true });
  return { run, result, submitted };
}

async function compare(workspace, selectors, files, code) {
  const request = { protocolVersion: 1, workspace, selectors };
  const expected = files?.map((file) => path.resolve(workspace, file)).sort();
  const publicRun = await execute(helper, request);
  const customRun = await custom(workspace, selectors);
  const nativeRun = await execute(fixtures.oracle, request, { args: [selectionApi] });
  if (code) {
    assert.equal(publicRun.stdout, ''); assert.equal(JSON.parse(publicRun.stderr).code, code);
    assert.notEqual(publicRun.code, 0);
    assert.equal(customRun.result.state, 'failed'); assert.equal(customRun.result.generationStarted, false);
    assert.equal(customRun.result.code, code); assert.equal(customRun.submitted, ''); assert.equal(customRun.run.code, 1);
    assert.equal(nativeRun.stdout, ''); assert.equal(JSON.parse(nativeRun.stderr).code, code); assert.notEqual(nativeRun.code, 0);
  } else {
    assert.equal(publicRun.code, 0, publicRun.stderr); assert.equal(publicRun.stderr, '');
    assert.deepEqual(JSON.parse(publicRun.stdout), { protocolVersion: 1, files: expected });
    assert.equal(customRun.run.code, 0, customRun.run.stderr); assert.equal(customRun.result.state, 'completed');
    assert.deepEqual(JSON.parse(customRun.result.text).files, expected); assert.deepEqual(JSON.parse(customRun.submitted), expected);
    assert.equal(nativeRun.code, 0, nativeRun.stderr); assert.deepEqual(JSON.parse(nativeRun.stdout).files, expected);
  }
}

// Test Value Gate: a moved runtime, a real helper consumer and unmodified Oracle
// selection code protect the common observable set, including baseline exceptions.
test('v1 conformance: helper, moved custom consumer and real Oracle selection share the baseline', async (t) => {
  const { workspace } = await tree(t);
  for (const observation of baseline.observations) await t.test(observation.id, async () => {
    let code;
    if (['blank-selector', 'empty-exclusion'].includes(observation.id)) code = 'fileSelectionInputInvalid';
    else if (observation.status === 'error') code = observation.message.startsWith('Missing file or directory:') ? 'fileSelectionPathMissing' : 'fileSelectionEmpty';
    await compare(workspace, observation.raw, observation.files, code);
  });
});

test('absolute paths, global exclusions, alias identity and special names remain literal', async (t) => {
  const { workspace } = await tree(t);
  await compare(workspace, [path.join(workspace, 'src/**/*.ts'), '!**/*.test.ts'], ['src/[id]/page.ts', 'src/main.ts', 'src/name,part.ts']);
  await compare(workspace, ['src/main.ts', 'linked.ts', './src/main.ts'], ['linked.ts', 'src/main.ts']);
  await compare(workspace, ['src/name?part.ts'], ['src/name,part.ts']);
  await compare(workspace, ['!docs/a.md', 'docs/*.md', 'docs/a.md'], ['docs/b.md']);
  await compare(workspace, ['src/main.ts,, docs/a.md,'], ['docs/a.md', 'src/main.ts']);
  await compare(workspace, ['./docs/*.md'], ['docs/a.md', 'docs/b.md']);
  await fs.writeFile(path.join(workspace, 'docs/1.md'), 'synthetic');
  await fs.writeFile(path.join(workspace, 'docs/2.md'), 'synthetic');
  await compare(workspace, ['docs/{1..2}.md'], ['docs/1.md', 'docs/2.md']);
  await compare(workspace, ['linked-dir/**/*.ts'], ['linked-dir/[id]/page.ts', 'linked-dir/main.test.ts', 'linked-dir/main.ts', 'linked-dir/name,part.ts']);
  await compare(workspace, ['*.ts'], [] , 'fileSelectionEmpty');
});

test('simplified ignore uses full paths, literal punctuation and no negation reinclusion', async (t) => {
  const { workspace } = await tree(t);
  await fs.writeFile(path.join(workspace, 'docs/.gitignore'), 'a.md\n!a.md\n# comment\n');
  await compare(workspace, ['docs'], ['docs/b.md']);
  await compare(workspace, ['docs/a.md'], ['docs/a.md']);
  await fs.writeFile(path.join(workspace, 'docs/.gitignore'), ' b.md  \n');
  await compare(workspace, ['docs/*.md'], ['docs/a.md']);
  await fs.mkdir(path.join(workspace, 'dist/build'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'dist/build/x.js'), 'synthetic');
  await compare(workspace, ['dist/**/*.js'], ['dist/out.js']);
  await fs.writeFile(path.join(workspace, 'dist/build/.gitignore'), '# marker');
  await compare(workspace, ['dist/**/*.js'], ['dist/build/x.js', 'dist/out.js']);
  await compare(workspace, ['dist'], ['dist/build/x.js', 'dist/out.js']);
});

test('ignore prefix identity, outside globs and dot opt-in preserve the fixed exceptions', async (t) => {
  const { root, workspace } = await tree(t);
  await compare(workspace, ['../*.txt'], ['../outside.txt']);
  await fs.mkdir(path.join(root, 'workspace-extra'));
  await fs.writeFile(path.join(root, 'workspace-extra/private.txt'), 'synthetic');
  await fs.writeFile(path.join(workspace, '.gitignore'), '../workspace-extra/private.txt\n');
  await compare(workspace, ['../workspace-extra/private.txt', 'docs/*.md'], ['docs/a.md', 'docs/b.md']);
  await fs.writeFile(path.join(workspace, 'docs/[rule].md'), 'synthetic');
  await fs.writeFile(path.join(workspace, 'docs/rule.md'), 'synthetic');
  await fs.writeFile(path.join(workspace, 'docs/.gitignore'), '[rule].md\n');
  await compare(workspace, ['docs/*.md'], ['docs/a.md', 'docs/b.md', 'docs/rule.md']);
  await compare(workspace, ['docs/*', '../outside.txt'], ['../outside.txt', 'docs/.gitignore', 'docs/a.md', 'docs/b.md', 'docs/rule.md']);
  await fs.symlink('absent.txt', path.join(workspace, 'broken-link'));
  await compare(workspace, ['broken-link'], undefined, 'fileSelectionPathMissing');
  await fs.writeFile(path.join(workspace, 'binary.bin'), Buffer.from([0, 255, 1]));
  await compare(workspace, ['binary.bin'], ['binary.bin']);
  await fs.writeFile(path.join(workspace, 'large.bin'), '');
  await fs.truncate(path.join(workspace, 'large.bin'), 2 * 1024 * 1024);
  await compare(workspace, ['large.bin'], ['large.bin']);
});

// Test Value Gate: actual opened files and failures protect metadata-only selection
// and no model-boundary side effect after any helper failure.
test('helper reads ignore bodies only and empty selectors do not open files', async (t) => {
  const { workspace } = await tree(t);
  const audit = path.join(temporary, 'read-audit');
  const nodeArgs = ['--import', fixtures.audit];
  const result = await execute(helper, { protocolVersion: 1, workspace, selectors: ['**/*'] }, { nodeArgs, env: { AW_TEST_READ_AUDIT: audit } });
  assert.equal(result.code, 0, result.stderr);
  const opened = (await fs.readFile(audit, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(opened.length > 0); assert.ok(opened.every((file) => path.basename(file) === '.gitignore'));
  await fs.rm(audit);
  const empty = await execute(helper, { protocolVersion: 1, workspace, selectors: [] }, { nodeArgs, env: { AW_TEST_READ_AUDIT: audit } });
  assert.equal(empty.code, 0); assert.deepEqual(JSON.parse(empty.stdout).files, []);
  assert.equal(await fs.stat(audit).catch(() => undefined), undefined);
});

test('public JSON errors have stable codes, no partial stdout and no input reflection', async (t) => {
  const { workspace } = await tree(t);
  const valid = { protocolVersion: 1, workspace, selectors: ['docs/a.md'] };
  for (const input of [{ ...valid, unknown: 'synthetic-private-value' }, { ...valid, protocolVersion: 2 },
    { selectors: [] }, { ...valid, workspace: 'relative' }, { ...valid, selectors: [3] },
    { ...valid, selectors: ['\0synthetic-private-value'] }, { ...valid, selectors: [' ,, '] },
    { ...valid, selectors: ['!  '] }, Buffer.from([0xff]), Buffer.from('{} {}')]) {
    const result = await execute(helper, input);
    assert.equal(result.code, 2); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'fileSelectionInputInvalid');
    assert.ok(!result.stderr.includes('synthetic-private-value'));
  }
  const large = await execute(helper, Buffer.alloc(LIMITS.inputBytes + 1, 32));
  assert.equal(large.code, 1); assert.equal(large.stdout, ''); assert.equal(JSON.parse(large.stderr).code, 'fileSelectionLimitExceeded');
  await compare(workspace, Array(LIMITS.selectors + 1).fill('docs/a.md'), undefined, 'fileSelectionLimitExceeded');
  await compare(workspace, [Array(LIMITS.patterns + 1).fill('docs/a.md').join(',')], undefined, 'fileSelectionLimitExceeded');
  for (const pattern of ['x'.repeat(LIMITS.patternBytes + 1), 'docs/{1..1001}.md', 'docs/{1..100}{1..100}.md']) {
    await compare(workspace, [pattern], undefined, 'fileSelectionLimitExceeded');
  }
  const args = await execute(helper, valid, { args: ['--unknown'] });
  assert.equal(args.code, 2); assert.equal(JSON.parse(args.stderr).code, 'fileSelectionInputInvalid');
  const help = await execute(helper, undefined, { args: ['--help'] });
  assert.equal(help.code, 0); assert.equal(help.stderr, '');
  for (const limit of Object.values(LIMITS)) assert.ok(help.stdout.includes(String(limit)));
  const untouched = ['  docs/a.md,src/main.ts  ']; assert.equal(validateSelectors(untouched), untouched);
});

test('selection and guard enforce resource, read and cancellation failures', async (t) => {
  const { root, workspace } = await tree(t);
  const request = { protocolVersion: 1, workspace, selectors: ['docs/*.md'] };
  for (const limits of [{ ...LIMITS, entries: 1 }, { ...LIMITS, operations: 1 }, { ...LIMITS, files: 1 },
    { ...LIMITS, outputBytes: 1 }, { ...LIMITS, ignoreFileBytes: 1 }, { ...LIMITS, ignoreTotalBytes: 1 },
    { ...LIMITS, durationMs: 0 }, { ...LIMITS, selectors: 0 }, { ...LIMITS, patterns: 0 }]) {
    await assert.rejects(selection.resolveFiles(request, { limits }), { code: 'fileSelectionLimitExceeded' });
  }
  await assert.rejects(selection.assertNativeSelectionReadable(workspace, request.selectors, { limits: { ...LIMITS, entries: 1 } }), { code: 'fileSelectionLimitExceeded' });
  await assert.rejects(selection.assertNativeSelectionReadable(workspace, [], { cancelled: true }), { code: 'adapterCancelled' });
  await assert.rejects(selection.resolveFiles(request, { simulateMissing: path.join(workspace, 'docs/a.md') }), { code: 'fileSelectionReadFailed' });
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.diagnostic('POSIX unreadable filesystem checks require a non-root POSIX user.'); return; }
  const outsideDirectory = path.join(root, 'unselected-directory');
  await fs.mkdir(outsideDirectory); await fs.chmod(outsideDirectory, 0);
  try {
    await compare(workspace, ['../*.txt'], ['../outside.txt']);
    await compare(workspace, ['../unselected-directory/**/*.txt'], undefined, 'fileSelectionReadFailed');
  } finally { await fs.chmod(outsideDirectory, 0o700); }
  const ignore = path.join(workspace, '.gitignore');
  await fs.chmod(ignore, 0);
  try {
    await compare(workspace, ['!**/*.test.ts'], undefined, 'fileSelectionEmpty');
    const bare = await execute(fixtures.oracle, request);
    assert.equal(bare.code, 0, 'Reference Oracle suppresses unreadable ignore files.');
    await compare(workspace, request.selectors, undefined, 'fileSelectionReadFailed');
  } finally { await fs.chmod(ignore, 0o600); }
  const directory = path.join(workspace, 'src');
  await fs.chmod(directory, 0);
  try { await compare(workspace, ['docs/*.md'], undefined, 'fileSelectionReadFailed'); }
  finally { await fs.chmod(directory, 0o700); }
  const file = path.join(workspace, 'docs/a.md');
  await fs.chmod(file, 0);
  try { await compare(workspace, ['docs/a.md'], undefined, 'fileSelectionReadFailed'); }
  finally { await fs.chmod(file, 0o600); }
});
