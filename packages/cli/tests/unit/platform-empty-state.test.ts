import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { createPlatformEmptyState, createPlatformInputEvidence, matchesPlatformEmptyState, platformPackageInputDigest, writePlatformEmptyState } from '../../src/utils/platform-empty-state.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import { getQualifiedPlatformProfile } from '../../src/platforms/capabilities.js';
import { resolveArtifactRenderConfig } from '../../src/utils/artifact-renderer.js';
import type { PluginMeta } from '../../src/types.js';
import type { DeploymentObservation } from '../../src/platforms/contracts.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('native intentional empty currentness', () => {
  // Test Value Gate: empty state is reusable only for the complete current source/config/capability/scope inputs, including multiple render units.
  it('matches only the exact binding and input bytes, without running a renderer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const rootDir = path.join(isolation.layout.fixtureCwd, 'plugin');
    const manifestPath = path.join(rootDir, '.agents-plugin', 'plugin.json');
    await fs.outputFile(path.join(rootDir, 'render.mjs'), 'throw new Error("must not execute");\n');
    const plugin: PluginMeta = { rootDir, manifestPath, pluginId: 'local/empty', sourceId: 'local', sourceIdentity: `sha256:${'a'.repeat(64)}`,
      manifest: { schemaVersion: 4, name: 'empty', version: '1.0.0', description: 'Empty', platforms: ['codex'],
        marketplace: { category: 'development', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        artifacts: { configKeys: ['enabled'], scopes: ['user'] },
        managedCommands: { packages: [], sets: [
          { set: 'tools', producer: { kind: 'artifact', platform: 'codex', artifactId: 'tool' }, mode: 'dynamic', refreshKeys: ['commandMode'] },
          { set: 'other', producer: { kind: 'artifact', platform: 'claude', artifactId: 'other' }, mode: 'dynamic', refreshKeys: ['otherMode'] },
        ] },
        config: { schemaVersion: 5, fields: { enabled: { type: 'boolean', default: false },
          commandMode: { type: 'string', default: 'old' }, otherMode: { type: 'string', default: 'other' } }, platforms: {} },
        scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } } } };
    await fs.outputJson(manifestPath, plugin.manifest);
    const adapter = getAgentPluginAdapter('codex');
    const ctx = { cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const resolution = await adapter.resolve(ctx, { plugin: { sourceId: 'local', sourceIdentity: plugin.sourceIdentity!,
      pluginId: plugin.pluginId!, version: '1.0.0' }, scope: { kind: 'user' }, operation: 'ensure', recoveryCandidates: [],
      discovery: { platform: 'codex', availability: 'available', diagnostics: [], installations: [{ id: 'fixture-codex', product: 'cli',
        availability: 'available', version: '0.155.0', reasonCodes: [], entry: { kind: 'cli', executable: '/fixture/codex', configRoot: isolation.env.CODEX_HOME! } }] } });
    const binding = resolution.bindings[0]!;
    const live: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'absent', registration: 'absent', ownership: 'absent', consumers: [], components: [],
      nativeIdentity: null, diagnostics: [], prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } } };
    const units = await Promise.all(resolution.renderUnits.map(async (renderUnit) => ({ renderUnit,
      capabilities: adapter.capabilities({ binding, renderUnit, observation: live, profile: getQualifiedPlatformProfile('codex') }),
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'empty', sourceId: 'local',
        sourceIdentity: plugin.sourceIdentity, platform: 'codex', scope: renderUnit.renderScope.kind, cwd: ctx.cwd, env: ctx.env }),
      prerequisites: live.prerequisites,
    })));
    const state = await createPlatformEmptyState({ plugin, binding, units });
    expect(state.units).toHaveLength(2);
    const packageDigest = platformPackageInputDigest(await createPlatformInputEvidence({ plugin, binding, units }));
    const project = await adapter.resolve(ctx, { plugin: binding.plugin, scope: { kind: 'project', projectRoot: ctx.cwd }, operation: 'ensure',
      recoveryCandidates: [], discovery: { platform: 'codex', availability: 'available', diagnostics: [], installations: binding.consumers } });
    const projectBinding = project.bindings[0]!;
    const projectUnits = await Promise.all(project.renderUnits.map(async (renderUnit) => ({ renderUnit,
      capabilities: adapter.capabilities({ binding: projectBinding, renderUnit, observation: live, profile: getQualifiedPlatformProfile('codex') }),
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'empty', sourceId: 'local',
        sourceIdentity: plugin.sourceIdentity, platform: 'codex', scope: renderUnit.renderScope.kind, cwd: ctx.cwd, env: ctx.env }),
      prerequisites: live.prerequisites,
    })));
    const projectEvidence = await createPlatformInputEvidence({ plugin, binding: projectBinding, units: projectUnits });
    expect(projectEvidence.binding.id).not.toBe(state.binding.id);
    expect(platformPackageInputDigest(projectEvidence)).toBe(packageDigest);
    expect(await matchesPlatformEmptyState({ state, env: ctx.env })).toBe(false);
    await writePlatformEmptyState({ state, env: ctx.env });
    expect(await matchesPlatformEmptyState({ state: await createPlatformEmptyState({ plugin, binding, units }), env: ctx.env })).toBe(true);
    await expect(createPlatformEmptyState({ plugin, binding, units: units.slice(0, 1) })).rejects.toThrow('platformEmptyStateIdentityInvalid');
    const changedScope = { ...state, binding: { ...state.binding, scope: { kind: 'project' as const, projectRoot: ctx.cwd } } };
    expect(await matchesPlatformEmptyState({ state: changedScope, env: ctx.env })).toBe(false);
    const changedCapabilities = structuredClone(units);
    changedCapabilities[0]!.capabilities.profileId = 'different-profile';
    expect(await matchesPlatformEmptyState({ state: await createPlatformEmptyState({ plugin, binding, units: changedCapabilities }), env: ctx.env })).toBe(false);
    const changedConfig = structuredClone(units);
    changedConfig[0]!.config.values.enabled = true;
    expect(platformPackageInputDigest(await createPlatformInputEvidence({ plugin, binding, units: changedConfig }))).not.toBe(packageDigest);
    expect(await matchesPlatformEmptyState({ state: await createPlatformEmptyState({ plugin, binding, units: changedConfig }), env: ctx.env })).toBe(false);
    const commandConfig = structuredClone(units);
    for (const unit of commandConfig) unit.config.values.commandMode = 'saved';
    const commandState = await createPlatformEmptyState({ plugin, binding, units: commandConfig });
    expect(await matchesPlatformEmptyState({ state: commandState, env: ctx.env })).toBe(false);
    for (const unit of units) {
      expect(commandState.units.find((entry) => entry.id === unit.renderUnit.id)!.inputDigest === state.units.find((entry) => entry.id === unit.renderUnit.id)!.inputDigest)
        .toBe(!unit.renderUnit.kinds.includes('skill'));
    }
    const otherConfig = structuredClone(units);
    for (const unit of otherConfig) unit.config.values.otherMode = 'saved';
    expect(await matchesPlatformEmptyState({ state: await createPlatformEmptyState({ plugin, binding, units: otherConfig }), env: ctx.env })).toBe(true);
    await fs.writeFile(path.join(rootDir, 'render.mjs'), 'throw new Error("different source bytes");\n');
    expect(await matchesPlatformEmptyState({ state: await createPlatformEmptyState({ plugin, binding, units }), env: ctx.env })).toBe(false);
  });
});
