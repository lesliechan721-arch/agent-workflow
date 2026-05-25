import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { applyCodexInstallLedger } from '../../src/adapters/codex.js';
import { cleanupCommand } from '../../src/commands/cleanup.js';
import { installCommand } from '../../src/commands/install.js';
import {
  CONFIG_READ_DEFAULT_RESOLUTION,
  CONFIG_WRITE_DEFAULT_SCOPE,
  normalizeInstallCommandOptions,
  parseScriptTimeoutMs,
  resolveConfigReadResolution,
  resolveConfigWriteScope,
} from '../../src/commands/options.js';
import { reinstallCommand } from '../../src/commands/reinstall.js';
import { statusCommand } from '../../src/commands/status.js';
import { uninstallCommand } from '../../src/commands/uninstall.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  Scope,
  StatusReport,
} from '../../src/types.js';
import {
  createAvailableLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
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

async function makeWorkspace(): Promise<{
  repoRoot: string;
  awHome: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-options-normalization-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);

  const env = {
    ...process.env,
    AW_HOME: path.join(root, 'aw-home'),
    AW_CODEX_HOME: path.join(root, 'codex-home'),
    AW_FORCE_CODEX_AVAILABLE: '1',
    PATH: '',
  } as NodeJS.ProcessEnv;

  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
  return {
    repoRoot,
    awHome: env.AW_HOME!,
    embeddedRoot,
    env,
  };
}

class RecordingAdapter implements PlatformAdapter {
  readonly name: PlatformName;
  readonly scopes: Scope[] = [];

  constructor(name: PlatformName, private readonly managed = true) {
    this.name = name;
  }

  async detect(_cwd: string): Promise<boolean> {
    return this.name === 'codex';
  }

  async installPlugin(_plugin: PluginMeta, scope: Scope): Promise<void> {
    this.scopes.push(scope);
  }

  async uninstallPlugin(_plugin: PluginMeta, scope: Scope): Promise<void> {
    this.scopes.push(scope);
  }

  async installExtensions(_plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
    this.scopes.push(scope);
    return [];
  }

  async uninstallExtensions(_plugin: PluginMeta, scope: Scope): Promise<void> {
    this.scopes.push(scope);
  }

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    await this.installPlugin(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    this.scopes.push(scope);
    return {
      platform: this.name,
      scope,
      initialized: this.managed,
      plugins: [{
        pluginName: plugin.manifest.name,
        native: {
          marketplaceRegistered: this.managed,
          pluginAvailable: true,
          pluginInstalled: this.managed,
          version: plugin.manifest.version,
        },
        generatedArtifacts: [],
        driftWarnings: [],
        scopeInitialized: this.managed ? 'yes' : 'no',
        catalogCompatibility: 'current',
        scopeManagedEvidence: {
          ledger: this.managed,
          tracking: false,
          sharedNativeRef: false,
        },
      }],
    };
  }
}

