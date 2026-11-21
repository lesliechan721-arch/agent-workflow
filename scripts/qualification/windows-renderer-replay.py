"""One-shot Windows qualification for the renderer SIGINT case at c57e7536."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / 'packages/cli/src/utils/plugin-scripts.ts'
TEST = ROOT / 'packages/cli/tests/integration/config-cross-plugin-command.test.ts'
COMMIT = 'c57e75368209d1ff54686fc297e4e885e78c0396'
PREFIX = 'AW_RENDERER_REPLAY_FACT '
CASE = 'reports interruption before standalone apply confirms effects and stops a preparing renderer'

def replace(source, before, after):
    assert source.count(before) == 1, before[:80]
    return source.replace(before, after)

def instrument():
    original = RUNNER.read_text(encoding='utf-8')
    runner = replace(original, '      let stdout = \'\'; let stderr = \'\'; let timedOut', '''      const replayBegin = performance.now();
      const replay = (stage: string, detail: Record<string, string | number | boolean | null> = {}): void => {
        if (process.env.AW_RENDERER_REPLAY_ARMED !== '1' || !windowsJobInvocation) return;
        process.stderr.write('AW_RENDERER_REPLAY_FACT ' + JSON.stringify({
          stage, ms: Math.round(performance.now() - replayBegin), helper: child.pid ?? 0, ...detail,
        }) + '\\n');
      };
      if (process.env.AW_RENDERER_REPLAY_ARMED === '1' && windowsJobInvocation) {
        replay('spawn');
        child.once('exit', (code, signal) => replay('helperExit', { code, signal }));
        child.once('close', (code, signal) => replay('helperClose', { code, signal }));
      }
      let stdout = ''; let stderr = ''; let timedOut''')
    runner = replace(runner, '        const failure = new Error(cause instanceof Error ? cause.message', '''        replay('cleanupFailed', {
          acceptedFailure: cause instanceof Error && cause.message === 'Windows Job helper did not accept termination.',
          closeDeadline: cause instanceof Error && cause.message === 'Windows Job helper exit could not be confirmed.',
        });
        const failure = new Error(cause instanceof Error ? cause.message''')
    runner = replace(runner, '''            if (child.exitCode === null && child.signalCode === null && child.kill('SIGKILL') === false) {
              throw new Error('Windows Job helper did not accept termination.');
            }''', '''            replay('abortHelper', { aborted, timedOut, childExited, inputCompleted, code: child.exitCode, signal: child.signalCode });
            if (child.exitCode === null && child.signalCode === null) {
              let accepted: boolean;
              try { accepted = child.kill('SIGKILL'); }
              catch (error) {
                const errno = (error as NodeJS.ErrnoException)?.code;
                replay('helperKillThrew', { errno: ['EPERM','ESRCH','EACCES','EINVAL'].includes(errno ?? '') ? errno! : 'other' });
                throw error;
              }
              replay('helperKill', { accepted });
              if (!accepted) throw new Error('Windows Job helper did not accept termination.');
            }''')
    original_test = TEST.read_text(encoding='utf-8')
    test = replace(original_test, "fs.writeFileSync(gate+'.started','running');", "fs.writeFileSync(gate+'.started',String(process.pid));")
    test = replace(test, "    await fs.outputFile(renderGate, '');\n    const applying = run(args);", """    process.env.AW_RENDERER_REPLAY_ARMED = '1';
    const began = performance.now();
    const fact = (stage: string, data: object) => process.stderr.write('AW_RENDERER_REPLAY_FACT ' + JSON.stringify({ stage, ms: Math.round(performance.now()-began), ...data }) + '\\n');
    const state = () => Promise.all(['provider','consumer'].flatMap(pluginName => (['user','project'] as const).map(async scope => {
      const file = resolvePluginConfigStorePath({ sourceId:'team', pluginName, scope, cwd, env });
      return await fs.readFile(file,'base64').catch((error: NodeJS.ErrnoException) => { if(error.code==='ENOENT') return null; throw error; });
    })));
    const initial = await state();
    const exists = (pid: number) => {
      try { process.kill(pid, 0); return 'present'; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'missing' : 'unconfirmed'; }
    };
    await fs.outputFile(renderGate, '');
    const applying = run(args);""")
    test = replace(test, """      process.emit('SIGINT', 'SIGINT');
      const stopped = await applying;
      expect(stopped).toMatchObject({ exitCode: 130, payload: {""", """      const renderer = Number(await fs.readFile(renderGate+'.started','utf8'));
      if (!Number.isSafeInteger(renderer) || renderer < 1) throw new Error('Invalid fixture PID');
      fact('sendInterrupt',{renderer, alive:exists(renderer), finished:await fs.pathExists(renderGate+'.finished')});
      process.emit('SIGINT', 'SIGINT');
      const stopped = await applying;
      const diagnostics = stopped.payload.diagnostics as Array<{code:string}>;
      fact('receipt',{renderer, alive:exists(renderer), finished:await fs.pathExists(renderGate+'.finished'), code:stopped.exitCode,
        cleanUnconfirmed:diagnostics.some(x=>x.code==='processCleanupUnconfirmed'), interrupted:diagnostics.some(x=>x.code==='operationInterrupted'),
        unchanged:JSON.stringify(initial)===JSON.stringify(await state()), noConfigWrite:stopped.payload.data?.configWrite==='notStarted'});
      const free = await withAwHomeMutationLock({env,signal:AbortSignal.timeout(3000),action:async()=>true}).catch(()=>false);
      fact('lock',{free});
      expect(stopped).toMatchObject({ exitCode: 130, payload: {""")
    test = replace(test, """      await fs.remove(renderGate);
      await applying;""", """      delete process.env.AW_RENDERER_REPLAY_ARMED;
      await fs.remove(renderGate);
      await applying;""")
    return [(RUNNER,runner),(TEST,test)]

FIELDS = {'stage','ms','helper','renderer','code','signal','accepted','acceptedFailure','closeDeadline','aborted','timedOut','childExited','inputCompleted','errno','alive','finished','cleanUnconfirmed','interrupted','unchanged','noConfigWrite','free'}
WORDS = {'spawn','helperExit','helperClose','helperKill','abortHelper','helperKillThrew','cleanupFailed','sendInterrupt','receipt','lock','present','missing','unconfirmed','SIGKILL','SIGTERM','SIGINT','EPERM','ESRCH','EACCES','EINVAL','other'}

def run_test(index, traced, child_env):
    args = ['node','../../scripts/test/run-vitest.mjs','run','--project','integration','tests/integration/config-cross-plugin-command.test.ts','--reporter=verbose','-t',CASE]
    started=time.monotonic()
    result=subprocess.run(args,cwd=ROOT/'packages/cli',env=child_env,capture_output=True,encoding='utf-8',errors='replace',timeout=120,check=False)
    text=re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',result.stdout+'\n'+result.stderr)
    facts=[]
    for line in text.splitlines():
        if PREFIX not in line: continue
        try: fact=json.loads(line.split(PREFIX,1)[1].strip())
        except ValueError: continue
        if not isinstance(fact,dict) or set(fact)-FIELDS:continue
        if any(isinstance(v,str) and v not in WORDS for v in fact.values()):continue
        if all(v is None or isinstance(v,(int,bool,str)) for v in fact.values()):facts.append(fact)
    row={'iteration':index,'traced':traced,'exitCode':result.returncode,'elapsedMs':round((time.monotonic()-started)*1000),
         'caseRan':bool(re.search(r'\d+ (?:passed|failed) \| 22 skipped',text)) or CASE in text,
         'reportedCleanupUnconfirmed':'processCleanupUnconfirmed' in text,'facts':facts[:64]}
    if not row['caseRan']:row['runnerError']=True
    print(json.dumps(row,separators=(',',':')),flush=True)
    return row

def main():
    updates=instrument()
    if '--verify' in sys.argv:
        print('Verified two exact diagnostic overlays');return
    assert sys.platform=='win32'
    # Compare those sources with the exact PR commit before adding diagnostic events.
    for p,_ in updates:
        original=subprocess.check_output(['git','show',COMMIT+':'+p.relative_to(ROOT).as_posix()],cwd=ROOT)
        assert original.replace(b'\r\n',b'\n')==p.read_bytes().replace(b'\r\n',b'\n')
    keys={'PATH','PATHEXT','SYSTEMROOT','COMSPEC','WINDIR','TEMP','TMP','HOMEDRIVE','HOMEPATH','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS',
          'PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','SYSTEMDRIVE','CI','GITHUB_ACTIONS','RUNNER_TEMP','AW_NATIVE_TOOL_CONTEXT','AW_TEST_WORKERS','AW_TEST_SHARD_PLATFORM','APPDATA','LOCALAPPDATA','USERPROFILE','USERNAME'}
    env={k:v for k,v in os.environ.items() if k.upper() in keys};env.update(GIT_CONFIG_NOSYSTEM='1',GIT_TERMINAL_PROMPT='0',NO_COLOR='1')
    filename=Path(os.environ['RUNNER_TEMP'])/'windows-renderer-interruption.json'
    rows=[]
    for index in range(1,17):
        if index==4:
            for p,new in updates:p.write_text(new,encoding='utf-8')
        try:row=run_test(index,index>=4,env)
        except subprocess.TimeoutExpired:row={'iteration':index,'traced':index>=4,'runnerTimeout':True}
        rows.append(row);filename.write_text(json.dumps({'sourceCandidate':COMMIT,'runs':rows},indent=2)+'\n',encoding='utf-8')
        if row.get('runnerError') or row.get('runnerTimeout'):break
        if index>=8 and any(r.get('exitCode')==1 and any(f.get('cleanUnconfirmed') for f in r['facts']) for r in rows if r.get('traced')):break
    if not rows or any(r.get('runnerError') or r.get('runnerTimeout') or r.get('exitCode')!=0 for r in rows):raise SystemExit(1)
if __name__=='__main__':main()
