import { randomUUID } from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import {
  createSkillEvalRunLayout,
  type SkillEvalRunLayout,
  type SkillReportSourceIdentity,
  type SkillReportTargetCompositions,
} from './skill-reporting.js';

export type EvalRunLayout = SkillEvalRunLayout;

export async function createPluginEvalRunLayout(options: {
  repoRoot: string;
  plugin: string;
  skill: string;
  batchName?: string;
  batchId?: string;
  runId?: string;
  source: SkillReportSourceIdentity;
  environmentDigest: string;
  modelEnvironmentDigest?: string | null;
  harnessDigest: string;
  requiredTargets: string[];
  targetCompositions?: SkillReportTargetCompositions;
}): Promise<EvalRunLayout> {
  return createSkillEvalRunLayout({
    repoRoot: options.repoRoot,
    owner: { kind: 'plugin-skill', plugin: options.plugin, skill: options.skill },
    batchName: options.batchName,
    batchId: options.batchId,
    runId: options.runId,
    source: options.source,
    environmentDigest: options.environmentDigest,
    modelEnvironmentDigest: options.modelEnvironmentDigest,
    harnessDigest: options.harnessDigest,
    requiredTargets: options.requiredTargets,
    targetCompositions: options.targetCompositions,
  });
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
