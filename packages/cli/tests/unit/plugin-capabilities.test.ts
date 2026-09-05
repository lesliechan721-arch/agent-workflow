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
    expect(await runCli(['plugin', 'capabilities', '--surface', 'manifest', '--json'], {
      io: output.io,
    })).toBe(0);
    const result = JSON.parse(output.stdout());
    expect(result).toMatchObject({
      command: 'plugin:capabilities', schemaVersion: 1,
      awVersion: expect.any(String), coreVersion: expect.any(String), surface: 'manifest',
    });
    expect(Object.keys(result.capabilities)).toEqual(['manifest']);
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
        field: 'distributions.agentSkills',
        profiles: 'agent-skills',
        requires: expect.stringContaining('native capability'),
        conflicts: expect.stringContaining('Portable-only'),
      }),
      expect.objectContaining({
        field: 'distributions.agentSkills.skills',
        profiles: 'agent-skills static',
        requires: expect.stringContaining('production README.md'),
      }),
    ]));
    expect(output.stderr()).toBe('');
  });

  it('uses null for the full query and emits every fixed surface', async () => {
    const output = capture();
    expect(await runCli(['plugin', 'capabilities', '--json'], { io: output.io })).toBe(0);
    const result = JSON.parse(output.stdout());
    expect(result.surface).toBeNull();
    expect(Object.keys(result.capabilities)).toEqual([
      'manifest', 'build-config', 'extensions', 'slash-commands',
      'mcp-apps', 'config', 'pre-apply', 'artifacts',
    ]);
    expect(output.stderr()).toBe('');
  });

  it('fails closed for an unknown surface without JSON stdout', async () => {
    const output = capture();
    expect(await runCli(['plugin', 'capabilities', '--surface', 'unknown', '--json'], {
      io: output.io,
    })).toBe(1);
    expect(output.stdout()).toBe('');
    expect(output.stderr()).toContain('Unknown plugin capability surface');
  });

  it('publishes the exact renderer request context contract', async () => {
    const output = capture();
    expect(await runCli(['plugin', 'capabilities', '--surface', 'artifacts', '--json'], {
      io: output.io,
    })).toBe(0);
    const result = JSON.parse(output.stdout());
    expect(result.capabilities.artifacts).toContainEqual(expect.objectContaining({
      field: 'rendererContext.requestedArtifactIds',
      required: true,
      requires: 'Return exactly these declared artifacts and no other artifacts.',
    }));
  });

  it('renders a compact human view', async () => {
    const output = capture();
    expect(await runCli(['plugin', 'capabilities', '--surface', 'pre-apply'], {
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
