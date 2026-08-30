import path from 'node:path';

import {
  getRuntimeCapabilities,
  runExecutionPlan,
  validateExecutionPlan,
  validateRunBundle,
  type RunExecutionPlanOptions,
  type RunExecutionResult,
} from '@lesliechan721/agent-skill-eval';

export interface AwSkillEvalExecutionResult extends RunExecutionResult {
  engine: { provider: string; version: string };
  bundleValidation: Awaited<ReturnType<typeof validateRunBundle>>;
}

export function getAwSkillEvalExecutionOwner(): { provider: string; version: string } {
  const capabilities = getRuntimeCapabilities();
  return {
    provider: capabilities.provider,
    version: capabilities.providerVersion,
  };
}

// AW owns only the high-level dispatch here. The shared package owns its plan validation,
// provider execution, evidence capture, bundle construction, and bundle validation. AW-native
// command, trigger, and conversation suites keep their separate suite/report contracts and must
// not be translated into an AwSkillEvalExecutionPlan.
export async function runAwSkillEvalExecutionPlan(
  planPath: string,
  options: RunExecutionPlanOptions,
): Promise<AwSkillEvalExecutionResult> {
  const absolutePlanPath = path.resolve(planPath);
  const planValidation = await validateExecutionPlan(absolutePlanPath);
  if (!planValidation.valid) {
    throw new Error(`AwSkillEvalExecutionPlan is invalid:\n${planValidation.errors.join('\n')}`);
  }
  const execution = await runExecutionPlan(absolutePlanPath, options);
  const bundleValidation = await validateRunBundle(execution.bundlePath);
  if (!bundleValidation.valid) {
    throw new Error(`EvalRunBundle is invalid:\n${bundleValidation.errors.join('\n')}`);
  }
  return {
    ...execution,
    engine: getAwSkillEvalExecutionOwner(),
    bundleValidation,
  };
}
