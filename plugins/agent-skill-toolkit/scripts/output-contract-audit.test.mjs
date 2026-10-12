import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { auditOutputContracts } from '../tooling/src/audit-output-contracts.mjs';
import { SCAN_LIMITS } from '../tooling/src/common.mjs';
import { fixture, jsonRun, put, run, sourceEntry } from '../tooling/test/helpers.mjs';

const entry = sourceEntry('audit-output-contracts');
const candidate = (report, target) => {
  const value = report.candidates.find(item => item.path === target);
  assert.ok(value, `missing candidate: ${target}`);
  return value;
};

// Test Value Gate: public v2 output, separate root coverage, bounded scans and
// false business-consumer/path claims are observable consumer risks.
test('audit v2 resolves static imports but never upgrades comments or execute/allow text', async t => {
  const root = await fixture(t);
  await put(root, 'contracts/result.schema.json', '{}\n');
  await put(root, 'scripts/validate-result.mjs', "import schema from '../contracts/result.schema.json' with {type:'json'};\n// readFile('../contracts/result.schema.json'); execute(schema); allow();\nconst note = 'publish allow execute';\n");
  const result = await jsonRun(entry, root);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.report.version, 2);
  assert.equal(result.report.command, 'audit-output-contracts');
  const item = candidate(result.report, 'contracts/result.schema.json');
  assert.equal(item.businessUse, 'not-assessed');
  assert.equal(item.assessment, 'references-found');
  assert.ok(item.references.some(ref => ref.resolution === 'resolved-path' && ref.line === 1));
  assert.ok(item.references.some(ref => ref.line === 2 && ref.resolution !== 'resolved-path'));
  assert.ok(item.references.every(ref => ref.relation === 'reference-candidate'));
});

test('audit preserves base-unknown for cwd reads, including Python', async t => {
  const root = await fixture(t);
  await put(root, 'contract.schema.json', '{}');
  await put(root, 'scripts/read.mjs', "await readFile('../contract.schema.json', 'utf8');\n");
  await put(root, 'read.py', "value = open('./contract.schema.json').read()\n");
  const result = await jsonRun(entry, root);
  const item = candidate(result.report, 'contract.schema.json');
  assert.equal(result.code, 0);
  assert.ok(item.references.some(ref => ref.path === 'read.py' && ref.resolution === 'base-unknown'));
  assert.ok(item.references.some(ref => ref.path === 'scripts/read.mjs' && ref.resolution === 'base-unknown'));
  assert.ok(result.report.scope.roots[0].readExtensions.includes('.py'));
});

test('audit does not resolve a same-name import to a different path', async t => {
  const root = await fixture(t);
  await put(root, 'a/result.schema.json', '{"a":1}');
  await put(root, 'b/result.schema.json', '{"b":1}');
  await put(root, 'scripts/read.ts', "import schema from '../b/result.schema.json';\n");
  const result = await jsonRun(entry, root);
  assert.equal(candidate(result.report, 'a/result.schema.json').references.length, 0);
  assert.equal(candidate(result.report, 'a/result.schema.json').assessment, 'no-reference-in-scope');
  assert.equal(candidate(result.report, 'b/result.schema.json').references[0].resolvedPath, 'b/result.schema.json');
});

test('audit counts source/final copies while recording each root coverage', async t => {
  const parent = await fixture(t);
  const source = path.join(parent, 'source');
  const final = path.join(parent, 'final');
  await put(source, 'contracts/result.schema.json', '{"type":"object"}');
  await put(final, 'skills/review/references/result.schema.json', '{"type":"object"}');
  const result = await jsonRun(entry, source, '--materialized-root', final);
  assert.equal(result.code, 0);
  assert.deepEqual(candidate(result.report, 'contracts/result.schema.json').copies, { source: 1, materialized: 1, uniqueContentHashes: 1 });
  assert.equal(result.report.scope.roots.length, 2);
  assert.ok(result.report.scope.roots.every(scope => scope.complete && scope.filesRead === 1));
});

test('audit no matches succeeds and exposes discovery/skipped-extension limits', async t => {
  const root = await fixture(t);
  await put(root, 'contract.schema.json', '{}');
  await put(root, 'ordinary-result.json', '{}');
  await put(root, 'notes.txt', 'contract.schema.json');
  const result = await jsonRun(entry, root);
  assert.equal(result.code, 0);
  assert.equal(result.report.complete, true);
  assert.equal(result.report.candidates.length, 1);
  assert.equal(result.report.candidates[0].assessment, 'no-reference-in-scope');
  assert.ok(result.report.scope.roots[0].skippedExtensions.includes('.txt'));
  assert.ok(result.report.candidates[0].unknowns.length);
  const none = await jsonRun(entry, await fixture(t));
  assert.equal(none.code, 0);
  assert.deepEqual(none.report.candidates, []);
});

test('human Markdown template retains human-format without business-use claims', async t => {
  const root = await fixture(t);
  await put(root, 'assets/human-template.md', '# Review\n\nWrite the observed facts.');
  const result = await jsonRun(entry, root);
  assert.equal(result.report.candidates[0].assessment, 'human-format');
  assert.equal(result.report.candidates[0].businessUse, 'not-assessed');
});

test('audit size and independent final limits return incomplete exit 1', async t => {
  const parent = await fixture(t);
  const source = path.join(parent, 'source');
  const final = path.join(parent, 'final');
  await put(source, 'result.schema.json', '{}');
  await put(final, 'large.py', 'x'.repeat(SCAN_LIMITS.maxFileBytes + 1));
  const result = await jsonRun(entry, source, '--materialized-root', final);
  assert.equal(result.code, 1);
  assert.equal(result.report.complete, false);
  assert.equal(result.report.scope.roots[0].complete, true);
  assert.equal(result.report.scope.roots[1].complete, false);
  assert.ok(result.report.diagnostics.some(item => item.origin === 'materialized' && item.code === 'scan-limit'));
  assert.equal(result.report.candidates[0].assessment, 'incomplete');
});

test('audit enumeration and file-count limits are separate and visible', async t => {
  const root = await fixture(t);
  await put(root, 'a.schema.json', '{}');
  await put(root, 'b.py', '# no consumer');
  const report = await auditOutputContracts(root, { limits: { ...SCAN_LIMITS, maxFiles: 1 } });
  assert.equal(report.complete, false);
  assert.equal(report.scope.roots[0].nodesEnumerated, 2);
  assert.equal(report.scope.roots[0].filesRead, 1);
  assert.ok(report.scope.roots[0].incompleteReasons.includes('file-count-limit'));
});

test('audit help succeeds without target; bad arguments/root are single JSON and exit 2', async () => {
  const help = await run(entry, ['--help']);
  assert.equal(help.code, 0);
  assert.equal(help.stderr, '');
  for (const args of [['/definitely/missing/root'], ['x', '--format', 'json', '--format', 'json'], ['x', '--dry-run']]) {
    const result = await jsonRun(entry, ...args);
    assert.equal(result.code, 2);
    assert.equal(result.report.complete, false);
    assert.equal(result.stderr, '');
  }
});
