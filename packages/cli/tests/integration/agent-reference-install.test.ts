import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';

import { createEmptyPreferences, writePreferences } from '../../src/intent/deployment-preferences.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { SKILL_OWNER_MARKER, type SkillOwnerMarker } from '../../src/utils/ownership.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { createCodexNativeTestRuntime, replaceCatalogSourcesConfig } from '../helpers/write-command-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

it('preserves one Codex User package and bound Skill when Project-only becomes both scopes and then User-only', async () => {
  // Test Value Gate: actual public write/status path, package owner evidence, and
  // physical supplement files prove that project activation cannot contaminate the User package.
  const isolation = getCurrentSourceTestIsolation();
  const { env, layout: { fixtureCwd: cwd } } = isolation;
  installNativeTestDiscovery({ platforms: ['codex'] });
  await fs.ensureDir(path.join(cwd, '.git'));
  await fs.outputFile(path.join(env.CODEX_HOME!, 'config.toml'),
    `[projects.${JSON.stringify(await fs.realpath(cwd))}]\ntrust_level = "trusted"\n`);
  await writePreferences({ scope: 'user', cwd, env }, { ...createEmptyPreferences(), targets: ['codex'] });

  const pluginName = 'binding-fixture';
  const selector = `team/${pluginName}`;
  const source = path.join(cwd, 'source');
  const pluginRoot = path.join(source, 'plugins', pluginName);
  await fs.outputFile(path.join(pluginRoot, 'skills/review/SKILL.md'),
    '---\nname: review\ndescription: Review using the package Agent.\n---\nUse {{aw.agent:reviewer}}.\n');
  await fs.outputFile(path.join(pluginRoot, 'skills/review/README.md'), 'Review with {{aw.agent:reviewer}}.\n');
  await fs.outputFile(path.join(pluginRoot, 'scripts/render.mjs'), [
    "import fs from 'node:fs';",
    "const context=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
    'const plan={version:3,components:[],omitted:[],unmet:[]};',
    'if(context.allowedOutputKinds.includes("agent")) {',
    ' const name=context.scope==="user" ? "reviewer" : "project-reviewer";',
    ' plan.components.push({id:"computed-role",kind:"agent",name,content:{description:"Review the change.",prompt:"Read-only review."}});',
    '}',
    'process.stdout.write(JSON.stringify(plan));',
  ].join('\n'));
  await createCatalogSnapshotFixture(source, pluginName, ['aw.skill-agent-placeholder.v1'], undefined, (manifest) => {
    manifest.platforms = ['codex'];
    manifest.skills = './skills';
    manifest.artifacts = { configKeys: [] };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
  });
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ env, expectedDigest: snapshot.digest,
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: source }] } });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });

  const runtime = await createCodexNativeTestRuntime(isolation);
  const run = async (args: string[]) => {
    const result = await runCliEntry([...args, '--json'], { cwd, env, interactive: false, nativeCliRunner: runtime.nativeCliRunner });
    return { exitCode: result.exitCode, receipt: result.parseJsonStdout<Record<string, unknown>>() };
  };
  const projectRole = path.join(cwd, '.codex', 'agents', `aw-team-${pluginName}-project-reviewer.toml`);
  const userRole = path.join(env.CODEX_HOME!, 'agents', `aw-team-${pluginName}-reviewer.toml`);
  const incorrectUserRole = path.join(env.CODEX_HOME!, 'agents', `aw-team-${pluginName}-project-reviewer.toml`);
  const projectOnly = await run(['plugin', 'install', selector, '--scope', 'project', '--target', 'codex', '--yes']);
  expect(projectOnly, JSON.stringify(projectOnly)).toMatchObject({ exitCode: 0, receipt: { status: 'success' } });
  const roots = [...runtime.packageRoots].filter(([id]) => id.startsWith(`${pluginName}@`));
  expect(roots).toHaveLength(1);
  const packageRoot = roots[0]![1];
  const skillPath = path.join(packageRoot, 'skills/review/SKILL.md');
  const markerPath = path.join(packageRoot, SKILL_OWNER_MARKER);
  const marker = async () => (await fs.readJson(markerPath) as SkillOwnerMarker).nativeProjection!;
  const first = await marker();
  const bytes = await fs.readFile(skillPath, 'utf8');
  expect(bytes).toContain(`Use aw-team-${pluginName}-reviewer.`);
  expect(bytes).not.toContain('{{aw.agent:');
  expect(first.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(await fs.pathExists(projectRole)).toBe(true);
  expect(await fs.pathExists(userRole)).toBe(false);
  expect(await fs.pathExists(incorrectUserRole)).toBe(false);

  const both = await run(['plugin', 'install', selector, '--scope', 'user', '--target', 'codex', '--yes']);
  // Native Codex's effective list cannot distinguish a separate Project
  // activation once the same package is enabled for User. Preserve that
  // existing observation boundary; the actual shared package and roles must
  // be complete even when the Project's activation is unconfirmed.
  expect(both, JSON.stringify(both)).toMatchObject({ exitCode: 4, receipt: { status: 'partial', data: {
    targetResults: expect.arrayContaining([
      expect.objectContaining({ scope: 'user', satisfaction: 'installed', installedComponentIds: ['skill:review', 'computed-role'] }),
      expect.objectContaining({ scope: 'project', blockerCodes: ['deploymentPostcheckFailed'],
        componentGaps: expect.arrayContaining([expect.objectContaining({ reasonCode: 'codexProjectActivationUnconfirmed' })]) }),
    ]),
  } } });
  expect(await fs.pathExists(projectRole)).toBe(true);
  expect(await fs.pathExists(userRole)).toBe(true);
  expect((await marker()).inputDigest).toBe(first.inputDigest);
  expect(await fs.readFile(skillPath, 'utf8')).toBe(bytes);

  const status = async () => readRecoveryStatus({ cwd, env, cliVersion: '1.0.0', nativeCliRunner: runtime.nativeCliRunner });
  const bothStatus = await status();
  expect(bothStatus.inventory?.filter((entry) => entry.pluginId === selector).flatMap((entry) => entry.targetResults)).toEqual(expect.arrayContaining([
    expect.objectContaining({ scope: 'user', satisfaction: 'installed' }),
    expect.objectContaining({ scope: 'project', satisfaction: 'unknown',
      deploymentObservations: expect.arrayContaining([expect.objectContaining({ after: expect.objectContaining({
        components: expect.arrayContaining([
          expect.objectContaining({ id: 'skill:review', presence: 'present' }),
          expect.objectContaining({ id: 'computed-role', presence: 'present' }),
        ]),
      }) })]),
    }),
  ]));
  expect(bothStatus.observedTargets?.flatMap(({ blockers, reasons }) => [...blockers, ...(reasons ?? [])])
    .map(({ code }) => code)).not.toContain('platformInputDrift');

  const removed = await run(['plugin', 'remove', selector, '--scope', 'project', '--yes']);
  expect(removed, JSON.stringify(removed)).toMatchObject({ exitCode: 0, receipt: { status: 'success' } });
  expect(await fs.pathExists(projectRole)).toBe(false);
  expect(await fs.pathExists(userRole)).toBe(true);
  expect((await marker()).inputDigest).toBe(first.inputDigest);
  expect(await fs.readFile(skillPath, 'utf8')).toBe(bytes);
  const personal = await status();
  expect(personal.inventory?.find((entry) => entry.pluginId === selector)?.targetResults).toContainEqual(expect.objectContaining({
    scope: 'user', satisfaction: 'installed',
  }));
  expect(personal.observedTargets?.flatMap(({ blockers, reasons }) => [...blockers, ...(reasons ?? [])])
    .map(({ code }) => code)).not.toContain('platformInputDrift');
}, 120_000);

