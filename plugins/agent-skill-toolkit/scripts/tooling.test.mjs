import assert from 'node:assert/strict';
import { copyFile, cp, lstat, mkdir, open, readdir, readFile, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { main as buildStagedTools } from './build-tools.mjs';
import { buildTools, GENERATED_FILES } from '../tooling/build.mjs';
import { checkSkill } from '../tooling/src/check-skill.mjs';
import { SCAN_LIMITS } from '../tooling/src/common.mjs';
import { initSkill } from '../tooling/src/init-skill.mjs';
import { fixture, jsonRun, pluginRoot, put, run, skill, sourceEntry } from '../tooling/test/helpers.mjs';

const init = sourceEntry('init-skill');
const check = sourceEntry('check-skill');

// Test Value Gate: public CLI output/exit codes, exclusive creation/residue,
// field/reference validation, read limits and real bundles are consumer risks.
test('init creates only standard SKILL.md and identifies a scaffold', async t => {
  const parent = await fixture(t);
  const target = path.join(parent, 'sample-skill');
  const result = await jsonRun(init, target, '--description', 'Read supplied notes.');
  assert.equal(result.code, 0);
  assert.equal(result.report.ok, true);
  assert.equal(result.report.state, 'scaffold');
  assert.deepEqual(result.report.created, ['SKILL.md']);
  assert.deepEqual(await readdir(target), ['SKILL.md']);
  const checked = await jsonRun(check, target);
  assert.equal(checked.code, 0);
  assert.equal(checked.report.ok, true);
  assert.ok(checked.report.diagnostics.some(item => item.code === 'scaffold-content' && item.severity === 'info'));
  const explicit = await jsonRun(init, path.join(parent, 'other-skill'), '--name', 'other-skill', '--description', 'Read notes: quoted "value"\nand new line.');
  assert.equal(explicit.code, 0);
  assert.equal((await jsonRun(check, path.join(parent, 'other-skill'))).code, 0);
});

test('init dry-run has zero writes and the same planned files', async t => {
  const parent = await fixture(t);
  const result = await jsonRun(init, path.join(parent, 'sample-skill'), '--description', 'Read supplied notes.', '--dry-run');
  assert.equal(result.code, 0);
  assert.equal(result.report.dryRun, true);
  assert.deepEqual(result.report.files, ['SKILL.md']);
  assert.deepEqual(result.report.created, []);
  assert.deepEqual(await readdir(parent), []);
});

test('init rejects existing nodes and preserves a sentinel', async t => {
  const parent = await fixture(t);
  const target = path.join(parent, 'sample-skill');
  await put(target, 'sentinel', 'retain');
  const result = await jsonRun(init, target, '--description', 'Read notes.');
  assert.equal(result.report.ok, false);
  assert.ok(result.report.diagnostics.some(item => item.code === 'target-exists'));
  assert.deepEqual(await readdir(target), ['sentinel']);
  assert.equal(await readFile(path.join(target, 'sentinel'), 'utf8'), 'retain');
});

test('init rejects invalid/duplicate/legacy args and names before writes', async t => {
  const parent = await fixture(t);
  const target = path.join(parent, 'sample-skill');
  for (const args of [
    ['--name', 'different', '--description', 'Read.'], ['--name', 'Bad_name', '--description', 'Read.'],
    ['--description', ''], ['--description', 'x'.repeat(1025)], ['--platform', 'codex', '--description', 'Read.'],
    ['--description', 'Read.', '--description', 'Again.'], ['--description'], ['--description', 'Read.', 'extra'],
  ]) {
    const result = await jsonRun(init, target, ...args);
    assert.equal(result.code, 2);
    assert.equal(result.report.state, 'not-created');
    assert.deepEqual(result.report.created, []);
  }
  assert.deepEqual(await readdir(parent), []);
});

test('init rejects symlink parents and missing parents', async t => {
  const parent = await fixture(t);
  await mkdir(path.join(parent, 'real'));
  await symlink(path.join(parent, 'real'), path.join(parent, 'linked'));
  const linked = await jsonRun(init, path.join(parent, 'linked', 'sample-skill'), '--description', 'Read.');
  assert.equal(linked.report.ok, false);
  assert.ok(linked.report.diagnostics.some(item => item.code === 'unsafe-path'));
  const missing = await jsonRun(init, path.join(parent, 'missing', 'sample-skill'), '--description', 'Read.');
  assert.equal(missing.report.ok, false);
  assert.deepEqual(await readdir(path.join(parent, 'real')), []);
});

test('init competing directory/file creation never overwrites foreign content', async t => {
  const parent = await fixture(t);
  const target = path.join(parent, 'sample-skill');
  const result = await initSkill(target, { description: 'Read.', fs: { lstat, open, unlink, rmdir, mkdir: async directory => {
    await mkdir(directory); await writeFile(path.join(directory, 'sentinel'), 'foreign');
    const error = new Error('race'); error.code = 'EEXIST'; throw error;
  } } });
  assert.equal(result.state, 'not-created');
  assert.equal(await readFile(path.join(target, 'sentinel'), 'utf8'), 'foreign');
  const second = path.join(parent, 'other-skill');
  const raced = await initSkill(second, { description: 'Read.', fs: { lstat, mkdir, unlink, rmdir, open: async (file, ...args) => {
    await writeFile(file, 'foreign', { flag: 'wx' }); return open(file, ...args);
  } } });
  assert.equal(raced.state, 'partial');
  assert.deepEqual(raced.created, ['.']);
  assert.equal(await readFile(path.join(second, 'SKILL.md'), 'utf8'), 'foreign');
});

test('init write failure cleans owned nodes and reports real retained residue', async t => {
  const parent = await fixture(t);
  const target = path.join(parent, 'sample-skill');
  const failingOpen = async (...args) => {
    const handle = await open(...args);
    return { stat: () => handle.stat(), close: () => handle.close(), writeFile: async () => {
      const error = new Error('disk full'); error.code = 'ENOSPC'; throw error;
    } };
  };
  const clean = await initSkill(target, { description: 'Read.', fs: { lstat, mkdir, open: failingOpen, unlink, rmdir } });
  assert.equal(clean.state, 'not-created');
  assert.deepEqual(clean.created, []);
  assert.deepEqual(await readdir(parent), []);
  const retained = await initSkill(target, { description: 'Read.', fs: { lstat, mkdir, open: failingOpen, unlink: async () => { throw new Error('cleanup denied'); }, rmdir } });
  assert.equal(retained.state, 'partial');
  assert.deepEqual(retained.created, ['.', 'SKILL.md']);
  assert.ok((await lstat(path.join(target, 'SKILL.md'))).isFile());
});

test('checker completes minimal and both common invocation field sets in one package', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'sample-skill');
  await put(root, 'SKILL.md', skill('sample-skill', 'allowed-tools: Read Bash\ndisable-model-invocation: true\nuser-invocable: true\nmetadata:\n  version: "1"\n'));
  const first = await jsonRun(check, root);
  assert.equal(first.code, 0);
  assert.deepEqual(first.report.coverage, { frontmatter: true, commonMetadata: true, references: true });
  await put(root, 'agents/openai.yaml', 'interface:\n  display_name: Sample\n');
  assert.equal((await jsonRun(check, root)).code, 0);
  await put(root, 'agents/openai.yaml', 'interface:\n  display_name: Sample\npolicy:\n  allow_implicit_invocation: false\n');
  assert.equal((await jsonRun(check, root)).code, 0);
  await put(root, 'agents/openai.yaml', 'policy:\n  allow_implicit_invocation: "false"\n');
  const invalid = await jsonRun(check, root);
  assert.equal(invalid.code, 1);
  assert.ok(invalid.report.diagnostics.some(item => item.code === 'field-type' && item.path === 'agents/openai.yaml'));
});

