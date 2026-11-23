import { describe, expect, it } from 'vitest';
import { validateCommandRoutesPlan } from '../../src/utils/artifact-plan.js';

const artifact = {
  id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes', refreshKeys: ['mode'],
  routes: { subcommands: [{ name: 'export', runner: 'node', entry: 'run.mjs' }] },
};
const validate = (artifacts: unknown[]) => validateCommandRoutesPlan({ version: 2, artifacts }, ['mode']);

describe('dynamic route artifact plan', () => {
  // The renderer response either replaces the whole table or fails validation before publication.
  it('normalizes launched commands and accepts an empty table', () => {
    expect(validate([artifact])).toMatchObject({ ...artifact, routes: { subcommands: [{ name: 'export', entry: 'run.mjs', args: [], cwd: 'caller' }] } });
    expect(validate([{ ...artifact, routes: {} }]).routes).toEqual({ subcommands: [] });
  });

  it('requires one artifact with the declared identity and refresh keys', () => {
    for (const artifacts of [[], [artifact, artifact], [artifact, { ...artifact, id: 'extra' }],
      [{ ...artifact, id: 'wrong' }], [{ ...artifact, target: 'aw.command-set' }], [{ ...artifact, kind: 'commandSet' }],
      [{ ...artifact, refreshKeys: [] }], [{ ...artifact, refreshKeys: ['external'] }],
      [{ ...artifact, platform: 'codex' }], [{ ...artifact, owner: 'author' }], [{ ...artifact, files: {} }]]) {
      expect(() => validate(artifacts)).toThrow();
    }
    expect(() => validateCommandRoutesPlan({ version: 3, artifacts: [artifact] }, ['mode'])).toThrow();
    expect(() => validateCommandRoutesPlan({ version: 2, artifacts: [artifact], extra: true }, ['mode'])).toThrow();
  });

  it('rejects duplicate names and entries outside author-owned resources', () => {
    const [launch] = artifact.routes.subcommands;
    for (const subcommands of [[launch, launch], [{ ...launch, entry: '../outside.mjs' }],
      [{ ...launch, entry: '.aw/injected.mjs' }], [{ ...launch, runner: 'shell' }]]) {
      expect(() => validate([{ ...artifact, routes: { subcommands } }])).toThrow();
    }
  });
});
