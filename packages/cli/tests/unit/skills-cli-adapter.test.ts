import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addSkills,
  listInstalledSkills,
  probeSkillsCli,
  verifySkillTargets,
  verifySkills,
} from '../../src/portable/skills-cli.js';
import { normalizePortableAgents } from '../../src/portable/commands.js';
import { writeSkillsCliFixture } from '../helpers/skills-cli-fixture.js';

const roots: string[] = [];

async function fakeSkills(options: {
  version?: string;
  list?: unknown;
  addExitCode?: number;
  delayVersion?: boolean;
} = {}): Promise<{ cwd: string; env: NodeJS.ProcessEnv; log: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-fake-skills-'));
  roots.push(root);
  const log = path.join(root, 'calls.jsonl');
  const fixture = await writeSkillsCliFixture(root, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    "fs.appendFileSync(process.env.FAKE_SKILLS_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');",
    "if (process.argv[2] === '--version') { const done = () => { console.log(process.env.FAKE_SKILLS_VERSION); process.exit(0); }; if (process.env.FAKE_SKILLS_DELAY_VERSION === '1') setTimeout(done, 30_000); else done(); }",
    "if (process.argv[2] === 'list') { console.log(process.env.FAKE_SKILLS_LIST); process.exit(0); }",
    "if (process.argv[2] === 'add') process.exit(Number(process.env.FAKE_SKILLS_ADD_EXIT || '0'));",
    'process.exit(2);',
  ].join('\n'), process.env);
  return {
    cwd: root,
    log,
    env: {
      ...fixture.env,
      FAKE_SKILLS_LOG: log,
      FAKE_SKILLS_VERSION: options.version ?? '1.5.23',
      FAKE_SKILLS_LIST: JSON.stringify(options.list ?? []),
      FAKE_SKILLS_ADD_EXIT: String(options.addExitCode ?? 0),
      FAKE_SKILLS_DELAY_VERSION: options.delayVersion ? '1' : '0',
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('Skills CLI adapter', () => {
  it('trims and stably deduplicates safe Agent IDs and rejects unsafe selections', () => {
    expect(normalizePortableAgents([' codex ', 'claude-code', 'codex'])).toEqual(['codex', 'claude-code']);
    for (const invalid of [[], [''], ['two words'], ['-option'], ['line\nbreak'], ['a'.repeat(129)]]) {
      expect(() => normalizePortableAgents(invalid)).toThrow('portableInvalidAgentSelection');
    }
    expect(() => normalizePortableAgents(Array.from({ length: 33 }, (_, index) => `agent-${index}`)))
      .toThrow('portableInvalidAgentSelection');
  });

  it.each([
    ['1.5.22', false],
    ['1.5.23', true],
    ['1.99.99', true],
    ['2.0.0', false],
  ])('enforces the supported version boundary for %s', async (version, supported) => {
    const fake = await fakeSkills({ version });
    const result = probeSkillsCli(fake);
    if (supported) await expect(result).resolves.toEqual({ version });
    else await expect(result).rejects.toThrow('portableSkillsCliIncompatible');
  });

  it('uses exact argv, cwd, global scope, and explicit agents without a shell', async () => {
    const fake = await fakeSkills();
    await addSkills({
      ...fake,
      rootDir: '/materialized/root',
      skills: ['alpha', 'beta'],
      agents: ['codex', 'claude-code'],
      global: true,
    });
    expect(JSON.parse((await fs.readFile(fake.log, 'utf8')).trim())).toEqual({
      args: [
        'add', '/materialized/root', '--skill', 'alpha', 'beta',
        '--agent', 'codex', 'claude-code', '--global', '--yes',
      ],
      cwd: await fs.realpath(fake.cwd),
    });
  });

  it('rejects invalid list JSON and projects verification onto automatic and explicit targets', async () => {
    const invalid = await fakeSkills({ list: { bad: true } });
    await expect(listInstalledSkills({ ...invalid, global: false }))
      .rejects.toThrow('portableSkillsCliVerificationFailed');

    const fake = await fakeSkills({
      list: [{ name: 'alpha', agents: ['Codex', 'Claude Code'], scope: 'project', path: '/safe/alpha' }],
    });
    await expect(verifySkills({ ...fake, skills: ['alpha', 'beta'], global: false }))
      .resolves.toEqual({
        records: [{
          name: 'alpha', agents: ['Codex', 'Claude Code'], scope: 'project', path: '/safe/alpha',
        }],
        missing: [{ skill: 'beta' }],
        unknown: [],
      });
    await expect(verifySkills({
      ...fake,
      skills: ['alpha'],
      agents: ['codex', 'claude-code'],
      global: false,
    })).resolves.toEqual({
      records: [
        { name: 'alpha', agents: ['codex'], scope: 'project', path: '/safe/alpha' },
        { name: 'alpha', agents: ['claude-code'], scope: 'project', path: '/safe/alpha' },
      ],
      missing: [],
      unknown: [],
    });
    const calls = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.map((call) => call.args)).toEqual([
      ['list', '--json'],
      ['list', '--agent', 'codex', '--json'],
      ['list', '--agent', 'claude-code', '--json'],
    ]);
  });

  it('excludes unrelated inventory and preserves non-rectangular exact targets', async () => {
    const fake = await fakeSkills({
      list: [
        { name: 'alpha', agents: ['codex', 'cursor'], scope: 'project' },
        { name: 'unrelated', agents: ['codex'], scope: 'project' },
      ],
    });

    await expect(verifySkillTargets({
      ...fake,
      targets: [
        { skill: 'alpha', agent: 'codex' },
        { skill: 'alpha', agent: 'claude-code' },
        { skill: 'beta', agent: 'cursor' },
      ],
      global: false,
    })).resolves.toEqual({
      records: [{ name: 'alpha', agents: ['codex'], scope: 'project' }],
      missing: [{ skill: 'beta', agent: 'cursor' }],
      unknown: [{ skill: 'alpha', agent: 'claude-code' }],
    });
  });

  it('deduplicates automatic records by Skill and Agent identity', async () => {
    const fake = await fakeSkills({
      list: [
        { name: 'alpha', agents: ['Codex'], scope: 'project' },
        { name: 'alpha', agents: ['codex', 'cursor'], scope: 'project' },
      ],
    });

    await expect(verifySkills({ ...fake, skills: ['alpha'], global: false })).resolves.toEqual({
      records: [{ name: 'alpha', agents: ['Codex', 'cursor'], scope: 'project' }],
      missing: [],
      unknown: [],
    });
  });

  it('keeps automatic results unknown when inventory cannot bind a selected Skill to an Agent', async () => {
    const fake = await fakeSkills({
      list: [
        { name: 'alpha', agents: [], scope: 'project' },
        { name: 'unrelated', agents: ['codex'], scope: 'project' },
      ],
    });

    await expect(verifySkills({ ...fake, skills: ['alpha'], global: false })).resolves.toEqual({
      records: [],
      missing: [],
      unknown: [{ skill: 'alpha' }],
    });
  });

  it('maps a missing executable and add failure to typed blockers without exposing process output', async () => {
    await expect(probeSkillsCli({ cwd: os.tmpdir(), env: { PATH: '' } }))
      .rejects.toThrow('portableSkillsCliMissing');
    const fake = await fakeSkills({ addExitCode: 7 });
    await expect(addSkills({ ...fake, rootDir: '/root', skills: ['alpha'], global: false }))
      .rejects.toThrow('portableSkillsCliInstallFailed');
  });

  it('aborts an in-flight Skills CLI process with the caller signal', async () => {
    const fake = await fakeSkills({ delayVersion: true });
    const abort = new AbortController();
    const pending = probeSkillsCli({ ...fake, signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
