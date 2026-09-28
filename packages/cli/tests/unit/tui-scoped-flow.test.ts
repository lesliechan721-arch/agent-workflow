import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { executeIntentPlan, executeTargetsPlan,
  prepareIntentPlan, prepareTargetsPlan } from '../../src/tui/scoped-flow.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('scoped TUI plan physical target', () => {
  async function aliasFixture() {
    const isolation = getCurrentSourceTestIsolation();
    const base = path.join(isolation.layout.fixtureCwd, 'scoped-plan-alias');
    const first = path.join(base, 'first');
    const second = path.join(base, 'second');
    const alias = path.join(base, 'alias');
    await fs.ensureDir(path.join(first, 'aw'));
    await fs.ensureDir(path.join(second, 'aw'));
    await fs.symlink(first, alias, 'dir');
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, AW_HOME: path.join(alias, 'aw') } };
    const swap = async () => { await fs.remove(alias); await fs.symlink(second, alias, 'dir'); };
    return { first, second, location, swap };
  }

  it('does not save targets after the AW_HOME ancestor changes physical location', async () => {
    const { second, location, swap } = await aliasFixture();
    const plan = await prepareTargetsPlan(location, 'set', ['codex']);
    await swap();
    await expect(executeTargetsPlan(location, plan)).rejects.toThrow('operationReviewStale');
    await expect(fs.pathExists(path.join(second, 'aw', 'deployment-preferences.json')))
      .resolves.toBe(false);
  });

  it('does not remove an identical declaration at a new physical location', async () => {
    const { first, second, location, swap } = await aliasFixture();
    await writeIntentFixture(location, { roots: [{ pluginId: 'local/demo', platforms: ['codex'] }] });
    const source = path.join(first, 'aw', 'plugin-intents.json');
    const target = path.join(second, 'aw', 'plugin-intents.json');
    await fs.copyFile(source, target);
    const original = await fs.readFile(target);
    const plan = await prepareIntentPlan(location, 'remove', 'local/demo');
    await swap();
    await expect(executeIntentPlan(location, plan)).rejects.toThrow('operationReviewStale');
    await expect(fs.readFile(target)).resolves.toEqual(original);
  });
});
