import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installCommand } from '../../src/commands/install.js';
import { statusCommand } from '../../src/commands/status.js';
import { uninstallCommand } from '../../src/commands/uninstall.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import type {
  GeneratedArtifact,
  InstalledLedger,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  StatusReport,
} from '../../src/types.js';
import { createAvailableLedger, readInstalledLedger, writeInstalledLedger } from '../../src/utils/local-marketplace.js';
import {
  resolveCodexProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
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

async function addLifecycleScripts(repoRoot: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.scripts = {
    timeoutMs: 31000,
    lifecycle: {
      install: './scripts/lifecycle.mjs',
      upgrade: './scripts/lifecycle.mjs',
      uninstall: './scripts/lifecycle.mjs',
    },
  };
  manifest.config = {
    schema: {
      token: {
        type: 'string',
        required: true,
        sensitive: true,
        default: 'secret-token',
      },
    },
  };
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.outputFile(
    path.join(pluginRoot, 'scripts', 'lifecycle.mjs'),
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'fs.appendFileSync(path.join(context.paths.awHome, "events.log"), JSON.stringify({',
      '  event: context.event,',
      '  source: context.script.source,',
      '  artifactCount: context.artifacts.length,',
      '  configToken: context.config.values.token,',
      '  rootDir: context.plugin.rootDir',
      '}) + "\\n");',
    ].join('\n'),
    'utf8',
  );
}

