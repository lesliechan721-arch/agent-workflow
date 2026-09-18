import test from 'node:test';
import assert from 'node:assert/strict';
import {checkIndependentArrangement,combineRequiredChecks} from '../skills/dev-build/evals/role-evidence.mjs';

// Synthetic normalized records test helper logic only, not actual agent isolation.
function graph(roles=['design-reviewer','quality-reviewer']) {
  const threads=roles.map((agentRole,i)=>({threadId:'c'+i,parentThreadId:'root',agentRole}));
  return {rootThreadId:'root',threadGraph:[{threadId:'root',parentThreadId:null},...threads],
    collaborationCalls:threads.map((t,i)=>({ordinal:i+1,tool:'spawn_agent',threadId:'root',linkedThreadId:t.threadId,status:'completed',arguments:{fork_turns:'none'}})),
    skillLoads:[{threadId:'root',skill:'dev-review-code'},...threads.map(t=>({threadId:t.threadId,skill:'dev-review-code'}))]};
}
const options={scopeThreadIds:['root','c0','c1']};
const rootProof={axis:'design',sourceRef:'engine/root-message/3',judgmentOrdinal:3,firstOtherConclusionReadOrdinal:9};
test('two actual child-axis identities are a legal arrangement',()=>assert.equal(checkIndependentArrangement(graph(),options).verdict,'pass'));
test('independent root plus one child is also legal',()=>assert.equal(checkIndependentArrangement(graph(['quality-reviewer']),{scopeThreadIds:['root','c0'],rootIndependent:true,rootAxisProof:rootProof}).verdict,'pass'));
test('root with no actual judgment source is not treated as proven',()=>assert.equal(checkIndependentArrangement(graph(['quality-reviewer']),{scopeThreadIds:['root','c0'],rootIndependent:true,rootAxisProof:{axis:'design'}}).verdict,'unknown'));
test('author root cannot supply an independent axis',()=>assert.equal(checkIndependentArrangement(graph(['quality-reviewer']),{scopeThreadIds:['root','c0'],rootIndependent:false,rootAxisProof:rootProof}).verdict,'fail'));
test('root that saw the other conclusion first is not an independent second result',()=>assert.equal(checkIndependentArrangement(graph(['quality-reviewer']),{scopeThreadIds:['root','c0'],rootIndependent:true,rootAxisProof:{...rootProof,judgmentOrdinal:11}}).verdict,'fail'));
test('two roles collapsed to one identity fail',()=>{const e=graph();e.threadGraph[2].threadId='c0';assert.equal(checkIndependentArrangement(e,options).verdict,'fail');});
test('author history inherited by a child fails',()=>{const e=graph();e.collaborationCalls[0].arguments.fork_turns='all';assert.equal(checkIndependentArrangement(e,options).verdict,'fail');});
test('same-role nested review expansion fails',()=>{const e=graph();e.threadGraph.push({threadId:'g',parentThreadId:'c0',agentRole:'design-reviewer'});assert.equal(checkIndependentArrangement(e,options).verdict,'fail');});
test('a distinct evidence-investigation role does not repeat the review assignment',()=>{const e=graph();e.threadGraph.push({threadId:'g',parentThreadId:'c0',agentRole:'evidence-investigator'});assert.equal(checkIndependentArrangement(e,options).verdict,'pass');});
test('missing normalized evidence stays unknown',()=>assert.equal(checkIndependentArrangement({modelOutput:'two reviewers clean'},options).verdict,'unknown'));
test('all required checks must have actual results',()=>{const r=combineRequiredChecks(['arrangement','product','review'],[{name:'arrangement',verdict:'pass',evidence:'trace'}]);assert.equal(r.passed,false);assert.equal(r.details.complete,false);});
test('browser keywords are not a result check',()=>{const r=combineRequiredChecks(['visual'],[{tool:'exec_command',output:'playwright 1200 420',exitCode:0}]);assert.equal(r.passed,false);assert.equal(r.details.complete,false);});
test('known defects remain visible alongside missing evidence',()=>{const r=combineRequiredChecks(['visual','review'],[{name:'visual',verdict:'fail',evidence:'preview below settings'}]);assert.equal(r.passed,false);assert.equal(r.details.checks[0].verdict,'fail');assert.equal(r.details.complete,false);});
test('required independent checks all passing can complete',()=>{const r=combineRequiredChecks(['visual','review'],[{name:'visual',verdict:'pass',evidence:'grader browser output and immutable subject snapshot'},{name:'review',verdict:'pass',evidence:'actual independent review statements evaluated'}]);assert.equal(r.passed,true);});
