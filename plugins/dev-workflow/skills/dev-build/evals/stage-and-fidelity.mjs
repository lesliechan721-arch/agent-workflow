import { check, nodeOracle, regularText } from './workflow-results.mjs';

export const STAGE_CASES = new Set([
  'full-source-to-task-clean-worker', 'full-spec-reorganization-clean-reader',
  'user-answer-changes-downstream-result', 'user-answer-changes-downstream-result-page-json',
  'preimplementation-baseline-scoped-commit', 'no-commit-and-small-task-path',
  'new-evidence-realign-only-affected-work', 'review-fix-preserves-human-scope',
]);

export const STAGE_CHECKPOINT_CASES = new Set([
  'full-source-to-task-clean-worker', 'preimplementation-baseline-scoped-commit',
]);

export function stageSemanticChecks(selected) {
  if (selected.id !== 'full-spec-reorganization-clean-reader') return [];
  const probes = selected.input.setup.readingProbes;
  if (!Array.isArray(probes) || !probes.length) throw new Error('Reader case requires independent reading probes.');
  return [{
    name: 'reader-probes',
    criterion: `逐题核对真实独立读者的回答和引用。读者只能消费本次生成的规范及纳入附件，不能读取原文或继承作者历史；作者自述和人工示例不能替代读者。缺少真实线程、读取或回答证据时为unknown。以下参考答案仅供独立判定，不提供给被测者：${JSON.stringify(probes)}`,
  }];
}

async function verifyModelPolicy(workspace) {
  return nodeOracle(workspace, `
    import assert from 'node:assert/strict';
    import {chooseRoute,visibleModels} from './src/model-policy.js';
    import {applicationState} from './src/runtime-state.js';
    const filters=[{mode:'all'},{mode:'regex',pattern:'^m-'},{mode:'selected',models:['m-a','absent']}];
    for(const raw of filters){
      const filter=Object.freeze(raw.models?{...raw,models:Object.freeze([...raw.models])}:raw);
      const accepts=id=>filter.mode==='all'||(filter.mode==='regex'?new RegExp(filter.pattern).test(id):filter.models.includes(id));
      for(const id of ['chatgpt-web/a','m-a','m-b','M-a','other','absent']){
        for(const available of [false,true])assert.equal(chooseRoute(id,filter,available),id.startsWith('chatgpt-web/')?'local':available&&accepts(id)?'upstream':'deny');
      }
      const local=Object.freeze(['chatgpt-web/a']);
      const remote=Object.freeze(['m-a','m-b','M-a','other','m-a','chatgpt-web/foreign']);
      assert.deepEqual(visibleModels(local,remote,filter),['chatgpt-web/a',...['m-a','m-b','M-a','other'].filter(accepts)]);
      assert.deepEqual(visibleModels(local,Object.freeze([]),filter),['chatgpt-web/a']);
      if(filter.models)assert.deepEqual(filter.models,['m-a','absent']);
    }
    for(const saved of ['old','new'])for(const loaded of ['old','new'])for(const active of [0,2])for(const failed of [false,true]){
      assert.equal(applicationState(saved,loaded,active,failed),saved===loaded?'applied':'pending');
    }
  `, 'model-policy-and-runtime');
}

export async function verifyExportChoice(workspace, expected) {
  if (!['filtered-csv', 'page-json'].includes(expected)) throw new Error('Unknown stage export branch.');
  return nodeOracle(workspace, `
    import assert from 'node:assert/strict';
    import {exportRows} from './src/export.js';
    function csv(text){
      const rows=[];let row=[],cell='',quoted=false;
      for(let i=0;i<text.length;i++){
        const ch=text[i];
        if(ch==='"'){
          if(quoted&&text[i+1]==='"'){cell+='"';i++;}
          else if(quoted)quoted=false;
          else {assert.equal(cell,'');quoted=true;}
        }else if(!quoted&&ch===','){row.push(cell);cell='';}
        else if(!quoted&&(ch==='\\n'||ch==='\\r')){
          if(ch==='\\r'){assert.equal(text[++i],'\\n');}
          row.push(cell);rows.push(row);row=[];cell='';
        }else cell+=ch;
      }
      assert.equal(quoted,false);
      if(cell||row.length){row.push(cell);rows.push(row);}
      return rows;
    }
    for(const values of [[['a','Ada'],['b,2','Lin "Q"'],['c','line\\nbreak']],[['z',''],['y','Other']]]){
      const filteredRows=Object.freeze(values.map(([id,name])=>Object.freeze({id,name})));
      const pageRows=Object.freeze(filteredRows.slice(1));
      const result=await exportRows(Object.freeze({filteredRows,pageRows}));
      assert.equal(typeof result.content,'string');
      if(${JSON.stringify(expected)}==='filtered-csv'){
        assert.equal(result.format,'csv');assert.deepEqual(csv(result.content),[['id','name'],...values]);
      }else{
        assert.equal(result.format,'json');assert.deepEqual(JSON.parse(result.content),pageRows);
      }
      assert.deepEqual(filteredRows.map(({id,name})=>[id,name]),values);
    }
  `, 'export-choice');
}

