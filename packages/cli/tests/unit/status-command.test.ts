import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConsoleItemsResult, statusCommand } from '../../src/commands/status.js';
import { discoverManagedPluginNames } from '../../src/commands/discovery.js';
import { CatalogResolutionError } from '../../src/utils/plugin-catalog.js';
import * as pluginCatalogModule from '../../src/utils/plugin-catalog.js';
import * as detectModule from '../../src/utils/detect.js';
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import * as installStateFacadeModule from '../../src/install-state/facade.js';
import * as installEvidenceModule from '../../src/install-state/evidence.js';
import * as codexNativeStateModule from '../../src/utils/codex-native-state.js';
import * as codexNativeRecoveryModule from '../../src/utils/codex-native-recovery.js';
import * as manifestModule from '../../src/utils/manifest.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import { createInstallStateFixtureEnv } from '../helpers/install-state-projection-fixtures.js';
import { createFakeCodexAppServerHarness } from '../helpers/fake-codex-app-server.js';
import {
  createMinimalPluginInstallStateFixtureBuilder,
  writeMinimalPluginInstallStateFixture,
} from '../helpers/minimal-plugin-install-state-fixtures.js';
import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';

function mockCurrentCatalogBlockedByAwVersion(): void {
  vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(new CatalogResolutionError({
    selector: {
      kind: 'default',
      cliVersion: '1.0.0',
      defaultChannel: 'latest',
    },
    channel: 'latest',
    catalogVersion: '2.0.0',
    minAwVersion: '9.0.0',
    latestCatalogBlocked: {
      channel: 'latest',
      catalogVersion: '2.0.0',
      minAwVersion: '9.0.0',
    },
    reason: 'latest catalog 需要更高的 aw 版本',
    reasonCode: 'awVersionTooLow',
  }));
}

function mockCurrentCatalogUnavailable(): void {
  vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(new CatalogResolutionError({
    selector: {
      kind: 'default',
      cliVersion: '1.0.0',
      defaultChannel: 'latest',
    },
    cacheFallback: {
      used: false,
    },
    reason: 'current catalog is temporarily unavailable',
    reasonCode: 'catalogUnavailable',
  }));
}

afterEach(async () => {
  vi.restoreAllMocks();
});

async function createStatusFixture(rootDirPrefix: string) {
  return writeMinimalPluginInstallStateFixture({
    rootDir: registerCurrentTestWritableStateRoot(
      await fs.mkdtemp(path.join(os.tmpdir(), rootDirPrefix)),
      `status fixture root (${rootDirPrefix})`,
    ),
    scenario: 'installed',
  });
}

async function createCodexUserStatusFixture(rootDirPrefix: string) {
  const rootDir = registerCurrentTestWritableStateRoot(
    await fs.mkdtemp(path.join(os.tmpdir(), rootDirPrefix)),
    `status fixture root (${rootDirPrefix})`,
  );
  const builder = await createMinimalPluginInstallStateFixtureBuilder(rootDir);
  const target = builder.createTarget({ platform: 'codex', scope: 'user' });
  await builder.writeRepoArtifact(target);
  const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
  const record = await builder.writeInstallRecord(target, lifecycle);
  await builder.writeDiagnosticCache(target);
  await builder.writeDependencyIndex([{ target, record }]);
  return {
    paths: builder.paths,
    target,
  };
}

function createAgentVersionRunner(options: {
  codex?: string | Error;
  claude?: string | Error;
} = {}): NativeCliRunner {
  return async (invocation) => {
    if (invocation.args.length !== 1 || invocation.args[0] !== '--version') {
      throw new Error(`Unexpected native CLI invocation in status-command.test.ts: ${invocation.command} ${invocation.args.join(' ')}`.trim());
    }
    const output = invocation.command === 'codex'
      ? options.codex ?? 'codex-cli 0.145.0'
      : invocation.command === 'claude'
        ? options.claude ?? '2.1.88 (Claude Code)'
        : undefined;
    if (output === undefined) {
      throw new Error(`Unexpected native CLI command: ${invocation.command}`);
    }
    if (output instanceof Error) {
      throw output;
    }
    return {
      exitCode: 0,
      stdout: output,
      stderr: '',
    };
  };
}

