import { describe, expect, it } from 'vitest';

import { parsePublishPlanArgs } from '../../../../scripts/release/publish-plan.mjs';
import { parsePrepareArgs } from '../../../../scripts/release/release-prepare.mjs';
import { parseStatusArgs } from '../../../../scripts/release/release-status.mjs';
import { parseTargetArgs } from '../../../../scripts/release/release-target.mjs';

describe('normal release command arguments', () => {
  it.each([
    ['release:status', parseStatusArgs, ['--cli-version', '1.0.0']],
    ['release:target', parseTargetArgs, ['--catalog-version', '1.0.0']],
    ['release:prepare', parsePrepareArgs, ['stable', '--cli-version', '1.0.0']],
    ['release:publish', parsePublishPlanArgs, ['--catalog-version', '1.0.0']],
  ])('%s rejects legacy version identity input', (_name, parse, args) => {
    expect(() => parse(args)).toThrow();
  });

  it('keeps the supported command surface strict', () => {
    expect(parseStatusArgs(['--json'])).toEqual({ json: true });
    expect(parseTargetArgs(['--cli', 'patch'])).toMatchObject({ cli: 'patch' });
    expect(parsePrepareArgs(['beta'])).toEqual({ channel: 'beta' });
    expect(parsePublishPlanArgs([])).toEqual({});
  });
});
