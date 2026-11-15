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
  // Test Value Gate: generic output uses the canonical root, and Native targets cannot use this writer.
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it.each(['user', 'project'] as const)(`uses the generic ${platform} %s directory and rejects Native targets`, (scope) => {
      const { context, home, cwd, paths, options } = fixture(platform, scope);
      const layout = portableRecoveryLayout(context, options);
      const root = scope === 'user' ? home : cwd;
      expect(layout.targetPath('generic', 'test-skill')).toBe(paths.join(root, '.agents', 'skills', 'test-skill'));
      for (const invalid of ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'gemini',
        'copilot', 'grok', 'claude-code', 'agent-skills']) {
        expect(() => layout.targetPath(invalid as never, 'test-skill')).toThrow('portableInvalidAgentSelection');
      }
      expect(() => layout.targetPath('generic', '../escape')).toThrow('portableSkillInvalid');
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