async function makeWorkspace(): Promise<{ repoRoot: string; awHome: string; embeddedRoot: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-lifecycle-command-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await addLifecycleScripts(repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  const awHome = path.join(root, 'aw-home');
  const env = {
    AW_HOME: awHome,
    AW_CODEX_HOME: path.join(root, 'codex-home'),
    AW_FORCE_CODEX_AVAILABLE: '1',
    PATH: process.env.PATH ?? '',
  } as NodeJS.ProcessEnv;
  return { repoRoot, awHome, embeddedRoot, env };
}

interface FakePluginState {
  scopeInitialized?: 'yes' | 'no';
  nativeInstalled?: boolean;
  artifactPath?: string;
}

class FakeAdapter implements PlatformAdapter {
  readonly name: PlatformName;
  readonly installCalls: string[] = [];
  readonly uninstallCalls: string[] = [];

  constructor(
    name: PlatformName,
    private readonly cwd: string,
    private readonly states: Record<string, FakePluginState> = {},
  ) {
    this.name = name;
  }

  private state(pluginName: string): FakePluginState {
    this.states[pluginName] ??= {};
    return this.states[pluginName];
  }

  async detect(): Promise<boolean> {
    return this.name === 'codex';
  }

  async installPlugin(plugin: PluginMeta): Promise<void> {
    this.installCalls.push(plugin.manifest.name);
    this.state(plugin.manifest.name).nativeInstalled = true;
  }

  async uninstallPlugin(plugin: PluginMeta): Promise<void> {
    this.uninstallCalls.push(plugin.manifest.name);
    this.state(plugin.manifest.name).nativeInstalled = false;
  }

  async installExtensions(plugin: PluginMeta, scope: 'project' | 'user'): Promise<GeneratedArtifact[]> {
    const artifactPath = path.join(this.cwd, `.generated-${this.name}`, `${plugin.manifest.name}-${scope}.txt`);
    await fs.outputFile(artifactPath, plugin.manifest.name, 'utf8');
    const state = this.state(plugin.manifest.name);
    state.artifactPath = artifactPath;
    state.scopeInitialized = 'yes';
    return [{ path: artifactPath, kind: 'instruction', platform: this.name }];
  }

  async uninstallExtensions(plugin: PluginMeta): Promise<void> {
    const state = this.state(plugin.manifest.name);
    if (state.artifactPath) {
      await fs.remove(state.artifactPath);
    }
    state.artifactPath = undefined;
    state.scopeInitialized = 'no';
  }

  async upgradePlugin(plugin: PluginMeta, scope: 'project' | 'user'): Promise<void> {
    await this.installPlugin(plugin, scope);
    await this.installExtensions(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: 'project' | 'user'): Promise<StatusReport> {
    const state = this.state(plugin.manifest.name);
    const generatedArtifacts = state.artifactPath
      ? [{
          path: state.artifactPath,
          exists: await fs.pathExists(state.artifactPath),
          kind: 'instruction' as const,
        }]
      : [];
    return {
      platform: this.name,
      scope,
      initialized: state.scopeInitialized === 'yes' || state.nativeInstalled === true,
      plugins: [{
        pluginName: plugin.manifest.name,
        native: {
          marketplaceRegistered: state.nativeInstalled === true,
          pluginAvailable: true,
          pluginInstalled: state.nativeInstalled === true,
          version: plugin.manifest.version,
        },
        generatedArtifacts,
        driftWarnings: [],
        ledgerStateStatus: 'available',
        ledgerStateReason: null,
        scopeInitialized: state.scopeInitialized ?? 'no',
        catalogCompatibility: 'current',
        platformRuntimeEvidence: { present: false },
        platformNativeFallbackEvidence: { present: false },
        scopeManagedEvidence: {
          ledger: state.scopeInitialized === 'yes',
          tracking: generatedArtifacts.length > 0,
          sharedNativeRef: false,
        },
        currentCatalog: {
          rootDir: '/synthetic',
          source: 'embedded',
          available: true,
        },
        artifactsInitialized: generatedArtifacts.every((artifact) => artifact.exists),
        repoManagedSessionState: {
          instructions: generatedArtifacts.length > 0 ? 'visible' : 'absent',
          rules: 'not_applicable',
          hooks: 'not_applicable',
          agents: 'not_applicable',
          diagnostics: [],
        },
        projectTrust: 'not_applicable',
      }],
    };
  }
}

function createAdapters(codex: FakeAdapter, cwd: string): Record<PlatformName, PlatformAdapter> {
  return {
    codex,
    claude: new FakeAdapter('claude', cwd),
  };
}

function readEvents(awHome: string): Promise<Array<Record<string, unknown>>> {
  return fs.readFile(path.join(awHome, 'events.log'), 'utf8')
    .then((content) => content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    .catch(() => []);
}

function codexProjectScope(ledger: InstalledLedger, projectKey: string) {
  return ledger.plugins['git-commit']?.platforms.codex?.projectScopes?.[projectKey];
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin lifecycle command integration', () => {
  it('runs install lifecycle from the pending snapshot before ledger write and stores that snapshot', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    await writeInstalledLedger(createAvailableLedger(), workspace.env);
    const codex = new FakeAdapter('codex', workspace.repoRoot);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
        scriptTimeoutMs: 45000,
      },
      {
        env: workspace.env,
        adapters: createAdapters(codex, workspace.repoRoot),
      },
    );

    const events = await readEvents(workspace.awHome);
    expect(events).toMatchObject([{
      event: 'install',
      source: 'installSnapshot',
      artifactCount: 1,
      configToken: 'secret-token',
    }]);
    const projectKey = await resolveCodexProjectKey(workspace.repoRoot);
    const scopeRecord = codexProjectScope(await readInstalledLedger(workspace.env), projectKey);
    await expect(fs.realpath(scopeRecord!.lifecycleConfigSnapshot!.snapshotRoot)).resolves.toBe(
      await fs.realpath(path.dirname(String(events[0].rootDir))),
    );
    await expect(fs.realpath(scopeRecord!.lifecycleConfigSnapshot!.bundleRoot)).resolves.toBe(
      await fs.realpath(String(events[0].rootDir)),
    );
  });

  it('uses upgrade lifecycle and garbage-collects the old snapshot after a successful upgrade', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    await writeInstalledLedger(createAvailableLedger(), workspace.env);
    const codex = new FakeAdapter('codex', workspace.repoRoot);

    await installCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, scope: 'project', platform: 'codex' },
      { env: workspace.env, adapters: createAdapters(codex, workspace.repoRoot) },
    );
    const projectKey = await resolveCodexProjectKey(workspace.repoRoot);
    const oldSnapshotRoot = codexProjectScope(await readInstalledLedger(workspace.env), projectKey)
      ?.lifecycleConfigSnapshot?.snapshotRoot;
    await fs.remove(path.join(workspace.awHome, 'events.log'));

    await upgradeCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, scope: 'project', platform: 'codex', scriptTimeoutMs: 46000 },
      { env: workspace.env, adapters: createAdapters(codex, workspace.repoRoot) },
    );

    const events = await readEvents(workspace.awHome);
    expect(events).toMatchObject([{ event: 'upgrade', source: 'installSnapshot' }]);
    const newSnapshotRoot = codexProjectScope(await readInstalledLedger(workspace.env), projectKey)
      ?.lifecycleConfigSnapshot?.snapshotRoot;
    expect(newSnapshotRoot).toBeTruthy();
    expect(newSnapshotRoot).not.toBe(oldSnapshotRoot);
    await expect(fs.pathExists(oldSnapshotRoot!)).resolves.toBe(false);
  });

  it('runs uninstall lifecycle before native uninstall and garbage-collects the ledger snapshot', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    await writeInstalledLedger(createAvailableLedger(), workspace.env);
    const codex = new FakeAdapter('codex', workspace.repoRoot);

    await installCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, scope: 'project', platform: 'codex' },
      { env: workspace.env, adapters: createAdapters(codex, workspace.repoRoot) },
    );
    const projectKey = await resolveCodexProjectKey(workspace.repoRoot);
    const snapshotRoot = codexProjectScope(await readInstalledLedger(workspace.env), projectKey)
      ?.lifecycleConfigSnapshot?.snapshotRoot;
    await fs.remove(path.join(workspace.awHome, 'events.log'));

    await uninstallCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, scope: 'project', platform: 'codex', scriptTimeoutMs: 47000 },
      { env: workspace.env, adapters: createAdapters(codex, workspace.repoRoot) },
    );

    const events = await readEvents(workspace.awHome);
    expect(events).toMatchObject([{ event: 'uninstall', source: 'installSnapshot' }]);
    expect(codex.uninstallCalls).toEqual(['git-commit']);
    expect(codexProjectScope(await readInstalledLedger(workspace.env), projectKey)).toBeUndefined();
    await expect(fs.pathExists(snapshotRoot!)).resolves.toBe(false);
  });

  it('adds status config/script health from install snapshots without leaking sensitive config values', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    await writeInstalledLedger(createAvailableLedger(), workspace.env);
    const codex = new FakeAdapter('codex', workspace.repoRoot);

    await installCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, scope: 'project', platform: 'codex' },
      { env: workspace.env, adapters: createAdapters(codex, workspace.repoRoot) },
    );

    const result = await statusCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, scope: 'project', platform: 'codex', json: true },
      { env: workspace.env, adapters: createAdapters(codex, workspace.repoRoot) },
    );
    const payload = JSON.parse(result.output);
    expect(payload.cells[0]).toMatchObject({
      healthSource: 'installSnapshot',
      config: 'configured',
      scripts: 'declared',
      configSources: ['default'],
    });
    expect(result.output).not.toContain('secret-token');
  });
});
