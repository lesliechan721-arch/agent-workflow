import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConsoleItemsResult, statusCommand } from '../../src/commands/status.js';
import { CatalogResolutionError } from '../../src/utils/plugin-catalog.js';
import * as pluginCatalogModule from '../../src/utils/plugin-catalog.js';
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

    await expect(loadConsoleItemsResult(
      { includeCatalogOnly: true },
      { env: process.env },
    )).resolves.toEqual({
      items: [],
      catalogUnavailable: true,
    });
  });
});
