import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

async function readPackageJson(relativePath: string): Promise<Record<string, unknown>> {
  return fs.readJson(path.join(repoRoot, relativePath));
}

describe('package metadata', () => {
  it('declares Node.js >=20 for the published CLI package and the workspace root', async () => {
    const [rootPackageJson, cliPackageJson] = await Promise.all([
      readPackageJson('package.json'),
      readPackageJson('packages/cli/package.json'),
    ]);

    expect(rootPackageJson).toMatchObject({
      engines: {
        node: '>=20',
      },
    });
    expect(cliPackageJson).toMatchObject({
      engines: {
        node: '>=20',
      },
    });
  });
});
