import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('plugin capabilities command', () => {
  it('emits one combined JSON object for a selected surface', async () => {
    const output = capture();
    expect(await runCli(['dev', 'plugin', 'capabilities', '--surface', 'manifest', '--json'], {
      io: output.io,
    })).toBe(0);
    const result = JSON.parse(output.stdout()).data;
    expect(result).toMatchObject({
      awVersion: expect.any(String), coreVersion: expect.any(String), surface: 'manifest',
    });
    expect(Object.keys(result.capabilities).sort()).toEqual(['manifest']);
    expect(result.capabilities.manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'marketplace.policy.installation', type: 'enum', required: true,
        owner: 'core',
        provenance: expect.arrayContaining(['@lesliechan721/aw-plugin-core manifest structure registry']),
        acceptedValues: ['AVAILABLE', 'NOT_AVAILABLE', 'INSTALLED_BY_DEFAULT'],
      }),
      expect.objectContaining({
        field: 'dependencies',
        owner: 'core',
        provenance: expect.arrayContaining(['@lesliechan721/aw CLI authoring adapter']),
        requires: expect.any(String),
        conflicts: expect.any(String),
      }),
      expect.objectContaining({
        field: 'platforms',
        acceptedValues: ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'copilot', 'grok', 'generic'],
        profiles: 'codex, claude, antigravity, cursor, opencode, pi, copilot, grok, generic',
        requires: expect.stringContaining('all canonical targets'),
      }),
      expect.objectContaining({
        field: 'skills',
        profiles: expect.stringContaining('one ./skills source root'),
        requires: expect.stringContaining('production README.md'),
      }),
    ]));
    expect(result.capabilities.manifest.map((entry: { field: string }) => entry.field)).not.toEqual(expect.arrayContaining([
      'distributions.agentSkills', 'distributions.agentSkills.skills', 'marketplace.policy.products',
    ]));
    expect(output.stderr()).toBe('');
  });

  it('uses null for the full query and emits every fixed surface', async () => {
    const output = capture();
    expect(await runCli(['dev', 'plugin', 'capabilities', '--json'], { io: output.io })).toBe(0);
    const result = JSON.parse(output.stdout()).data;
    expect(result.surface).toBeNull();
    expect(result.capabilities['platform-capabilities']).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'schemaVersion', acceptedValues: [3] }),
      expect.objectContaining({ field: 'status', acceptedValues: ['supported', 'unsupported'] }),
      expect.objectContaining({ field: 'agentNamingMode', acceptedValues: ['host-plugin', 'aw-prefix', 'unsupported'] }),
      expect.objectContaining({ field: 'features.agent.model', requires: expect.stringContaining('inherit, flash_lite, flash, pro') }),
    ]));
    expect(result.capabilities['platform-capabilities'].map(({ field }: { field: string }) => field))
      .not.toContainEqual(expect.stringMatching(/^features\.component\.kind\./u));
    expect(result.capabilities['platform-capabilities']).toContainEqual(expect.objectContaining({
      field: 'kinds.<kind>', acceptedValues: ['skill', 'mcp', 'agent', 'hook', 'instruction'],
    }));
    expect(result.capabilities['platform-components']).toContainEqual(expect.objectContaining({
      field: 'components[].requires', type: expect.stringContaining('component.kind.<kind>'),
    }));
    expect(result.capabilities.artifacts).toContainEqual(expect.objectContaining({ field: 'rendererContext.agentNaming', required: true }));
    expect(Object.keys(result.capabilities).sort()).toEqual([
      'manifest', 'build-config', 'extensions', 'mcp', 'config', 'pre-apply',
      'managed-commands', 'native-tools', 'artifacts', 'platform-components', 'platform-capabilities', 'hook-handlers',
    ].sort());
    expect(output.stderr()).toBe('');
  });

  it('returns a structured parameter error for an unknown surface', async () => {
    const output = capture();
    expect(await runCli(['dev', 'plugin', 'capabilities', '--surface', 'unknown', '--json'], {
      io: output.io,
    })).toBe(2);
    expect(JSON.parse(output.stdout())).toMatchObject({
      schemaVersion: 2, command: 'dev.plugin.capabilities', status: 'failed', data: {},
      diagnostics: [{ code: 'invalidArguments' }],
    });
  });

  it('publishes the exact renderer request context contract', async () => {
    const output = capture();
    expect(await runCli(['dev', 'plugin', 'capabilities', '--surface', 'artifacts', '--json'], {
      io: output.io,
    })).toBe(0);
    const result = JSON.parse(output.stdout()).data;
    expect(result.capabilities.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'artifacts.configKeys', required: true }),
      expect.objectContaining({ field: 'rendererContext.allowedOutputKinds', required: true,
        acceptedValues: ['skill', 'mcp', 'agent', 'hook', 'instruction'] }),
      expect.objectContaining({ field: 'rendererContext.platformCapabilities', required: true }),
    ]));
    expect(result.capabilities.artifacts.map((entry: { field: string }) => entry.field)).not.toEqual(expect.arrayContaining([
      'artifacts.targets', 'rendererContext.requestedArtifactIds', 'rendererContext.previousArtifacts',
    ]));
  });

  it('exposes independently gated v5 field declarations on the config surface', async () => {
    const output = capture();
    expect(await runCli(['dev', 'plugin', 'capabilities', '--surface', 'config', '--json'], { io: output.io })).toBe(0);
    const entries = JSON.parse(output.stdout()).data.capabilities.config;
    for (const [field, capability] of [
      ['platformOnly', 'aw.plugin-config-platform-only.v1'],
      ['properties.<property>.clearsOnChange', 'aw.plugin-config-clears-on-change.v1'],
      ['$ref', 'aw.plugin-config-ref-override.v1'],
      ['suggestions', 'aw.plugin-config-suggestions.v2'],
    ]) {
      expect(entries).toContainEqual(expect.objectContaining({ field: `config.fields.<key>.${field}`, requires: expect.stringContaining(capability) }));
    }
  });

  it('renders a compact human view', async () => {
    const output = capture();
    expect(await runCli(['dev', 'plugin', 'capabilities', '--surface', 'pre-apply'], {
      io: output.io,
    })).toBe(0);
    expect(output.stdout()).toContain('Plugin authoring capabilities');
    expect(output.stdout()).toContain('pre-apply:');
    expect(output.stdout()).toContain('scripts.preApply');
    expect(output.stdout()).toContain('values=1000..1800000');
    expect(output.stdout()).toContain('requires=A Node entry inside the plugin root.');
    expect(output.stderr()).toBe('');
  });
});