async function verifyAsyncExport(workspace) {
  return nodeOracle(workspace, `
    import assert from 'node:assert/strict';
    import {exportRows} from './src/export.js';
    import {listTitle} from './src/list.js';
    for(const jobId of ['job-a','job-b']){
      let starts=0;
      const service=Object.freeze({
        async readSync(){throw new Error('Truncated synchronous export is not the accepted outcome.');},
        async startExport(){starts++;return {jobId};},
      });
      assert.deepEqual(await exportRows(service),{kind:'job',jobId});assert.equal(starts,1);
    }
    assert.equal(listTitle(),'客户记录');
  `, 'realigned-export-and-independent-list');
}

export async function stageProductChecks(selected, workspace, evidence) {
  const checks = [];
  for (const file of ['decisions.md', 'project-facts.md', 'source-request.md', 'api-facts.md', 'input/original.md', 'reader-questions.md']) {
    if (!(file in selected.input.workspaceFiles)) continue;
    try {
      const actual = await regularText(workspace, file);
      checks.push(check(`source:${file}`, actual === selected.input.workspaceFiles[file] ? 'pass' : 'fail', 'Compare the actual original source with the imported fixture.'));
    } catch (error) {
      checks.push(check(`source:${file}`, 'fail', error.message));
    }
  }
  if (STAGE_CHECKPOINT_CASES.has(selected.id)) checks.push(await verifyModelPolicy(workspace));
  else if (selected.id.startsWith('user-answer-changes-downstream-result')) {
    checks.push(await verifyExportChoice(workspace, selected.input.setup.branch.afterAnswerOracle));
  } else if (selected.id === 'new-evidence-realign-only-affected-work') {
    checks.push(await verifyAsyncExport(workspace));
  } else {
    const file = selected.id === 'no-commit-and-small-task-path' ? 'README.md' : 'spec.md';
    try {
      const text = await regularText(workspace, file);
      checks.push(check('actual-document', file === 'README.md'
        ? (text === '# 项目设置\n保留本段。\n' ? 'pass' : 'fail')
        : (text.trim() ? 'pass' : 'fail'), 'Only checks the requested document artifact; semantic quality needs independent Engine evidence.'));
    } catch (error) {
      checks.push(check('actual-document', 'fail', error.message));
    }
    if (selected.id !== 'full-spec-reorganization-clean-reader') {
      const diff = evidence.workspaceDiff;
      const changes = [...diff.added, ...diff.modified, ...diff.removed];
      const allowed = selected.expected.allowedWorkspaceChanges;
      checks.push(check('bounded-document-scope', changes.every((file) => allowed.includes(file)) ? 'pass' : 'fail', JSON.stringify({ changes, allowed })));
    }
  }
  return checks;
}

export async function stageCheckpointCheck(selected, workspace, baseline, git) {
  const commits = (await git(workspace, ['rev-list', '--reverse', `${baseline.head}..HEAD`])).split('\n').filter(Boolean);
  if (!commits.length) return check('preimplementation-baseline', 'fail', 'No actual model-created checkpoint.');
  const first = commits[0];
  const files = (await git(workspace, ['ls-tree', '-r', '--name-only', first])).split('\n');
  const productChanges = await git(workspace, ['diff', '--name-only', baseline.head, first, '--', 'src', 'public']);
  const hasTicket = ['tickets/model-policy.md', 'tickets/runtime-state.md'].some((file) => files.includes(file));
  const valid = files.includes('spec.md') && hasTicket && !productChanges;
  return check('preimplementation-baseline', valid ? 'pass' : 'fail', JSON.stringify({
    first, files, productChanges,
    limit: 'Git verifies saved contents; approval, first write order and task usability require the separate Engine checks.',
  }));
}
