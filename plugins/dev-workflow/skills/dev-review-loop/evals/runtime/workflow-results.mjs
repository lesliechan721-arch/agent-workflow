import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
export const check = (name, verdict, evidence) => ({ name, verdict, evidence });

export function caseChecks(selected) {
  const criteria = selected.expected?.criteria;
  if (!Array.isArray(criteria) || !criteria.length) throw new Error('Workflow case requires actual criteria.');
  return criteria.map((entry, index) => ({
    name: typeof entry?.id === 'string' ? entry.id : `criterion-${index + 1}`,
    criterion: typeof entry === 'string' ? entry : JSON.stringify(entry),
  }));
}

export function evaluationForCase(selected, options = {}) {
  const files = Object.keys(selected.input.workspaceFiles);
  const outputs = (selected.expected?.allowedWorkspaceChanges ?? []).filter((file) => !file.includes('*'));
  return {
    artifacts: [...new Set([...files, ...outputs, 'tickets/view.md', 'spec.md', 'work.md'])],
    checks: [...caseChecks(selected), {
      name: 'source-and-role-evidence',
      criterion: '实际读取的来源与输出、作者参与历史、任务关联、范围及发生顺序支持本例结论。仅命令参数提到路径、文件标题、模型自述或两个审查标题不足以通过。缺少真实前提、独立判断或读取证据时保留unknown。',
    }],
    interactions: options.interactions ?? [],
    ...(options.setupPrompt ? { setupPrompt: options.setupPrompt } : {}),
  };
}

export function semanticChecks(selected, evidence) {
  const required = [...caseChecks(selected).map((item) => item.name), 'source-and-role-evidence'];
  const actual = Array.isArray(evidence.evaluation?.checks) ? evidence.evaluation.checks : [];
  if (actual.some((item) => item.name === 'user-decisions')) required.push('user-decisions');
  return required.map((name) => {
    const matches = actual.filter((item) => item?.name === name);
    if (matches.length !== 1 || !['pass', 'fail', 'unknown'].includes(matches[0].verdict)
      || typeof matches[0].evidence !== 'string' || !matches[0].evidence.trim()) {
      return check(`semantic:${name}`, 'unknown', 'Engine-owned independent semantic evidence missing or malformed.');
    }
    return { ...matches[0], name: `semantic:${name}` };
  });
}

export async function regularText(workspace, relative, maxBytes = 512 * 1024) {
  if (!relative || relative.includes('\\') || relative.includes('\0') || path.posix.isAbsolute(relative)
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Expected a normalized workspace-relative file.');
  }
  let current = workspace;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('Artifact symlinks are not readable evidence.');
  }
  const info = await lstat(current);
  if (!info.isFile() || info.size > maxBytes) throw new Error('Artifact is not a bounded regular file.');
  return readFile(current, 'utf8');
}

export async function nodeOracle(workspace, source, name = 'product') {
  try {
    const result = await execute(process.execPath, ['--input-type=module', '-e', source], {
      cwd: workspace, timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    return check(name, 'pass', result.stdout.trim() || 'Independent Node assertions passed on actual product.');
  } catch (error) {
    return check(name, error.killed || error.code === 'ENOENT' ? 'unknown' : 'fail',
      String(error.stderr || error.message).slice(0, 8_000));
  }
}

export async function verifyExport(workspace, expected, shallowCopyRequired = false) {
  if (!['filtered', 'all', 'delegated'].includes(expected)) throw new Error('Unknown export oracle.');
  return nodeOracle(workspace, `
    import assert from 'node:assert/strict';
    import { chooseExportRows } from './src/export.js';
    let selected;
    for (const ids of [['a','b','c'],['z','y','x','w']]) {
      const allRows=Object.freeze(ids.map(id=>Object.freeze({id})));
      const filteredRows=Object.freeze(allRows.filter((_,i)=>i%2===1));
      const actual=chooseExportRows(allRows,filteredRows);
      const choices=${JSON.stringify(expected)}==='delegated'?['filtered','all']:[${JSON.stringify(expected)}];
      const choice=choices.find(kind=>JSON.stringify(actual)===JSON.stringify(kind==='all'?allRows:filteredRows));
      assert.ok(choice,'Export does not implement the delivered user answer.');
      ${shallowCopyRequired ? "assert.notEqual(actual,filteredRows);assert.ok(actual.every((row,index)=>row===filteredRows[index]));" : ''}
      if(selected) assert.equal(choice,selected,'Delegated selection must be consistent.');
      selected=choice;
      assert.deepEqual(allRows.map(row=>row.id),ids);
    }
    console.log(JSON.stringify({collection:selected,sets:2,inputPreserved:true}));
  `);
}

export async function verifyCurrentPage(workspace) {
  return nodeOracle(workspace, `
    import assert from 'node:assert/strict';
    import { exportCustomers } from './src/export.js';
    const results=[];
    for (const [ids,total] of [[['c1','c2'],5],[['x1','x2'],7]]) {
      const items=Object.freeze(ids.map(id=>Object.freeze({id})));
      const service=Object.freeze({capabilities:{maxRows:2,supportsPagination:false},async firstPage(){return {items,total};}});
      const result=await exportCustomers(service);
      assert.deepEqual(result.rows,items);assert.equal(typeof result.scopeLabel,'string');assert.ok(result.scopeLabel.trim());
      results.push({rows:result.rows,scopeLabel:result.scopeLabel,total});
    }
    console.log(JSON.stringify({results,labelMeaning:'Requires separate semantic evidence; nonempty text is not proof.'}));
  `);
}

export async function verifyNormalization(workspace, includeDisplay = true) {
  return nodeOracle(workspace, `
    import assert from 'node:assert/strict';
    import {normalize} from './src/normalize.js';
    ${includeDisplay ? "const {display}=await import('./src/display.js');" : ''}
    for (const [input,expected] of [['  Ada   Lovelace  ','Ada Lovelace'],['  Lin   Q  ','Lin Q'],['','']]) {
      assert.equal(normalize(input),expected);
      ${includeDisplay ? "assert.equal(display(input),'姓名：'+expected);" : ''}
    }
  `);
}

/** The optional browser owns a separate process/dependency boundary, not plugin installation. */
export async function verifyVisualPage(workspace, relative = 'public/index.html') {
  try {
    const script = fileURLToPath(new URL('./browser/browser-oracle.mjs', import.meta.url));
    const { stdout } = await execute(process.execPath, [script, workspace, relative], {
      cwd: workspace, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    if (result.name !== 'visual-product' || !['pass', 'fail', 'unknown'].includes(result.verdict)
      || typeof result.evidence !== 'string') throw new Error('Invalid browser result.');
    return result;
  } catch (error) {
    return check('visual-product', 'unknown', `Browser execution unavailable: ${error.message}`);
  }
}
