import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import type { NormalizedPluginManifest } from '../../src/types.js';
import {
  preflightRequiredPluginConfigs,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';

const tempDirs: string[] = [];
const sourceIdentity = `sha256:${'a'.repeat(64)}`;
const logicalIdentity = 'catalog.example/config-recovery';

function manifest(fields: NonNullable<NormalizedPluginManifest['config']>['fields']): NormalizedPluginManifest {
  return {
    schemaVersion: 3,
    name: 'demo',
    version: '1.0.0',
    description: 'Config recovery fixture.',
    marketplace: {
      category: 'test',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    config: { fields },
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-recovery-'));
  tempDirs.push(root);
  registerCurrentTestWritableStateRoot(root);
  const cwd = path.join(root, 'project');
  const env = { AW_HOME: path.join(root, 'aw-home') };
  await fs.ensureDir(cwd);
  return { cwd, env };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('config recovery commands', () => {
  it('uses stdin for secrets and the same explicit project definition context for normal fields', async () => {
    const { cwd, env } = await fixture();
    const pluginManifest = manifest({
      token: { type: 'string', required: true, sensitive: true },
      mode: { type: 'string', required: true },
    });

    const error = await preflightRequiredPluginConfigs({
      targets: [{
        sourceId: 'team', sourceIdentity, logicalIdentity, manifest: pluginManifest,
      }],
      cwd,
      defaultScope: 'project',
      context: createCommandExecutionContext({ cwd, env }),
    }).catch((failure: unknown) => failure as Error);

    expect(error.message).toContain(
      'aw plugin config set team/demo token --context project --value-stdin',
    );
    expect(error.message).toContain(
      "aw plugin config set team/demo mode --context project --value-json '<json>'",
    );
    expect(error.message).not.toContain('--scope');
    expect(error.message).not.toContain('token --context project --value-json');
    expect(error.message).not.toContain('token --context project --preset');
  });

  it('uses stdin for an invalid sensitive override without exposing its saved value', async () => {
    const { cwd, env } = await fixture();
    const pluginManifest = manifest({
      token: {
        type: 'string', required: true, sensitive: true,
        validation: { minLength: 5 },
      },
    });
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity, logicalIdentity,
      pluginName: 'demo', scope: 'user', cwd, env,
      values: { token: 'abc' },
    });

    const error = await preflightRequiredPluginConfigs({
      targets: [{
        sourceId: 'team', sourceIdentity, logicalIdentity, manifest: pluginManifest,
      }],
      cwd,
      defaultScope: 'project',
      context: createCommandExecutionContext({ cwd, env }),
    }).catch((failure: unknown) => failure as Error);

    expect(error.message).toContain(
      'aw plugin config set team/demo token --context project --value-stdin',
    );
    expect(error.message).not.toContain('abc');
    expect(error.message).not.toContain('--value-json');
    expect(error.message).not.toContain('--preset');
  });
});
