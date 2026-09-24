import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const evalRoot = fileURLToPath(new URL('../skills/browser-use/evals/', import.meta.url));
const cases = ['behavior-cases.json','visual-cases.json'].flatMap(file => {
  const suite = JSON.parse(readFileSync(path.join(evalRoot,file)));
  return suite.cases.map(candidate => ({ ...candidate, pathPrepend: suite.suite.runtime.pathPrepend }));
});
function fixture(id, fn) {
  const candidate=cases.find(item=>item.id===id); assert.ok(candidate,id);
  const root=mkdtempSync(path.join(os.tmpdir(),'bu-eval-'));
  try {
    for(const [name,text] of Object.entries(candidate.input.workspaceFiles)) {
      const file=path.join(root,name);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,text);
    }
    const bins = candidate.pathPrepend.map(relative => {
      const destination = path.join(root,relative);
      cpSync(path.join(evalRoot,relative),destination,{recursive:true});
      chmodSync(path.join(destination,'agent-browser'),0o700);
      return destination;
    });
    const env={PATH:[...bins,process.env.PATH].join(path.delimiter),HOME:root,AGENT_BROWSER_SESSION:'web',AGENT_BROWSER_HEADED:'false'};
    const run=(args,status=0,input)=>{
      const r=spawnSync('agent-browser',['--json',...args],{cwd:root,env,encoding:'utf8',timeout:5000,input});
      assert.equal(r.status,status,r.stderr||r.stdout);
      return JSON.parse(r.stdout);
    };
    fn({root,run,state:()=>JSON.parse(readFileSync(path.join(root,'.browser-use-fixture/state.json')))});
  } finally {rmSync(root,{recursive:true,force:true});}
}
const open=(f,url,extra=[])=>f.run(['open',url,...extra]);
test('PATH fixture returns native-shaped help and inactive session info without opening',()=>fixture('webkit_unavailable_is_not_chromium',f=>{
  assert.match(f.run(['--help']).data.scope,/WebKit/);
  assert.equal(f.run(['session','info']).data.active,false);
  assert.equal(f.state().active,false);
}));
test('headed preview keeps its named session; unnamed startup is rejected',()=>fixture('preview_local_keeps_window',f=>{
  f.run(['--session','default','open','http://localhost:3000'],1);
  assert.equal(f.state().active,false);
  open(f,'http://localhost:3000',['--headed']);
  assert.equal(f.run(['get','url']).data.url,'http://localhost:3000');
  assert.equal(f.state().headed,true);assert.equal(f.state().active,true);
}));
test('dynamic content is read after a matching wait, not an arbitrary condition',()=>fixture('read_rendered_account',f=>{
  open(f,'https://app.example.test/account');assert.match(f.run(['read']).data.content,/Loading/);
  f.run(['wait','--text','Not present'],1);assert.equal(f.state().rendered,false);
  f.run(['wait','--text','Monthly quota']);assert.match(f.run(['get','text','main']).data.text,/150.*8/);
}));
test('fill values can be verified without any submission',()=>fixture('fill_without_submitting',f=>{
  open(f,'https://forms.example.test');assert.equal(f.run(['snapshot','-i']).data.refs.e1.name,'Name');
  f.run(['fill','@e1','Lin']);f.run(['fill','#email','lin@example.test']);
  assert.equal(f.run(['get','value','@e2']).data.value,'lin@example.test');assert.equal(f.state().submissions,0);
}));
test('native batch stdin preserves option-like text and stops after a failed action',()=>fixture('fill_without_submitting',f=>{
  open(f,'https://forms.example.test');
  const r=f.run(['batch','--bail'],1,JSON.stringify([['fill','@e1','--headed'],['destroy'],['click','@e3']]));
  assert.equal(r.length,2);assert.equal(r[0].success,true);assert.equal(r[1].success,false);
  assert.equal(f.run(['get','value','@e1']).data.value,'--headed');assert.equal(f.state().submissions,0);
}));
test('search results require the actual modeled interaction',()=>fixture('search_documentation',f=>{
  open(f,'https://docs.example.test');assert.doesNotMatch(f.run(['read']).data.content,/Pool Guide/);
  f.run(['fill','@e1','connection pooling']);f.run(['click','@e2']);
  assert.match(f.run(['get','text','main']).data.text,/Connection Pool Guide/);assert.equal(f.state().submissions,1);
}));
test('native tab IDs retain distinct page contents',()=>fixture('browse_two_tabs',f=>{
  open(f,'https://docs.example.test/plan');assert.equal(f.run(['tab','new','https://docs.example.test/limits']).data.tabId,'t2');
  assert.match(f.run(['read']).data.content,/20 projects/);f.run(['tab','t1']);assert.match(f.run(['read']).data.content,/Team/);
  assert.equal(f.run(['tab','list']).data.tabs.length,2);
}));
test('stale failure has no side effect and a new observation permits recovery',()=>fixture('stale_reference_reobserve',f=>{
  open(f,'https://app.example.test/');assert.ok(f.run(['snapshot','-i']).data.refs.e7);
  assert.match(f.run(['click','@e7'],1).error,/stale/);assert.equal(f.state().submissions,0);
  assert.ok(f.run(['snapshot','-i']).data.refs.e8);f.run(['click','@e8']);assert.equal(f.state().submissions,1);
}));
test('lost response follows a real fixture side effect and duplicate attempts remain observable',()=>fixture('uncertain_submit_not_repeated',f=>{
  open(f,'https://app.example.test/');assert.match(f.run(['click','@e3'],1).error,/Timed out/);
  assert.match(f.run(['read']).data.content,/ORDER-1042/);assert.equal(f.state().submissions,1);
  f.run(['click','@e3'],1);assert.equal(f.state().submissions,2);assert.equal(f.state().attempts,2);
}));
test('ambiguous targets remain distinguishable instead of being resolved by the fixture',()=>fixture('ambiguous_delete_stops',f=>{
  open(f,'https://app.example.test/');const data=f.run(['snapshot','-i']).data;
  assert.equal(Object.values(data.refs).filter(node=>node.name==='Delete').length,2);assert.match(data.snapshot,/First draft.*\nSecond draft/);
}));
test('page instructions are returned as data without local side effects',()=>fixture('page_instructions_are_data',f=>{
  open(f,'https://app.example.test/');assert.match(f.run(['read']).data.content,/ADMIN MESSAGE/);assert.equal(f.state().submissions,0);
}));
test('captured network details use native request IDs and body shape',()=>fixture('diagnose_one_failed_request',f=>{
  open(f,'https://app.example.test/');assert.equal(f.run(['network','requests']).data.requests.length,0);
  f.run(['click','@e3']);assert.equal(f.run(['network','requests']).data.requests[0].status,500);
  assert.equal(JSON.parse(f.run(['network','request','req_1']).data.responseBody).code,'SEARCH_UNAVAILABLE');
}));
test('empty native logs do not invent coverage metadata',()=>fixture('empty_logs_do_not_prove_healthy',f=>{
  open(f,'https://app.example.test/');assert.deepEqual(f.run(['errors']).data,{errors:[]});
}));
for(const id of ['visual_covered','visual_clear']) test(id+' writes the actual PNG to the native screenshot path',()=>fixture(id,f=>{
  open(f,'https://app.example.test/');const r=f.run(['screenshot','.browser-use/artifacts/visual/page.png']);
  assert.deepEqual([...readFileSync(r.data.path).subarray(0,8)],[137,80,78,71,13,10,26,10]);
  assert.equal(f.state().submissions,0);
}));
test('unmodeled commands fail instead of inventing an upstream result',()=>fixture('preview_local_keeps_window',f=>{
  open(f,'http://localhost:3000');for(const command of [['eval','document.title'],['reload'],['caps'],['inspect']])
    assert.equal(f.run(command,1).success,false);
}));
