import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  calculateBundleFingerprint,
  createAvailableLedger,
  initializeLocalMarketplace,
  readInstalledLedger,
  validateLocalMarketplaceLayout,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import { readJsonFile } from '../../src/utils/json.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{ repoRoot: string; awHome: string; embeddedRoot: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-local-marketplace-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  const awHome = path.join(root, 'aw-home');

  return { repoRoot, awHome, embeddedRoot };
}

function codexOpenAiYamlPath(rootDir: string, pluginName = 'git-commit'): string {
  return path.join(
    rootDir,
    'plugins',
    pluginName,
    'codex',
    'skills',
    'commit',
    'agents',
    'openai.yaml',
  );
}

async function readCodexAllowImplicitInvocation(rootDir: string): Promise<boolean> {
  const parsed = YAML.parse(await fs.readFile(codexOpenAiYamlPath(rootDir), 'utf8')) as {
    policy?: { allow_implicit_invocation?: boolean };
  };
  return parsed.policy?.allow_implicit_invocation === true;
}

async function writeCodexAllowImplicitInvocation(rootDir: string, value: boolean): Promise<void> {
  await fs.writeFile(
    codexOpenAiYamlPath(rootDir),
    YAML.stringify({ policy: { allow_implicit_invocation: value } }),
    'utf8',
  );
}

