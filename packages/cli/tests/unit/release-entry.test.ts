import { describe, expect, it, vi } from 'vitest';

import {
  commitReleaseMetadata,
  parseReleaseArgs,
  runRelease,
} from '../../../../scripts/release/release.mjs';
import { calculateCanonicalDigest } from '../../../../scripts/release/release-model.mjs';
import { assertPreparedCliAttempt } from '../../../../scripts/release/prepared-release.mjs';

const targets = { schemaVersion: 1, cli: '0.1.0', catalog: '0.1.0' };

describe('one-command release entry', () => {
  it('parses channels, explicit axes, bumps, and tag repair as separate contracts', () => {
    expect(parseReleaseArgs([
      'beta', '--all', '--cli-bump', 'patch', '--catalog-bump', 'minor',
      '--plugin', 'git-toolkit=patch',
    ])).toMatchObject({
      channel: 'beta',
      axes: { cli: true, catalog: true },
      cliBump: 'patch',
      catalogBump: 'minor',
    });
    expect(parseReleaseArgs(['release', '--catalog'])).toMatchObject({
      channel: 'stable', axes: { cli: false, catalog: true },
    });
    expect(parseReleaseArgs(['--repair-cli'])).toEqual({ repairCli: true });
    expect(parseReleaseArgs(['--repair-cli-tag'])).toEqual({ repairCliTag: true });
    expect(() => parseReleaseArgs(['beta'])).toThrow('Select exactly one');
    expect(() => parseReleaseArgs(['beta', '--cli', '--catalog'])).toThrow('exactly one');
    expect(() => parseReleaseArgs(['beta', '--catalog', '--cli-bump', 'patch']))
      .toThrow('--cli-bump requires');
    expect(() => parseReleaseArgs(['--repair-cli-tag', '--cli']))
      .toThrow('cannot be combined');
    expect(() => parseReleaseArgs(['--repair-cli', '--cli']))
      .toThrow('cannot be combined');
  });

  it('commits only generated release metadata paths when bumps are requested', async () => {
    const parsed = parseReleaseArgs([
      'beta', '--all', '--cli-bump', 'patch', '--catalog-bump', 'minor',
      '--plugin', 'git-toolkit=patch',
    ]);
    const runGit = vi.fn(async (args: string[]) => ({
      stdout: args[0] === 'diff'
        ? [
            'release/version-targets.json',
            'packages/cli/package.json',
            'packages/agent-skill-eval/package.json',
            'packages/plugin-core/package.json',
            'pnpm-lock.yaml',
            'plugins/git-toolkit/.agents-plugin/plugin.json',
            '',
          ].join('\0')
        : '',
      stderr: '',
    }));
    const updateTargets = vi.fn(async () => ({ targets }));

    await commitReleaseMetadata(parsed, { repoRoot: '/repo', runGit, updateTargets });

    expect(updateTargets).toHaveBeenCalledWith([
      '--cli', 'patch', '--catalog', 'minor', '--plugin', 'git-toolkit=patch',
    ], expect.objectContaining({ repoRoot: '/repo' }));
    expect(runGit).toHaveBeenCalledWith([
      'add', '--',
      'release/version-targets.json',
      'packages/cli/package.json',
      'packages/agent-skill-eval/package.json',
      'packages/plugin-core/package.json',
      'pnpm-lock.yaml',
      'plugins/git-toolkit/.agents-plugin/plugin.json',
    ], expect.any(Object));
    expect(runGit).toHaveBeenCalledWith([
      'diff', '--cached', '--name-only', '-z',
    ], expect.any(Object));
    expect(runGit).toHaveBeenCalledWith([
      'commit', '-m', 'chore(release): set release targets',
    ], expect.any(Object));
  });

  it('runs verification before prepare and publishes only after all preflight checks', async () => {
    const events: string[] = [];
    const descriptor = {
      channel: 'beta',
      candidates: { cli: '0.1.0-beta.1', catalog: '0.1.0-beta.1' },
    };
    await runRelease(['beta', '--all'], {
      repoRoot: '/repo',
      assertClean: async () => { events.push('clean'); },
      assertTargetsMatchHead: async () => { events.push('head'); },
      commitMetadata: async () => { events.push('metadata'); return null; },
      readTargets: async () => targets,
      resolveCandidates: async () => descriptor.candidates,
      assertCliTagAvailable: async () => { events.push('tag-preflight'); },
      runVerification: async (_command: string, args: string[]) => {
        events.push(args[1]);
      },
      prepare: async () => { events.push('prepare'); return descriptor; },
      publish: async () => { events.push('publish'); return descriptor; },
    });

    expect(events).toEqual([
      'clean', 'head', 'metadata', 'clean', 'tag-preflight',
      'release:verify', 'clean', 'prepare', 'publish',
    ]);
  });

  it('stops before verification when a selected axis has no candidate', async () => {
    const runVerification = vi.fn();
    await expect(runRelease(['release', '--all'], {
      repoRoot: '/repo',
      assertClean: async () => undefined,
      assertTargetsMatchHead: async () => undefined,
      commitMetadata: async () => null,
      readTargets: async () => targets,
      resolveCandidates: async () => ({ cli: null, catalog: '0.1.0' }),
      runVerification,
    })).rejects.toThrow('Selected CLI axis has no release candidate');
    expect(runVerification).not.toHaveBeenCalled();
  });

  it('repairs a CLI tag from the prepared descriptor without running a normal release', async () => {
    const events: string[] = [];
    const descriptor = {
      source: { head: 'a'.repeat(40) },
      axes: { cli: true, catalog: false },
      candidates: { cli: '0.1.0-beta.1', catalog: null },
    };
    await runRelease(['--repair-cli-tag'], {
      repoRoot: '/repo',
      readDescriptor: async () => ({ root: '/prepared', descriptor }),
      assertPreparedCliAttempt: async () => { events.push('attempt'); },
      assertPreparedCliArtifacts: async () => { events.push('prepared'); },
      assertPublishedCliArtifactsMatch: async () => { events.push('registry'); },
      runGit: async () => { events.push('commit'); return { stdout: '', stderr: '' }; },
      ensureCliTag: async () => {
        events.push('tag');
        return { version: '0.1.0-beta.1', sourceHead: descriptor.source.head, status: 'published' };
      },
    });
    expect(events).toEqual(['attempt', 'prepared', 'registry', 'commit', 'tag']);
  });

  it('dispatches explicit CLI package repair without running a normal release', async () => {
    const repairCli = vi.fn(async () => ({
      version: '0.1.0-beta.1',
      sourceHead: 'a'.repeat(40),
      status: 'published',
    }));

    await expect(runRelease(['--repair-cli'], { repairCli })).resolves.toMatchObject({
      version: '0.1.0-beta.1',
      status: 'published',
    });
    expect(repairCli).toHaveBeenCalledOnce();
  });

  it('rejects CLI tag repair when the prepared source changed after the CLI attempt', async () => {
    const original = {
      schemaVersion: 1,
      source: { head: 'a'.repeat(40), targetsDigest: 'sha256:targets' },
      axes: { cli: true, catalog: false },
      candidates: { cli: '0.1.0-beta.1', catalog: null },
    };
    const changed = {
      ...original,
      source: { ...original.source, head: 'b'.repeat(40) },
    };

    await expect(assertPreparedCliAttempt(changed, {
      readAttempt: async () => ({
        schemaVersion: 1,
        targetsDigest: original.source.targetsDigest,
        candidates: { cli: original.candidates.cli },
        descriptorDigest: calculateCanonicalDigest(original),
      }),
    })).rejects.toThrow('attempt marker does not match');
  });
});
