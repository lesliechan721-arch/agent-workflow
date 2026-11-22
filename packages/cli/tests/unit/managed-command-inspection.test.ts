import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeIdentityValue, getCommandPackageId, normalizeCommandRoutes } from '@lesliechan721/aw-plugin-core/manifest';

import { createRebuildIntegration, disposePreparedPlatformRebuildSession } from '../../src/commands/rebuild-integration.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { executeRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { inspectManagedCommandRouteChanges } from '../../src/utils/managed-command-cli-review.js';
import { getClaudeHome, getCodexHome } from '../../src/utils/state-paths.js';
import { syncManagedCommandPackage } from '../../src/utils/managed-command-store.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';

describe('managed command read-only inspection', () => {
  let isolated: IsolatedTestEnvironment;
  const prepared = new Map<string, import('../../src/utils/plugin-scripts.js').PluginProcessResult>();
  beforeEach(async () => { isolated = await createIsolatedTestEnv(); });
  afterEach(async () => { await disposePreparedPlatformRebuildSession(prepared); prepared.clear(); await isolated.cleanup(); });

  it('reads project approval files only when Review covers the current project', async () => {
    const cwd = isolated.layout.fixtureCwd;
    const selector = 'fixture/inspection-commands';
    const env = isolated.env;
    await fs.ensureDir(path.join(cwd, '.git'));
    const user = path.join(getClaudeHome(env), 'settings.json');
    const project = path.join(cwd, '.claude', 'settings.json');
    const settings = { permissions: { ask: [`Bash(aw command run ${selector} -- check *)`] } };
    await Promise.all([fs.outputJson(user, settings), fs.outputJson(project, settings)]);
    const options = { selector, cwd, env, after: normalizeCommandRoutes({
      subcommands: [{ name: 'check', runner: 'node', entry: 'tool.mjs' }],
    }) };
    const userReview = await inspectManagedCommandRouteChanges({ ...options, userOnly: true });
    expect(userReview.affectedPermissions.map((rule) => rule.path)).toEqual([user]);
    const projectReview = await inspectManagedCommandRouteChanges(options);
    expect(projectReview.affectedPermissions.map((rule) => rule.path)).toEqual([user, project]);
    const empty = normalizeCommandRoutes({ subcommands: [] });
    const inactive = await inspectManagedCommandRouteChanges({ ...options, before: empty, after: empty, inspectInactiveRestrictions: true });
    expect(inactive.routeChanges).toEqual([]);
    expect(inactive.affectedPermissions.map(({ path, action, handlerUnavailable }) => [path, action, handlerUnavailable]))
      .toEqual([[user, 'ask', true], [project, 'ask', true]]);
  });

  it('shows matching Codex rules in user and project files when invocation text routes to a new entry', async () => {
    const cwd = isolated.layout.fixtureCwd;
    const env = isolated.env;
    const selector = 'fixture/inspection-commands';
    const argv = ['aw', 'command', 'run', selector, '--', 'check'];
    const user = path.join(getCodexHome(env), 'rules', 'default.rules');
    const project = path.join(cwd, '.codex', 'rules', 'review.rules');
    await fs.ensureDir(path.join(cwd, '.git'));
    await fs.outputFile(user, `
# prefix_rule(pattern = ["aw"], decision = "forbidden")
prefix_rule(
    justification = """Check exported data (read only).
    # This line is part of the justification.""",
    pattern = ['aw', 'command', 'run', '${selector}', '--', 'check', 'human readable'],
    match = [${JSON.stringify([...argv, 'human readable'])}],
    not_match = ['aw command run ${selector} -- publish'],
) # Default decision allows this prefix.
`);
    await fs.outputFile(project, `
prefix_rule(decision = 'prompt', pattern = ["aw", "command", "run", "${selector}", "--", ["publish", "check"]])
`);
    const options = { selector, cwd, env,
      before: normalizeCommandRoutes({ subcommands: [], fallback: { runner: 'node', entry: 'old.mjs' } }),
      after: normalizeCommandRoutes({ subcommands: [{ name: 'check', runner: 'node', entry: 'new.mjs' }],
        fallback: { runner: 'node', entry: 'old.mjs' } }),
    };
    const userRule = { platform: 'codex', path: user, action: 'allow', argvPrefix: [...argv, 'human readable'] };
    const userReview = await inspectManagedCommandRouteChanges({ ...options, userOnly: true });
    expect(userReview.affectedPermissions).toEqual([userRule]);
    const review = await inspectManagedCommandRouteChanges(options);
    expect(review.affectedPermissions).toEqual([userRule, expect.objectContaining({ platform: 'codex', path: project, action: 'ask', argvPrefix: argv })]);
    expect(review.permissionReadFailures).toEqual([]);
  });

  it('reports top-level Codex rules alongside uninspected expressions and binds Review to all file bytes', async () => {
    const cwd = isolated.layout.fixtureCwd;
    const env = isolated.env;
    const selector = 'fixture/inspection-commands';
    const argv = ['aw', 'command', 'run', selector, '--', 'check'];
    const forbidden = `prefix_rule(pattern = ${JSON.stringify(argv)}, decision = "forbidden")`;
    const user = path.join(getCodexHome(env), 'rules', 'default.rules');
    const writeRule = (route: string) => fs.outputFile(user, `
base = ${JSON.stringify(['aw', 'command', 'run', selector, '--'])}
route = ${JSON.stringify(route)}
prefix_rule(pattern = base + [route], decision = "allow")
if False: pass; ${forbidden}
def deferred():
    ${forbidden}
explanation = r"""
${forbidden}
"""
alias = (
${forbidden} if False else None
)
# ${forbidden}
prefix_rule(
    pattern = ${JSON.stringify(argv)},
    decision = "prompt",
)
tag = "publish"; prefix_rule(pattern = ${JSON.stringify([...argv, 'ship'])}, decision = "allow")
`);
    await writeRule('publish');
    const options = { selector, cwd, env, after: normalizeCommandRoutes({
      subcommands: [{ name: 'check', runner: 'node', entry: 'tool.mjs' }],
    }) };
    const reviewed = await inspectManagedCommandRouteChanges(options);
    expect(reviewed.affectedPermissions).toEqual([
      { platform: 'codex', path: user, action: 'ask', argvPrefix: argv },
      { platform: 'codex', path: user, action: 'allow', argvPrefix: [...argv, 'ship'] },
    ]);
    expect(reviewed.permissionReadFailures).toEqual([user]);
    await writeRule('archive');
    const current = await inspectManagedCommandRouteChanges(options);
    expect(current.affectedPermissions).toEqual(reviewed.affectedPermissions);
    expect(current.permissionReadFailures).toEqual(reviewed.permissionReadFailures);
    expect(canonicalizeIdentityValue(current)).not.toBe(canonicalizeIdentityValue(reviewed));
  });

  it('leaves a shadowed Codex rule name uninspected', async () => {
    const cwd = isolated.layout.fixtureCwd;
    const env = isolated.env;
    const selector = 'fixture/inspection-commands';
    const argv = ['aw', 'command', 'run', selector, '--', 'check'];
    const user = path.join(getCodexHome(env), 'rules', 'default.rules');
    await fs.outputFile(user, `
def ignore(*args, **kwargs):
    pass
if True:
    unused, prefix_rule = [None, ignore]
prefix_rule(pattern = ${JSON.stringify(argv)}, decision = "allow")
`);
    const review = await inspectManagedCommandRouteChanges({ selector, cwd, env, after: normalizeCommandRoutes({
      subcommands: [{ name: 'check', runner: 'node', entry: 'tool.mjs' }],
    }) });
    expect(review.affectedPermissions).toEqual([]);
    expect(review.permissionReadFailures).toEqual([user]);
  });

  it.skipIf(process.platform === 'win32')('reports linked Codex rules and binds Review to the link', async () => {
    const cwd = isolated.layout.fixtureCwd;
    const env = isolated.env;
    const selector = 'fixture/inspection-commands';
    const argv = ['aw', 'command', 'run', selector, '--', 'check'];
    const link = path.join(getCodexHome(env), 'rules', 'linked.rules');
    const target = path.join(cwd, 'outside.rules');
    await fs.outputFile(target, 'prefix_rule(pattern = ' + JSON.stringify(argv) + ')\n');
    await fs.ensureDir(path.dirname(link));
    await fs.symlink(target, link, 'file');
    const options = { selector, cwd, env, after: normalizeCommandRoutes({
      subcommands: [{ name: 'check', runner: 'node', entry: 'tool.mjs' }],
    }) };
    const reviewed = await inspectManagedCommandRouteChanges(options);
    expect(reviewed.affectedPermissions).toEqual([]);
    expect(reviewed.permissionReadFailures).toEqual([link]);
    expect(reviewed.codexRulesDigest).toBeDefined();

    await fs.unlink(link);
    await fs.symlink(path.join(cwd, 'missing.rules'), link, 'file');
    const updated = await inspectManagedCommandRouteChanges(options);
    expect(updated.permissionReadFailures).toEqual(reviewed.permissionReadFailures);
    expect(updated.codexRulesDigest).not.toBe(reviewed.codexRulesDigest);
  });

  it('reviews OpenCode rule changes in the selected scope and keeps the native pattern visible', async () => {
    const cwd = isolated.layout.fixtureCwd;
    const env = { ...isolated.env, OPENCODE_CONFIG_DIR: path.join(cwd, 'alternate-global') };
    const selector = 'fixture/inspection-commands';
    const argv = ['aw', 'command', 'run', selector, '--', 'check'];
    await fs.ensureDir(path.join(cwd, '.git'));
    const user = path.join(env.OPENCODE_CONFIG_DIR, 'opencode.json');
    const fallback = path.join(resolvePlatformConfigRoot('opencode', { cwd, env }), 'opencode.json');
    await fs.outputJson(fallback, { permissions: [{ action: 'shell', resource: '*', effect: 'deny' }] });
    const project = path.join(cwd, 'opencode.json');
    await fs.outputJson(user, { permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] });
    await fs.outputJson(project, { permissions: [{ action: 'shell', resource: argv.join(' ') + ' *', effect: 'deny' }] });
    const options = { selector, cwd, env, after: normalizeCommandRoutes({
      subcommands: [{ name: 'check', runner: 'node', entry: 'tool.mjs' }],
    }) };
    const personal = await inspectManagedCommandRouteChanges({ ...options, userOnly: true });
    expect(personal.affectedPermissions).toEqual([expect.objectContaining({ platform: 'opencode', path: user, action: 'ask', resourcePattern: '*' })]);
    const scoped = await inspectManagedCommandRouteChanges(options);
    expect(scoped.affectedPermissions).toHaveLength(2);
    expect(scoped.affectedPermissions).toContainEqual({ platform: 'opencode', path: project, action: 'deny', argvPrefix: argv });
    expect(scoped.permissionReadFailures).not.toContain(project);
    const unresolved = await inspectManagedCommandRouteChanges({ ...options, env: { ...env, OPENCODE_CONFIG_DIR: 'relative' } });
    expect(unresolved.affectedPermissions).toEqual([{ platform: 'opencode', path: project, action: 'deny', argvPrefix: argv }]);
    expect(unresolved.permissionReadFailures).toContain('OPENCODE_CONFIG_DIR');
  });

  it.each(['invalid JSON', 'invalid rule', 'unreadable file'] as const)('keeps inspecting OpenCode layers when the target fails with %s', async (damage) => {
    const cwd = isolated.layout.fixtureCwd;
    const project = path.join(cwd, 'opencode.json');
    const alternateProject = path.join(cwd, 'opencode.jsonc');
    const custom = path.join(cwd, 'custom.json');
    const env = { ...isolated.env, OPENCODE_CONFIG: custom };
    const user = path.join(resolvePlatformConfigRoot('opencode', { cwd, env }), 'opencode.json');
    const selector = 'fixture/inspection-commands';
    const argv = ['aw', 'command', 'run', selector, '--', 'check'];
    const rule = (effect: string) => ({ action: 'shell', resource: argv.join(' ') + ' *', effect });
    await fs.ensureDir(path.join(cwd, '.git'));
    await fs.outputJson(user, { permissions: [rule('ask')] });
    await fs.outputJson(alternateProject, { permissions: [rule('deny')] });
    await fs.outputJson(custom, { agents: { reviewer: { permissions: [rule('allow')] } } });
    if (damage === 'invalid JSON') await fs.outputFile(project, '{"permissions": [');
    else if (damage === 'invalid rule') await fs.outputJson(project, { permissions: [rule('allow'), rule('unknown'), rule('deny')] });
    else await fs.ensureDir(project);

    const review = await inspectManagedCommandRouteChanges({ selector, cwd, env, after: normalizeCommandRoutes({
      subcommands: [{ name: 'check', runner: 'node', entry: 'tool.mjs' }],
    }) });
    const match = (file: string, action: string) => ({ platform: 'opencode', path: file, action, argvPrefix: argv });
    expect(review.permissionReadFailures.filter((file) => file === project)).toEqual([project]);
    expect(review.affectedPermissions).toEqual(expect.arrayContaining([
      match(user, 'ask'), match(alternateProject, 'deny'), match(custom, 'allow'),
    ]));
    expect(review.affectedPermissions.filter(({ path: file }) => file === project)).toEqual(
      damage === 'invalid rule' ? [match(project, 'allow'), match(project, 'deny')] : []);
  });

  it('shows configured Grok rules without treating an unread project file as a grant', async () => {
    const cwd = isolated.layout.fixtureCwd;
    const selector = 'fixture/inspection-commands';
    const env = { ...isolated.env, GROK_HOME: path.join(cwd, 'personal-grok') };
    const user = path.join(env.GROK_HOME, 'config.toml');
    const project = path.join(cwd, '.grok/config.toml');
    await fs.ensureDir(path.join(cwd, '.git'));
    await fs.outputFile(user, `[permission]\nrules = [{ action = "ask", tool = "bash", pattern = "aw command run ${selector} -- check *" }]\n`);
    await fs.outputFile(project, '# project configuration\n');
    const options = { selector, cwd, env, after: normalizeCommandRoutes({ subcommands: [{ name: 'check', runner: 'node', entry: 'tool.mjs' }] }) };
    const scoped = await inspectManagedCommandRouteChanges(options);
    expect(scoped.affectedPermissions).toContainEqual(expect.objectContaining({ platform: 'grok', path: user, action: 'ask' }));
    expect(scoped.unverifiedGrokProjectPath).toBe(project);
    expect((await inspectManagedCommandRouteChanges({ ...options, userOnly: true })).unverifiedGrokProjectPath).toBeUndefined();
  });

  // A broken shared revision cannot block offline removal of independently owned Native output.
  it.each(['missing', 'damaged'] as const)('cleans owned Native output with a %s command revision pointer', async (pointerState) => {
    const root = path.join(isolated.layout.fixtureCwd, 'source');
    const bin = path.join(isolated.layout.fixtureCwd, 'bin');
    await fs.outputFile(path.join(bin, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { ...isolated.env, PATH: `${bin}${path.delimiter}${isolated.env.PATH ?? ''}` };
    await fs.outputJson(path.join(root, '.agents-plugin/plugin.json'), {
      schemaVersion: 4, name: 'inspection-commands', version: '1.0.0', description: 'Inspection fixture.',
      platforms: ['opencode'], requires: { aw: { capabilities: ['aw.managed-commands.v2'] } },
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      artifacts: { configKeys: [] },
      command: { sourceDir: './tools', mode: 'dynamic', refreshKeys: [] },
    });
    await fs.outputFile(path.join(root, 'render.mjs'), 'throw new Error("Inspection and cleanup must not run the renderer.");\n');
    const sourceDirectory = path.join(root, 'tools');
    await fs.outputFile(path.join(sourceDirectory, 'tool.mjs'), 'export {};\n');
    const plugin = { ...await readPluginManifest(root), sourceId: 'fixture',
      sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'fixture/inspection-commands' };
    const producer = { sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginName: plugin.manifest.name };
    await syncManagedCommandPackage({ producer, sourceDirectory, env, record: {
      schemaVersion: 2, producer, pluginVersion: '1.0.0',
      sourceContentDigest: `sha256:${'b'.repeat(64)}`,
      routes: normalizeCommandRoutes({ subcommands: [{ name: 'run', runner: 'node', entry: 'tool.mjs' }] }),
      runtimeConfigPlatforms: [], dynamicRefreshKeys: [],
    } });
    const packageRoot = path.join(isolated.layout.awHomeDir, 'commands', 'packages', getCommandPackageId(producer));
    const ownerPath = path.join(packageRoot, 'owner.json');
    const owner = await fs.readJson(ownerPath);
    const pointer = path.join(packageRoot, 'current.json');
    if (pointerState === 'damaged') await fs.writeFile(pointer, '{broken');
    else await fs.remove(pointer);
    const context = { ...createCommandExecutionContext({ env, nativeCliRunner: async () => ({ exitCode: 0, stdout: 'opencode 2.0.0', stderr: '' }) }),
      preparedArtifactRenderResults: prepared };
    const integration = createRebuildIntegration({ context });
    const common = { plugin, platform: 'opencode' as const, scope: 'user' as const,
      cwd: isolated.layout.fixtureCwd, catalog: { rootDir: root, source: 'local' as const } };
    const inspected = await integration.buildTarget({ ...common, command: 'install', readOnlyInspectionPlan: true });
    const component = inspected.ownedComponents[0];
    if (component?.kind !== 'owned-directory') throw new Error('Missing package ownership component.');
    expect(inspected.operationActions).toBeUndefined();
    await fs.outputFile(path.join(component.path, 'plugin.js'), 'export default {};\n');
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity });
    const target = await integration.buildTarget({ ...common, command: 'cleanup' });
    await integration.sealMarketplaceGenerations([target]);
    const result = await executeRebuildOperation({ command: 'cleanup', target, driver: integration.driver });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(await fs.pathExists(component.path)).toBe(false);
    expect(await fs.readJson(ownerPath)).toEqual(owner);
    if (pointerState === 'damaged') expect(await fs.readFile(pointer, 'utf8')).toBe('{broken');
    else expect(await fs.pathExists(pointer)).toBe(false);
  });
});
