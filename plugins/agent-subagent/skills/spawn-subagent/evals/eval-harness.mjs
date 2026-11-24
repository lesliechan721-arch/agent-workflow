import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { workflowRoles } from './codex-workflow-adapter.mjs';
import {
  setupTriggerWorkspace,
  TRIGGER_WORKSPACE_FIXTURES,
} from './trigger-fixture.mjs';

const SKILL_KEY = 'spawn-subagent';

export async function createEvalWorkspace({
  withSkill = true,
  fixture = 'default',
  sourceRoot,
} = {}) {
  if (!TRIGGER_WORKSPACE_FIXTURES.has(fixture)) {
    throw new Error(`Unsupported trigger workspace fixture: ${fixture}`);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'spawn-subagent-eval-'));
  try {
    if (!sourceRoot) {
      throw new Error(
        'custom provider input.workspacePath is required; use the workspace snapshot from the prepared Eval Plan.',
      );
    }
    await cp(sourceRoot, root, { recursive: true, force: true });
    const skillRoot = path.join(root, '.agents', 'skills', SKILL_KEY);
    const skillPath = path.join(skillRoot, 'SKILL.md');
    const roles = (await workflowRoles(root)).map(({ name, description, configFile }) => ({
      roleFile: { name },
      roleDescription: description,
      rolePath: path.join(root, configFile),
    }));
    await rm(path.join(root, '.codex', 'config.toml'), { force: true });
    if (!withSkill) await rm(skillRoot, { recursive: true, force: true });
    await setupTriggerWorkspace({
      workspaceRoot: root,
      evalCase: { workspace_fixture: fixture },
    });
    return { root, skillPath, roles, withSkill, fixture };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