async function listSkillBackupDirs(
  rootDir: string,
  pluginName = 'git-commit',
  platform = 'codex',
): Promise<string[]> {
  const platformRoot = path.join(rootDir, 'plugins', pluginName, platform);
  if (!(await fs.pathExists(platformRoot))) {
    return [];
  }

  return (await fs.readdir(platformRoot))
    .filter((entry) => entry.startsWith('.skills-backup-'))
    .sort();
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  delete process.env.AW_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('local marketplace', () => {
  it('initializes ~/.aw from the embedded bundle and preserves a valid ledger on refresh', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.writeJson(
      path.join(awHome, 'installed.json'),
      {
        version: 1,
        ledgerState: {
          status: 'available',
          degradedAt: null,
          reason: null,
        },
        plugins: {
          'git-commit': {
            lastResolvedVersion: '0.1.0',
            platforms: {},
          },
        },
      },
      { spaces: 2 },
    );

    const beforeFingerprint = await readJsonFile<{ bundleFingerprint: string }>(
      path.join(awHome, 'config.json'),
    );

    await fs.writeFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      '# changed\n',
      'utf8',
    );

    await initializeLocalMarketplace({ force: true, env: process.env });

    const afterConfig = await readJsonFile<{ bundleFingerprint: string }>(
      path.join(awHome, 'config.json'),
    );
    const preservedLedger = await readJsonFile(path.join(awHome, 'installed.json'));

    expect(afterConfig.bundleFingerprint).not.toBe(beforeFingerprint.bundleFingerprint);
    expect(preservedLedger).toMatchObject({
      ledgerState: {
        status: 'available',
      },
      plugins: {
        'git-commit': {
          lastResolvedVersion: '0.1.0',
        },
      },
    });
  });

  it('preserves AW-managed plugin config during local marketplace rebuilds', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.outputJson(
      path.join(awHome, 'plugin-config', 'git-commit', 'config.json'),
      {
        token: 'secret',
      },
      { spaces: 2 },
    );

    await fs.writeFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      '# changed again\n',
      'utf8',
    );
    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(fs.readJson(
      path.join(awHome, 'plugin-config', 'git-commit', 'config.json'),
    )).resolves.toEqual({
      token: 'secret',
    });
  });

  it('preserves AW-managed plugin install snapshots during local marketplace rebuilds', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.outputFile(
      path.join(awHome, 'plugin-install-snapshots', 'codex', 'user', 'scope', 'git-commit', 'digest', 'bundle', 'marker.txt'),
      'snapshot',
      'utf8',
    );

    await fs.writeFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      '# changed for snapshot preserve\n',
      'utf8',
    );
    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(fs.readFile(
      path.join(awHome, 'plugin-install-snapshots', 'codex', 'user', 'scope', 'git-commit', 'digest', 'bundle', 'marker.txt'),
      'utf8',
    )).resolves.toBe('snapshot');
  });

  it('repairs a corrupted local marketplace layout during force init', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const marketplacePath = path.join(awHome, '.claude-plugin', 'marketplace.json');
    const marketplace = await fs.readJson(marketplacePath);
    marketplace.plugins[0].source = './plugins/broken';
    await fs.writeJson(marketplacePath, marketplace, { spaces: 2 });

    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('rebuilds ~/.aw when config.json is malformed during a non-force refresh', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.writeFile(path.join(awHome, 'config.json'), '{"version":', 'utf8');

    await expect(initializeLocalMarketplace({ force: false, env: process.env })).resolves.toMatchObject({
      rootDir: awHome,
      changed: true,
    });
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('rebuilds ~/.aw when config.json uses an unsupported schema version during a non-force refresh', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const configPath = path.join(awHome, 'config.json');
    const config = await fs.readJson(configPath);
    config.version = 2;
    await fs.writeJson(configPath, config, { spaces: 2 });

    await expect(initializeLocalMarketplace({ force: false, env: process.env })).resolves.toMatchObject({
      rootDir: awHome,
      changed: true,
    });
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('treats an invalid source manifest as an unhealthy local marketplace layout', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.writeFile(
      path.join(awHome, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'),
      '{"name":',
      'utf8',
    );

    await expect(validateLocalMarketplaceLayout(awHome)).rejects.toThrow();
  });

  it('returns a degraded ledger when installed.json contains malformed JSON', async () => {
    const { awHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;

    await fs.ensureDir(awHome);
    await fs.writeFile(path.join(awHome, 'installed.json'), '{"version":', 'utf8');

    await expect(readInstalledLedger(process.env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'rebuilt_from_missing_or_invalid',
      },
      plugins: {},
    });
  });

  it('writes a degraded ledger when the previous installed.json is missing or invalid', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await fs.ensureDir(awHome);
    await fs.writeFile(path.join(awHome, 'installed.json'), '{"version":"broken"}', 'utf8');

    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(readJsonFile(path.join(awHome, 'installed.json'))).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'rebuilt_from_missing_or_invalid',
      },
      plugins: {},
    });
    await expect(calculateBundleFingerprint(awHome)).resolves.toMatch(/^sha256:/);
  });

  it('replays available ledger skill trigger preferences during force rebuild', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
            skillTriggerWriteOrder: 1,
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);
    await writeCodexAllowImplicitInvocation(awHome, true);
    const localManifestPath = path.join(awHome, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
    const localManifest = await fs.readJson(localManifestPath);
    localManifest.skillTriggers.commit.allowInstallOverride = false;
    await fs.writeJson(localManifestPath, localManifest, { spaces: 2 });

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(result.warnings.join('\n')).not.toContain('degraded');
    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(false);
    expect(await listSkillBackupDirs(awHome)).toEqual([]);
    await expect(readInstalledLedger(process.env)).resolves.toMatchObject({
      ledgerState: {
        status: 'available',
      },
    });
  });

  it('uses the shared winner when replaying conflicting scope records', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
            skillTriggerWriteOrder: 1,
          },
          projectScopes: {
            'project-a': {
              managed: true,
              updatedAt: '2026-04-28T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
              },
              installOptions: {
                skillTriggerPreference: 'auto',
              },
              skillTriggerWriteOrder: 2,
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);
    await writeCodexAllowImplicitInvocation(awHome, false);

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(true);
    expect(result.warnings.join('\n')).toContain('user (manual)');
  });

  it('uses the stable scope identity fallback when replaying old ledgers without write order', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
          },
          projectScopes: {
            alpha: {
              managed: true,
              updatedAt: '2026-04-28T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
              },
              installOptions: {
                skillTriggerPreference: 'auto',
              },
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);
    await writeCodexAllowImplicitInvocation(awHome, false);

    await initializeLocalMarketplace({ force: true, env: process.env });

    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(true);
  });

  it('replays skill trigger preferences during non-force stale and bundle refreshes', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
            skillTriggerWriteOrder: 1,
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);

    await writeCodexAllowImplicitInvocation(awHome, true);
    await fs.writeFile(path.join(awHome, 'config.json'), '{"version":', 'utf8');
    await initializeLocalMarketplace({ force: false, env: process.env });
    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(false);

    await writeCodexAllowImplicitInvocation(awHome, true);
    await fs.writeFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'claude', 'skills', 'commit', 'README.md'),
      'fingerprint changed\n',
      'utf8',
    );
    await initializeLocalMarketplace({ force: false, env: process.env });
    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(false);
  });

  it('skips replay for degraded ledgers and keeps the pristine bundle', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await writeInstalledLedger(
      {
        version: 1,
        ledgerState: {
          status: 'degraded',
          degradedAt: '2026-04-28T00:00:00.000Z',
          reason: 'operation_interrupted_after_native_write',
        },
        plugins: {
          'git-commit': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-04-28T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    requiresNativePlugin: true,
                  },
                  installOptions: {
                    skillTriggerPreference: 'manual',
                  },
                },
              },
            },
          },
        },
      },
      process.env,
    );
    await writeCodexAllowImplicitInvocation(awHome, false);

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(result.warnings.join('\n')).toContain('跳过 skill trigger 偏好 replay');
    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(true);
    await expect(readInstalledLedger(process.env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_native_write',
      },
    });
  });

  it('keeps rebuild best-effort when replay sees malformed pristine skill files', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
            skillTriggerWriteOrder: 1,
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);
    await fs.writeFile(codexOpenAiYamlPath(embeddedRoot), 'policy: [', 'utf8');

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(result.warnings.join('\n')).toContain('偏好跳过覆盖');
    await expect(fs.readFile(codexOpenAiYamlPath(awHome), 'utf8')).resolves.toBe('policy: [');
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });
});
