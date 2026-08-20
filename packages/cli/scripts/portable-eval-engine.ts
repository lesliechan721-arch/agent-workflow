import path from 'node:path';

import {
  getRuntimeCapabilities,
  runExecutionPlan,
  validateExecutionPlan,
  validateRunBundle,
  type RunExecutionResult,
} from '@lesliechan721/agent-skill-eval';

export interface PortableEvalExecutionResult extends RunExecutionResult {
  engine: { provider: string; version: string };
  bundleValidation: Awaited<ReturnType<typeof validateRunBundle>>;
}

export function getPortableEvalExecutionOwner(): { provider: string; version: string } {
  const capabilities = getRuntimeCapabilities();
  return {
    provider: capabilities.provider,
    version: capabilities.providerVersion,
  };
}

// AW owns only the high-level dispatch here. The shared package owns portable plan validation,
// provider execution, evidence capture, bundle construction, and bundle validation. AW-native
// command, trigger, and conversation suites keep their separate suite/report contracts and must
// not be translated into a portable plan without a real audit and provider capability document.
export async function runPortableEvalExecutionPlan(
  planPath: string,
): Promise<PortableEvalExecutionResult> {
  const absolutePlanPath = path.resolve(planPath);
  const planValidation = await validateExecutionPlan(absolutePlanPath);
  if (!planValidation.valid) {
    throw new Error(`EvalExecutionPlan is invalid:\n${planValidation.errors.join('\n')}`);
  }
  const execution = await runExecutionPlan(absolutePlanPath);
  const bundleValidation = await validateRunBundle(execution.bundlePath);
  if (!bundleValidation.valid) {
    throw new Error(`EvalRunBundle is invalid:\n${bundleValidation.errors.join('\n')}`);
  }
  return {
    ...execution,
    engine: getPortableEvalExecutionOwner(),
    bundleValidation,
  };
}
