#!/usr/bin/env node
/** Structural assistant for AW Selected Cases v1.
 * Compatibility basis: the documented Selected Cases v1 field subset.
 * This is NOT the current public parser, a semantic Oracle judge, or a run receipt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const kinds = new Set(['trigger', 'conversation', 'custom-process', 'codex-workflow']);
const rec = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const txt = v => typeof v === 'string' && v.trim().length > 0;
const safe = v => txt(v) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(v);
const strings = v => Array.isArray(v) && v.every(txt) && new Set(v).size === v.length;
const relative = (p, tree=false) => {
  if (!txt(p)) return false;
  const q = tree && p.endsWith('/**') ? p.slice(0,-3) : p;
  return !!q && !/[\0\\*?\[\]]/u.test(q) && !q.startsWith('/') && !/^[A-Za-z]:/u.test(q) && !q.split('/').some(s=>!s || s==='.' || s==='..');
};
const within = (p, pattern) => pattern.endsWith('/**') ? p === pattern.slice(0,-3) || p.startsWith(pattern.slice(0,-2)) : p===pattern;
export function validateDocument(doc, strict=false) {
  const diagnostics=[];
  const issue=(code,message,id=null)=>diagnostics.push({level:'error',code,message,case_id:id});
  const need=(condition,code,message,id=null)=>{if(!condition)issue(code,message,id);return condition;};
  const keys=(v,allowed,label,id=null)=>{
    if(!need(rec(v),'type',`${label} must be an object`,id))return false;
    for(const k of Object.keys(v))if(!allowed.includes(k))issue('unknown-field',`${label}.${k} is unsupported`,id);
    return true;
  };
  if(!keys(doc,['version','suite','cases'],'document'))return diagnostics;
  need(doc.version===1,'version','version must be 1');
  if(!keys(doc.suite,['kind','unitUnderTest','participants','policy','runtime'],'suite'))return diagnostics;
  const s=doc.suite;
  need(kinds.has(s.kind),'kind','unsupported suite.kind');need(safe(s.unitUnderTest),'unit','unitUnderTest must be a safe identifier');
  if(s.participants!==undefined)need(strings(s.participants)&&s.participants.length>0&&s.participants.every(safe),'participants','participants must be unique safe identifiers');
  if(s.policy!==undefined || strict){
    if(keys(s.policy,['optimization','falseNegativeCost','falsePositiveCost','rationale'],'suite.policy')){
      for(const k of Object.keys(s.policy))need(txt(s.policy[k]),'policy',`policy.${k} must be non-empty`);
      if(strict)for(const k of ['optimization','falseNegativeCost','falsePositiveCost','rationale'])need(txt(s.policy[k]),'policy',`strict audit requires policy.${k}`);
    }
  }
  const runtime=s.runtime??{};
  const allowedRuntime=s.kind==='trigger'?['observeSpawnAgent','isolation','strictNegativeSplits','forbidMultipleSkillLoads','fixture','minimumPassRate']:s.kind==='conversation'?['isolation','pathPrepend','minimumPassRate']:['minimumPassRate'];
  if(keys(runtime,allowedRuntime,'suite.runtime')){
    if(runtime.isolation!==undefined)need(['standard','strict'].includes(runtime.isolation),'isolation','isolation invalid');
    for(const k of ['observeSpawnAgent','forbidMultipleSkillLoads'])if(runtime[k]!==undefined)need(typeof runtime[k]==='boolean','runtime',`${k} must be boolean`);
    if(runtime.minimumPassRate!==undefined)need(typeof runtime.minimumPassRate==='number'&&Number.isFinite(runtime.minimumPassRate)&&runtime.minimumPassRate>=0&&runtime.minimumPassRate<=1,'rate','minimumPassRate outside 0..1');
    if(runtime.strictNegativeSplits!==undefined)need(strings(runtime.strictNegativeSplits)&&runtime.strictNegativeSplits.every(x=>['train','validation','sanity'].includes(x)),'split','strictNegativeSplits invalid');
    if(runtime.fixture!==undefined)need(relative(runtime.fixture),'path','fixture path invalid');
    if(runtime.pathPrepend!==undefined)need(strings(runtime.pathPrepend)&&runtime.pathPrepend.every(x=>relative(x)),'path','runtime.pathPrepend invalid');
  }
  if(!need(Array.isArray(doc.cases)&&doc.cases.length>0,'cases','cases must be non-empty'))return diagnostics;
  const seen=new Set();
  for(let i=0;i<doc.cases.length;i++){
    const c=doc.cases[i];const id=rec(c)&&txt(c.id)?c.id:`#${i}`;
    const common=['id','split','tags','audit'];
    if(!keys(c,s.kind==='trigger'?[...common,'input']:s.kind==='conversation'?[...common,'prompt','assertions','input','expected']:[...common,'input','expected','assertions'],'case',id))continue;
    need(safe(c.id),'id','id invalid',id);need(!seen.has(c.id),'duplicate-id','case ID duplicated',id);seen.add(c.id);
    need(safe(c.split),'split','split invalid',id);need(strings(c.tags),'tags','tags must be a unique string array',id);
    const tags=Array.isArray(c.tags)?c.tags:[];
    if(c.audit!==undefined){
      if(keys(c.audit,['rationale','errorCost','allowedVariance','minimalCounterexample'],'audit',id)){
        for(const k of ['rationale','allowedVariance','minimalCounterexample'])if(c.audit[k]!==undefined)need(txt(c.audit[k]),'audit',`${k} must be non-empty`,id);
        if(c.audit.errorCost!==undefined)need(['high','medium','low'].includes(c.audit.errorCost),'audit','errorCost invalid',id);
      }
    }
    const required=[];
    if(tags.some(x=>['boundary','regression'].includes(x)))required.push('rationale','minimalCounterexample');
    if(tags.some(x=>['release-critical','high-cost'].includes(x)))required.push('errorCost');
    if(tags.includes('high-variance'))required.push('allowedVariance');
    for(const k of required)need(txt(c.audit?.[k]),'audit',`tag requires audit.${k}`,id);
    if(s.kind==='trigger'){
      need(/^[a-z0-9][a-z0-9_]*$/u.test(c.id??''),'trigger-id','provider requires lowercase snake_case ID',id);
      need(['train','validation','sanity'].includes(c.split),'trigger-split','trigger split must be train/validation/sanity',id);
      if(!keys(c.input,['query','expectedLoad','expected','shouldSpawnAgent','workspaceFixture','useProjectRules'],'input',id))continue;
      const x=c.input;need(txt(x.query),'query','input.query required',id);
      const hasBool=x.expectedLoad!==undefined,hasSet=x.expected!==undefined;
      need(Number(hasBool)+Number(hasSet)===1,'expectation','exactly one expectedLoad or expected.loadedSkills; firstLoaded is not supported by Selected Cases v1',id);
      if(hasBool)need(typeof x.expectedLoad==='boolean','expectation','expectedLoad boolean required',id);
      if(hasSet&&keys(x.expected,['loadedSkills'],'input.expected',id)){
        need(strings(x.expected.loadedSkills),'expectation','loadedSkills must be unique strings',id);
        const allowed=[s.unitUnderTest,...(s.participants??[])];
        for(const sk of x.expected.loadedSkills??[])need(allowed.includes(sk),'route','expected non-participant skill',id);
        if(runtime.forbidMultipleSkillLoads)need((x.expected.loadedSkills??[]).length<=1,'route','multiple expected despite forbidden flag',id);
      }
      if(runtime.observeSpawnAgent)need(typeof x.shouldSpawnAgent==='boolean','spawn','observed spawn requires boolean expectation',id);
      else need(x.shouldSpawnAgent===undefined,'spawn','spawn expectation requires observer',id);
      if(x.workspaceFixture!==undefined)need(relative(x.workspaceFixture)&&txt(runtime.fixture),'fixture','workspaceFixture requires suite runtime fixture module',id);
      if(x.useProjectRules!==undefined)need(typeof x.useProjectRules==='boolean','rules','useProjectRules boolean required',id);
    } else if(s.kind==='conversation'){
      need(txt(c.prompt),'prompt','prompt required',id);need(Array.isArray(c.assertions)&&c.assertions.length>0&&c.assertions.every(txt),'assertions','observable assertions required',id);
      const x=c.input??{},e=c.expected??{};
      if(keys(x,['scriptedReplies','workspaceFiles','pathPrepend'],'input',id)){
        if(x.workspaceFiles!==undefined&&need(rec(x.workspaceFiles),'fixture','workspaceFiles must be object',id))for(const [p,body] of Object.entries(x.workspaceFiles)){
          need(relative(p)&&!['.git','.agents','.codex'].includes(p.split('/')[0]),'fixture-path','fixture path invalid or targets provider control plane',id);need(typeof body==='string','fixture','fixture content must be string',id);
        }
        if(x.pathPrepend!==undefined)need(strings(x.pathPrepend)&&x.pathPrepend.every(p=>relative(p)),'path','pathPrepend invalid',id);
        if(x.scriptedReplies!==undefined&&need(Array.isArray(x.scriptedReplies),'replies','replies must be array',id))for(const r of x.scriptedReplies){
          if(typeof r==='string')continue;
          if(keys(r,['answersByIndex','expectedQuestionCount','unexpectedQuestionAnswer'],'reply',id)){
            need(Array.isArray(r.answersByIndex)&&r.answersByIndex.every(a=>typeof a==='string'),'reply','answersByIndex invalid',id);need(typeof r.unexpectedQuestionAnswer==='string','reply','fallback answer required',id);
            if(r.expectedQuestionCount!==undefined)need(Number.isInteger(r.expectedQuestionCount)&&r.expectedQuestionCount>=0,'reply','count invalid',id);
          }
        }
      }
      if(keys(e,['output','workspaceUnchanged','allowedWorkspaceChanges','artifacts'],'expected',id)){
        if(e.output!==undefined)need(txt(e.output),'output','expected.output non-empty',id);
        if(e.workspaceUnchanged!==undefined)need(typeof e.workspaceUnchanged==='boolean','write','workspaceUnchanged boolean required',id);
        const allowed=e.allowedWorkspaceChanges??[];
        need(strings(allowed)&&allowed.every(p=>relative(p,true)),'write','allowedWorkspaceChanges invalid',id);
        if(e.artifacts!==undefined&&need(Array.isArray(e.artifacts),'artifacts','artifacts must be array',id))for(const a of e.artifacts){
          if(!keys(a,['path','exists','contains','notContains','json'],'artifact',id))continue;
          need(relative(a.path),'path','artifact path invalid',id);
          if(a.exists!==undefined)need(typeof a.exists==='boolean','artifact','exists boolean required',id);
          for(const k of ['contains','notContains'])if(a[k]!==undefined)need(strings(a[k])&&a[k].length>0,'artifact',`${k} invalid`,id);
          if(a.json!==undefined)need(rec(a.json),'artifact','json assertion object required',id);
          if(e.workspaceUnchanged===false&&allowed.length>0)need(allowed.some(p=>within(a.path,p)),'artifact','artifact outside allowed write scope',id);
        }
        if(e.workspaceUnchanged===false){
          need(Array.isArray(e.allowedWorkspaceChanges),'write','writable case needs explicit allowed paths; [] permits no changes',id);
          if(allowed.length>0)need(Array.isArray(e.artifacts)&&e.artifacts.length>0,'write','provider write case needs actual artifact assertions',id);
        }
      }
    }
  }
  return diagnostics;
}
function args(argv){let input,format='text',strict=false,help=false;for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--help'||a==='-h')help=true;else if(a==='--strict')strict=true;else if(a==='--format')format=argv[++i];else if(a.startsWith('-'))throw new Error(`Unknown option ${a}`);else if(input)throw new Error('One case document only');else input=a;}if(!['text','json'].includes(format))throw new Error('format must be text/json');if(!help&&!input)throw new Error('Missing case file');return {input,format,strict,help};}
function main(){
 const o=args(process.argv.slice(2));
 if(o.help){console.log('Usage: validate-eval-cases.mjs <cases.json> [--strict] [--format text|json]\nStructural subset aligned to pinned Selected Cases v1. --strict additionally requires an explicit suite policy. Does not audit Oracle or run models.');return;}
 const st=fs.lstatSync(o.input);if(!st.isFile()||st.isSymbolicLink()||st.size>4*1024*1024)throw new Error('Input must be a regular file up to 4 MiB');
 const d=JSON.parse(fs.readFileSync(o.input,'utf8'));const diagnostics=validateDocument(d,o.strict);
 const result={valid:diagnostics.length===0,scope:'structural-assistant-not-official-parser',summary:{errors:diagnostics.length,cases:Array.isArray(d.cases)?d.cases.length:0},diagnostics};
 if(o.format==='json')console.log(JSON.stringify(result,null,2));else{for(const x of diagnostics)console.log(`[ERROR] ${x.code} (${x.case_id??'suite'}): ${x.message}`);console.log(result.valid?'Structural checks passed; Oracle and execution remain unverified.':'Structural checks failed.');}
 if(!result.valid)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{main();}catch(e){console.error(`[ERROR] ${e.message}`);process.exitCode=2;}}