test('checker rejects standard field types, duplicate keys and empty body', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'sample-skill');
  for (const content of [
    skill('sample-skill', 'description: Again\n'), skill('sample-skill', 'compatibility: 12\n'),
    skill('sample-skill', 'metadata:\n  version: 1\n'), skill('sample-skill', 'allowed-tools: [Read, 3]\n'),
    skill('sample-skill', 'disable-model-invocation: "false"\n'), skill('sample-skill', '', ''),
    '---\n- not a mapping\n---\nBody', '---\nname: sample-skill\nwhen_to_use: Read notes\n---\nBody',
  ]) {
    await put(root, 'SKILL.md', content);
    const result = await jsonRun(check, root);
    assert.equal(result.code, 1);
    assert.equal(result.report.ok, false);
  }
});

test('checker limits YAML alias expansion and does not execute custom tags', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'sample-skill');
  for (const fields of [
    'a: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\n',
    'extra: !execute command\n', 'metadata: &a {child: *a}\n',
  ]) {
    await put(root, 'SKILL.md', skill('sample-skill', fields));
    const result = await jsonRun(check, root);
    assert.equal(result.code, 1);
    assert.ok(result.report.diagnostics.some(item => item.code === 'invalid-frontmatter'));
  }
});

test('checker Unicode code-point lengths, BOM and CRLF remain usable', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'sample-skill');
  const content = `---\nname: sample-skill\ndescription: ${'😀'.repeat(1024)}\ncompatibility: ${'😀'.repeat(500)}\n---\nRead.\n`;
  await put(root, 'SKILL.md', '\uFEFF' + content.replaceAll('\n', '\r\n'));
  const result = await jsonRun(check, root);
  assert.equal(result.code, 0);
  assert.ok(result.report.diagnostics.some(item => item.code === 'utf8-bom'));
  await put(root, 'SKILL.md', content.replace('description: ', 'description: 😀'));
  assert.equal((await jsonRun(check, root)).code, 1);
});