it.each(['opencode', 'generic'] as const)('records a mixed plugin Agent gap in the actual %s lifecycle and status', async (platform) => {
  // The preparation result must reach the public receipt and later read-only status,
  // without publishing the referencing Skill or running the renderer again.
  const { env, layout: { fixtureCwd: cwd } } = getCurrentSourceTestIsolation();
  if (platform === 'opencode') installNativeTestDiscovery({ platforms: ['opencode'] });
  await fs.ensureDir(path.join(cwd, '.git'));
  await writePreferences({ scope: 'user', cwd, env }, { ...createEmptyPreferences(), targets: [platform] });
  const source = path.join(cwd, 'source');
  const pluginRoot = path.join(source, 'plugins/binding-fixture');
  const selector = 'team/binding-fixture';
  const sentinel = path.join(cwd, 'renderer-ran');
  for (const [name, body] of [['consumer', 'Use {{aw.agent:reviewer}}.'], ['independent', 'Independent work.']]) {
    await fs.outputFile(path.join(pluginRoot, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Reference fixture.\n---\n${body}\n`);
    await fs.outputFile(path.join(pluginRoot, 'skills', name, 'README.md'), '# Fixture\n');
  }
  await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(sentinel)}, 'ran');`,
    "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
    'const components = context.allowedOutputKinds.includes("agent") && context.platformCapabilities.kinds.agent.status === "supported"',
    '  ? [{ id: "role", kind: "agent", name: "reviewer", content: { description: "Review.", prompt: "Review the change." } }] : [];',
    'console.log(JSON.stringify({ version: 3, components, omitted: [], unmet: [] }));',
  ].join('\n'));
  await createCatalogSnapshotFixture(source, 'binding-fixture', ['aw.skill-agent-placeholder.v1'], undefined, (manifest) => {
    manifest.platforms = [platform];
    manifest.skills = './skills';
    manifest.artifacts = { configKeys: [] };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
  });
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ env, expectedDigest: snapshot.digest,
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: source }] } });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });

  const result = await runCliEntry(['plugin', 'install', selector, '--scope', 'project', '--target', platform, '--yes', '--json'],
    { cwd, env, interactive: false });
  const receipt = result.parseJsonStdout<Record<string, unknown>>();
  const gap = { id: 'skill:consumer', name: 'consumer', kind: 'skill', reasonCode: 'interface-unsupported',
    requiredFeatures: [{ feature: 'component.kind.agent' }], providerPluginId: selector, agent: platform, renderScope: 'project' };
  expect({ exitCode: result.exitCode, receipt }, JSON.stringify(receipt)).toMatchObject({ exitCode: 0, receipt: { status: 'success', data: {
    targetResults: [expect.objectContaining({ target: platform, satisfaction: 'installed', componentGaps: [gap],
      installedComponentIds: ['skill:independent'] })],
  } } });
  const skills = platform === 'generic' ? path.join(cwd, '.agents', 'skills')
    : path.join(cwd, '.opencode', 'plugins', 'aw-team-binding-fixture', 'skills');
  expect(await fs.pathExists(path.join(skills, 'consumer'))).toBe(false);
  expect(await fs.readFile(path.join(skills, 'independent', 'SKILL.md'), 'utf8')).toContain('Independent work.');
  expect(await fs.pathExists(sentinel)).toBe(true);
  await fs.remove(sentinel);
  const status = await readRecoveryStatus({ cwd, env, scope: 'project', cliVersion: '1.0.0' });
  const observed = status.inventory?.find(({ pluginId }) => pluginId === selector)?.targetResults;
  expect(observed, JSON.stringify(status)).toContainEqual(expect.objectContaining({
    satisfaction: 'installed', componentGaps: [gap], installedComponentIds: ['skill:independent'],
  }));
  expect(await fs.pathExists(sentinel)).toBe(false);
}, 60_000);
