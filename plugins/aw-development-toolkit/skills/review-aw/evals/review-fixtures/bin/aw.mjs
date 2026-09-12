#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
let root=process.cwd();
while(!fs.existsSync(path.join(root,'fixture-control.json'))){const up=path.dirname(root);if(up===root)throw Error('Fixture control missing');root=up;}
const c=JSON.parse(fs.readFileSync(path.join(root,'fixture-control.json'),'utf8'));
const args=process.argv.slice(2), log=path.join(root,'_review-log');fs.mkdirSync(log,{recursive:true});
fs.appendFileSync(path.join(log,'commands.jsonl'),JSON.stringify({args,cwd:process.cwd(),testDouble:true})+'\n');
const resolve=p=>path.resolve(root,p);
const sh=b=>'sha256:'+crypto.createHash('sha256').update(b).digest('hex');
let options=null;
const val=flag=>options ? (options[flag]?.[0]??null) : (args.includes(flag)?args[args.indexOf(flag)+1]:null);
const source=resolve(c.sourceRoot), final=resolve(c.finalRoot);
const profile={platform:'codex',scope:'project',inputDigest:sh('{}')};
const digestDir=(dir)=>{let rows=[];function walk(d){for(const n of fs.readdirSync(d).sort()){const p=path.join(d,n);if(fs.statSync(p).isDirectory())walk(p);else rows.push(path.relative(dir,p)+'\0'+fs.readFileSync(p,'utf8'));}}walk(dir);return sh(rows.join('\0'));};
const current=()=>sh(fs.readFileSync(path.join(source,'SKILL.md'),'utf8')+fs.readFileSync(resolve(c.provider),'utf8'));
function result(state){let e=fs.existsSync(final);return {skill:'demo-skill',sourcePath:source,profile,finalPath:e?final:null,digest:e?digestDir(final):null,state,evidencePath:e?resolve(c.binding):null};}
function send(x,code=0){console.log(JSON.stringify(x));process.exitCode=code;}
const common={schemaVersion:2,command:'review:inspect',view:'review',ok:true,target:{kind:'skill',path:source},sources:[resolve(c.manifest),resolve(c.provider)],skills:[],issues:[]};
// Fixture-only selector validation: one Skill, Codex/project and default config.
// Reject unsupported choices rather than emulate unimplemented production profiles.
function selectionProblem(){
 if(args[0]!=='review'||!['inspect','prepare'].includes(args[1])||args.includes('--help'))return null;
 const inspect=args[1]==='inspect';
 const allowed=new Set(['--workspace-root','--skill','--platform','--scope','--config','--json',...(inspect?['--view','--materialization']:['--out'])]);
 const repeatable=new Set(['--skill','--materialization']);options={};
 const issue=(code,message,value=null)=>({code,path:value,message:'TEST DOUBLE: '+message});
 for(let i=3;i<args.length;i++){
  const flag=args[i];
  if(!allowed.has(flag))return issue('invalidArguments','Unknown option or extra positional argument');
  if(options[flag]&&!repeatable.has(flag))return issue('invalidArguments','Repeated single-value option');
  const value=flag==='--json'?'true':args[++i];
  if(value===undefined||value===''||value.startsWith('--'))return issue('invalidArguments','Missing option value');
  (options[flag]??=[]).push(value);
 }
 if(val('--view')&&!['review','release'].includes(val('--view')))return issue('invalidArguments','Unknown view');
 const requested=options['--skill']??[];
 if(requested.some(x=>x!=='demo-skill'))return issue('invalidArguments','Unknown or conflicting Skill selection');
 if(val('--workspace-root')&&path.resolve(process.cwd(),val('--workspace-root'))!==path.dirname(path.dirname(path.dirname(path.dirname(resolve(c.manifest))))))return issue('invalidArguments','Workspace does not own this target');
 if(!inspect&&(!val('--platform')||!val('--scope')||!val('--out')))return issue('invalidArguments','prepare needs explicit platform, scope and out');
 if((val('--platform')&&val('--platform')!=='codex')||(val('--scope')&&val('--scope')!=='project')||(c.unsupported&&(val('--platform')||val('--scope')||!inspect)))return issue('unsupportedProfile','Only the declared Codex/project fixture profile is available');
 if(val('--config')){
  const configPath=path.resolve(process.cwd(),val('--config'));
  try{
   const relative=path.relative(root,configPath);
   if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!fs.lstatSync(configPath).isFile()||fs.lstatSync(configPath).isSymbolicLink())throw Error('unsafe config');
   const real=path.relative(root,fs.realpathSync(configPath));
   if(real==='..'||real.startsWith('..'+path.sep)||path.isAbsolute(real))throw Error('unsafe config');
   const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
   if(config===null||Array.isArray(config)||typeof config!=='object'||Object.keys(config).some(k=>k!=='demo-plugin'))throw Error('unknown plugin');
   const fields=config['demo-plugin'];
   if(fields!==undefined&&(fields===null||Array.isArray(fields)||typeof fields!=='object'||Object.keys(fields).length))throw Error('unknown fields');
   // {} and {"demo-plugin":{}} are the same effective default for this fixture.
  }catch{return issue('invalidArguments','Missing, unsafe or unsupported config',val('--config'));}
 }
 for(const binding of options['--materialization']??[]){
  if(path.resolve(process.cwd(),binding)!==resolve(c.binding)||!fs.existsSync(resolve(c.binding)))return issue('sourceBindingInvalid','Unexpected or missing supplied binding',binding);
 }
 return null;
}
const selectorProblem=selectionProblem();
if(args.includes('--help'))send('TEST DOUBLE: review inspect <target> --view review|release --json; review prepare <target> --platform codex --scope project --out <dir> --json; self check');
else if(args[0]==='self'&&args[1]==='check')send({ok:true,missingCapabilities:[],fixture:true});
else if(args[0]==='review'&&['inspect','prepare'].includes(args[1]) && (!args[2] || ![source,path.join(source,'SKILL.md'),path.dirname(path.dirname(source)),resolve(c.manifest)].includes(path.resolve(process.cwd(),args[2])))){
 send({schemaVersion:args[1]==='inspect'?2:1,command:'review:'+args[1],ok:false,target:null,skills:[],issues:[{code:'fixtureTargetMismatch',path:args[2]??null,message:'TEST DOUBLE: target is outside the selected fixture'}]},2);
}else if(selectorProblem){
 send({...common,schemaVersion:args[1]==='prepare'?1:2,command:'review:'+args[1],ok:false,...(args[1]==='prepare'?{sourceBindingPath:null}:{}),skills:[],issues:[selectorProblem]},2);
}else if(args[0]==='review'&&args[1]==='inspect'){
 if(val('--view')==='release'){send({schemaVersion:2,command:'review:inspect',view:'release',ok:false,issues:[{code:'fixtureScope',message:'This fixture covers review navigation only'}]},2);}
 else {let state='missing',notSelected=false;if(fs.existsSync(final)){
  const b=JSON.parse(fs.readFileSync(resolve(c.binding),'utf8'));
  state=b.fixtureSourceDigest===current()?'ready':'stale';
  if(!fs.existsSync(path.join(final,'references/policy.md'))||b.fixtureFinalDigest!==digestDir(final))state='invalid';
  // Optional fixtureProfile lets tests separate self-valid binding from request matching.
  // These remain test fingerprints, not production configuration/currentness validation.
  const bound=b.fixtureProfile??profile;
  if(state==='ready'&&(bound.platform!==profile.platform||bound.scope!==profile.scope||bound.inputDigest!==profile.inputDigest)){state='missing';notSelected=true;}
 }if(c.unsupported)state='unsupported';
 common.skills=[notSelected?{...result('missing'),finalPath:null,digest:null,evidencePath:null}:result(state)];if(notSelected)common.issues.push({code:'materializationNotSelected',path:resolve(c.binding),message:'TEST DOUBLE: valid fixture binding does not match the requested default profile/config'});if(state!=='ready')common.issues.push({code:state==='missing'?'requiredFinalMissing':state==='stale'?'sourceBindingDrifted':state==='invalid'?'finalInvalid':'unsupportedProfile',path:source,message:'TEST DOUBLE: '+state});send(common);}
}else if(args[0]==='review'&&args[1]==='prepare'){
 const out=val('--out');if(!out||path.resolve(process.cwd(),out)!==resolve(c.outputRoot)||c.allowPrepare!==true||val('--platform')!=='codex'||val('--scope')!=='project'){send({schemaVersion:1,command:'review:prepare',ok:false,target:common.target,sourceBindingPath:null,skills:[],issues:[{code:'fixturePermission',path:out,message:'Preparation not allowed in this fixture'}]},2);}
 else if(c.failPrepare){send({schemaVersion:1,command:'review:prepare',ok:false,target:common.target,sourceBindingPath:null,skills:[],issues:[{code:'materializationFailed',path:source,message:'TEST DOUBLE: renderer failure'}]},1);}
 else if(fs.existsSync(resolve(c.outputRoot))){send({schemaVersion:1,command:'review:prepare',ok:false,target:common.target,sourceBindingPath:null,skills:[],issues:[{code:'unsafeOutput',path:out,message:'Existing output'}]},2);}
 else{
  fs.mkdirSync(path.join(final,'references'),{recursive:true});fs.copyFileSync(path.join(source,'SKILL.md'),path.join(final,'SKILL.md'));fs.copyFileSync(resolve(c.provider),path.join(final,'references/policy.md'));
  fs.writeFileSync(resolve(c.binding),JSON.stringify({testDouble:true,fixtureSourceDigest:current(),fixtureFinalDigest:digestDir(final)}));
  send({schemaVersion:1,command:'review:prepare',ok:true,target:common.target,sourceBindingPath:resolve(c.binding),skills:[result('ready')],issues:[]});
 }
}else if(args[0]==='skill'&&args[1]==='validate'){
 const dir=path.isAbsolute(args[2])?args[2]:path.resolve(process.cwd(),args[2]);const ok=fs.existsSync(path.join(dir,'SKILL.md'))&&fs.existsSync(path.join(dir,'references/policy.md'));send({ok,fixture:true,issues:ok?[]:[{code:'missingReference',path:dir}]},ok?0:1);
}else{send({ok:false,fixture:true,error:'Unlisted command'},64);}
