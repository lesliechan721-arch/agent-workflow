import type { Scope } from '../types.js';
import { resolveRequiredCanonicalRepoRoot } from '../utils/state-paths.js';

export interface WorkContext {
  context: Scope;
  cwd: string;
  projectRoot?: string;
  scopes: Scope[];
}

/** Project context includes user requirements; user context never discovers a project. */
export async function resolveWorkContext(options: { cwd: string; context?: Scope; scope?: Scope }): Promise<WorkContext> {
  if (options.context === 'user') {
    if (options.scope === 'project') throw new Error('contextScopeConflict: project scope requires project context.');
    return { context: 'user', cwd: options.cwd, scopes: ['user'] };
  }
  let projectRoot: string | undefined;
  try { projectRoot = await resolveRequiredCanonicalRepoRoot(options.cwd); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('projectRootUnavailable:')) throw error;
    if (options.context === 'project' || options.scope === 'project') throw error;
  }
  return projectRoot ? { context: 'project', cwd: options.cwd, projectRoot, scopes: ['user', 'project'] }
    : { context: 'user', cwd: options.cwd, scopes: ['user'] };
}