describe('status command P8', () => {
  it('projects agent version diagnostics into status JSON without raw output unless verbose', async () => {
    const fixture = await createStatusFixture('aw-status-agent-version-json-');
    const env = createInstallStateFixtureEnv(fixture.paths);
    const runtime = {
      env,
      nativeCliRunner: createAgentVersionRunner({
        codex: 'codex-cli 0.130.0',
        claude: '2.1.88 (Claude Code)',
      }),
      p7Targets: [{
        pluginName: fixture.target.location.plugin,
        platform: fixture.target.location.platform,
        scope: fixture.target.location.scope,
        projectKey: fixture.target.location.projectKey ?? undefined,
        executionCwd: fixture.paths.repoRoot,
      }],
    } as never;

    const plain = await statusCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: fixture.target.location.scope,
        platform: fixture.target.location.platform,
        json: true,
      },
      runtime,
    );
    const plainPayload = JSON.parse(plain.output) as {
      agentVersions: Array<{
        platform: string;
        status: string;
        detectedVersion?: string;
        requiredMinVersion: string;
        reasonCode?: string;
        suggestedAction: string;
        rawVersionOutput?: string;
      }>;
      detection: {
        codex: { agentVersion?: { rawVersionOutput?: string; rawOutput?: string } };
      };
      consoleItems: Array<{
        agentVersionSummary?: Array<{ platform: string; status: string; rawVersionOutput?: string }>;
      }>;
    };

    expect(plainPayload.agentVersions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platform: 'codex',
        status: 'tooOld',
        detectedVersion: '0.130.0',
        requiredMinVersion: '0.145.0',
        reasonCode: 'agentVersionTooLow',
        suggestedAction: expect.stringContaining('升级到 >= 0.145.0'),
      }),
      expect.objectContaining({
        platform: 'claude',
        status: 'supported',
        detectedVersion: '2.1.88',
        requiredMinVersion: '2.1.88',
      }),
    ]));
    expect(JSON.stringify(plainPayload)).not.toContain('rawVersionOutput');
    expect(JSON.stringify(plainPayload)).not.toContain('rawOutput');
    expect(plainPayload.consoleItems[0]?.agentVersionSummary).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'codex', status: 'tooOld' }),
    ]));

    const verbose = await statusCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: fixture.target.location.scope,
        platform: fixture.target.location.platform,
        verbose: true,
        json: true,
      },
      runtime,
    );
    const verbosePayload = JSON.parse(verbose.output) as typeof plainPayload;
    expect(verbosePayload.agentVersions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platform: 'codex',
        rawVersionOutput: 'codex-cli 0.130.0',
      }),
    ]));
  });

  it('keeps probeFailed out of ordinary status while still showing actionable version blockers', async () => {
    const fixture = await createStatusFixture('aw-status-agent-version-human-');

    const result = await statusCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: fixture.target.location.scope,
        platform: fixture.target.location.platform,
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        nativeCliRunner: createAgentVersionRunner({
          codex: new Error('version probe exploded'),
          claude: 'not-a-semver',
        }),
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
        }],
      } as never,
    );

    expect(result.output).toContain('Agent 版本提示');
    expect(result.output).toContain('claude: unparseable');
    expect(result.output).toContain('agentVersionUnparseable');
    expect(result.output).not.toContain('probeFailed');
    expect(result.output).not.toContain('version probe exploded');
  });

  it('collects Codex native view diagnostics only for verbose status reads', async () => {
    const fixture = await createCodexUserStatusFixture('aw-status-native-view-');
    const env = createInstallStateFixtureEnv(fixture.paths);
    const pluginId = `${fixture.target.location.plugin}@aw`;
    const harnesses: Array<ReturnType<typeof createFakeCodexAppServerHarness>> = [];
    const createHarness = () => createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/installed' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'plugin-installed-1', result: { plugins: [{ id: pluginId, enabled: true, injectable: true }] } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/read' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'plugin-read-1', result: { id: pluginId, marketplace: 'aw', source: { path: fixture.paths.awHome } } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/list' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'plugin-list-1', result: { plugins: [{ id: pluginId, marketplace: 'aw', mentionable: true }] } },
          },
        ],
      },
    ]);
    const codexAppServerRunner: ReturnType<ReturnType<typeof createFakeCodexAppServerHarness>['createRunner']> = (invocation) => {
      const harness = createHarness();
      harnesses.push(harness);
      return harness.spawn(invocation);
    };
    const runtime = {
      env,
      nativeCliRunner: createAgentVersionRunner(),
      codexAppServerRunner,
      p7Targets: [{
        pluginName: fixture.target.location.plugin,
        platform: fixture.target.location.platform,
        scope: fixture.target.location.scope,
        projectKey: fixture.target.location.projectKey ?? undefined,
        executionCwd: fixture.paths.repoRoot,
      }],
    } as never;

    const plain = await statusCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: fixture.target.location.scope,
        platform: fixture.target.location.platform,
        json: true,
      },
      runtime,
    );
    expect(harnesses).toHaveLength(0);
    expect(JSON.parse(plain.output).locations[0].nativeState.codexNativeView).toBeNull();

    const verbose = await statusCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: fixture.target.location.scope,
        platform: fixture.target.location.platform,
        verbose: true,
        json: true,
      },
      runtime,
    );
    const verbosePayload = JSON.parse(verbose.output) as {
      locations: Array<{
        nativeState: { codexNativeView: { status: string; pluginId: string; summaries: Array<{ method: string }> } };
      }>;
    };

    expect(harnesses.flatMap((harness) => harness.stdinMessages.map((message) => message.json?.method))).toEqual(expect.arrayContaining([
      'plugin/installed',
      'plugin/read',
      'plugin/list',
    ]));
    expect(verbosePayload.locations[0]?.nativeState.codexNativeView).toMatchObject({
      status: 'nativeViewAvailable',
      pluginId,
      summaries: expect.arrayContaining([
        expect.objectContaining({ method: 'plugin/installed' }),
        expect.objectContaining({ method: 'plugin/read' }),
        expect.objectContaining({ method: 'plugin/list' }),
      ]),
    });
    expect(JSON.stringify(verbose.locationReadModelByKey)).toContain('Codex native view');
  });

  it('keeps verbose status on local evidence when current catalog resolution fails closed', async () => {
    const fixture = await createStatusFixture('aw-status-command-');

    mockCurrentCatalogBlockedByAwVersion();

    const result = await statusCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: fixture.target.location.scope,
        platform: fixture.target.location.platform,
        verbose: true,
        json: true,
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
        }],
      } as never,
    );

    const payload = JSON.parse(result.output) as {
      catalog: {
        reasonCode?: string;
        latestCatalogBlocked?: {
          catalogVersion: string;
          minAwVersion: string;
        };
      };
      cells: Array<{
        installState?: {
          currentCatalogAvailable: boolean;
          upgradeAvailable: boolean;
        };
      }>;
    };

    expect(payload.catalog.reasonCode).toBe('awVersionTooLow');
    expect(payload.catalog.latestCatalogBlocked).toMatchObject({
      catalogVersion: '2.0.0',
      minAwVersion: '9.0.0',
    });
    expect(payload.cells[0]?.installState).toMatchObject({
      currentCatalogAvailable: false,
      upgradeAvailable: false,
    });
    expect(result.currentPluginByName).toEqual({});
  });

  it('shows unreadable install record details in verbose status findings', async () => {
    const fixture = await createStatusFixture('aw-status-invalid-record-');
    mockCurrentCatalogBlockedByAwVersion();

    const record = await fs.readJson(fixture.files.installRecordPath) as {
      record: {
        lifecycle: {
          runtimeRoot: string;
          bundleRoot: string;
          manifestPath: string;
        };
      };
    };
    const runtimeRoot = path.join(fixture.paths.rootDir, 'outside-runtime');
    record.record.lifecycle = {
      ...record.record.lifecycle,
      runtimeRoot,
      bundleRoot: path.join(runtimeRoot, 'bundle'),
      manifestPath: path.join(runtimeRoot, 'bundle', 'plugin.json'),
    };
    await fs.writeJson(fixture.files.installRecordPath, record, { spaces: 2 });

    const result = await statusCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: fixture.target.location.scope,
        platform: fixture.target.location.platform,
        verbose: true,
        json: true,
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
        }],
      } as never,
    );

    const payload = JSON.parse(result.output) as {
      locations: Array<{
        reasonCodes: string[];
        issues: Array<{ code: string; detail?: string }>;
        summary: string;
        findings: string[];
        record: { status: string };
      }>;
    };

    expect(payload.locations[0]).toMatchObject({
      record: { status: 'invalid' },
      reasonCodes: expect.arrayContaining(['invalidInstallRecord']),
      issues: [],
    });
    expect(payload.locations[0]?.summary).toContain('需要先清理');
  });

  it('marks console catalogUnavailable when current catalog is unavailable and no plugin rows are present', async () => {
    mockCurrentCatalogUnavailable();

    const result = await loadConsoleItemsResult(
      { includeCatalogOnly: true },
      { env: process.env },
    );
    expect(result).toMatchObject({
      items: [],
      catalogUnavailable: true,
    });
    expect(result.catalog.reasonCode).toBe('catalogUnavailable');
    expect(pluginCatalogModule.resolveCurrentCatalog).toHaveBeenCalledTimes(1);
    expect(pluginCatalogModule.resolveCurrentCatalog).toHaveBeenCalledWith(
      expect.anything(),
      { freshnessPolicy: 'cacheFirst' },
    );
  });

  it('preserves an injected catalog and performs no catalog resolution', async () => {
    const resolveCatalog = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog');
    const resolveCatalogPlugins = vi.spyOn(pluginCatalogModule, 'resolveCatalogPlugins');
    const catalog = {
      rootDir: process.cwd(),
      source: 'remote',
      reason: 'injected unavailable catalog',
      reasonCode: 'catalogUnavailable',
      cacheState: {
        state: 'stale',
        validatedAt: '2026-08-09T00:00:00.000Z',
        ageMs: 60_001,
        ttlMs: 60_000,
      },
    } as const;

    const result = await statusCommand([], { json: true }, {
      env: process.env,
      catalogResolution: catalog,
      p7Targets: [],
    } as never);

    expect(result.catalog).toBe(catalog);
    expect(JSON.parse(result.output)).toMatchObject({
      catalog: { cacheState: catalog.cacheState },
    });
    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(resolveCatalogPlugins).not.toHaveBeenCalled();
  });

  it('keeps one legacy catalog resolution when discovery receives no catalog', async () => {
    const fixture = await createStatusFixture('aw-status-discovery-legacy-catalog-');
    const env = createInstallStateFixtureEnv(fixture.paths);
    const plugin = {
      rootDir: path.join(fixture.paths.rootDir, 'legacy-catalog-plugin'),
      manifestPath: path.join(fixture.paths.rootDir, 'legacy-catalog-plugin', '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'legacy-catalog-plugin',
        version: '1.0.0',
        description: 'legacy catalog plugin',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
      },
    } as const;
    const catalog = {
      rootDir: fixture.paths.rootDir,
      source: 'embedded',
    } as const;
    const legacyResolver = vi.spyOn(pluginCatalogModule, 'resolveCatalogPlugins')
      .mockResolvedValue({ catalog, plugins: [plugin] } as never);
    const directParser = vi.spyOn(manifestModule, 'resolvePluginsFromCatalog');

    const records = await discoverManagedPluginNames({
      cwd: fixture.paths.repoRoot,
      env,
      pluginNames: [plugin.manifest.name],
      includeCurrentCatalog: true,
    });

    expect(legacyResolver).toHaveBeenCalledTimes(1);
    expect(legacyResolver).toHaveBeenCalledWith(undefined, env);
    expect(directParser).not.toHaveBeenCalled();
    expect(records[0]?.currentCatalog).toMatchObject({
      catalog,
      currentPlugin: plugin,
    });
  });

  it('reuses global reads within one status call and rereads them for the next call', async () => {
    const fixture = await createCodexUserStatusFixture('aw-status-read-snapshot-');
    const env = createInstallStateFixtureEnv(fixture.paths);
    mockCurrentCatalogUnavailable();
    const ledger = vi.spyOn(localMarketplaceModule, 'readInstalledLedger');
    const detection = vi.spyOn(detectModule, 'detectEnvironment');
    const dependencyIndex = vi.spyOn(installStateFacadeModule, 'inspectGlobalDependencyIndex');
    const nativeEvidence = vi.spyOn(installEvidenceModule, 'inspectCodexNativeEvidence');
    const nativeState = vi.spyOn(codexNativeStateModule, 'readCodexNativePluginState');
    const nativeRecovery = vi.spyOn(codexNativeRecoveryModule, 'readCodexNativeRecoveryBreadcrumb');
    const versionCalls: string[] = [];
    const nativeCliRunner: NativeCliRunner = async (invocation) => {
      versionCalls.push(invocation.command);
      return {
        exitCode: 0,
        stdout: invocation.command === 'codex' ? 'codex-cli 0.145.0' : '2.1.88 (Claude Code)',
        stderr: '',
      };
    };
    const runtime = {
      env,
      nativeCliRunner,
      p7Targets: [0, 1].map(() => ({
        pluginName: fixture.target.location.plugin,
        platform: fixture.target.location.platform,
        scope: fixture.target.location.scope,
        executionCwd: fixture.paths.repoRoot,
      })),
    } as never;

    await statusCommand([fixture.target.location.plugin], {
      cwd: fixture.paths.repoRoot,
      platform: 'codex',
      scope: 'user',
      json: true,
    }, runtime);

    expect(ledger).toHaveBeenCalledTimes(1);
    expect(detection).toHaveBeenCalledTimes(1);
    expect(dependencyIndex).toHaveBeenCalledTimes(1);
    expect(nativeEvidence).toHaveBeenCalledTimes(1);
    expect(nativeState).toHaveBeenCalledTimes(1);
    expect(nativeRecovery).toHaveBeenCalledTimes(1);
    expect(versionCalls.filter((command) => command === 'codex')).toHaveLength(1);
    expect(versionCalls.filter((command) => command === 'claude')).toHaveLength(1);

    await statusCommand([fixture.target.location.plugin], {
      cwd: fixture.paths.repoRoot,
      platform: 'codex',
      scope: 'user',
      json: true,
    }, runtime);

    expect(ledger).toHaveBeenCalledTimes(2);
    expect(detection).toHaveBeenCalledTimes(2);
    expect(dependencyIndex).toHaveBeenCalledTimes(2);
    expect(nativeEvidence).toHaveBeenCalledTimes(2);
    expect(nativeState).toHaveBeenCalledTimes(2);
    expect(nativeRecovery).toHaveBeenCalledTimes(2);
  });

  it('reuses the injected catalog and status snapshot for catalog-only console candidates', async () => {
    const fixture = await createStatusFixture('aw-status-catalog-only-snapshot-');
    const env = createInstallStateFixtureEnv(fixture.paths);
    const plugin = {
      rootDir: path.join(fixture.paths.rootDir, 'catalog-plugin'),
      manifestPath: path.join(fixture.paths.rootDir, 'catalog-plugin', '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'catalog-only-plugin',
        version: '1.0.0',
        description: 'catalog only plugin',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
      },
    } as const;
    const resolvePlugins = vi.spyOn(manifestModule, 'resolvePluginsFromCatalog')
      .mockResolvedValue([plugin] as never);
    const resolveCatalog = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog');
    const ledger = vi.spyOn(localMarketplaceModule, 'readInstalledLedger');
    const detection = vi.spyOn(detectModule, 'detectEnvironment');
    const dependencyIndex = vi.spyOn(installStateFacadeModule, 'inspectGlobalDependencyIndex');
    const catalog = {
      rootDir: fixture.paths.rootDir,
      source: 'embedded',
    } as const;

    const result = await loadConsoleItemsResult({
      cwd: fixture.paths.repoRoot,
      includeCatalogOnly: true,
    }, {
      env,
      catalogResolution: catalog,
      nativeCliRunner: createAgentVersionRunner(),
    } as never);

    expect(result.catalog).toBe(catalog);
    expect(result.items.some((item) => item.summary.pluginName === plugin.manifest.name)).toBe(true);
    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(resolvePlugins).toHaveBeenCalledTimes(1);
    expect(resolvePlugins).toHaveBeenCalledWith(catalog.rootDir, undefined);
    expect(ledger).toHaveBeenCalledTimes(1);
    expect(detection).toHaveBeenCalledTimes(1);
    expect(dependencyIndex).toHaveBeenCalledTimes(1);
  });
});
