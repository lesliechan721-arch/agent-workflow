import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addSkills,
  listInstalledSkills,
  probeSkillsCli,
  probePortableRecoverySkillsCli,
  verifySkillTargets,
  verifySkills,
  type SkillsCliRunner,
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

async function windowsSkills(kind: 'npm-global' | 'npm-local' | 'pnpm' | 'pnpm-basic'): Promise<
  Awaited<ReturnType<typeof fakeSkills>> & { launcher: string; shim: string; packageRoot: string }
> {
  const fake = await fakeSkills();
  const prefix = path.join(fake.cwd, 'prefix with spaces');
  const binRoot = kind === 'npm-local' ? path.join(prefix, 'node_modules', '.bin') : prefix;
  const packageRoot = kind.startsWith('pnpm')
    ? path.join(prefix, 'global', '5', 'node_modules', 'skills')
    : path.join(prefix, 'node_modules', 'skills');
  const launcher = path.join(packageRoot, 'bin', 'cli.mjs');
  const shim = path.join(binRoot, 'skills.cmd');
  await fs.ensureDir(path.dirname(launcher));
  await fs.ensureDir(binRoot);
  await fs.writeFile(launcher, (await fs.readFile(path.join(fake.cwd, 'skills'), 'utf8'))
    .replace("const fs = require('node:fs');", "import fs from 'node:fs';"));
  await fs.writeJson(path.join(packageRoot, 'package.json'), {
    name: 'skills', version: '1.5.23', type: 'module', bin: { skills: './bin/cli.mjs' },
  });
  const target = path.relative(binRoot, launcher).split(path.sep).join('\\');
  // Fixtures follow npm cmd-shim@8.0.0 and pnpm@10.33.0's @zkochan/cmd-shim@7.0.0.
  const nodePath = 'C:\\pnpm home\\global\\5\\node_modules\\.pnpm\\node_modules';
  const content = kind.startsWith('pnpm') ? [
    '@SETLOCAL',
    ...(kind === 'pnpm' ? [
      '@IF NOT DEFINED NODE_PATH (',
      `  @SET "NODE_PATH=${nodePath}"`,
      ') ELSE (',
      `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`,
      ')',
    ] : []),
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${target}" %*`,
    ')',
    '',
  ] : [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
    'SETLOCAL', 'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
    '',
  ];
  await fs.writeFile(shim, content.join('\r\n'));
  return { ...fake, launcher, shim, packageRoot,
    env: { ...fake.env, PATH: `"${binRoot}"`, PATHEXT: '.cmd' } };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('Skills CLI adapter', () => {
  it.each(['npm-global', 'npm-local', 'pnpm', 'pnpm-basic'] as const)(
    'runs Windows %s Node bins for public probes, lists and both recovery scopes', async (kind) => {
      const fake = await windowsSkills(kind);
      const options = { ...fake, platform: 'win32' as const };
      await expect(probePortableRecoverySkillsCli(options)).resolves.toEqual({ version: '1.5.23' });
      const scopeCwds: string[] = [];
      for (const global of [false, true]) {
        const cwd = path.join(fake.cwd, global ? 'neutral' : 'project');
        await fs.ensureDir(cwd);
        scopeCwds.push(await fs.realpath(cwd));
        await expect(listInstalledSkills({ ...options, cwd, global, agent: 'claude-code' })).resolves.toEqual([]);
        await addSkills({ ...options, cwd, rootDir: '/source with spaces/"quoted" & | <> ^ % !',
          skills: ['skill with spaces', 'quote"and&shell|chars'], agents: ['claude-code'], global, copy: true });
      }
      const calls = (await fs.readFile(fake.log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(calls.map((call) => call.args)).toEqual([
        ['--version'],
        ['list', '--agent', 'claude-code', '--json'],
        ['add', '/source with spaces/"quoted" & | <> ^ % !', '--skill', 'skill with spaces',
          'quote"and&shell|chars', '--agent', 'claude-code', '--copy', '--yes'],
        ['list', '--global', '--agent', 'claude-code', '--json'],
        ['add', '/source with spaces/"quoted" & | <> ^ % !', '--skill', 'skill with spaces',
          'quote"and&shell|chars', '--agent', 'claude-code', '--global', '--copy', '--yes'],
      ]);
      expect(calls.map((call) => call.cwd)).toEqual([
        await fs.realpath(fake.cwd), scopeCwds[0], scopeCwds[0], scopeCwds[1], scopeCwds[1],
      ]);
    },
  );

  it('passes the resolved Windows Node entry, timeout and cancellation to a runner without a shell', async () => {
    const fake = await windowsSkills('npm-global');
    const { PATH, ...env } = fake.env;
    const signal = new AbortController().signal;
    const runner = vi.fn<SkillsCliRunner>(async () => ({ stdout: '1.5.23', stderr: '' }));
    await probeSkillsCli({ ...fake, env: { ...env, Path: PATH }, platform: 'win32',
      runner, timeoutMs: 321, signal });
    expect(runner).toHaveBeenCalledWith(process.execPath, [await fs.realpath(fake.launcher), '--version'],
      expect.objectContaining({ cwd: fake.cwd, encoding: 'utf8', timeout: 321, signal }));
    expect(runner.mock.calls[0]?.[2]).not.toHaveProperty('shell');
  });

  it.each(['', 'inherited installation'])(
    'uses Node-selected Windows PATH instead of the inherited Path %s', async (inheritedPath) => {
      const selected = await windowsSkills('npm-global');
      const inherited = await windowsSkills('npm-global');
      await fs.writeFile(inherited.launcher, '#!/usr/bin/env node\nconsole.log("1.5.22");\n');
      const { PATH, PATHEXT, ...env } = selected.env;
      await expect(probePortableRecoverySkillsCli({ ...selected, platform: 'win32', env: {
        ...env, Path: inheritedPath ? inherited.env.PATH : '', PATH, PATHEXT,
      } })).resolves.toEqual({ version: '1.5.23' });
      expect(JSON.parse((await fs.readFile(selected.log, 'utf8')).trim()).args).toEqual(['--version']);
    },
  );

  it('uses Node-selected Windows PATHEXT for the public Skills probe', async () => {
    const fake = await windowsSkills('npm-global');
    const { PATHEXT, ...env } = fake.env;
    await expect(probePortableRecoverySkillsCli({ ...fake, platform: 'win32',
      env: { ...env, Pathext: '.bat', PATHEXT } })).resolves.toEqual({ version: '1.5.23' });
  });

  it('preserves the pnpm default NODE_PATH prefix and an existing Windows environment value', async () => {
    const fake = await windowsSkills('pnpm');
    const runner = vi.fn<SkillsCliRunner>(async () => ({ stdout: '1.5.23', stderr: '' }));
    await probeSkillsCli({ ...fake, env: { ...fake.env, Node_Path: 'C:\\existing modules' }, platform: 'win32', runner });
    expect(runner.mock.calls[0]?.[2].env).toMatchObject({
      NODE_PATH: 'C:\\pnpm home\\global\\5\\node_modules\\.pnpm\\node_modules;C:\\existing modules',
    });
  });

  it.each(['C:\\selected modules', ''])(
    'prepends pnpm NODE_PATH to the Node-selected environment value %s', async (selectedPath) => {
      const fake = await windowsSkills('pnpm');
      const runner = vi.fn<SkillsCliRunner>(async () => ({ stdout: '1.5.23', stderr: '' }));
      await expect(probePortableRecoverySkillsCli({ ...fake, platform: 'win32', runner,
        env: { ...fake.env, Node_Path: 'C:\\inherited modules', NODE_PATH: selectedPath } }))
        .resolves.toEqual({ version: '1.5.23' });
      const childEnv = runner.mock.calls[0]?.[2].env;
      expect(childEnv?.NODE_PATH).toBe('C:\\pnpm home\\global\\5\\node_modules\\.pnpm\\node_modules'
        + (selectedPath ? `;${selectedPath}` : ''));
      expect(runner.mock.calls[0]?.[2]).not.toHaveProperty('shell');
    },
  );

  it.each(['%COMSPEC%', 'C:\\modules" & calc.exe & "'])(
    'rejects unsafe pnpm environment expansion %s before execution', async (value) => {
      const fake = await windowsSkills('pnpm');
      await fs.writeFile(fake.shim, (await fs.readFile(fake.shim, 'utf8')).replaceAll(
        'C:\\pnpm home\\global\\5\\node_modules\\.pnpm\\node_modules', value,
      ));
      const runner = vi.fn<SkillsCliRunner>(async () => ({ stdout: '1.5.23', stderr: '' }));
      await expect(probeSkillsCli({ ...fake, platform: 'win32', runner }))
        .rejects.toThrow('portableSkillsCliIncompatible');
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it('keeps POSIX startup on the PATH command', async () => {
    const runner = vi.fn<SkillsCliRunner>(async () => ({ stdout: '1.5.23', stderr: '' }));
    await probeSkillsCli({ cwd: os.tmpdir(), env: { PATH: '' }, platform: 'linux', runner });
    expect(runner).toHaveBeenCalledWith('skills', ['--version'], expect.objectContaining({ encoding: 'utf8' }));
  });

  it('keeps Windows version gates, process timeouts, cancellation and add failures', async () => {
    const fake = await windowsSkills('npm-global');
    const options = { ...fake, platform: 'win32' as const };
    await expect(probePortableRecoverySkillsCli({ ...options, env: { ...fake.env, FAKE_SKILLS_VERSION: '1.5.24' } }))
      .rejects.toThrow('portableSkillsCliIncompatible');
    await expect(probeSkillsCli({ ...options, env: { ...fake.env, FAKE_SKILLS_VERSION: '2.0.0' } }))
      .rejects.toThrow('portableSkillsCliIncompatible');
    await expect(probePortableRecoverySkillsCli({ ...options,
      env: { ...fake.env, FAKE_SKILLS_DELAY_VERSION: '1' }, timeoutMs: 50 }))
      .rejects.toThrow('portableSkillsCliIncompatible');
    const abort = new AbortController();
    abort.abort();
    await expect(probeSkillsCli({ ...options, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(addSkills({ ...options, env: { ...fake.env, FAKE_SKILLS_ADD_EXIT: '7' },
      rootDir: '/source', skills: ['alpha'], global: false })).rejects.toThrow('portableSkillsCliInstallFailed');
  });

  it.each([undefined, ''])('reports missing Windows PATH %s without running a command', async (PATH) => {
    const runner = vi.fn<SkillsCliRunner>(async () => ({ stdout: '1.5.23', stderr: '' }));
    await expect(probeSkillsCli({ cwd: os.tmpdir(), env: { PATH }, platform: 'win32', runner }))
      .rejects.toThrow('portableSkillsCliMissing');
    expect(runner).not.toHaveBeenCalled();
  });

  it('uses Windows PATHEXT and reports absent PATH binaries', async () => {
    const fake = await windowsSkills('npm-global');
    await fs.move(fake.shim, fake.shim.replace(/\.cmd$/u, '.CMD'));
    await expect(probeSkillsCli({ ...fake, env: { ...fake.env, PATHEXT: undefined }, platform: 'win32' }))
      .resolves.toEqual({ version: '1.5.23' });
    await expect(probeSkillsCli({ ...fake, env: { ...fake.env, PATH: fake.cwd }, platform: 'win32' }))
      .rejects.toThrow('portableSkillsCliMissing');
  });

  it.each([
    ['changed shim', async (fake: Awaited<ReturnType<typeof windowsSkills>>) => fs.appendFile(fake.shim, '@calc.exe\r\n')],
    ['foreign package', async (fake: Awaited<ReturnType<typeof windowsSkills>>) => fs.writeJson(
      path.join(fake.packageRoot, 'package.json'), { name: 'foreign', bin: { skills: './bin/cli.mjs' } },
    )],
    ['wrong bin', async (fake: Awaited<ReturnType<typeof windowsSkills>>) => fs.writeJson(
      path.join(fake.packageRoot, 'package.json'), { name: 'skills', bin: { skills: '../../foreign.mjs' } },
    )],
    ['missing bin', async (fake: Awaited<ReturnType<typeof windowsSkills>>) => fs.remove(fake.launcher)],
    ['batch shim', async (fake: Awaited<ReturnType<typeof windowsSkills>>) => {
      await fs.move(fake.shim, fake.shim.replace(/\.cmd$/u, '.bat'));
      fake.env.PATHEXT = '.bat';
    }],
    ['linked shim', async (fake: Awaited<ReturnType<typeof windowsSkills>>) => {
      const outside = path.join(fake.cwd, 'outside.cmd');
      await fs.move(fake.shim, outside);
      await fs.symlink(outside, fake.shim);
    }],
    ['linked bin', async (fake: Awaited<ReturnType<typeof windowsSkills>>) => {
      const outside = path.join(fake.cwd, 'outside.mjs');
      await fs.move(fake.launcher, outside);
      await fs.symlink(outside, fake.launcher);
    }],
  ])('rejects an unsupported Windows %s before public execution', async (_name, change) => {
    const fake = await windowsSkills('npm-global');
    await change(fake);
    const runner = vi.fn<SkillsCliRunner>(async () => ({ stdout: '1.5.23', stderr: '' }));
    const options = { ...fake, platform: 'win32' as const, runner };
    await expect(probeSkillsCli(options)).rejects.toThrow('portableSkillsCliIncompatible');
    await expect(listInstalledSkills({ ...options, global: false })).rejects.toThrow('portableSkillsCliIncompatible');
    await expect(addSkills({ ...options, rootDir: '/source', skills: ['alpha'], global: true }))
      .rejects.toThrow('portableSkillsCliIncompatible');
    expect(runner).not.toHaveBeenCalled();
  });

  it('supports pnpm package links while retaining the canonical package bin boundary', async () => {
    const fake = await windowsSkills('pnpm');
    const storedPackage = path.join(fake.cwd, 'store', 'node_modules', 'skills');
    await fs.move(fake.packageRoot, storedPackage);
    await fs.symlink(storedPackage, fake.packageRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(probeSkillsCli({ ...fake, platform: 'win32' })).resolves.toEqual({ version: '1.5.23' });
    const outside = path.join(fake.cwd, 'foreign-bin');
    await fs.move(path.join(storedPackage, 'bin'), outside);
    await fs.symlink(outside, path.join(storedPackage, 'bin'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(probeSkillsCli({ ...fake, platform: 'win32' })).rejects.toThrow('portableSkillsCliIncompatible');
  });

  it('keeps project recovery on its exact provider version and passes copy explicitly', async () => {
    const incompatible = await fakeSkills({ version: '1.5.24' });
    await expect(probeSkillsCli(incompatible)).resolves.toEqual({ version: '1.5.24' });
    await expect(probePortableRecoverySkillsCli(incompatible)).rejects.toThrow('portableSkillsCliIncompatible');
    const fake = await fakeSkills();
    await addSkills({ ...fake, rootDir: '/persistent/materialization', skills: ['alpha'],
      agents: ['cursor'], global: false, copy: true, timeoutMs: 1000 });
    expect(JSON.parse((await fs.readFile(fake.log, 'utf8')).trim()).args).toEqual([
      'add', '/persistent/materialization', '--skill', 'alpha', '--agent', 'cursor', '--copy', '--yes',
    ]);
  });

  it('bounds provider probes with an explicit timeout', async () => {
    const fake = await fakeSkills({ delayVersion: true });
    await expect(probePortableRecoverySkillsCli({ ...fake, timeoutMs: 50 })).rejects.toThrow('portableSkillsCliIncompatible');
  });
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
