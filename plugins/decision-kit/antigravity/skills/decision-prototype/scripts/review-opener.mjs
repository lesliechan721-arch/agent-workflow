import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import os from 'node:os';

const method = 'system-browser';
const defaultTimeoutMs = 5_000;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function result(status, reason) {
  return reason ? { status, method, reason } : { status, method };
}

function validatedReviewUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'http:'
    || !loopbackHosts.has(parsed.hostname.toLowerCase())
    || parsed.port === ''
    || Number(parsed.port) < 1
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/review/index.html'
    || parsed.search !== ''
  ) {
    return null;
  }
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  if (
    [...fragment.keys()].length !== 1
    || !/^[A-Za-z0-9_-]{43}$/.test(fragment.get('token') ?? '')
  ) {
    return null;
  }
  return parsed.href;
}

async function defaultPathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function openerFor(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    return {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    };
  }
  if (platform === 'linux') return { command: 'xdg-open', args: [url] };
  return null;
}

async function unavailableEnvironment({ platform, env, osRelease, pathExists }) {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return 'remote session';
  if (env.CI) return 'headless session';
  if (platform === 'linux') {
    if (
      env.WSL_DISTRO_NAME
      || env.WSL_INTEROP
      || /microsoft|wsl/i.test(osRelease)
    ) {
      return 'WSL session without a verified desktop bridge';
    }
    if (
      env.container
      || await pathExists('/.dockerenv')
      || await pathExists('/run/.containerenv')
    ) {
      return 'container session without a verified desktop bridge';
    }
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return 'headless session';
  }
  if (platform === 'win32' && env.SESSIONNAME?.toLowerCase() === 'services') {
    return 'headless session';
  }
  return null;
}

function runOpener(command, args, { spawnProcess, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    let stderr = '';
    const diagnostic = (message) => {
      const detail = stderr
        .replace(/token=[^\s"'<>]*/gi, 'token=[redacted]')
        .split(new URL(args.at(-1)).hash.slice('#token='.length)).join('[redacted]')
        .split(os.homedir()).join('~')
        .replace(/\s+/g, ' ').trim();
      return `${message}${detail ? ` ${detail}` : ''}`.slice(0, 500);
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stderr?.destroy();
      resolve(value);
    };

    try {
      child = spawnProcess(command, args, {
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch {
      finish(result('failed', 'The system browser opener could not start.'));
      return;
    }

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8_192) stderr += chunk.toString();
    });
    child.once('error', (error) => {
      if (error?.code === 'ENOENT') {
        finish(result('unavailable', 'The system browser opener is not available.'));
      } else {
        const code = ['EACCES', 'EPERM'].includes(error?.code) ? ` (${error.code})` : '';
        finish(result('failed', `The system browser opener could not start${code}.`));
      }
    });
    child.once('close', (code, signal) => {
      if (code === 0) finish(result('requested'));
      else finish(result('failed', diagnostic(
        `The system browser opener did not accept the request (${signal ? `signal ${signal}` : `exit ${code}`}).`,
      )));
    });
    timer = setTimeout(() => {
      // A desktop opener may remain attached to the user application.
      child.unref?.();
      finish(result('failed', 'The system browser opener did not finish in time.'));
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function requestBrowserOpen(url, options = {}) {
  const reviewUrl = validatedReviewUrl(url);
  if (!reviewUrl) {
    return result('failed', 'The Review URL is not a valid local Review session URL.');
  }

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const release = options.osRelease ?? os.release();
  const pathExists = options.pathExists ?? defaultPathExists;
  const unavailable = await unavailableEnvironment({
    platform,
    env,
    osRelease: release,
    pathExists,
  });
  if (unavailable) {
    return result('unavailable', `System browser opening is unavailable in this ${unavailable}.`);
  }

  const opener = openerFor(platform, reviewUrl);
  if (!opener) {
    return result('unavailable', 'System browser opening is unavailable on this platform.');
  }

  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, defaultTimeoutMs)
    : defaultTimeoutMs;
  return runOpener(opener.command, opener.args, {
    spawnProcess: options.spawnProcess ?? spawn,
    timeoutMs,
  });
}
