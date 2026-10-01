import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { createScopeContext, type ScopeContext } from '../../src/intent/scope-context.js';
import { portableSkillTreeDigest } from '../../src/portable/historical-materialization.js';
import { portableRecoveryLayout } from '../../src/portable/recovery-layout.js';
import { inspectPortableResidue } from '../../src/portable/recovery.js';
import type { InstalledSkillRecord } from '../../src/portable/skills-cli.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const platforms = ['darwin', 'linux', 'win32'] as const;
const provider = vi.hoisted(() => ({ records: [] as InstalledSkillRecord[] }));
vi.mock('../../src/portable/skills-cli.js', () => ({
  probePortableRecoverySkillsCli: async () => undefined,
  listInstalledSkills: async () => provider.records,
  addSkills: async () => undefined,
}));

function fixture(platform: NodeJS.Platform, scope: 'user' | 'project', overrides: NodeJS.ProcessEnv = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = platform === 'win32' ? 'C:\\Users\\测试 用户' : '/users/测试 用户';
  const cwd = platform === 'win32' ? 'D:\\work\\project' : '/work/project';
  const env = { [platform === 'win32' ? 'USERPROFILE' : 'HOME']: home, ...overrides };
  const context: ScopeContext = {
    scope, callerCwd: cwd, executionCwd: cwd, configProfile: scope,
    awHome: paths.join(home, '.aw'), generationRoot: paths.join(home, '.aw', 'portable'), env,
    targetHomes: {
      home, codex: paths.normalize(env.CODEX_HOME?.trim() || paths.join(home, '.codex')),
      claude: paths.normalize(env.CLAUDE_CONFIG_DIR?.trim() || paths.join(home, '.claude')),
      cursor: paths.join(home, '.cursor'),
      xdgState: paths.normalize(env.XDG_STATE_HOME || paths.join(home, '.local', 'state')),
    },
    dispose: async () => undefined,
  };
  return { context, home, cwd, paths,
    options: { platform, systemHome: home, canonicalizePath: paths.normalize } };
}

