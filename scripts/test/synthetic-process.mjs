import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SYNTHETIC_PROCESS_TTL_MS = 30_000;

export function startSyntheticProcessWatchdog(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_SYNTHETIC_PROCESS_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('Synthetic process TTL must be a positive integer.');
  }
  return setTimeout(() => process.exit(124), ttlMs);
}

function readOptions(args) {
  const options = {
    ttlMs: DEFAULT_SYNTHETIC_PROCESS_TTL_MS,
    ignoreSignals: [],
    pidFile: undefined,
    stdout: undefined,
    stdoutEnv: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--ttl-ms') {
      options.ttlMs = Number(args[index + 1]);
      index += 1;
    } else if (argument === '--ignore-sigterm') {
      options.ignoreSignals.push('SIGTERM');
    } else if (argument === '--ignore-sigint') {
      options.ignoreSignals.push('SIGINT');
    } else if (argument === '--pid-file') {
      options.pidFile = args[index + 1];
      index += 1;
    } else if (argument === '--stdout') {
      options.stdout = args[index + 1] ?? '';
      index += 1;
    } else if (argument === '--stdout-env') {
      options.stdoutEnv = args[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown synthetic process option: ${argument}`);
    }
  }
  return options;
}

export function runSyntheticProcess(args = process.argv.slice(2)) {
  const options = readOptions(args);
  for (const signal of options.ignoreSignals) {
    process.on(signal, () => {});
  }
  if (options.pidFile) {
    fs.mkdirSync(path.dirname(options.pidFile), { recursive: true });
    fs.writeFileSync(options.pidFile, `${process.pid}\n`);
  }
  if (options.stdout !== undefined) {
    process.stdout.write(options.stdout);
  }
  if (options.stdoutEnv) {
    process.stdout.write(process.env[options.stdoutEnv] ?? '');
  }
  startSyntheticProcessWatchdog({ ttlMs: options.ttlMs });
  setInterval(() => {}, 1_000);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    runSyntheticProcess();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