test('unknown extensions and compatible allowed-tools arrays are advisory', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'sample-skill');
  await put(root, 'SKILL.md', skill('sample-skill', 'allowed-tools: [Read, Bash]\ncustom-field:\n  nested: true\n'));
  await put(root, 'agents/openai.yaml', 'interface:\n  custom: {nested: true}\nextra: true\n');
  const result = await jsonRun(check, root);
  assert.equal(result.code, 0);
  assert.ok(result.report.diagnostics.some(item => item.code === 'nonstandard-field-form'));
  assert.ok(result.report.diagnostics.filter(item => item.code === 'unknown-extension').length >= 3);
});

test('checker resolves root/current links, link references and icons without running scripts', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'sample-skill');
  await put(root, 'SKILL.md', skill('sample-skill', '', '[guide][method]\n\n[method]: references/guide.md#usage\n\n`scripts/never-run.mjs`\n\n```sh\ncat references/not-real.md\n```'));
  await put(root, 'references/guide.md', '# Guide\n\n[details](./details.md)\n[asset](../assets/icon.svg)\n[package](../)\n');
  await put(root, 'references/details.md', 'Read `assets/icon.svg`.');
  await put(root, 'assets/icon.svg', '<svg/>');
  await put(root, 'scripts/never-run.mjs', `throw new Error('must not run');`);
  await put(root, 'agents/openai.yaml', 'interface:\n  icon_small: ./assets/icon.svg\n');
  const result = await jsonRun(check, root);
  assert.equal(result.code, 0);
  assert.equal(result.report.scan.filesRead, 4);
  await unlink(path.join(root, 'references/details.md'));
  const missing = await jsonRun(check, root);
  assert.equal(missing.code, 1);
  assert.ok(missing.report.diagnostics.some(item => item.code === 'missing-reference' && item.path === 'references/guide.md' && item.line));
});

test('checker ignores inline syntax explanations and slash invocation commands', async t => {
  const root = path.join(await fixture(t), 'sample-skill');
  await put(root, 'SKILL.md', skill('sample-skill', '', 'Markdown links use `./` and `../`; invoke `/sample-skill` explicitly.\n'));
  const result = await jsonRun(check, root);
  assert.equal(result.code, 0);
  assert.deepEqual(result.report.diagnostics, []);
});

test('checker preserves unresolved/external pointers and rejects escaping/symlink resources', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'sample-skill');
  await put(root, 'SKILL.md', skill('sample-skill', '', '`references/${name}.md`\n`assets/*.png`\n[external](/outside/file.md)\n[web](https://example.com/a.md)\n'));
  const advisory = await jsonRun(check, root);
  assert.equal(advisory.code, 0);
  assert.ok(advisory.report.diagnostics.some(item => item.code === 'unresolved-reference'));
  assert.ok(advisory.report.diagnostics.some(item => item.code === 'external-reference'));
  await put(root, 'SKILL.md', skill('sample-skill', '', '[bad](../foreign.md)'));
  assert.equal((await jsonRun(check, root)).code, 1);
  await symlink(path.join(parent, 'outside'), path.join(root, 'linked'));
  const unsafe = await jsonRun(check, root);
  assert.equal(unsafe.code, 1);
  assert.equal(unsafe.report.complete, false);
  assert.ok(unsafe.report.diagnostics.some(item => item.code === 'unsafe-node'));
});

test('checker bounded scans and invalid UTF-8 cannot report complete success', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'sample-skill');
  await put(root, 'SKILL.md', skill('sample-skill', '', '`references/large.md`'));
  await put(root, 'references/large.md', 'x'.repeat(SCAN_LIMITS.maxFileBytes + 1));
  const large = await jsonRun(check, root);
  assert.equal(large.code, 1);
  assert.equal(large.report.complete, false);
  assert.equal(large.report.coverage.references, false);
  await put(root, 'references/large.md', 'Read.');
  const files = await checkSkill(root, { limits: { ...SCAN_LIMITS, maxFiles: 1 } });
  assert.equal(files.ok, false);
  assert.equal(files.complete, false);
  const nodes = await checkSkill(root, { limits: { ...SCAN_LIMITS, maxNodes: 1 } });
  assert.equal(nodes.complete, false);
  assert.ok(nodes.scan.incompleteReasons.includes('node-count-limit'));
  await put(root, 'SKILL.md', Buffer.from([0xff]));
  const bytes = await jsonRun(check, root);
  assert.equal(bytes.code, 1);
  assert.equal(bytes.report.complete, false);
});

