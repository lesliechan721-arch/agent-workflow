import { randomUUID } from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

export interface EvalRunLayout {
  runId: string;
  workRoot: string;
  reportRoot: string;
  rawRoot: string;
  cleanupWork(): Promise<void>;
}

function timestampId(date = new Date()): string {
  return date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

export function createEvalRunId(date = new Date()): string {
  return `${timestampId(date)}-${randomUUID().slice(0, 8)}`;
}

function validateSegment(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
    throw new Error(`${label} must use lowercase kebab-case.`);
  }
  return value;
}

function validateRunId(value: string): string {
  if (!/^\d{8}T\d{6}Z-[0-9a-f]{8}$/u.test(value)) {
    throw new Error('--run-id must use YYYYMMDDTHHMMSSZ-xxxxxxxx.');
  }
  return value;
}

async function makeExclusiveDirectory(directory: string): Promise<void> {
  await fs.ensureDir(path.dirname(directory));
  await fs.mkdir(directory);
}

export async function createPluginEvalRunLayout(options: {
  repoRoot: string;
  skillRoot: string;
  plugin: string;
  skill: string;
  runId?: string;
}): Promise<EvalRunLayout> {
  const plugin = validateSegment(options.plugin, 'plugin');
  const skill = validateSegment(options.skill, 'skill');
  const runId = validateRunId(options.runId ?? createEvalRunId());
  const relativeTarget = path.join('plugins', plugin, skill, runId);
  const workRoot = path.join(
    options.repoRoot,
    '.tmp',
    'agent-workflows',
    'evals',
    relativeTarget,
  );
  const resolvedSkillRoot = path.resolve(options.skillRoot);
  const relativeSkillRoot = path.relative(options.repoRoot, resolvedSkillRoot);
  if (
    relativeSkillRoot === '..' ||
    relativeSkillRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeSkillRoot)
  ) {
    throw new Error('Skill report directory must stay inside the repository.');
  }
  const reportRoot = path.join(resolvedSkillRoot, 'reports', 'evals', runId);
  await makeExclusiveDirectory(workRoot);
  try {
    await makeExclusiveDirectory(reportRoot);
    const rawRoot = path.join(reportRoot, 'raw');
    await fs.mkdir(rawRoot);
    return {
      runId,
      workRoot,
      reportRoot,
      rawRoot,
      cleanupWork: async () => {
        await fs.remove(workRoot);
      },
    };
  } catch (error) {
    await fs.remove(workRoot);
    throw error;
  }
}

export async function writeEvalRunJson(
  reportRoot: string,
  fileName: string,
  value: unknown,
): Promise<void> {
  const target = path.join(reportRoot, fileName);
  const temporary = path.join(
    reportRoot,
    `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.writeJson(temporary, value, { spaces: 2 });
  await fs.rename(temporary, target);
}
