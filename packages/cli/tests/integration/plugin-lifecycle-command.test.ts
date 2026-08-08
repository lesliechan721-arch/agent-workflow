import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installCommand } from '../../src/commands/install.js';
import { readInstallRecordForLocation } from '../../src/install-state/facade.js';
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
} from '../../src/utils/paths.js';
import { resolveSafeCliEnv } from '../helpers/cli-runtime.js';
import { activateCliEmbeddedRoot, createCliTestWorkspace } from '../helpers/workspace.js';

const tempDirs: string[] = [];

async function addLifecycleScripts(repoRoot: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  delete manifest.apps;
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
  await fs.remove(path.join(pluginRoot, '.app.json'));
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
  const workspace = await createCliTestWorkspace({
    rootDirPrefix: 'aw-lifecycle-command-',
    mutateRepo: addLifecycleScripts,
  });
  tempDirs.push(workspace.rootDir);
  tempDirs.push(workspace.embeddedRoot!);

  const env = resolveSafeCliEnv({
    ...workspace.env,
    AW_FORCE_CODEX_AVAILABLE: '1',
  });

  return {
    repoRoot: workspace.repoRoot,
    awHome: workspace.awHome,
    embeddedRoot: workspace.embeddedRoot!,
    env,
  };
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

function normalizeMacTmpPath(value: string): string {
  return value.replace(/^\/private(?=\/var\/folders\/)/, '');
}

async function readCodexProjectInstallRecord(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  projectKey: string,
) {
  return readInstallRecordForLocation({
    cwd: repoRoot,
    location: {
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'project',
      projectKey,
    },
    env,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin lifecycle command integration', () => {
  it('runs install lifecycle before install record commit and writes a historical lifecycle runtime', async () => {
    const workspace = await makeWorkspace();
    activateCliEmbeddedRoot(workspace.embeddedRoot, 'plugin lifecycle install embedded root');
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
      artifactCount: 2,
      configToken: 'secret-token',
    }]);
    const projectKey = await resolveCodexProjectKey(workspace.repoRoot);
    const recordRead = await readCodexProjectInstallRecord(workspace.repoRoot, workspace.env, projectKey);
    expect(recordRead.status).toBe('ok');
    if (recordRead.status !== 'ok') {
      throw new Error(`expected install record, got ${recordRead.status}`);
    }

    const lifecycle = recordRead.value.record.lifecycle;
    expect(lifecycle).toBeTruthy();
    await expect(fs.pathExists(lifecycle!.runtimeRoot)).resolves.toBe(true);
    await expect(fs.realpath(lifecycle!.bundleRoot)).resolves.toBe(
      await fs.realpath(path.join(lifecycle!.runtimeRoot, 'bundle')),
    );
    await expect(fs.realpath(lifecycle!.manifestPath)).resolves.toBe(
      await fs.realpath(path.join(lifecycle!.bundleRoot, '.agents-plugin', 'plugin.json')),
    );
  });

  it('updates the historical lifecycle runtime reference on upgrade', async () => {
    const workspace = await makeWorkspace();
    activateCliEmbeddedRoot(workspace.embeddedRoot, 'plugin lifecycle upgrade embedded root');
    await writeInstalledLedger(createAvailableLedger(), workspace.env);
    const codex = new FakeAdapter('codex', workspace.repoRoot);

    await installCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, scope: 'project', platform: 'codex' },
      { env: workspace.env, adapters: createAdapters(codex, workspace.repoRoot) },
    );
    const projectKey = await resolveCodexProjectKey(workspace.repoRoot);
    const oldRecordRead = await readCodexProjectInstallRecord(workspace.repoRoot, workspace.env, projectKey);
    expect(oldRecordRead.status).toBe('ok');
    if (oldRecordRead.status !== 'ok') {
      throw new Error(`expected install record, got ${oldRecordRead.status}`);
    }
    const oldRuntimeRoot = oldRecordRead.value.record.lifecycle?.runtimeRoot;
    await fs.remove(path.join(workspace.awHome, 'events.log'));

    await upgradeCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
        scriptTimeoutMs: 46000,
      },
      { env: workspace.env, adapters: createAdapters(codex, workspace.repoRoot) },
    );

    const events = await readEvents(workspace.awHome);
    expect(events).toMatchObject([{ event: 'upgrade' }]);
    const newRecordRead = await readCodexProjectInstallRecord(workspace.repoRoot, workspace.env, projectKey);
    expect(newRecordRead.status).toBe('ok');
    if (newRecordRead.status !== 'ok') {
      throw new Error(`expected install record, got ${newRecordRead.status}`);
    }
    const newRuntimeRoot = newRecordRead.value.record.lifecycle?.runtimeRoot;
    expect(newRuntimeRoot).toBeTruthy();
    expect(newRuntimeRoot).not.toBe(oldRuntimeRoot);
    await expect(fs.pathExists(newRuntimeRoot!)).resolves.toBe(true);
  });

  it('runs uninstall lifecycle from the historical runtime before native uninstall and garbage-collects it', async () => {
    const workspace = await makeWorkspace();
    activateCliEmbeddedRoot(workspace.embeddedRoot, 'plugin lifecycle uninstall embedded root');
    await writeInstalledLedger(createAvailableLedger(), workspace.env);
    const codex = new FakeAdapter('codex', workspace.repoRoot);

    await installCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, scope: 'project', platform: 'codex' },
      { env: workspace.env, adapters: createAdapters(codex, workspace.repoRoot) },
    );
    const projectKey = await resolveCodexProjectKey(workspace.repoRoot);
    const recordRead = await readCodexProjectInstallRecord(workspace.repoRoot, workspace.env, projectKey);
    expect(recordRead.status).toBe('ok');
    if (recordRead.status !== 'ok') {
      throw new Error(`expected install record, got ${recordRead.status}`);
    }
    const lifecycle = recordRead.value.record.lifecycle;
    expect(lifecycle).toBeTruthy();
    await fs.remove(path.join(workspace.awHome, 'events.log'));

    await uninstallCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, scope: 'project', platform: 'codex', scriptTimeoutMs: 47000 },
      { env: workspace.env, adapters: createAdapters(codex, workspace.repoRoot) },
    );

    const events = await readEvents(workspace.awHome);
    expect(events).toMatchObject([{ event: 'uninstall' }]);
    expect(normalizeMacTmpPath(String(events[0]!.rootDir))).toBe(
      normalizeMacTmpPath(lifecycle!.bundleRoot),
    );
    expect(codex.uninstallCalls).toEqual(['git-commit']);
    const postUninstallRecordRead = await readCodexProjectInstallRecord(workspace.repoRoot, workspace.env, projectKey);
    expect(postUninstallRecordRead.status).toBe('missing');
    await expect(fs.pathExists(lifecycle!.runtimeRoot)).resolves.toBe(false);
  });

  it('reports status health from the current catalog without leaking sensitive config values', async () => {
    const workspace = await makeWorkspace();
    activateCliEmbeddedRoot(workspace.embeddedRoot, 'plugin lifecycle status embedded root');
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
      healthSource: 'currentCatalog',
    });
    expect(result.output).not.toContain('secret-token');
  });

  it('keeps status health on the current catalog even when the historical runtime is missing', async () => {
    const workspace = await makeWorkspace();
    activateCliEmbeddedRoot(workspace.embeddedRoot, 'plugin lifecycle missing runtime embedded root');
    await writeInstalledLedger(createAvailableLedger(), workspace.env);
    const codex = new FakeAdapter('codex', workspace.repoRoot);

    await installCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, scope: 'project', platform: 'codex' },
      { env: workspace.env, adapters: createAdapters(codex, workspace.repoRoot) },
    );

    const projectKey = await resolveCodexProjectKey(workspace.repoRoot);
    const recordRead = await readCodexProjectInstallRecord(workspace.repoRoot, workspace.env, projectKey);
    expect(recordRead.status).toBe('ok');
    if (recordRead.status !== 'ok') {
      throw new Error(`expected install record, got ${recordRead.status}`);
    }
    expect(recordRead.value.record.lifecycle).toBeTruthy();
    await fs.remove(recordRead.value.record.lifecycle!.runtimeRoot);

    const result = await statusCommand(
      ['git-commit'],
      { cwd: workspace.repoRoot, scope: 'project', platform: 'codex', json: true },
      { env: workspace.env, adapters: createAdapters(codex, workspace.repoRoot) },
    );

    const payload = JSON.parse(result.output);
    expect(payload.cells[0]).toMatchObject({
      healthSource: 'currentCatalog',
    });
    expect(result.output).not.toContain('secret-token');
  });
});
