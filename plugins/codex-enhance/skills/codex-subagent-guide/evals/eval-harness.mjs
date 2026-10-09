import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  setupTriggerWorkspace,
  TRIGGER_WORKSPACE_FIXTURES,
} from './trigger-fixture.mjs';

const SKILL_KEY = 'codex-subagent-guide';
const GUIDE_ROLE_NAMES = [
  'codex-subagent',
];

function parseTomlString(source, key, file) {
  const match = source.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, 'mu'));
  if (!match) throw new Error(`${file} is missing ${key}.`);
  return JSON.parse(match[1]);
}

async function readMaterializedRoles(root) {
  const roleRoot = path.join(root, '.codex', 'agents');
  const files = (await readdir(roleRoot)).filter((file) => file.endsWith('.toml')).sort();
  const roles = await Promise.all(files.map(async (file) => {
    const rolePath = path.join(roleRoot, file);
    const source = await readFile(rolePath, 'utf8');
    const name = parseTomlString(source, 'name', file);
    return {
      roleFile: { name },
      roleDescription: parseTomlString(source, 'description', file),
      rolePath,
    };
  }));
  return GUIDE_ROLE_NAMES.map((name) => {
    const matches = roles.filter((role) => role.roleFile.name === name);
    if (matches.length !== 1) {
      throw new Error(
        `Materialized codex-subagent-guide must contain role ${name} exactly once, got ${matches.length}.`,
      );
    }
    return matches[0];
  });
}

export async function createEvalWorkspace({
  withSkill = true,
  fixture = 'default',
  sourceRoot,
} = {}) {
  if (!TRIGGER_WORKSPACE_FIXTURES.has(fixture)) {
    throw new Error(`Unsupported trigger workspace fixture: ${fixture}`);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-guide-eval-'));
  try {
    if (!sourceRoot) {
      throw new Error(
        'custom provider input.workspacePath is required; use the workspace snapshot from the prepared Eval Plan.',
      );
    }
    await cp(sourceRoot, root, { recursive: true, force: true });
    const skillRoot = path.join(root, '.agents', 'skills', SKILL_KEY);
    const skillPath = path.join(skillRoot, 'SKILL.md');
    const roles = await readMaterializedRoles(root);
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