function createAdapters(codex: RecordingAdapter): Record<PlatformName, PlatformAdapter> {
  return {
    codex,
    claude: new RecordingAdapter('claude', false),
  };
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('command option normalization', () => {
  it('requires explicit platforms for write commands while still defaulting scope to user', async () => {
    const workspace = await makeWorkspace();
    const codex = new RecordingAdapter('codex');

    await expect(
      installCommand(
        ['git-commit'],
        { cwd: workspace.repoRoot } as any,
        { env: workspace.env, adapters: createAdapters(codex) },
      ),
    ).rejects.toThrow('install 命令需要显式指定 `--platform codex|claude|both`。');

    await installCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, platform: 'codex' } as any,
      { env: workspace.env, adapters: createAdapters(codex) },
    );
    await uninstallCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, platform: 'codex' } as any,
      { env: workspace.env, adapters: createAdapters(codex) },
    );
    await installCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, platform: 'codex' } as any,
      { env: workspace.env, adapters: createAdapters(codex) },
    );
    await upgradeCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, platform: 'codex' } as any,
      { env: workspace.env, adapters: createAdapters(codex) },
    );

    expect(codex.scopes).toContain('user');
    expect(codex.scopes).not.toContain('project');
  }, 15000);

  it('requires explicit upgrade --all platforms and defaults status to both', async () => {
    const workspace = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(workspace.repoRoot, 'plugins', 'git-commit'));
    await writeInstalledLedger(
      await applyCodexInstallLedger(createAvailableLedger(), plugin, 'user', workspace.repoRoot),
      workspace.env,
    );

    const codex = new RecordingAdapter('codex');
    await expect(
      upgradeCommand(
        [],
        { cwd: workspace.repoRoot, all: true } as any,
        { env: workspace.env, adapters: createAdapters(codex) },
      ),
    ).rejects.toThrow('upgrade 命令需要显式指定 `--platform codex|claude|both`。');

    await upgradeCommand(
      [],
      { cwd: workspace.repoRoot, all: true, platform: 'codex' } as any,
      { env: workspace.env, adapters: createAdapters(codex) },
    );

    const status = await statusCommand(
      [],
      { cwd: workspace.repoRoot } as any,
      { env: workspace.env, adapters: createAdapters(codex) },
    );

    expect(status.reports.map((report) => `${report.platform}:${report.scope}`)).toEqual([
      'codex:user',
      'codex:project',
      'claude:user',
      'claude:project',
    ]);
  });

  it('returns clear validation errors for invalid partial options', async () => {
    const workspace = await makeWorkspace();
    await expect(
      installCommand(
        ['git-commit'],
        { cwd: workspace.repoRoot, scope: 'repo', platform: 'codex' } as any,
        { env: workspace.env, adapters: createAdapters(new RecordingAdapter('codex')) },
      ),
    ).rejects.toThrow('Unsupported scope "repo".');
    await expect(
      statusCommand(
        [],
        { cwd: workspace.repoRoot, platform: 'workspace' } as any,
        { env: workspace.env, adapters: createAdapters(new RecordingAdapter('codex')) },
      ),
    ).rejects.toThrow('Unsupported platform "workspace".');
  });

  it('rejects adopt-existing scope misuse and removed public flags before platform writes', async () => {
    const workspace = await makeWorkspace();
    const codex = new RecordingAdapter('codex');
    const adapters = createAdapters(codex);

    await expect(
      installCommand(
        ['git-commit'],
        {
          cwd: workspace.repoRoot,
          platform: 'codex',
          adoptExisting: true,
        } as any,
        { env: workspace.env, adapters },
      ),
    ).rejects.toThrow('`install --adopt-existing` 只允许 `--scope project`。');

    await expect(
      cleanupCommand(
        ['git-commit'],
        {
          cwd: workspace.repoRoot,
          platform: 'codex',
          plan: true,
        } as any,
        { env: workspace.env, adapters },
      ),
    ).rejects.toThrow('`cleanup --plan` 已移除');

    await expect(
      reinstallCommand(
        ['git-commit'],
        {
          cwd: workspace.repoRoot,
          platform: 'codex',
          takeoverSharedRuntime: true,
        } as any,
        { env: workspace.env, adapters },
      ),
    ).rejects.toThrow('`reinstall` 不再接受 `--takeover-shared-runtime`');

    expect(codex.scopes).toEqual([]);
  });

  it('rejects legacy platform auto for public write commands', async () => {
    const workspace = await makeWorkspace();
    const adapters = createAdapters(new RecordingAdapter('codex'));

    await expect(
      installCommand(
        ['git-commit'],
        { cwd: workspace.repoRoot, platform: 'auto' } as any,
        { env: workspace.env, adapters },
      ),
    ).rejects.toThrow('Unsupported platform "auto". Expected one of: codex, claude, both.');

    await expect(
      cleanupCommand(
        ['git-commit'],
        { cwd: workspace.repoRoot, platform: 'auto' } as any,
        { env: workspace.env, adapters },
      ),
    ).rejects.toThrow('Unsupported platform "auto". Expected one of: codex, claude, both.');

    await expect(
      reinstallCommand(
        ['git-commit'],
        { cwd: workspace.repoRoot, platform: 'auto' } as any,
        { env: workspace.env, adapters },
      ),
    ).rejects.toThrow('Unsupported platform "auto". Expected one of: codex, claude, both.');
  });

  it('normalizes script timeout options for lifecycle command reuse', () => {
    expect(parseScriptTimeoutMs('1000')).toBe(1000);
    expect(parseScriptTimeoutMs(300000)).toBe(300000);
    expect(normalizeInstallCommandOptions({
      cwd: '/tmp/project',
      platform: 'codex',
      scriptTimeout: '45000',
    })).toMatchObject({
      scriptTimeoutMs: 45000,
    });
    expect(normalizeInstallCommandOptions({
      cwd: '/tmp/project',
      platform: 'codex',
      scriptTimeout: '45000',
      scriptTimeoutMs: 60000,
    })).toMatchObject({
      scriptTimeoutMs: 60000,
    });

    expect(() => parseScriptTimeoutMs('999')).toThrow('between 1000 and 300000');
    expect(() => parseScriptTimeoutMs('300001')).toThrow('between 1000 and 300000');
    expect(() => parseScriptTimeoutMs('1000.5')).toThrow('Expected an integer');
  });

  it('exposes config read/write default semantics for future config commands', () => {
    expect(CONFIG_WRITE_DEFAULT_SCOPE).toBe('user');
    expect(CONFIG_READ_DEFAULT_RESOLUTION).toBe('effective');
    expect(resolveConfigWriteScope(undefined)).toBe('user');
    expect(resolveConfigReadResolution(undefined)).toBe('effective');
    expect(resolveConfigWriteScope('project')).toBe('project');
    expect(resolveConfigReadResolution('user')).toBe('user');
    expect(() => resolveConfigWriteScope('workspace')).toThrow('Unsupported scope "workspace".');
  });
});
