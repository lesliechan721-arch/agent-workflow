import type { NativeExecutionInput } from '../../src/commands/rebuild-command.js';
import { observePreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import type { PlatformName, Scope } from '../../src/types.js';

export async function createNativeTestExecution(options: {
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  selectedTargets: readonly { pluginId: string; platform: PlatformName }[];
  includeSelectedInDemand?: boolean;
}): Promise<{ executionInput: NativeExecutionInput; dispose(): Promise<void> }> {
  if (options.scope === 'project' && !await fs.pathExists(path.join(options.cwd, '.git'))
    && !await fs.pathExists(path.join(options.cwd, 'pnpm-workspace.yaml'))) {
    await fs.ensureDir(path.join(options.cwd, '.git'));
  }
  const location = { scope: options.scope, cwd: options.cwd, env: options.env };
  const [intent, preferences] = await Promise.all([
    observeIntent(location), observePreferences(location),
  ]);
  if (intent.state !== 'absent' && intent.state !== 'valid') {
    throw new Error(`Invalid test Intent: ${intent.state}`);
  }
  if (preferences.state !== 'absent' && preferences.state !== 'valid') {
    throw new Error(`Invalid test preferences: ${preferences.state}`);
  }
  const context = await createScopeContext(location);
  const roots = intent.state === 'valid'
    ? intent.value.roots.map((root) => ({ pluginId: root.pluginId,
      platforms: ['codex', 'claude'] as PlatformName[] })) : [];
  if (options.includeSelectedInDemand) {
    for (const selected of options.selectedTargets) {
      if (!roots.some((root) => root.pluginId === selected.pluginId)) {
        roots.push({ pluginId: selected.pluginId, platforms: [selected.platform] });
      }
    }
  }
  return {
    executionInput: {
      context,
      requirements: {
        roots,
        dependencyScopeOverrides: preferences.state === 'valid'
          ? preferences.value.dependencyScopeOverrides : [],
      },
      selectedTargets: options.selectedTargets.map((target) => ({ ...target, scope: options.scope })),
      preserveOtherObservedTargets: true,
    },
    dispose: context.dispose,
  };
}
import path from 'node:path';

import fs from 'fs-extra';
