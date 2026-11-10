// Read-only RPC subprocess. The caller's verified process-tree runner owns this
// process and its client, including abnormal exits and timeout cleanup.
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export async function readClientRpc({ platform, launcher, cwd }, env = process.env) {
  if (!['codex', 'pi'].includes(platform)) throw new Error('rpc-platform-unsupported');
  const args = platform === 'codex' ? ['app-server', '--stdio']
    : ['--mode', 'rpc', '--no-session', '--offline', '--no-mcp', '--no-context-files', '--approve'];
  const child = spawn(launcher.executable, [...launcher.prefix, ...args], { cwd, env,
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close').catch(() => []);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      let buffer = '';
      let bytes = 0;
      const responses = {};
      const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
      child.on('error', () => reject(new Error('rpc-spawn-failed')));
      child.on('close', () => reject(new Error('rpc-ended-before-response')));
      child.stdin.on('error', () => reject(new Error('rpc-input-failed')));
      child.stderr.on('data', (data) => {
        bytes += data.length;
        if (bytes > 2 * 1024 * 1024) reject(new Error('rpc-output-limit'));
      });
      child.stdout.on('data', (data) => {
        bytes += data.length;
        if (bytes > 2 * 1024 * 1024) { reject(new Error('rpc-output-limit')); return; }
        buffer += data.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (platform === 'codex') {
            if (message.id === 1) {
              if (message.error || !Object.hasOwn(message, 'result')) { reject(new Error('rpc-initialize-failed')); return; }
              send({ method: 'initialized', params: {} });
              send({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } });
            } else if (message.id === 2) {
              if (message.error || !Object.hasOwn(message, 'result')) reject(new Error('rpc-skills-failed'));
              else resolve(message.result);
            }
          } else if (message.type === 'response' && ['get_commands', 'get_state'].includes(message.command)) {
            if (!message.success) { reject(new Error('rpc-read-failed')); return; }
            responses[message.command] = message.data;
            if (responses.get_commands && responses.get_state) resolve({ commands: responses.get_commands, state: responses.get_state });
          }
        }
      });
      timer = setTimeout(() => reject(new Error('rpc-timeout')), 15_000);
      if (platform === 'codex') send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'aw_native_qualification', version: '1.0.0' }, capabilities: { experimentalApi: true },
      } });
      else {
        send({ id: 'commands', type: 'get_commands' });
        send({ id: 'state', type: 'get_state' });
      }
    });
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    const stop = setTimeout(() => child.kill('SIGKILL'), 500);
    child.kill('SIGTERM');
    await closed;
    clearTimeout(stop);
  }
}

if (process.argv[1]?.endsWith('native-platform-rpc.mjs')) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 16 * 1024) throw new Error('rpc-input-limit');
    }
    process.stdout.write(JSON.stringify(await readClientRpc(JSON.parse(input))) + '\n');
  } catch (error) {
    process.stderr.write(`${/^rpc-[a-z-]+$/u.test(error?.message) ? error.message : 'rpc-failed'}\n`);
    process.exitCode = 1;
  }
}
