import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { observeProjectPreferences, resolveProjectPreferencesPath, setProjectAgents } from '../../src/project/project-preferences.js';
import { executeProjectTargetsPlan, prepareProjectTargetsPlan } from '../../src/tui/project-flow.js';
import { git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function location(name: string) {
  const cwd = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  return { cwd, env: getCurrentSourceTestIsolation().env };
}

describe('project TUI target Review', () => {
  it('rejects a changed preference before writing the reviewed selection', async () => {
    const project = await location('tui-targets-stale');
    const review = await prepareProjectTargetsPlan(project, 'set', ['codex']);
    await setProjectAgents(project, ['cursor']);
    await expect(executeProjectTargetsPlan(project, review)).rejects.toThrow('operationReviewStale');
    const current = await observeProjectPreferences(project);
    expect(current.state).toBe('valid');
    if (current.state !== 'valid') throw new Error('Expected valid preferences.');
    expect(current.value.agents).toEqual(['cursor']);
  });

  it('shows reset scope and clears damaged local preferences only after confirmation', async () => {
    const project = await location('tui-targets-reset');
    const filePath = await resolveProjectPreferencesPath(project);
    await fs.outputFile(filePath, '{bad');
    const review = await prepareProjectTargetsPlan(project, 'reset');
    expect(review.changes).toContain('清空本机 Agent 选择');
    expect(await fs.readFile(filePath, 'utf8')).toBe('{bad');
    expect((await executeProjectTargetsPlan(project, review)).agents).toEqual([]);
    expect((await observeProjectPreferences(project)).state).toBe('valid');
  });
});