test('checker help needs no target; parameter/root failures exit 2', async () => {
  assert.equal((await run(check, ['--help'])).code, 0);
  for (const args of [['missing', '--platform', 'codex'], ['missing', '--dry-run'], ['missing', 'extra'], ['/definitely/missing/root']]) {
    const result = await jsonRun(check, ...args);
    assert.equal(result.code, 2);
    assert.equal(result.report.ok, false);
    assert.equal(result.report.complete, false);
    assert.equal(result.stderr, '');
  }
});

test('independent build delivers six runnable script copies and four complete notices', async t => {
  const parent = await fixture(t);
  const output = path.join(parent, 'export');
  await buildTools(output);
  const scripts = GENERATED_FILES.filter(([, relative]) => relative.endsWith('.mjs'));
  assert.equal(scripts.length, 6);
  const alias = path.join(parent, 'export-alias');
  await symlink(output, alias);
  for (const [name, relative] of scripts) {
    const result = await run(path.join(output, 'skills', name, relative), ['--help'], { cwd: parent, env: { PATH: '', HOME: parent, NODE_PATH: '' } });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const throughAlias = await run(path.join(alias, 'skills', name, relative), ['--help']);
    assert.equal(throughAlias.code, 0);
    assert.equal(throughAlias.stdout, result.stdout);
  }
  const author = path.join(output, 'skills/author-agent-skill/scripts');
  const target = path.join(parent, 'sample-skill');
  assert.equal((await jsonRun(path.join(author, 'init-skill.mjs'), target, '--description', 'Read.')).code, 0);
  assert.equal((await jsonRun(path.join(author, 'check-skill.mjs'), target)).code, 0);
  const aliasCheck = await jsonRun(path.join(alias, 'skills/author-agent-skill/scripts/check-skill.mjs'), target);
  assert.equal(aliasCheck.code, 0);
  assert.equal(aliasCheck.report.ok, true);
  const targetAlias = path.join(parent, 'input-alias');
  await symlink(target, targetAlias);
  assert.equal((await jsonRun(path.join(author, 'check-skill.mjs'), targetAlias)).code, 2);
  assert.equal((await jsonRun(path.join(output, 'skills/review-agent-skill/scripts/audit-output-contracts.mjs'), target)).code, 0);
  const notices = GENERATED_FILES.filter(([, relative]) => relative.endsWith('.txt'));
  assert.equal(notices.length, 4);
  for (const [name, relative] of notices) {
    const notice = await readFile(path.join(output, 'skills', name, relative), 'utf8');
    // Static contract exception: bundled libraries must retain their license notices; behavior test is not suitable because these legal notices are consumed as distributed text.
    assert.ok(notice.includes('Copyright Eemeli Aro'));
    assert.ok(notice.includes('Christopher Jeffrey'));
    assert.ok(notice.includes('Permission is hereby granted'));
  }
  await assert.rejects(buildTools(output), { code: 'target-exists' });
});

test('AW wrapper refuses source and only generates declared staging targets', async t => {
  const parent = await fixture(t);
  const wrapper = path.join(pluginRoot, 'scripts/build-tools.mjs');
  await assert.rejects(buildStagedTools, /只允许写 AW staging/);
  const staging = path.join(parent, 'aw-plugin-staging-test', 'plugin');
  await put(staging, '.agents-plugin/plugin.json', JSON.stringify({ name: 'agent-skill-toolkit', scripts: { node: { packageRoot: './tooling' } },
    buildConfig: { generatedSkillRuntimeFiles: GENERATED_FILES.map(([skill, target]) => ({ skill, target })) } }));
  for (const name of new Set(GENERATED_FILES.map(([name]) => name))) await put(staging, `skills/${name}/SKILL.md`, skill(name));
  await mkdir(path.join(staging, 'scripts'));
  await copyFile(wrapper, path.join(staging, 'scripts/build-tools.mjs'));
  await cp(path.join(pluginRoot, 'tooling'), path.join(staging, 'tooling'), { recursive: true, filter: source => path.basename(source) !== 'node_modules' });
  await symlink(path.join(pluginRoot, 'tooling/node_modules'), path.join(staging, 'tooling/node_modules'));
  const result = await run(path.join(staging, 'scripts/build-tools.mjs'), [], { cwd: parent });
  assert.equal(result.code, 0, result.stderr);
  for (const [name, relative] of GENERATED_FILES) assert.ok((await lstat(path.join(staging, 'skills', name, relative))).isFile());
  assert.equal((await run(path.join(staging, 'scripts/build-tools.mjs'), [], { cwd: parent })).code, 1);
});
