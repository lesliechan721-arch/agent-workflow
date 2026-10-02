import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

import { check, nodeOracle, regularText } from './workflow-results.mjs';

const execute = promisify(execFile);
export const COVERAGE_CASES = new Set([
  'real-known-work-before-review', 'reuse-after-test-only-fix',
  'cumulative-not-last-delta', 'full-new-review-request', 'first-reuse-baseline-missing',
]);
const reviews = ['design-A.md', 'quality-A.md'].map((file) => `.dev-workflows/selection/reviews/${file}`);

export function coverageArtifacts(selected) {
  if (!COVERAGE_CASES.has(selected.id)) return [];
  return [...reviews, ...['A', 'B', 'C'].map((version) => `.dev-workflows/selection/versions/${version}/select.js`)];
}

export function coverageSemanticChecks(selected) {
  if (!COVERAGE_CASES.has(selected.id)) return [];
  return [{ name: 'coverage-history-and-budget', criterion:
    'Use actual Engine observations, snapshots, measurementStart, thread history and judgments. Setup actions are not measured repairs. Each reused axis must have an accessible original version, full scope, real independent judgment, addressed findings and independently checked cumulative applicability; no finding is not proof of coverage. Count the first measured modification batch against the same budget. Missing setup or source evidence is unknown. Explicit new full reassessment needs new clean judgments. Assigned axis reviewers work directly without repeating the parent review.' }];
}

export async function coverageProductChecks(selected, workspace) {
  if (!COVERAGE_CASES.has(selected.id)) return [];
  const checks = [];
  const mutable = selected.id === 'reuse-after-test-only-fix' ? ['test/resources.test.js']
    : selected.id === 'cumulative-not-last-delta' ? [] : ['src/select.js', 'test/select.test.js'];
  for (const [file, source] of Object.entries(selected.input.workspaceFiles)) {
    if (file === 'work.md' || file === 'src/select.js' && selected.id === 'cumulative-not-last-delta' || mutable.includes(file)) continue;
    try {
      checks.push(check(`source:${file}`, await regularText(workspace, file) === source ? 'pass' : 'fail', 'Compare actual source with the imported contract and scope.'));
    } catch (error) { checks.push(check(`source:${file}`, 'unknown', error.message)); }
  }
  if (selected.id === 'cumulative-not-last-delta') {
    checks.push(await nodeOracle(workspace, `
      import assert from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      const root='./.dev-workflows/selection/versions/';
      const {selectRecords:a}=await import(root+'A/select.js');
      const {selectRecords:b}=await import(root+'B/select.js');
      const {selectRecords:c}=await import(root+'C/select.js');
      const rows=[{id:'a',tenantId:'t1'},{id:'a',tenantId:'t2'}];
      assert.deepEqual(a(rows,'t1',['a']),[rows[0]]);
      assert.deepEqual(b(rows,'t1',['a']),rows);
      assert.deepEqual(c(rows,'t1',['a']),rows);
      assert.equal(readFileSync(root+'A/select.js','utf8'),${JSON.stringify(selected.input.workspaceFiles['src/select.js'])});
      assert.equal(readFileSync('src/select.js','utf8'),readFileSync(root+'C/select.js','utf8'));
    `, 'cumulative-probe'));
  } else {
    checks.push(await nodeOracle(workspace, `
      import assert from 'node:assert/strict';
      import {selectRecords} from './src/select.js';
      for(const [tenant,other,ids] of [['t1','t2',['a','b']],['org','foreign',['x','y']]]){
        const rows=Object.freeze([Object.freeze({id:ids[1],tenantId:tenant}),Object.freeze({id:ids[0],tenantId:tenant}),Object.freeze({id:ids[0],tenantId:other})]);
        const selected=Object.freeze([ids[0]]);
        assert.deepEqual(selectRecords(rows,tenant,selected),[rows[1]]);
        assert.deepEqual(selectRecords(rows,tenant,[]),[]);
        assert.deepEqual(selectRecords(rows,tenant,ids),rows.slice(0,2));
        assert.deepEqual(selected,[ids[0]]);
      }
    `, 'selection-contract'));
  }
  if (selected.id === 'reuse-after-test-only-fix') {
    try {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      await execute(process.execPath, ['--test'], { cwd: workspace, env, timeout: 15_000, maxBuffer: 1024 * 1024 });
      checks.push(await nodeOracle(workspace, "import assert from 'node:assert/strict';import {existsSync,readdirSync} from 'node:fs';if(existsSync('.scratch'))assert.deepEqual(readdirSync('.scratch'),[]);", 'test-resource-cleanup'));
    } catch (error) { checks.push(check('test-resource-cleanup', error.killed ? 'unknown' : 'fail', String(error.stderr || error.stdout || error.message).slice(0, 8_000))); }
  }
  return checks;
}
