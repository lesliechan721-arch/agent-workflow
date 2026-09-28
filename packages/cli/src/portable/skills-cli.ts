import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MIN_VERSION = [1, 5, 23] as const;
const MAX_VERSION = [2, 0, 0] as const;
export const SKILLS_CLI_SUPPORTED_VERSION_LABEL = '>=1.5.23 <2.0.0';

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
  timeoutMs?: number;
}

export interface PortableSkillTarget {
  skill: string;
  agent?: string;
}

export interface SkillsVerificationResult {
  records: InstalledSkillRecord[];
  missing: PortableSkillTarget[];
  unknown: PortableSkillTarget[];
}

function comparableAgentName(value: string): string {
  // skills v1.5.23 lists displayName values and an --agent query can still include other Agents.
  // Source: https://github.com/vercel-labs/skills/blob/v1.5.23/src/list.ts
  // and https://github.com/vercel-labs/skills/blob/v1.5.23/src/installer.ts
  return value.trim().toLowerCase().replace(/\s+/gu, '-');
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
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
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
      `skills ${version.join('.')} 不在支持范围 ${SKILLS_CLI_SUPPORTED_VERSION_LABEL}。`,
    );
  }
  return { version: version.join('.') };
}

/** Portable recovery has a narrower, independently qualified provider contract. */
export async function probePortableRecoverySkillsCli(
  options: SkillsCliInvocationOptions,
): Promise<{ version: string }> {
  const result = await probeSkillsCli({ ...options, timeoutMs: options.timeoutMs ?? 15_000 });
  if (result.version !== '1.5.23') {
    throw new SkillsCliError('portableSkillsCliIncompatible', 'Portable 恢复需要精确 skills 1.5.23。');
  }
  return result;
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
  copy?: boolean;
}): Promise<void> {
  const args = ['add', options.rootDir, '--skill', ...options.skills,
    ...(options.agents ? ['--agent', ...options.agents] : []),
    ...(options.global ? ['--global'] : []), ...(options.copy ? ['--copy'] : []), '--yes'];
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
}): Promise<SkillsVerificationResult> {
  const targets = options.agents
    ? options.agents.flatMap((agent) => options.skills.map((skill) => ({ skill, agent })))
    : options.skills.map((skill) => ({ skill }));
  return verifySkillTargets({ ...options, targets });
}

export async function verifySkillTargets(options: SkillsCliInvocationOptions & {
  targets: PortableSkillTarget[];
  global: boolean;
}): Promise<SkillsVerificationResult> {
  const records: InstalledSkillRecord[] = [];
  const missing: PortableSkillTarget[] = [];
  const unknown: PortableSkillTarget[] = [];
  const groups = new Map<string | undefined, PortableSkillTarget[]>();
  for (const target of options.targets) {
    const group = groups.get(target.agent) ?? [];
    if (!group.some((entry) => entry.skill === target.skill)) group.push(target);
    groups.set(target.agent, group);
  }
  for (const [agent, targets] of groups) {
    let current: InstalledSkillRecord[];
    try {
      current = await listInstalledSkills({ ...options, ...(agent ? { agent } : {}) });
    } catch (error) {
      if (error instanceof SkillsCliError) {
        unknown.push(...targets);
        continue;
      }
      throw error;
    }
    for (const target of targets) {
      const matches = current.filter((entry) => entry.name === target.skill);
      if (matches.length === 0) {
        missing.push(target);
        continue;
      }
      if (agent) {
        const matchingRecord = matches.find((entry) => entry.agents.some(
          (observedAgent) => comparableAgentName(observedAgent) === comparableAgentName(agent),
        ));
        if (!matchingRecord) {
          unknown.push(target);
          continue;
        }
        records.push({ ...matchingRecord, agents: [agent] });
        continue;
      }
      const observedAgents: string[] = [];
      const seenAgents = new Set<string>();
      for (const observedAgent of matches.flatMap((entry) => entry.agents)) {
        const key = observedAgent.toLowerCase();
        if (seenAgents.has(key)) continue;
        seenAgents.add(key);
        observedAgents.push(observedAgent);
      }
      if (observedAgents.length === 0) {
        unknown.push(target);
        continue;
      }
      records.push({ ...matches[0]!, agents: observedAgents });
    }
  }
  return { records, missing, unknown };
}