describe('Portable provider target layout', () => {
  // Test Value Gate: observing another directory can miss installed Skills and authorize an unsafe overwrite.
  for (const platform of platforms) {
    it.each(['user', 'project'] as const)(`observes ${platform} %s copy targets and lock`, (scope) => {
      const { context, home, cwd, paths, options } = fixture(platform, scope);
      const layout = portableRecoveryLayout(context, options);
      const root = scope === 'user' ? home : cwd;
      expect(layout.targetPath('codex', 'test-skill')).toBe(paths.join(root, '.agents', 'skills', 'test-skill'));
      expect(layout.targetPath('cursor', 'test-skill')).toBe(layout.targetPath('codex', 'test-skill'));
      expect(layout.targetPath('claude-code', 'test-skill')).toBe(paths.join(root, '.claude', 'skills', 'test-skill'));
      expect(layout.lockPath).toBe(scope === 'user'
        ? paths.join(home, '.agents', '.skill-lock.json') : paths.join(cwd, 'skills-lock.json'));
    });

    it.each(['user', 'project'] as const)(`uses ${platform} provider overrides only for their actual targets in %s`, (scope) => {
      const paths = platform === 'win32' ? path.win32 : path.posix;
      const custom = platform === 'win32' ? 'E:\\custom homes' : '/custom homes';
      const { context, home, cwd, options } = fixture(platform, scope, {
        CODEX_HOME: paths.join(custom, 'codex'),
        CLAUDE_CONFIG_DIR: `  ${paths.join(custom, 'claude')}  `,
        XDG_STATE_HOME: paths.join(custom, 'state'),
      });
      const layout = portableRecoveryLayout(context, options);
      expect(layout.targetRoot('codex')).toBe(paths.join(scope === 'user' ? home : cwd, '.agents'));
      expect(layout.targetRoot('cursor')).toBe(layout.targetRoot('codex'));
      expect(layout.targetRoot('claude-code')).toBe(scope === 'user'
        ? paths.join(custom, 'claude') : paths.join(cwd, '.claude'));
      expect(layout.lockPath).toBe(scope === 'user'
        ? paths.join(custom, 'state', 'skills', '.skill-lock.json') : paths.join(cwd, 'skills-lock.json'));
    });

    it(`uses ${platform} system home when its home variable is absent`, () => {
      const { context, home, paths, options } = fixture(platform, 'user', {
        HOME: undefined, USERPROFILE: undefined,
      });
      expect(portableRecoveryLayout(context, options).targetRoot('codex')).toBe(paths.join(home, '.agents'));
    });

    it.each(['home', 'claude', 'state'] as const)(`rejects a relative ${platform} %s provider directory`, (directory) => {
      const variable = directory === 'home' ? platform === 'win32' ? 'USERPROFILE' : 'HOME'
        : directory === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'XDG_STATE_HOME';
      const { context, options } = fixture(platform, 'user', { [variable]: 'relative' });
      expect(() => portableRecoveryLayout(context, options)).toThrow();
    });
  }

  it('uses Windows USERPROFILE with no HOME and ignores a conflicting HOME', () => {
    const { context, home, paths, options } = fixture('win32', 'user', { HOME: 'Z:\\wrong-home' });
    expect(portableRecoveryLayout(context, options).targetRoot('codex')).toBe(paths.join(home, '.agents'));
    delete context.env.HOME;
    expect(portableRecoveryLayout(context, options).targetRoot('codex')).toBe(paths.join(home, '.agents'));
  });

  // Test Value Gate: Windows env copies can retain mixed-case keys that the provider still reads.
  it.each(['home', 'claude', 'state'] as const)('observes a mixed-case Windows %s override', (directory) => {
    const { context, options, paths } = fixture('win32', 'user');
    const custom = 'D:\\custom\\directory';
    if (directory === 'home') {
      delete context.env.USERPROFILE;
      context.env.UserProfile = custom;
      context.targetHomes.home = custom;
    } else if (directory === 'claude') {
      context.env.Claude_Config_Dir = `  ${custom}  `;
      context.targetHomes.claude = custom;
    } else {
      context.env.Xdg_State_Home = custom;
      context.targetHomes.xdgState = custom;
    }
    const layout = portableRecoveryLayout(context, options);
    expect(directory === 'state' ? layout.lockPath : layout.targetRoot(directory === 'home' ? 'codex' : 'claude-code'))
      .toBe(directory === 'state' ? paths.join(custom, 'skills', '.skill-lock.json')
        : directory === 'home' ? paths.join(custom, '.agents') : custom);
  });

  it('uses the first sorted Windows provider key for duplicate mixed-case variants', () => {
    const { context, options, paths } = fixture('win32', 'user');
    context.env = { userprofile: 'Z:\\ignored', UserProfile: 'D:\\home',
      claude_config_dir: 'Z:\\ignored', Claude_Config_Dir: 'E:\\claude',
      xdg_state_home: 'Z:\\ignored', Xdg_State_Home: 'F:\\state' };
    context.targetHomes.home = 'D:\\home';
    context.targetHomes.claude = 'E:\\claude';
    context.targetHomes.xdgState = 'F:\\state';
    const layout = portableRecoveryLayout(context, options);
    expect(layout.targetRoot('codex')).toBe(paths.join('D:\\home', '.agents'));
    expect(layout.targetRoot('claude-code')).toBe('E:\\claude');
    expect(layout.lockPath).toBe(paths.join('F:\\state', 'skills', '.skill-lock.json'));
  });

  it.each(['UserProfile', 'Claude_Config_Dir', 'Xdg_State_Home'])(
    'rejects an unsafe relative Windows %s value', (key) => {
      const { context, options } = fixture('win32', 'user');
      if (key === 'UserProfile') delete context.env.USERPROFILE;
      context.env[key] = 'relative';
      expect(() => portableRecoveryLayout(context, options)).toThrow();
    },
  );

  it('ignores mixed-case provider configuration keys on POSIX', () => {
    const { context, options, home, paths } = fixture('linux', 'user', {
      home: '/ignored', Claude_Config_Dir: '/ignored', Xdg_State_Home: '/ignored',
    });
    const layout = portableRecoveryLayout(context, options);
    expect(layout.targetRoot('codex')).toBe(paths.join(home, '.agents'));
    expect(layout.targetRoot('claude-code')).toBe(paths.join(home, '.claude'));
    expect(layout.lockPath).toBe(paths.join(home, '.agents', '.skill-lock.json'));
  });

  it('uses POSIX system home with only USERPROFILE', () => {
    const { context, home, paths, options } = fixture('linux', 'user', {
      HOME: undefined, USERPROFILE: '/different-profile',
    });
    expect(portableRecoveryLayout(context, options).targetRoot('codex')).toBe(paths.join(home, '.agents'));
  });

  it('accepts a Windows UNC home and defaults a whitespace-only Claude override', () => {
    const { context, paths, options } = fixture('win32', 'user', { CLAUDE_CONFIG_DIR: '   ' });
    const home = '\\\\server\\profiles\\test-user';
    context.env.USERPROFILE = home;
    context.targetHomes.home = home;
    const layout = portableRecoveryLayout(context, options);
    expect(layout.targetRoot('codex')).toBe(paths.join(home, '.agents'));
    expect(layout.targetRoot('claude-code')).toBe(paths.join(home, '.claude'));
  });

  it.each(['user', 'project'] as const)('rejects an ambiguous Windows execution directory for %s', (scope) => {
    const { context, options } = fixture('win32', scope);
    context.executionCwd = '\\work\\project';
    expect(() => portableRecoveryLayout(context, options)).toThrow('portableEnvironmentUnsupported');
  });

  it.each(['', 'C:relative', '\\Users\\relative-drive'])(
    'rejects an empty or ambiguous Windows home: %j', (USERPROFILE) => {
      const { context, options } = fixture('win32', 'user', { USERPROFILE });
      expect(() => portableRecoveryLayout(context, options)).toThrow();
    },
  );

  it('rejects changed provider home or lock paths after scope preparation', () => {
    const { context, options } = fixture('linux', 'user');
    context.env.HOME = '/changed-home';
    expect(() => portableRecoveryLayout(context, options)).toThrow('portableEnvironmentUnsupported');
    context.env.HOME = context.targetHomes.home;
    context.env.XDG_STATE_HOME = '/changed-state';
    expect(() => portableRecoveryLayout(context, options)).toThrow('portableEnvironmentUnsupported');
  });

  // Test Value Gate: a supplied environment without HOME must not read the parent process HOME or USERPROFILE.
  it('prepares an actual scope context with system home when home variables are absent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const home = path.join(isolation.env.HOME!, 'system-home');
    await fs.ensureDir(home);
    const userInfo = vi.spyOn(os, 'userInfo').mockReturnValue({
      username: 'test-user', uid: 1000, gid: 1000, shell: null, homedir: home,
    });
    try {
      const context = await createScopeContext({ scope: 'user', cwd: isolation.layout.fixtureCwd,
        readOnly: true, env: { ...isolation.env, HOME: undefined, USERPROFILE: undefined } });
      try {
        expect(context.targetHomes.home).toBe(await fs.realpath(home));
        expect(portableRecoveryLayout(context).targetRoot('codex')).toBe(path.join(context.targetHomes.home, '.agents'));
        const physicalPath = path.join(context.targetHomes.home, '.agents', 'skills', 'existing');
        await fs.outputFile(path.join(physicalPath, 'SKILL.md'), 'existing portable skill');
        const installedDigest = await portableSkillTreeDigest(physicalPath);
        provider.records = [{ name: 'existing', path: physicalPath, agents: ['Codex'], scope: 'global',
          source: path.join(home, 'external-source') }];
        expect(await inspectPortableResidue({ scope: 'user', context, selector: 'team/root', agents: ['codex'],
          retainedTargets: [{ skill: 'existing', agent: 'codex', physicalPath, installedDigest }] }))
          .toEqual({ state: 'absent', targets: [], blockers: [] });
      } finally { await context.dispose(); }
    } finally { userInfo.mockRestore(); }
  });
});
