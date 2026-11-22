import { randomUUID } from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import { expect, it } from 'vitest';
import { normalizePluginCommand } from '@lesliechan721/aw-plugin-core/manifest';

import type { CommandManagementResult } from '../../src/commands/managed-commands.js';
import type { LifecycleData } from '../../src/commands/public-lifecycle-result.js';
import type { CommandResult } from '../../src/output/public-result.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Test Value Gate: updating a declaration's physical form must migrate only AW-owned rules.
it('reviews and migrates Claude plain command prefixes without taking over manual rules', async () => {
  const isolation = getCurrentSourceTestIsolation();
  const { env, layout: { fixtureCwd: cwd } } = isolation;
  const catalog = path.join(cwd, 'catalog');
  const { nativeCliRunner } = await createClaudeNativeTestRuntime(isolation);
  await fs.ensureDir(path.join(cwd, '.git'));
  await fs.outputFile(path.join(catalog, 'plugins/demo/skills/demo/SKILL.md'),
    '---\nname: demo\ndescription: Command prefix fixture.\n---\nUse the fixture.\n');
  await createCatalogSnapshotFixture(catalog, 'demo', [], 'Command prefix fixture.', (manifest) => {
    manifest.platforms = ['claude'];
    manifest.skills = './skills';
    manifest.extensions = { permissions: [{ name: 'example', allow: ['find sample'], ask: ['printf confirm'], deny: ['printf blocked'] }] };
  });
  const run = async <T extends object>(args: string[], exitCode = 0) => {
    const result = await runCliEntry([...args, '--json'], { cwd, env, interactive: false, nativeCliRunner });
    expect(result.exitCode, result.stdout || result.stderr).toBe(exitCode);
    return result.parseJsonStdout<CommandResult<T>>();
  };
  const selector = 'local/demo';
  await run(['source', 'add', 'local', '--path', catalog, '--primary', '--no-auto-check', '--yes']);
  await run(['source', 'sync', 'local', '--yes']);
  await run(['target', 'set', 'claude', '--context', 'project']);
  const settingsPath = path.join(cwd, '.claude/settings.local.json');
  const install = ['plugin', 'install', selector, '--scope', 'project', '--target', 'claude'];
  const subject = { pluginId: selector, target: 'claude', scope: 'project', field: 'permissions.example' };
  const impacts = ([['allow', 'find sample'], ['ask', 'printf confirm'], ['deny', 'printf blocked']] as const).map(([action, prefix]) => {
    const resource = `Bash(${prefix} *)`;
    const extra = action === 'allow' ? 'known-safe environment assignments.*require approval for find' : 'any leading environment assignment';
    return { code: 'hostPermissionAdditionalImpact', subject,
      message: expect.stringMatching(new RegExp(`${action} Bash.*recognized shell wrappers.*${extra}`, 'u')),
      detail: { reasonCode: 'claude-bash-wrapper-matching', path: settingsPath, permissionAction: action, permissionResource: resource } };
  });
  const preview = await run<LifecycleData>(install, 3);
  expect(preview.data.confirmation).toMatchObject({ required: true, provided: false, effects: expect.arrayContaining(
    impacts.map(({ code, subject, message }) => expect.objectContaining({ code, subject, message })),
  ) });
  expect(await fs.pathExists(settingsPath)).toBe(false);
  const installed = await run<LifecycleData>([...install, '--yes']);
  expect(installed.diagnostics).toEqual(expect.arrayContaining(impacts.map((impact) => expect.objectContaining(impact))));
  const settings = await fs.readJson(settingsPath);
  expect(settings.permissions).toMatchObject({ allow: ['Bash(find sample *)'], ask: ['Bash(printf confirm *)'], deny: ['Bash(printf blocked *)'] });

  // Recreate the prior AW spelling and a manual rule that shared its exact value.
  const [owner] = Object.keys(settings.awGenerated.permissions);
  expect(owner).toBeDefined();
  const legacy = { allow: ['Bash(find sample)'], ask: ['Bash(printf confirm)'], deny: ['Bash(printf blocked)'] };
  settings.awGenerated.permissions[owner!] = legacy;
  settings.awGenerated.manualPermissions = { ask: legacy.ask };
  settings.permissions = { ...legacy, allow: [...legacy.allow, 'Read'] };
  settings.sandbox = { enabled: true, excludedCommands: ['npm test'] };
  await fs.writeJson(settingsPath, settings);
  const synced = await run<LifecycleData>(['plugin', 'sync', selector, '--context', 'project', '--target', 'claude', '--yes']);
  expect(synced.diagnostics).toEqual(expect.arrayContaining(impacts.map((impact) => expect.objectContaining(impact))));
  const migrated = await fs.readJson(settingsPath);
  expect(migrated.permissions).toMatchObject({ allow: ['Read', 'Bash(find sample *)'],
    ask: ['Bash(printf confirm)', 'Bash(printf confirm *)'], deny: ['Bash(printf blocked *)'] });
  expect(migrated.sandbox).toEqual(settings.sandbox);
});

