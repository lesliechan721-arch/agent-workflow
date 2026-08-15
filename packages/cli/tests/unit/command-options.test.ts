import { describe, expect, it } from 'vitest';

import {
  normalizeCleanupCommandOptions,
  normalizeInstallCommandOptions,
  normalizeReinstallCommandOptions,
  normalizeUninstallCommandOptions,
  normalizeUpgradeCommandOptions,
} from '../../src/commands/options.js';

describe('write command options', () => {
  it('requires explicit platforms for every write command', () => {
    for (const normalize of [
      normalizeInstallCommandOptions,
      normalizeUpgradeCommandOptions,
      normalizeReinstallCommandOptions,
      normalizeUninstallCommandOptions,
    ]) {
      expect(() => normalize({})).toThrow(/platform/u);
    }
    expect(() => normalizeCleanupCommandOptions({ platform: 'codex' })).toThrow(/scope/u);
  });
});
