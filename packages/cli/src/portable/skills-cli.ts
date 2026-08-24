import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MIN_VERSION = [1, 5, 23] as const;
const MAX_VERSION = [2, 0, 0] as const;

export type SkillsCliErrorCode =
  | 'portableSkillsCliMissing'
  | 'portableSkillsCliIncompatible'
  | 'portableSkillsCliInstallFailed'
  | 'portableSkillsCliVerificationFailed';

export class SkillsCliError extends Error {
  constructor(
    readonly code: SkillsCliErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'SkillsCliError';
  }
}

export interface InstalledSkillRecord {
  name: string;
  path?: string;
  scope?: string;
  agents: string[];
  source?: string | null;
  sourceUrl?: string | null;
  sourceType?: string | null;
}

export interface SkillsCliInvocationOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function invokeSkills(
  args: string[],
  options: SkillsCliInvocationOptions,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('skills', args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (failure.code === 'ENOENT') {
      throw new SkillsCliError('portableSkillsCliMissing', 'PATH 中没有 skills 可执行文件。');
    }
    throw failure;
  }
}

export async function probeSkillsCli(
  options: SkillsCliInvocationOptions,
): Promise<{ version: string }> {
  let output: string;
  try {
    const result = await invokeSkills(['--version'], options);
    output = result.stdout.trim();
  } catch (error) {
    if (error instanceof SkillsCliError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new SkillsCliError('portableSkillsCliIncompatible', '无法读取 skills 版本。');
  }
  const match = output.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u);
  if (!match) {
    throw new SkillsCliError('portableSkillsCliIncompatible', 'skills --version 没有返回有效 semver。');
  }
  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (compareVersion(version, MIN_VERSION) < 0 || compareVersion(version, MAX_VERSION) >= 0) {
    throw new SkillsCliError(
      'portableSkillsCliIncompatible',
      `skills ${version.join('.')} 不在支持范围 >=1.5.23 <2.0.0。`,
    );
  }
  return { version: version.join('.') };
}

function parseInstalledSkills(value: unknown): InstalledSkillRecord[] {
  if (!Array.isArray(value)) {
    throw new SkillsCliError('portableSkillsCliVerificationFailed', 'skills list --json 必须返回数组。');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new SkillsCliError('portableSkillsCliVerificationFailed', 'skills list --json 含无效条目。');
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || !Array.isArray(record.agents)
      || record.agents.some((agent) => typeof agent !== 'string')) {
      throw new SkillsCliError('portableSkillsCliVerificationFailed', 'skills list --json 条目缺少 name 或 agents。');
    }
    return {
      name: record.name,
      ...(typeof record.path === 'string' ? { path: record.path } : {}),
      ...(typeof record.scope === 'string' ? { scope: record.scope } : {}),
      agents: record.agents as string[],
      ...(typeof record.source === 'string' || record.source === null ? { source: record.source } : {}),
      ...(typeof record.sourceUrl === 'string' || record.sourceUrl === null ? { sourceUrl: record.sourceUrl } : {}),
      ...(typeof record.sourceType === 'string' || record.sourceType === null ? { sourceType: record.sourceType } : {}),
    };
  });
}

export async function listInstalledSkills(options: SkillsCliInvocationOptions & {
  global: boolean;
  agent?: string;
}): Promise<InstalledSkillRecord[]> {
  const args = ['list', ...(options.global ? ['--global'] : []),
    ...(options.agent ? ['--agent', options.agent] : []), '--json'];
  let stdout: string;
  try {
    ({ stdout } = await invokeSkills(args, options));
  } catch (error) {
    if (error instanceof SkillsCliError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new SkillsCliError('portableSkillsCliVerificationFailed', 'skills list --json 执行失败。');
  }
  try {
    return parseInstalledSkills(JSON.parse(stdout));
  } catch (error) {
    if (error instanceof SkillsCliError) throw error;
    throw new SkillsCliError('portableSkillsCliVerificationFailed', 'skills list --json 返回无效 JSON。');
  }
}

export async function addSkills(options: SkillsCliInvocationOptions & {
  rootDir: string;
  skills: string[];
  agents?: string[];
  global: boolean;
}): Promise<void> {
  const args = ['add', options.rootDir, '--skill', ...options.skills,
    ...(options.agents ? ['--agent', ...options.agents] : []),
    ...(options.global ? ['--global'] : []), '--yes'];
  try {
    await invokeSkills(args, options);
  } catch (error) {
    if (error instanceof SkillsCliError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new SkillsCliError('portableSkillsCliInstallFailed', 'skills add 执行失败。');
  }
}

export async function verifySkills(options: SkillsCliInvocationOptions & {
  skills: string[];
  agents?: string[];
  global: boolean;
}): Promise<{ records: InstalledSkillRecord[]; missing: Array<{ skill: string; agent?: string }> }> {
  if (options.agents) {
    const records: InstalledSkillRecord[] = [];
    const missing: Array<{ skill: string; agent?: string }> = [];
    for (const agent of options.agents) {
      const current = await listInstalledSkills({ ...options, agent });
      records.push(...current);
      const names = new Set(current.filter((entry) => entry.agents.length > 0).map((entry) => entry.name));
      for (const skill of options.skills) {
        if (!names.has(skill)) missing.push({ skill, agent });
      }
    }
    return { records, missing };
  }
  const records = await listInstalledSkills(options);
  const names = new Set(records.filter((entry) => entry.agents.length > 0).map((entry) => entry.name));
  return {
    records,
    missing: options.skills.filter((skill) => !names.has(skill)).map((skill) => ({ skill })),
  };
}
