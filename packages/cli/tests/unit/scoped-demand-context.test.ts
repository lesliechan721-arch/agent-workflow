import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { addRoot, resolveIntentPath } from '../../src/intent/intent-store.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import { demandNativeProjection, readDemand, readIntentReferences, resolveDelivery } from '../../src/recovery/demand.js';
import type { NormalizedPluginManifest } from '../../src/types.js';
import { getClaudeHome, getCodexHome, resolveAwHome } from '../../src/utils/state-paths.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function manifest(): NormalizedPluginManifest {
  return {
    schemaVersion: 3, name: 'demo', version: '1.0.0', description: 'demo', skills: './skills',
    marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    distributions: { agentSkills: { skills: './portable' } },
  };
}

describe('scoped demand and execution context', () => {
  it('chooses delivery by explicit scope and Agent without fallback on runtime health', () => {
    const plugin = manifest();
    for (const scope of ['user', 'project'] as const) {
      expect(resolveDelivery(plugin, 'codex', scope)).toEqual({ kind: 'native', platform: 'codex' });
      expect(resolveDelivery(plugin, 'claude-code', scope)).toEqual({ kind: 'native', platform: 'claude' });
      expect(resolveDelivery(plugin, 'cursor', scope)).toEqual({
        kind: 'agent-skills', provider: 'skills-cli', agentId: 'cursor',
      });
    }
    plugin.slashCommands = './commands';
    expect(resolveDelivery(plugin, 'codex', 'project')?.kind).toBe('agent-skills');
    delete plugin.distributions;
    expect(resolveDelivery(plugin, 'cursor', 'project')).toBeUndefined();
  });

  it('retains source references with no Agents or available Catalog and uses a protocol-free Native view', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    await addRoot(location, 'team/demo', 'catalog-team');
    const demand = await readDemand(location);
    expect(demand.roots?.[0]).toMatchObject({ pluginId: 'team/demo' });
    expect(demand.preferences.state).toBe('absent');
    expect(await readIntentReferences(location)).toEqual(['team/demo']);
    const native = demandNativeProjection(demand);
    expect(native).toEqual({ roots: [{ pluginId: 'team/demo', platforms: ['codex', 'claude'] }],
      dependencyScopeOverrides: [] });
    expect(native).not.toHaveProperty('schemaVersion');
    expect(native).not.toHaveProperty('kind');
  });

  it('reports a precise backup and rebuild path for unsupported User Intent bytes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const file = await resolveIntentPath(location);
    const bytes = JSON.stringify({ schemaVersion: 2, kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }], dependencyScopeOverrides: [] });
    await fs.outputFile(file, bytes);
    const demand = await readDemand(location);
    expect(demand.roots).toBeNull();
    expect(demand.errors[0]?.message).toContain(file);
    expect(demand.errors[0]?.message).toContain('备份');
    expect(demand.errors[0]?.message).toContain('aw intent add');
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  });

  it('uses a neutral User cwd in and outside repositories and keeps read-only observation temporary', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const ordinary = path.join(isolation.layout.fixtureCwd, 'ordinary-context');
    const repo = path.join(isolation.layout.fixtureCwd, 'repo-context');
    await fs.ensureDir(ordinary);
    await fs.ensureDir(path.join(repo, '.git'));
    for (const cwd of [ordinary, repo]) {
      const context = await createScopeContext({ scope: 'user', cwd, env: isolation.env, readOnly: true });
      expect(context.executionCwd).not.toContain(repo);
      expect(context.executionCwd).not.toContain(ordinary);
      expect(context.projectRoot).toBeUndefined();
      expect(context.targetHomes.home).toBe(path.join(
        await fs.realpath(path.dirname(isolation.env.HOME!)), path.basename(isolation.env.HOME!),
      ));
      const runtime = path.join(isolation.env.AW_HOME!, 'runtime', 'user');
      expect(await fs.pathExists(runtime)).toBe(false);
      const temporary = context.executionCwd;
      await context.dispose();
      expect(await fs.pathExists(temporary)).toBe(false);
    }
  });

  it('rejects polluted AW_HOME ancestors, uses an operation-owned cwd, and preserves foreign files', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const repo = path.join(isolation.layout.fixtureCwd, 'aw-inside-repo');
    const awHome = path.join(repo, 'aw-home');
    await fs.ensureDir(path.join(repo, '.git'));
    await fs.ensureDir(awHome);
    const foreign = path.join(awHome, 'foreign.txt');
    await fs.writeFile(foreign, 'keep');
    const context = await createScopeContext({ scope: 'user', cwd: repo,
      env: { ...isolation.env, AW_HOME: awHome } });
    expect(context.executionCwd).not.toContain(repo);
    expect(context.generationRoot).toBe(path.join(await fs.realpath(awHome), 'portable', 'user'));
    const temporary = context.executionCwd;
    await context.dispose();
    expect(await fs.pathExists(temporary)).toBe(false);
    expect(await fs.readFile(foreign, 'utf8')).toBe('keep');
    expect(await fs.pathExists(path.join(awHome, 'runtime'))).toBe(false);
  });

  it('blocks backend context when every neutral cwd fails and leaves foreign state untouched', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const repo = path.join(isolation.layout.fixtureCwd, 'no-neutral');
    await fs.ensureDir(path.join(repo, '.git'));
    const awHome = path.join(repo, 'aw-home');
    const foreign = path.join(awHome, 'foreign.txt');
    await fs.outputFile(foreign, 'keep');
    const mkdtemp = vi.spyOn(fs, 'mkdtemp').mockRejectedValue(new Error('no safe temp'));
    try {
      await expect(createScopeContext({ scope: 'user', cwd: repo,
        env: { ...isolation.env, AW_HOME: awHome } })).rejects.toThrow('userNeutralCwdUnavailable');
    } finally {
      mkdtemp.mockRestore();
    }
    expect(await fs.readFile(foreign, 'utf8')).toBe('keep');
    expect(await fs.pathExists(path.join(awHome, 'runtime'))).toBe(false);
  });

  it('rejects a neutral cwd whose ancestor carries project configuration', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const configured = path.join(isolation.layout.fixtureCwd, 'configured-ancestor');
    const awHome = path.join(configured, 'aw-home');
    await fs.ensureDir(path.join(configured, '.codex'));
    await fs.ensureDir(awHome);
    const context = await createScopeContext({ scope: 'user', cwd: configured,
      env: { ...isolation.env, AW_HOME: awHome } });
    expect(context.executionCwd).not.toContain(configured);
    expect(await fs.pathExists(path.join(awHome, 'runtime'))).toBe(false);
    await context.dispose();
  });

  it.each(['.git', '.agent-workflows', '.aw-workspace.json', '.codex'])(
    'rejects a persistent neutral cwd under an ancestor with %s', async (marker) => {
      const isolation = getCurrentSourceTestIsolation();
      const configured = path.join(isolation.layout.fixtureCwd, `marker-${marker.replaceAll('.', '-')}`);
      const awHome = path.join(configured, 'aw-home');
      await fs.ensureDir(awHome);
      const markerPath = path.join(configured, marker);
      if (marker.endsWith('.json') || marker === '.git') await fs.writeFile(markerPath, 'marker');
      else await fs.ensureDir(markerPath);
      const context = await createScopeContext({ scope: 'user', cwd: configured,
        env: { ...isolation.env, AW_HOME: awHome } });
      expect(context.executionCwd).not.toContain(configured);
      expect(await fs.pathExists(path.join(awHome, 'runtime'))).toBe(false);
      await context.dispose();
    },
  );

  it('resolves a symlinked AW_HOME before checking neutral cwd ancestors', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const repo = path.join(isolation.layout.fixtureCwd, 'aliased-repo');
    const actual = path.join(repo, 'aw-home');
    const alias = path.join(isolation.layout.fixtureCwd, 'aw-alias');
    await fs.ensureDir(path.join(repo, '.git'));
    await fs.ensureDir(actual);
    await fs.symlink(actual, alias, 'dir');
    const context = await createScopeContext({ scope: 'user', cwd: repo,
      env: { ...isolation.env, AW_HOME: alias } });
    expect(context.executionCwd).not.toContain(repo);
    expect(context.awHome).toBe(await fs.realpath(actual));
    await context.dispose();
  });

  it('rejects ambiguous relative environment homes and resolves Project worktree context only for a repo', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const plain = path.join(isolation.layout.fixtureCwd, 'plain-project');
    await fs.ensureDir(plain);
    await expect(createScopeContext({ scope: 'project', cwd: plain, env: isolation.env }))
      .rejects.toThrow('projectRootUnavailable');
    await expect(createScopeContext({ scope: 'user', cwd: plain,
      env: { ...isolation.env, XDG_STATE_HOME: 'relative' } })).rejects.toThrow('scopeEnvironmentAmbiguous');
    const repo = path.join(isolation.layout.fixtureCwd, 'real-project');
    await fs.ensureDir(path.join(repo, '.git'));
    const context = await createScopeContext({ scope: 'project', cwd: repo, env: isolation.env });
    expect(context.executionCwd).toBe(await fs.realpath(repo));
    expect(context.projectRoot).toBe(await fs.realpath(repo));
    expect(context.configProfile).toBe('project');
    await context.dispose();
  });

  it('binds fallback AW and Agent homes to the supplied HOME and honors Claude config override', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const home = isolation.env.HOME!;
    const customClaude = path.join(home, 'custom-claude');
    const env = { ...isolation.env, AW_HOME: undefined, AW_CODEX_HOME: undefined,
      AW_CLAUDE_HOME: undefined, CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: customClaude };
    expect(resolveAwHome(env)).toBe(path.join(home, '.aw'));
    expect(getCodexHome(env)).toBe(path.join(home, '.codex'));
    expect(getClaudeHome(env)).toBe(customClaude);
    const context = await createScopeContext({ scope: 'user', cwd: isolation.layout.fixtureCwd,
      env, readOnly: true });
    expect(context.awHome).toBe(path.join(await fs.realpath(path.dirname(home)),
      path.basename(home), '.aw'));
    expect(context.targetHomes.claude).toBe(path.join(context.targetHomes.home, 'custom-claude'));
    expect(context.env.HOME).toBe(home);
    await context.dispose();
    expect(await fs.pathExists(path.join(home, '.aw'))).toBe(false);
  });
});
