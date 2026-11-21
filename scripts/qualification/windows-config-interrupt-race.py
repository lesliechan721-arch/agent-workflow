"""Replay one public config apply interruption twice on a disposable Windows checkout."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / 'packages/cli/src/utils/plugin-scripts.ts'
TEST = ROOT / 'packages/cli/tests/integration/config-cross-plugin-command.test.ts'
BASE = 'c57e75368209d1ff54686fc297e4e885e78c0396'
CASE = 'reports interruption before standalone apply confirms effects and stops a preparing renderer'
PREFIX = 'AW_CONFIG_RACE_FACT '
ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')

# Both real renderers wait for explicitly owned files. Only consumer is released
# before interrupting. The fallback deadline bounds teardown on observation bugs.
RENDERER = '''      ...(options.delayProviderRender ? [
        `const gate=${JSON.stringify(renderGate)};`,
        "if(fs.existsSync(gate)){const marker=gate+'.'+name;fs.writeFileSync(marker+'.starting',String(process.pid));fs.renameSync(marker+'.starting',marker+'.started');const deadline=Date.now()+14000;while(!fs.existsSync(marker+'.release')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));if(!fs.existsSync(marker+'.release'))throw new Error('Controlled renderer gate expired.');fs.writeFileSync(marker+'.finished','finished');}",
      ] : []),
'''

PUBLIC_CASE = '''    type Role = 'provider' | 'consumer';
    const roles = ['provider', 'consumer'] as const;
    const begun = performance.now();
    const fact = (stage: string, value: object) => process.stderr.write('AW_CONFIG_RACE_FACT ' + JSON.stringify({
      stage, ms: Math.round(performance.now() - begun), ...value,
    }) + '\\n');
    const files = roles.flatMap(pluginName => (['user', 'project'] as const).map(scope =>
      resolvePluginConfigStorePath({ sourceId: 'team', pluginName, scope, cwd, env })));
    const configDigests = () => Promise.all(files.map(async file => {
      try { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }));
    const before = await configDigests();
    const helpers = new Map<Role, number>();
    const exits = new Map<number, { exit: boolean; close: boolean; code: number | null; killed: boolean }>();
    const processState = (pid: number) => {
      try { process.kill(pid, 0); return 'present'; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'missing' : 'unconfirmed'; }
    };
    const originalRun = defaultPluginProcessRunner.run;
    const observingRun = vi.spyOn(defaultPluginProcessRunner, 'run').mockImplementation((invocation, options) => {
      const entry = invocation.args[0];
      const owner = entry && path.basename(entry) === 'render.mjs' ? path.basename(path.dirname(entry)) : undefined;
      if (owner !== 'provider' && owner !== 'consumer') return originalRun(invocation, options);
      return originalRun(invocation, { ...options, onSpawn(child) {
        options.onSpawn?.(child);
        if (helpers.has(owner)) return;
        helpers.set(owner, child.pid);
        exits.set(child.pid, { exit: false, close: false, code: null, killed: false });
      } });
    });
    const emitProperty = Object.getOwnPropertyDescriptor(ChildProcess.prototype, 'emit');
    const emit = ChildProcess.prototype.emit;
    ChildProcess.prototype.emit = function (this: ChildProcess, event: string | symbol, ...values: unknown[]) {
      const observed = this.pid === undefined ? undefined : exits.get(this.pid);
      if (observed && (event === 'exit' || event === 'close')) {
        observed[event] = true;
        observed.code = typeof values[0] === 'number' && Number.isSafeInteger(values[0]) ? values[0] : null;
        observed.killed = values[1] === 'SIGKILL';
      }
      return Reflect.apply(emit, this, [event, ...values]);
    };
    let applying: ReturnType<typeof run> | undefined;
    let interrupted = false;
    try {
      await fs.outputFile(renderGate, '');
      applying = run(args);
      const renderers = new Map<Role, number>();
      await vi.waitFor(async () => {
        expect(helpers.size).toBe(2);
        for (const role of roles) {
          const pid = Number(await fs.readFile(`${renderGate}.${role}.started`, 'utf8'));
          expect(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid).toBe(true);
          renderers.set(role, pid);
        }
      }, { timeout: 8000 });
      const provider = renderers.get('provider')!;
      const consumer = renderers.get('consumer')!;
      const providerHelper = helpers.get('provider')!;
      const consumerHelper = helpers.get('consumer')!;
      const pids = [provider, consumer, providerHelper, consumerHelper];
      expect(new Set(pids).size).toBe(4);
      expect(pids.every(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid
        && processState(pid) === 'present')).toBe(true);

      // Holding this JS stack prevents Node from dispatching the actual exit or
      // close callbacks. All liveness reads use signal 0 against owned PIDs.
      const waited = new Int32Array(new SharedArrayBuffer(4));
      fs.writeFileSync(`${renderGate}.consumer.release`, 'complete');
      const deadline = performance.now() + 5000;
      while (processState(consumerHelper) === 'present' && performance.now() < deadline) Atomics.wait(waited, 0, 0, 4);
      const { exit, close } = exits.get(consumerHelper)!;
      const hit = processState(consumerHelper) === 'missing' && processState(consumer) === 'missing'
        && processState(providerHelper) === 'present' && processState(provider) === 'present'
        && fs.existsSync(`${renderGate}.consumer.finished`) && !fs.existsSync(`${renderGate}.provider.finished`)
        && !exit && !close;
      fact('window', { hit, provider, consumer, providerHelper, consumerHelper, exit, close });
      expect(hit).toBe(true);
      interrupted = true;
      process.emit('SIGINT', 'SIGINT');

      const stopped = await applying;
      const diagnostics = stopped.payload.diagnostics as Array<{ code: string }>;
      const { data, status, command } = stopped.payload;
      fact('receipt', { code: stopped.exitCode, failed: status === 'failed', commandMatches: command === 'plugin.config.apply',
        identity: data.plugin === 'consumer' && data.pluginId === 'team/consumer' && data.sourceId === 'team',
        context: data.context.context === 'project' && data.context.projectRoot === expected.data.context.projectRoot,
        noWrite: data.configWrite === 'notStarted', noConfirmation: data.confirmation === null, noApply: !Object.hasOwn(data, 'apply'),
        cleanUnconfirmed: diagnostics.some(item => item.code === 'processCleanupUnconfirmed'),
        interrupted: diagnostics.some(item => item.code === 'operationInterrupted') });
      const after = await configDigests();
      const unchanged = before.every((value, index) => value === after[index]);
      fact('config', { before, after, unchanged });
      const locked = await withAwHomeMutationLock({ env, signal: AbortSignal.timeout(3000), action: async () => true }).catch(() => false);
      await vi.waitFor(() => expect(pids.every(pid => processState(pid) === 'missing')
        && [providerHelper, consumerHelper].every(pid => exits.get(pid)?.close)).toBe(true), { timeout: 5000 });
      const providerStopped = !fs.existsSync(`${renderGate}.provider.finished`);
      const consumerFinished = fs.existsSync(`${renderGate}.consumer.finished`) && exits.get(consumerHelper)?.code === 0
        && exits.get(consumerHelper)?.killed === false;
      fact('cleanup', { locked, allExited: pids.every(pid => processState(pid) === 'missing'), providerStopped, consumerFinished });
      expect(unchanged).toBe(true);
      expect(locked).toBe(true);
      expect(providerStopped).toBe(true);
      expect(consumerFinished).toBe(true);
      expect(stopped).toMatchObject({ exitCode: 130, payload: {
        ...expected, data: { ...expected.data, pluginId: 'team/consumer', sourceId: 'team' },
      } });
      expect(stopped.payload.data).not.toHaveProperty('apply');
    } finally {
      if (applying && !interrupted) process.emit('SIGINT', 'SIGINT');
      try { await applying; } finally {
        observingRun.mockRestore();
        if (emitProperty) Object.defineProperty(ChildProcess.prototype, 'emit', emitProperty);
        else Reflect.deleteProperty(ChildProcess.prototype, 'emit');
        await fs.remove(renderGate);
      }
    }
'''


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError('Fixture source anchor is absent or ambiguous.')
    return source.replace(before, after, 1)


def test_overlay(original):
    source = original.decode('utf-8').replace('\r\n', '\n')
    source = replace_once(source, "import { execFileSync } from 'node:child_process';", """import { ChildProcess, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { defaultPluginProcessRunner } from '../../src/utils/plugin-scripts.js';""")
    gate_start = source.index("      ...(options.delayProviderRender && name === 'provider' ? [\n")
    gate_end = source.index('      ] : []),\n', gate_start) + len('      ] : []),\n')
    source = source[:gate_start] + RENDERER + source[gate_end:]
    target = source.index(f"  it('{CASE}', async () => {{\n")
    end = source.index('  }, 30_000);\n', target)
    body = source[target:end]
    start = body.index("    await fs.outputFile(renderGate, '');\n    const applying = run(args);\n")
    return (source[:target] + body[:start] + PUBLIC_CASE + source[end:]).encode('utf-8')


def git_bytes(file):
    return subprocess.run(['git', 'show', f'{BASE}:{file.relative_to(ROOT).as_posix()}'], cwd=ROOT,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout


def canonical(content):
    return content.replace(b'\r\n', b'\n')


FIELDS = {
    'window': {'hit', 'provider', 'consumer', 'providerHelper', 'consumerHelper', 'exit', 'close'},
    'receipt': {'code', 'failed', 'commandMatches', 'identity', 'context', 'noWrite', 'noConfirmation', 'noApply',
                'cleanUnconfirmed', 'interrupted'},
    'config': {'before', 'after', 'unchanged'},
    'cleanup': {'locked', 'allExited', 'providerStopped', 'consumerFinished'},
}


def read_facts(log):
    facts = {}
    for line in ANSI.sub('', log).splitlines():
        if PREFIX not in line:
            continue
        try:
            row = json.loads(line.split(PREFIX, 1)[1])
            stage = row.pop('stage')
            ms = row.pop('ms')
            if stage in facts or set(row) != FIELDS[stage] or type(ms) is not int or ms < 0:
                continue
            for key, value in row.items():
                if key in ('before', 'after'):
                    assert isinstance(value, list) and len(value) == 4 and all(
                        item is None or isinstance(item, str) and re.fullmatch(r'[0-9a-f]{64}', item) for item in value)
                elif key in ('code', 'provider', 'consumer', 'providerHelper', 'consumerHelper'):
                    assert type(value) is int and value >= 0
                else:
                    assert type(value) is bool
            facts[stage] = {'ms': ms, **row}
        except (AssertionError, KeyError, TypeError, ValueError, AttributeError):
            continue
    return facts


def confirmed(result, expect_fixed):
    facts = result['facts']
    if set(facts) != set(FIELDS):
        return False
    window, receipt, config, cleanup = (facts[name] for name in FIELDS)
    return (result['wrapperExit'] == (0 if expect_fixed else 1)
            and window['hit'] and not window['exit'] and not window['close']
            and len({window[key] for key in ('provider', 'consumer', 'providerHelper', 'consumerHelper')}) == 4
            and receipt['code'] == (130 if expect_fixed else 1)
            and all(receipt[key] for key in ('failed', 'commandMatches', 'identity', 'context', 'noWrite', 'noConfirmation', 'noApply'))
            and receipt['interrupted'] == expect_fixed and receipt['cleanUnconfirmed'] != expect_fixed
            and config['unchanged'] and config['before'] == config['after']
            and all(cleanup[key] for key in FIELDS['cleanup']))


def run_case(label, content, home):
    keys = {'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'OS', 'PROGRAMFILES',
            'PROGRAMFILES(X86)', 'PROGRAMW6432', 'CI', 'GITHUB_ACTIONS', 'AW_NATIVE_TOOL_CONTEXT'}
    env = {key: value for key, value in os.environ.items() if key.upper() in keys}
    if not any(key.upper() == 'AW_NATIVE_TOOL_CONTEXT' and value for key, value in env.items()):
        raise ValueError('Prepared Windows helper context is required.')
    for name in ('home', 'tmp', 'appdata', 'localappdata'):
        (home / name).mkdir(parents=True)
    env.update(HOME=str(home / 'home'), USERPROFILE=str(home / 'home'), TMP=str(home / 'tmp'),
               TEMP=str(home / 'tmp'), TMPDIR=str(home / 'tmp'), APPDATA=str(home / 'appdata'),
               LOCALAPPDATA=str(home / 'localappdata'), GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0', NO_COLOR='1')
    args = ['node', '../../scripts/test/run-vitest.mjs', 'run', '--project', 'integration', '--maxWorkers=1',
            'tests/integration/config-cross-plugin-command.test.ts', '-t', CASE]
    start = time.monotonic()
    try:
        proc = subprocess.run(args, cwd=ROOT / 'packages/cli', env=env, capture_output=True, encoding='utf-8',
                              errors='replace', timeout=100, check=False)
        result = {'label': label, 'wrapperExit': proc.returncode, 'facts': read_facts(proc.stdout + '\n' + proc.stderr)}
    except subprocess.TimeoutExpired:
        result = {'label': label, 'wrapperExit': None, 'facts': {}, 'wrapperTimedOut': True}
    result.update(sourceSha256=hashlib.sha256(content).hexdigest(), elapsedMs=round((time.monotonic()-start)*1000))
    result['confirmed'] = confirmed(result, expect_fixed=label == 'fixed')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', action='store_true', help='Check source anchors only. Do not modify the checkout.')
    parser.add_argument('--output', type=Path, default=Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir()))
                        / 'windows-config-interrupt-race.json')
    args = parser.parse_args()
    original_test = TEST.read_bytes()
    base_runner = git_bytes(RUNNER)
    fixed_runner = RUNNER.read_bytes()
    if canonical(original_test) != canonical(git_bytes(TEST)) or canonical(base_runner) == canonical(fixed_runner):
        raise ValueError('Expected frozen test and a distinct fixed runner.')
    overlay = test_overlay(original_test)
    if args.verify:
        print('Verified frozen public test, its temporary controls, and distinct runner sources.')
        return 0
    if sys.platform != 'win32':
        raise ValueError('A real Windows runner is required.')
    rows = []
    try:
        TEST.write_bytes(overlay)
        with tempfile.TemporaryDirectory(prefix='aw-config-interrupt-race-') as tmp:
            for label, content in (('baseline', base_runner), ('fixed', fixed_runner)):
                RUNNER.write_bytes(content)
                rows.append(run_case(label, content, Path(tmp) / label))
    finally:
        try:
            RUNNER.write_bytes(fixed_runner)
        finally:
            TEST.write_bytes(original_test)
    report = {'baselineCommit': BASE, 'testOverlaySha256': hashlib.sha256(overlay).hexdigest(), 'runs': rows,
              'passed': len(rows) == 2 and all(row['confirmed'] for row in rows)}
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError):
        print(json.dumps({'passed': False, 'error': 'setup-or-observation-failed'}))
        sys.exit(1)
