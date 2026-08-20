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

describe('create-aw-plugin real-model eval safety contract', () => {
  // Static contract exception: an author agent could start an unmanaged model process without informed consent; runtime tests cover the CLI gate, but these structured invariants are consumed by author agents before invoking it.
  it('keeps the root and adapter Full Access consent policy synchronized', async () => {
    const policyPaths = [
      path.join(repoRoot, '.agents', 'skills', 'create-aw-plugin', 'references', 'skill-evaluation.md'),
      path.join(
        repoRoot,
        'plugins',
        'aw-plugin-development',
        'skills',
        'author-aw-plugin',
        'references',
        'aw-validation-and-version.md',
      ),
    ];
    const parsePolicy = (content: string): Record<string, string> => {
      const block = content.match(
        /<!-- aw-full-access-consent-policy:v1 -->([\s\S]*?)<!-- \/aw-full-access-consent-policy -->/u,
      )?.[1];
      expect(block).toBeTruthy();
      return Object.fromEntries(
        [...block!.matchAll(/^\| `([^`]+)` \| ([^|\n]+) \|$/gmu)]
          .map((match) => [match[1], match[2].trim()]),
      );
    };
    const policies = await Promise.all(policyPaths.map(async (policyPath) =>
      parsePolicy(await fs.readFile(policyPath, 'utf8'))));

    expect(policies[0]).toEqual(policies[1]);
    expect(policies[0]).toMatchObject({
      agent_must_not_add_allow_unmanaged_processes: expect.stringMatching(/\S/u),
      agent_must_stop_without_user_choice: expect.stringMatching(/\S/u),
    });
  });
});
