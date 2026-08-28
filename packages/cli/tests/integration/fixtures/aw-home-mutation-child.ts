import fs from 'fs-extra';
import { expect, it } from 'vitest';

import { addCatalogSourceCommand } from '../../../src/commands/catalog-source.js';

async function waitForRelease(releasePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await fs.pathExists(releasePath)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for parent release.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it('runs one public Catalog source mutation in a child process', async () => {
  const sourceId = process.env.AW_LOCK_CHILD_SOURCE_ID;
  const sourceRoot = process.env.AW_LOCK_CHILD_SOURCE_ROOT;
  const cwd = process.env.AW_LOCK_CHILD_CWD;
  const startedPath = process.env.AW_LOCK_CHILD_STARTED;
  const enteredPath = process.env.AW_LOCK_CHILD_ENTERED;
  const releasePath = process.env.AW_LOCK_CHILD_RELEASE;
  if (!sourceId || !sourceRoot || !cwd || !startedPath || !enteredPath) {
    throw new Error('Missing public mutation child process input.');
  }
  await fs.outputFile(startedPath, `${sourceId}\n`);

  const result = await addCatalogSourceCommand({
    source: { id: sourceId, type: 'path', primary: false, path: sourceRoot },
    cliVersion: '1.0.0',
    cwd,
    env: process.env,
    runtime: {
      beforeRefresh: async () => {
        await fs.outputFile(enteredPath, `${sourceId}\n`);
        if (releasePath) await waitForRelease(releasePath);
      },
    },
  });

  expect(result).toMatchObject({ ok: true, changed: true, sourceId });
});
