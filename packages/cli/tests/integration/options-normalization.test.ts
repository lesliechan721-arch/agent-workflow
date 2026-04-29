import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { applyCodexInstallLedger } from '../../src/adapters/codex.js';
import { installCommand } from '../../src/commands/install.js';
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
  codexHome: string;
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
    codexHome: env.AW_CODEX_HOME!,
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
  it('normalizes partial direct command options to user/auto without undefined property crashes', async () => {
    const workspace = await makeWorkspace();
    const codex = new RecordingAdapter('codex');

    await installCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot } as any,
      { env: workspace.env, adapters: createAdapters(codex) },
    );
    await uninstallCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot } as any,
      { env: workspace.env, adapters: createAdapters(codex) },
    );
    const plugin = await readPluginManifest(path.join(workspace.repoRoot, 'plugins', 'git-commit'));
    await writeInstalledLedger(
      await applyCodexInstallLedger(createAvailableLedger(), plugin, 'user', workspace.repoRoot),
      workspace.env,
    );
    await upgradeCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot } as any,
      { env: workspace.env, adapters: createAdapters(codex) },
    );

    expect(codex.scopes).toContain('user');
    expect(codex.scopes).not.toContain('project');
  });

  it('normalizes upgrade --all partial options and keeps status scope/platform filters optional', async () => {
    const workspace = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(workspace.repoRoot, 'plugins', 'git-commit'));
    await writeInstalledLedger(
      await applyCodexInstallLedger(createAvailableLedger(), plugin, 'user', workspace.repoRoot),
      workspace.env,
    );

    const codex = new RecordingAdapter('codex');
    await upgradeCommand(
      [],
      { cwd: workspace.repoRoot, all: true } as any,
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
    ]);
  });

  it('returns clear validation errors for invalid partial options', async () => {
    const workspace = await makeWorkspace();
    await expect(
      installCommand(
        ['git-commit'],
        { cwd: workspace.repoRoot, scope: 'repo' } as any,
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
});
