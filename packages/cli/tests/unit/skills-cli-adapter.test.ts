import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addSkills,
  listInstalledSkills,
  probeSkillsCli,
  verifySkills,
} from '../../src/portable/skills-cli.js';
import { normalizePortableAgents } from '../../src/portable/commands.js';

const roots: string[] = [];

async function fakeSkills(options: {
  version?: string;
  list?: unknown;
  addExitCode?: number;
  delayVersion?: boolean;
} = {}): Promise<{ cwd: string; env: NodeJS.ProcessEnv; log: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-fake-skills-'));
  roots.push(root);
  const executable = path.join(root, 'skills');
  const log = path.join(root, 'calls.jsonl');
  await fs.writeFile(executable, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.FAKE_SKILLS_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');",
    "if (process.argv[2] === '--version') { const done = () => { console.log(process.env.FAKE_SKILLS_VERSION); process.exit(0); }; if (process.env.FAKE_SKILLS_DELAY_VERSION === '1') setTimeout(done, 30_000); else done(); }",
    "if (process.argv[2] === 'list') { console.log(process.env.FAKE_SKILLS_LIST); process.exit(0); }",
    "if (process.argv[2] === 'add') process.exit(Number(process.env.FAKE_SKILLS_ADD_EXIT || '0'));",
    'process.exit(2);',
  ].join('\n'));
  await fs.chmod(executable, 0o755);
  return {
    cwd: root,
    log,
    env: {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
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

  it('rejects invalid list JSON and verifies default and explicit modes from list evidence', async () => {
    const invalid = await fakeSkills({ list: { bad: true } });
    await expect(listInstalledSkills({ ...invalid, global: false }))
      .rejects.toThrow('portableSkillsCliVerificationFailed');

    const fake = await fakeSkills({
      list: [{ name: 'alpha', agents: ['Codex'], scope: 'project', path: '/safe/alpha' }],
    });
    await expect(verifySkills({ ...fake, skills: ['alpha', 'beta'], global: false }))
      .resolves.toMatchObject({ missing: [{ skill: 'beta' }] });
    await expect(verifySkills({
      ...fake,
      skills: ['alpha'],
      agents: ['codex', 'claude-code'],
      global: false,
    })).resolves.toMatchObject({ missing: [] });
    const calls = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.map((call) => call.args)).toEqual([
      ['list', '--json'],
      ['list', '--agent', 'codex', '--json'],
      ['list', '--agent', 'claude-code', '--json'],
    ]);
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
