import os from 'node:os';
import path from 'node:path';

export function parseTestWorkerCount(value, name = 'AW_TEST_WORKERS') {
  if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${name} must be a positive safe decimal integer; received ${JSON.stringify(value)}.`);
  }
  return Number(value);
}

export function resolveTestWorkers({ env = process.env, explicit, defaultWorkers = 2, serial = false } = {}) {
  const raw = env.AW_TEST_WORKERS;
  const configured = raw === undefined || raw === '' ? undefined : parseTestWorkerCount(raw);
  const requested = explicit === undefined ? undefined : parseTestWorkerCount(explicit, 'Explicit test workers');
  if (serial && requested !== undefined && requested > 1) {
    throw new Error(`This test entry requires 1 worker; received explicit workers ${requested}.`);
  }
  return {
    maxWorkers: serial ? 1 : requested ?? configured ?? defaultWorkers,
    source: serial ? 'serial constraint' : requested !== undefined ? 'explicit parameter' : configured !== undefined ? 'environment' : 'default',
  };
}

export function vitestWorkerOptions(options = {}) {
  return { maxWorkers: resolveTestWorkers(options).maxWorkers, minWorkers: 1 };
}

export function nodeTestWorkerOptions(options = {}) {
  const resolved = resolveTestWorkers({ ...options, defaultWorkers: null });
  return {
    ...resolved,
    // Node's isolated test runner defaults to availableParallelism() - 1, with a floor of 1.
    effectiveWorkers: resolved.maxWorkers ?? Math.max(1, os.availableParallelism() - 1),
  };
}

export function vitestWorkerInvocation(args, env = process.env) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const match = /^--(maxWorkers|max-workers|minWorkers|min-workers|config|project)(?:=(.*))?$/u.exec(args[index]);
    if (!match) continue;
    const value = match[2] ?? args[++index];
    const name = match[1].replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (name === 'maxWorkers' || name === 'minWorkers') {
      parseTestWorkerCount(value, `--${match[1]}`);
    }
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  const serial = (values.get('project') ?? []).includes('process-lifecycle') ||
    (values.get('config') ?? []).some((value) => /^vitest\.(dist|smoke|perf|process-lock-child|intent-round-trip-child)\.config\.[cm]?[jt]s$/u.test(path.basename(value))) ||
    args.some((arg) => ['--no-file-parallelism', '--fileParallelism=false', '--file-parallelism=false'].includes(arg));
  const explicit = values.get('maxWorkers')?.at(-1);
  const resolved = resolveTestWorkers({ env, explicit, serial });
  const minimum = values.get('minWorkers')?.at(-1);
  if (minimum !== undefined && Number(minimum) > resolved.maxWorkers) {
    throw new Error(`--minWorkers (${minimum}) cannot exceed effective maxWorkers (${resolved.maxWorkers}).`);
  }
  return { ...resolved, serial };
}

export function formatTestWorkers(runner, resolved) {
  return `AW_TEST_WORKERS ${JSON.stringify({ runner, maxWorkers: resolved.effectiveWorkers ?? resolved.maxWorkers, source: resolved.source })}\n`;
}
