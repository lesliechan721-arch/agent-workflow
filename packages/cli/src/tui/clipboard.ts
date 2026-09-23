import { spawn } from 'node:child_process';

const COPY_TIMEOUT_MS = 5_000;
const COPY_FAILURE_MESSAGE = '无法复制到系统剪贴板。请检查剪贴板工具和桌面会话。';

interface ClipboardInvocation {
  command: string;
  args: string[];
  stdin: string;
  env: NodeJS.ProcessEnv;
}

interface ClipboardDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runner?: (invocation: ClipboardInvocation) => Promise<void>;
}

function runClipboardCommand(invocation: ClipboardInvocation): Promise<void> {
  return new Promise((resolve, reject) => {
    // Linux tools keep a background selection owner after the command exits.
    // Generic process-tree cleanup would discard the copied content.
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    let settled = false;
    let inputComplete = false;
    let exited = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.destroy();
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* The command can already be closed. */ }
      }
      reject(error);
    };
    const complete = (): void => {
      if (settled || !inputComplete || !exited) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => fail(new Error(COPY_FAILURE_MESSAGE)), COPY_TIMEOUT_MS);
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal !== null) {
        fail(new Error(COPY_FAILURE_MESSAGE));
        return;
      }
      exited = true;
      complete();
    });
    child.stdin!.once('error', fail);
    child.stdin!.once('finish', () => {
      inputComplete = true;
      complete();
    });
    child.stdin!.end(invocation.stdin, 'utf8');
  });
}

export async function copyToClipboard(
  text: string,
  dependencies: ClipboardDependencies = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const runner = dependencies.runner ?? runClipboardCommand;
  const candidates: Array<Pick<ClipboardInvocation, 'command' | 'args'>> = [];
  if (platform === 'darwin') {
    candidates.push({ command: 'pbcopy', args: [] });
  } else if (platform === 'win32') {
    candidates.push({
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
    });
  } else if (platform === 'linux') {
    if (env.WAYLAND_DISPLAY) {
      candidates.push({ command: 'wl-copy', args: ['--type', 'text/plain;charset=utf-8'] });
    }
    if (env.DISPLAY) {
      candidates.push(
        { command: 'xclip', args: ['-selection', 'clipboard', '-in'] },
        { command: 'xsel', args: ['--clipboard', '--input'] },
      );
    }
  }
  for (const candidate of candidates) {
    try {
      await runner({
        ...candidate,
        stdin: text,
        env: platform === 'darwin' ? { ...env, LC_ALL: 'en_US.UTF-8' } : env,
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') break;
    }
  }
  throw new Error(COPY_FAILURE_MESSAGE);
}
