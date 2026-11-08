import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { portableOwnedTreeDigest } from '../../src/portable/writer.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('scoped CLI authorization bridge', () => {
  // Test Value Gate: the CLI must require an explicit deletion grant and preserve owned output until it is provided.
  it.each([false, true])('uses explicit --yes authorization for project output removal: %s', async (confirmed) => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const cwd = layout.fixtureCwd;
    await git(cwd, ['init', '--quiet']);
    const skillsRoot = path.join(cwd, '.cursor', 'skills');
    const skillRoot = path.join(skillsRoot, 'demo');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '# Retain until confirmed\n');
    await fs.outputJson(path.join(skillRoot, '.agent-workflows-owner.json'), {
      schemaVersion: 1, owner: 'agent-workflows', kind: 'portable-skill',
      pluginId: 'team/demo', logicalIdentity: 'team-identity', platform: 'cursor', scope: 'project', skill: 'demo',
      filesDigest: await portableOwnedTreeDigest(skillRoot), configDigest: `sha256:${'a'.repeat(64)}`,
    });
    const output = createCapturedCliIo();
    expect(await runCli([
      'plugin', 'remove', 'team/demo', '--scope', 'project', '--only', 'outputs', '--target', 'cursor',
      ...(confirmed ? ['--yes'] : []), '--json',
    ], { cwd, env, interactive: false, io: output.io })).toBe(confirmed ? 0 : 3);
    expect(JSON.parse(output.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.remove', status: confirmed ? 'success' : 'blocked',
      data: {
        confirmation: { required: true, provided: confirmed, effects: [expect.objectContaining({
          code: 'removeOwnedOutput', subject: { pluginId: 'team/demo', target: 'cursor', scope: 'project' },
          impact: 'selected-scope',
        })] },
        changes: { requirements: 'none', config: 'none', outputs: confirmed ? 'changed' : 'none' },
      },
    });
    expect(await fs.pathExists(skillRoot)).toBe(!confirmed);
  });
});
