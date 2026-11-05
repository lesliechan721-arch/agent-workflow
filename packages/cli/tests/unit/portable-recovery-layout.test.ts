import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ScopeContext } from '../../src/intent/scope-context.js';
import { portableRecoveryLayout } from '../../src/portable/recovery-layout.js';

function fixture(platform: NodeJS.Platform, scope: 'user' | 'project') {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = platform === 'win32' ? 'C:\\Users\\测试 用户' : '/users/测试 用户';
  const cwd = platform === 'win32' ? 'D:\\work\\project' : '/work/project';
  const env = { [platform === 'win32' ? 'USERPROFILE' : 'HOME']: home };
  const context: ScopeContext = { scope, callerCwd: cwd, executionCwd: cwd, configProfile: scope,
    awHome: paths.join(home, '.aw'), generationRoot: paths.join(home, '.aw', 'portable'), env,
    targetHomes: { home, codex: paths.join(home, '.codex'), claude: paths.join(home, '.claude'),
      cursor: paths.join(home, '.cursor'), xdgState: paths.join(home, '.local', 'state') },
    dispose: async () => undefined };
  return { context, home, cwd, paths, options: { platform, systemHome: home, canonicalizePath: paths.normalize } };
}

describe('Portable fixed target directories', () => {
  // Test Value Gate: canonical consumer paths protect separate target configuration and native Skill boundaries.
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it.each(['user', 'project'] as const)(`uses all five ${platform} %s consumer directories`, (scope) => {
      const { context, home, cwd, paths, options } = fixture(platform, scope);
      const layout = portableRecoveryLayout(context, options);
      const root = scope === 'user' ? home : cwd;
      const expected = scope === 'user' ? {
        antigravity: ['.gemini', 'config', 'skills'], cursor: ['.cursor', 'skills'],
        opencode: ['.config', 'opencode', 'skills'], pi: ['.pi', 'agent', 'skills'], generic: ['.agents', 'skills'],
      } : { antigravity: ['.agents', 'skills'], cursor: ['.cursor', 'skills'],
        opencode: ['.opencode', 'skills'], pi: ['.pi', 'skills'], generic: ['.agents', 'skills'] };
      for (const [agent, directories] of Object.entries(expected)) {
        expect(layout.targetPath(agent as 'cursor', 'test-skill')).toBe(paths.join(root, ...directories, 'test-skill'));
      }
      for (const invalid of ['codex', 'claude', 'claude-code', 'gemini', 'agent-skills']) {
        expect(() => layout.targetPath(invalid as 'cursor', 'test-skill')).toThrow('portableInvalidAgentSelection');
      }
      expect(() => layout.targetPath('cursor', '../escape')).toThrow('portableSkillInvalid');
    });
    it(`rejects a changed ${platform} home and an ambiguous execution path`, () => {
      const { context, options } = fixture(platform, 'user');
      context.env[platform === 'win32' ? 'USERPROFILE' : 'HOME'] = 'relative';
      expect(() => portableRecoveryLayout(context, options)).toThrow('portableEnvironmentUnsupported');
      const project = fixture(platform, 'project');
      project.context.executionCwd = platform === 'win32' ? '\\relative-drive' : 'relative';
      expect(() => portableRecoveryLayout(project.context, project.options)).toThrow('portableEnvironmentUnsupported');
    });
  }
});