// Test Value Gate: shared routing must not erase a project's inactive host restrictions.
it.each(['claude', 'codex'] as const)('retains $0 project restrictions across route restoration and source rebinding', async (platform) => {
  const isolation = getCurrentSourceTestIsolation();
  const { env } = isolation;
  const cwd = isolation.layout.fixtureCwd;
  const projectA = path.join(cwd, 'project-a');
  const projectB = path.join(cwd, 'project-b');
  const catalog = path.join(cwd, 'catalog');
  const replacement = path.join(cwd, 'replacement-catalog');
  await fs.ensureDir(path.join(projectA, '.git'));
  await fs.ensureDir(path.join(projectB, '.git'));
  const external = platform === 'claude' ? await createClaudeNativeTestRuntime(isolation)
    : await createCodexNativeTestRuntime(isolation, { projectRoots: [projectA, projectB] });
  const selector = 'local/demo';
  const call = ['command', 'run', selector, '--', 'run'];
  const observed = path.join(cwd, 'observed.json');
  const invoke = (args: string[], cwd = projectA) => runCliEntry(args, { cwd, env, interactive: false,
    nativeCliRunner: external.nativeCliRunner });
  const read = async <T extends object>(args: string[], cwd = projectA, exitCode = 0) => {
    const result = await invoke([...args, '--json'], cwd);
    expect(result.exitCode, result.stdout || result.stderr).toBe(exitCode);
    return result.parseJsonStdout<CommandResult<T>>();
  };
  const lifecycle = (action: 'install' | 'sync', cwd = projectA, exitCode = 0) => read<LifecycleData>([
    'plugin', action, selector, action === 'install' ? '--scope' : '--context', 'project', '--target', platform, '--yes',
  ], cwd, exitCode);
  const syncSource = () => read(['source', 'sync', 'local', '--yes']);
  const show = async () => (await read<CommandManagementResult>(['command', 'show', selector])).data.commands[0]!;
  const verifyAllowedFixture = async (expected: string) => {
    await fs.remove(observed);
    const result = await invoke([...call, 'observe']);
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(await fs.readJson(observed)).toEqual({ version: expected, argv: ['observe'] });
  };

  async function writeSnapshot(root: string, version: string, hasRoute: boolean, includePolicy = true) {
    const pluginRoot = path.join(root, 'plugins/demo');
    await fs.outputFile(path.join(pluginRoot, 'tools/run.mjs'), `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ version: ${JSON.stringify(version)}, argv: process.argv.slice(2) }));\n`);
    await fs.outputFile(path.join(pluginRoot, 'skills/consumer/SKILL.md'),
      '---\nname: consumer\ndescription: Command policy fixture.\n---\n{{aw.command}} run\n');
    await createCatalogSnapshotFixture(root, 'demo', [], 'Command policy fixture.', (manifest) => {
      manifest.version = version;
      manifest.platforms = [platform];
      manifest.skills = './skills';
      manifest.command = normalizePluginCommand({
        sourceDir: './tools', mode: 'static',
        routes: { subcommands: hasRoute ? [{ name: 'run', runner: 'node', entry: 'run.mjs' }] : [] },
      }, manifest);
      if (includePolicy) manifest.extensions = { permissions: [
        { name: 'grant', allow: [{ argsPrefix: [] }],
          ...(platform === 'claude' ? { agentOverrides: { claude: { sandbox: {
            excludedCommands: [{ argsPrefix: ['run'] }],
          } } } } : {}) },
        { name: 'restrict', ask: [{ argsPrefix: ['run', 'confirm'] }], deny: [{ argsPrefix: ['run', 'blocked'] }] },
      ] };
    });
  }
  await writeSnapshot(catalog, '1.0.0', true);
  await read(['source', 'add', 'local', '--path', catalog, '--primary', '--no-auto-check', '--yes']);
  await syncSource();
  await read(['target', 'set', platform, '--context', 'project']);
  const installed = await lifecycle('install');
  expect(installed.status, JSON.stringify(installed)).toBe('success');

  const settingsFile = path.join(projectA, '.claude/settings.local.json');
  const rulesDir = path.join(projectA, '.codex/rules');
  const rulesFile = async (name: string) => {
    const file = (await fs.readdir(rulesDir)).find((entry) => entry.endsWith(`-${name}.rules`));
    return file && path.join(rulesDir, file);
  };
  let verifyRestrictions: () => Promise<string>;
  let verifyNoGrants: () => Promise<void>;
  // Controlled policy check for the fixture's exact argv-prefix rules. No host session or denied command starts.
  let decide: (rules: string, argv: string[]) => 'ask' | 'deny' | undefined;
  if (platform === 'claude') {
    const settings = await fs.readJson(settingsFile);
    expect(settings.permissions.allow).toEqual(['Bash(aw command run local/demo -- *)']);
    expect(settings.sandbox.excludedCommands).toEqual(['aw command run local/demo -- run *']);
    verifyNoGrants = async () => {
      const current = await fs.readJson(settingsFile);
      expect(current.permissions.allow ?? []).toEqual([]);
      expect(current.sandbox?.excludedCommands ?? []).toEqual([]);
    };
    verifyRestrictions = async () => {
      const raw = await fs.readFile(settingsFile, 'utf8');
      const permissions = JSON.parse(raw).permissions;
      expect(permissions.ask).toEqual(['Bash(aw command run local/demo -- run confirm *)']);
      expect(permissions.deny).toEqual(['Bash(aw command run local/demo -- run blocked *)']);
      return raw;
    };
    decide = (rules, argv) => {
      const permissions: { ask: string[]; deny: string[] } = JSON.parse(rules).permissions;
      const command = argv.join(' ');
      return (['deny', 'ask'] as const).find((action) => permissions[action].some((rule) => {
        const prefix = rule.slice(5, -3);
        return rule.endsWith(' *)') && (command === prefix || command.startsWith(`${prefix} `));
      }));
    };
  } else {
    const grantFile = (await rulesFile('grant'))!;
    const restrictFile = (await rulesFile('restrict'))!;
    expect(await fs.readFile(grantFile, 'utf8')).toContain('["aw","command","run","local/demo","--"], decision = "allow"');
    verifyNoGrants = async () => { expect(await fs.pathExists(grantFile)).toBe(false); };
    verifyRestrictions = async () => {
      const raw = await fs.readFile(restrictFile, 'utf8');
      expect(raw).toContain('["aw","command","run","local/demo","--","run","confirm"], decision = "prompt"');
      expect(raw).toContain('["aw","command","run","local/demo","--","run","blocked"], decision = "forbidden"');
      return raw;
    };
    decide = (rules, argv) => {
      for (const [, pattern, decision] of rules.matchAll(/^prefix_rule\(pattern = (\[.*\]), decision = "(prompt|forbidden)"\)$/gmu)) {
        const prefix: string[] = JSON.parse(pattern!);
        if (prefix.every((token, index) => argv[index] === token)) return decision === 'forbidden' ? 'deny' : 'ask';
      }
      return undefined;
    };
  }
  function verifyDecisions(rules: string) {
    for (const extra of [[], ['fixture', 'extra']]) {
      expect(decide(rules, ['aw', ...call, 'confirm', ...extra])).toBe('ask');
      expect(decide(rules, ['aw', ...call, 'blocked', ...extra])).toBe('deny');
    }
    expect(decide(rules, ['aw', ...call, 'observe'])).toBeUndefined();
  }

  await verifyAllowedFixture('1.0.0');
  const active = await show();
  const staleRevision = platform === 'claude' ? path.join(path.dirname(active.resourceRoot!), randomUUID()) : undefined;
  if (staleRevision) {
    // A stale revision that points outside the package must be preserved during cleanup.
    await fs.symlink(projectB, staleRevision, process.platform === 'win32' ? 'junction' : 'dir');
  }
  await writeSnapshot(catalog, '2.0.0', false);
  await syncSource();
  const cleared = await lifecycle('sync', projectA, 4);
  expect(cleared.data.commandResults, JSON.stringify(cleared.diagnostics)).toContainEqual(expect.objectContaining({
    selector, availability: 'empty', action: 'updated', state: staleRevision ? 'partial' : 'completed',
  }));
  const current = await show();
  expect(current.availability).toBe('empty');
  expect(current.resourceRoot).not.toBe(active.resourceRoot);
  if (staleRevision) {
    expect(cleared.status).toBe('partial');
    expect(cleared.nextActions).toContainEqual(expect.objectContaining({
      kind: 'command', argv: ['aw', 'command', 'package', 'sync', selector], requiresConfirmation: true,
    }));
    expect(await fs.realpath(staleRevision)).toBe(await fs.realpath(projectB));
    await fs.unlink(staleRevision);
  }
  await verifyNoGrants();
  expect(cleared.diagnostics).toContainEqual(expect.objectContaining({ code: 'invocationPolicyNotApplied',
    subject: { pluginId: selector, target: platform, scope: 'project', field: 'permissions.grant' },
    detail: { reasonCode: 'command-route-unreachable', skippedPermissionActions: platform === 'claude' ? ['allow', 'sandbox'] : ['allow'] },
  }));
  const restrictionsBeforeRestore = await verifyRestrictions();
  verifyDecisions(restrictionsBeforeRestore);
  expect(await invoke([...call, 'observe'])).toMatchObject({ exitCode: 2,
    stderr: expect.stringContaining('commandRouteNotFound') });

  await writeSnapshot(catalog, '3.0.0', true);
  await syncSource();
  await read(['target', 'set', platform, '--context', 'project'], projectB);
  const restored = await lifecycle('install', projectB);
  expect(restored.status, JSON.stringify(restored.diagnostics)).toBe('success');
  expect(restored.data.commandResults).toContainEqual(expect.objectContaining({ selector, availability: 'ready' }));
  await verifyNoGrants();
  const restoredRestrictions = await verifyRestrictions();
  expect(restoredRestrictions).toBe(restrictionsBeforeRestore);
  verifyDecisions(restoredRestrictions);
  await verifyAllowedFixture('3.0.0');

  await writeSnapshot(replacement, '4.0.0', true, false);
  await read(['source', 'update', 'local', '--path', replacement, '--yes'], projectB);
  await syncSource();
  expect(await invoke([...call, 'observe'])).toMatchObject({ exitCode: 1,
    stderr: expect.stringContaining('commandNotFound') });
  const sync = ['command', 'package', 'sync', selector];
  const preview = await read<CommandManagementResult>(sync, projectA, 3);
  expect(preview.data.packageReview).toMatchObject({ existingApprovalsMayMatch: true, affectedPermissions: expect.arrayContaining([
    expect.objectContaining({ platform, action: 'ask', argvPrefix: ['aw', ...call, 'confirm'] }),
    expect.objectContaining({ platform, action: 'deny', argvPrefix: ['aw', ...call, 'blocked'] }),
  ]) });
  const rebound = await read<CommandManagementResult>([...sync, '--yes'], projectB);
  expect(rebound.data.changes).toEqual([{ kind: 'package', id: expect.any(String), action: 'created' }]);
  expect(rebound.data.changes[0]?.id).not.toBe(restored.data.commandResults?.[0]?.packageId);
  await verifyNoGrants();
  const reboundRestrictions = await verifyRestrictions();
  expect(reboundRestrictions).toBe(restrictionsBeforeRestore);
  verifyDecisions(reboundRestrictions);
  await verifyAllowedFixture('4.0.0');
});
