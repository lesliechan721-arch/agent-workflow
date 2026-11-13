import os from 'node:os';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPONENT_KINDS, getHookHandlerContract, createAwPluginRequirementsReceipt,
  type ExpectedComponentSet, type PlatformCapabilitiesV1, type PlatformComponentPlanV3,
  type PlatformRenderContextV1, type PluginComponent,
} from '@lesliechan721/aw-plugin-core/manifest';
import type { PluginMeta } from '../../src/types.js';
import {
  ARTIFACT_RENDERER_MAX_STDOUT_BYTES, preparePlatformComponents, runPreparedArtifactRenderer,
  type ResolvedArtifactRenderConfig,
} from '../../src/utils/artifact-renderer.js';
import { calculateFileDigest, type PluginProcessRunner } from '../../src/utils/plugin-scripts.js';
import { projectPlatform } from '../../src/platforms/projection.js';
import type { ProjectionInput } from '../../src/platforms/contracts.js';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';

// Test Value Gate: exercise production preparation, authority boundaries and process cleanup.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.remove(root); });
const empty: PlatformComponentPlanV3 = { version: 3, components: [], omitted: [], unmet: [] };
function capabilities(): PlatformCapabilitiesV1 {
  return { schemaVersion: 1, platform: 'codex', scope: 'user', basis: 'profile', profileId: 'test-profile', consumers: [],
    kinds: Object.fromEntries(COMPONENT_KINDS.map((kind) => [kind, { status: 'supported', reasonCodes: [], delivery: ['native-package'] }])) as PlatformCapabilitiesV1['kinds'],
    features: {
      'agent.execution': { status: 'supported', reasonCodes: [], values: ['isolated-context'] },
      'agent.prompt-mode': { status: 'supported', reasonCodes: [], values: ['host-default'] },
      'agent.tools': { status: 'supported', reasonCodes: [], values: ['allowlist', 'none'] },
      'mcp.transport': { status: 'supported', reasonCodes: [], values: ['stdio', 'http', 'sse'] },
      'instruction.coverage': { status: 'supported', reasonCodes: [], values: ['main', 'plugin-agents', 'other-agents'] },
      'instruction.paths': { status: 'supported', reasonCodes: [] },
      'skill.runtime-config': { status: 'supported', reasonCodes: [], values: ['aw.installed-runtime-config.v2'] },
      'hook.common.before_tool': { status: 'supported', reasonCodes: [],
        values: Object.keys(getHookHandlerContract('codex', 'common', 'before_tool').protocol!.responses) },
    } };
}
function config(): ResolvedArtifactRenderConfig {
  return { mode: 'artifact-render', targetScope: 'user', schema: {
    count: { type: 'number' }, absent: { type: 'string' }, token: { type: 'string', sensitive: true },
    hidden: { type: 'string' },
  }, values: { count: 0, token: 'private-token-value', hidden: 'unrelated' },
  sources: { count: 'common', absent: 'missing', token: 'platform', hidden: 'common' }, issues: [], stores: {} };
}
async function plugin(script = 'console.log(JSON.stringify({version:3,components:[],omitted:[],unmet:[]}));'): Promise<PluginMeta> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-v3-renderer-'));
  roots.push(root);
  const manifest: PluginMeta['manifest'] = { schemaVersion: 4, name: 'dynamic-test', version: '1.0.0', description: 'Renderer test',
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    artifacts: { configKeys: ['count', 'absent', 'token'] }, scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
    config: { schemaVersion: 5, fields: config().schema! } };
  const manifestPath = path.join(root, '.agents-plugin/plugin.json');
  await fs.outputJson(manifestPath, manifest);
  await fs.outputFile(path.join(root, 'render.mjs'), script);
  return { rootDir: root, manifestPath, manifest, sourceId: 'test', pluginId: 'test/dynamic-test' };
}
function skill(name = 'task', files: Extract<PluginComponent, { kind: 'skill' }>['content']['files'] = {}): PluginComponent {
  return { id: name, kind: 'skill', name, content: { files: {
    'SKILL.md': { text: `---\nname: ${name}\ndescription: Run the task.\n---\nRun the task.\n` }, ...files,
  } } };
}
function renderer(makePlan: (context: PlatformRenderContextV1) => unknown, contexts: PlatformRenderContextV1[] = []): PluginProcessRunner {
  return { run: async (invocation) => {
    const context = await fs.readJson(invocation.env.AW_PLUGIN_CONTEXT!) as PlatformRenderContextV1;
    contexts.push(context);
    return { exitCode: 0, signal: null, stdout: JSON.stringify(makePlan(context)), stderr: '', timedOut: false };
  } };
}
function prepare(item: PluginMeta, overrides: Partial<Parameters<typeof preparePlatformComponents>[0]> = {}) {
  return preparePlatformComponents({ plugin: item, platform: 'codex', renderScope: 'user', kinds: [...COMPONENT_KINDS],
    capabilities: capabilities(), config: config(), cwd: item.rootDir, ...overrides });
}

describe('complete platform component preparation', () => {
  it('regenerates complete collections from zero and allows changing categories, names and counts', async () => {
    const item = await plugin();
    const contexts: PlatformRenderContextV1[] = [];
    const runner = renderer((context) => context.allowedOutputKinds.includes('skill') ? empty : {
      ...empty, components: Array.from({ length: Number(context.config.values.count) }, (_, index) => ({
        id: `role-${index}`, name: `review-${index}`, kind: index ? 'mcp' : 'agent',
        content: index ? { type: 'stdio', command: 'node', args: ['--version'] } : { description: 'Review', prompt: 'Review the change.' },
      })),
    }, contexts);
    const first = await prepare(item, { runner });
    expect(first.empty).toBe('intentional');
    const next = config(); next.values.count = 2;
    const second = await prepare(item, { runner, config: next, changedConfigKeys: [] });
    expect(second.expected.components.map((entry) => [entry.id, entry.kind])).toEqual([['role-0', 'agent'], ['role-1', 'mcp']]);
    expect(second.expected.sources).toEqual({ 'role-0': 'dynamic', 'role-1': 'dynamic' });
    expect(second.evidence.renderInputDigest).not.toBe(first.evidence.renderInputDigest);
    expect(contexts.map((context) => context.allowedOutputKinds)).toEqual([
      ['skill'], ['mcp', 'agent', 'hook', 'instruction'], ['skill'], ['mcp', 'agent', 'hook', 'instruction'],
    ]);
  });

  it('clips every config and history field by batch authority and keeps missing facts', async () => {
    const item = await plugin();
    const contexts: PlatformRenderContextV1[] = [];
    await prepare(item, { runner: renderer(() => empty, contexts), changedConfigKeys: ['count', 'token', 'hidden'], previousComponents: [
      { id: 'task', kind: 'skill', name: 'task', content: 'not forwarded' },
      { id: 'role', kind: 'agent', name: 'role', path: '/host/private' },
    ] as PlatformRenderContextV1['previousComponents'] });
    const [skills, other] = contexts;
    expect(Object.keys(skills!.config.schema.fields)).toEqual(['count', 'absent']);
    expect(skills!.config.values).toEqual({ count: 0 });
    expect(skills!.config.sources).toEqual({ count: 'common', absent: 'missing' });
    expect(skills!.changedConfigKeys).toEqual(['count']);
    expect(skills!.previousComponents).toEqual([{ id: 'task', kind: 'skill', name: 'task' }]);
    expect(other!.config.values).toEqual({ count: 0, token: 'private-token-value' });
    expect(other!.previousComponents).toEqual([{ id: 'role', kind: 'agent', name: 'role' }]);
    const invalid = config();
    invalid.issues = [{ type: 'invalid-config', key: 'hidden', message: 'private-token-value' },
      { type: 'invalid-config', key: 'token', message: 'private-token-value' }];
    await prepare(item, { kinds: ['skill'], config: invalid, runner: renderer(() => empty) });
  });

  it('does not call empty batches or scopes intentionally excluded by the author', async () => {
    const item = await plugin();
    let calls = 0;
    const runner = renderer(() => { calls += 1; return empty; });
    await prepare(item, { kinds: [], runner });
    item.manifest.artifacts!.scopes = ['project'];
    expect((await prepare(item, { runner })).empty).toBe('intentional');
    expect(calls).toBe(0);
    item.manifest.artifacts!.scopes = ['user'];
    await prepare(item, { kinds: ['agent'], runner });
    expect(calls).toBe(1);
  });

  it('merges static coverage and dynamic gaps without losing missing values or component associations', async () => {
    const item = await plugin();
    item.manifest.extensions = { instructions: [{ name: 'rules', title: 'Rules', content: 'Check the result.', coverage: ['main', 'plugin-agents'] }] };
    const facts = capabilities();
    facts.features['instruction.coverage'] = { status: 'supported', reasonCodes: [], values: ['main'] };
    facts.features['hook.common.before_tool'] = { status: 'supported', reasonCodes: [], values: ['notify'] };
    const result = await prepare(item, { capabilities: facts, runner: renderer((context) => context.allowedOutputKinds.includes('skill') ? empty : {
      ...empty, unmet: [{ id: 'blocking-hook', kind: 'hook', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['block'] }], reasonCode: 'interface-unsupported' }],
    }) });
    expect(result.expected.components).toMatchObject([{ id: 'instruction:rules', content: { coverage: ['main'] } }]);
    expect(result.expected.unmet).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentId: 'instruction:rules', requiredFeatures: [{ feature: 'instruction.coverage', values: ['plugin-agents'] }] }),
      expect.objectContaining({ id: 'blocking-hook', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['block'] }] }),
    ]));
    expect(result.empty).toBeNull();
  });

  it('rejects dynamic identity and name conflicts with static declarations', async () => {
    const item = await plugin();
    item.manifest.extensions = { agents: [{ name: 'review', description: 'Review', prompt: 'Check the change.' }] };
    for (const id of ['agent:review', 'new-id']) {
      await expect(prepare(item, { runner: renderer((context) => context.allowedOutputKinds.includes('skill') ? empty : {
        ...empty, components: [{ id, kind: 'agent', name: 'review', content: { description: 'Review', prompt: 'Check.' } }],
      }) })).rejects.toThrow(/component(Identity|Name)Conflict/u);
    }
    await expect(prepare(item, { runner: renderer((context) => context.allowedOutputKinds.includes('skill') ? empty : {
      ...empty, omitted: [{ id: 'agent:review', kind: 'agent', reason: 'config-disabled' }],
    }) })).rejects.toThrow('componentIdentityConflict');
  });

  it('keeps all-unmet distinct from intentional empty and rejects invalid or unsupported output', async () => {
    const item = await plugin();
    const facts = capabilities();
    facts.features['agent.tools'] = { status: 'unsupported', reasonCodes: ['interface-unsupported'] };
    const unmet = await prepare(item, { capabilities: facts, runner: renderer((context) => context.allowedOutputKinds.includes('skill') ? empty : {
      ...empty, unmet: [{ id: 'restricted', kind: 'agent', requiredFeatures: [{ feature: 'agent.tools', values: ['none'] }], reasonCode: 'interface-unsupported' }],
    }) });
    expect(unmet.empty).toBe('unmet');
    expect(unmet.expected.unmet[0]!.requiredFeatures).toEqual([{ feature: 'agent.tools', values: ['none'] }]);
    for (const plan of [
      { ...empty, unexpected: true },
      { ...empty, components: [{ id: 'bad', kind: 'agent', name: 'bad', content: { description: 'Bad', prompt: 'Check.', tools: [] } }] },
      { ...empty, components: [skill()] },
      { ...empty, unmet: [{ id: 'bad', kind: 'agent', requiredFeatures: [], reasonCode: 'interface-unsupported' }] },
    ]) {
      await expect(prepare(item, { kinds: ['agent'], capabilities: facts, runner: renderer(() => plan) })).rejects.toThrow();
    }
  });

  it('redacts short sensitive values from schema diagnostics', async () => {
    const item = await plugin();
    const selected = config(); selected.values.token = 'xyz';
    const failure = prepare(item, { kinds: ['agent'], config: selected, runner: renderer(() => ({ ...empty,
      components: [{ id: 'invalid/xyz', kind: 'agent', name: 'role', content: { description: 'Check', prompt: 'Check.' } }],
    })) });
    await expect(failure).rejects.toThrow();
    await failure.catch((error: Error) => expect(error.message).not.toContain('xyz'));
  });

  it('freezes text, binary bundle files and exact runtime imports, and verifies local import closure', async () => {
    const item = await plugin();
    item.manifest.artifacts!.sourceDirs = ['./resources'];
    await fs.outputFile(path.join(item.rootDir, 'resources/data.bin'), Buffer.from([0, 255, 3]));
    await fs.outputFile(path.join(item.rootDir, '.agents-plugin/runtime-imports/helper.mjs'), 'export const ok = true;\n');
    item.manifest.artifacts!.runtimeImports = [{ name: 'helper', plugin: 'provider', export: 'helper', resolved: {
      path: './.agents-plugin/runtime-imports/helper.mjs', digest: await calculateFileDigest(path.join(item.rootDir, '.agents-plugin/runtime-imports/helper.mjs')),
      providerPluginId: 'test/provider', providerVersion: '1.0.0', source: './helper.mjs', requiredCapabilities: [], capabilitySetDigest: `sha256:${'0'.repeat(64)}`,
    } }];
    const result = await prepare(item, { kinds: ['skill'], runner: renderer(() => ({ ...empty, components: [skill('task', {
      'assets/data.bin': { source: { kind: 'bundle', path: 'resources/data.bin' } },
      'scripts/helper.mjs': { source: { kind: 'runtime-import', name: 'helper', path: 'helper.mjs' } },
      'scripts/main.mjs': { text: "import './helper.mjs';\n" },
    })] })) });
    expect(result.resources.files.find((file) => file.path === 'assets/data.bin')!.bytes).toEqual(Buffer.from([0, 255, 3]));
    expect(result.resources.bundleFiles).toEqual([]);
    await fs.writeFile(path.join(item.rootDir, 'resources/data.bin'), 'changed');
    expect(result.resources.files.find((file) => file.path === 'assets/data.bin')!.bytes).toEqual(Buffer.from([0, 255, 3]));
    await expect(prepare(item, { kinds: ['skill'], runner: renderer(() => ({ ...empty, components: [skill('task', {
      'scripts/main.mjs': { text: "import './missing.mjs';\n" },
    })] })) })).rejects.toThrow('componentResourceClosureInvalid');
  });

  it('freezes only command resource imports and rejects changes to declared inputs', async () => {
    const item = await plugin();
    item.manifest.artifacts!.sourceDirs = ['./resources'];
    await fs.outputFile(path.join(item.rootDir, 'resources/hook.mjs'), "import './helper.mjs';\n");
    await fs.outputFile(path.join(item.rootDir, 'resources/helper.mjs'), 'export const ready = true;\n');
    await fs.outputFile(path.join(item.rootDir, 'resources/template.md'), 'Source template.\n');
    const result = await prepare(item, { kinds: ['hook'], runner: renderer(() => ({ ...empty, components: [{
      id: 'notice', name: 'notice', kind: 'hook', content: { dialect: 'common', event: 'before_tool', feedback: 'notify',
        command: 'node "${CODEX_PLUGIN_ROOT}/resources/hook.mjs"' },
    }] })) });
    expect(result.resources.bundleFiles.map((file) => file.path)).toEqual(['resources/helper.mjs', 'resources/hook.mjs']);
    const runner: PluginProcessRunner = { run: async () => {
      await fs.writeFile(path.join(item.rootDir, 'resources/helper.mjs'), 'changed');
      return { exitCode: 0, signal: null, stdout: JSON.stringify(empty), stderr: '', timedOut: false };
    } };
    await expect(prepare(item, { kinds: ['hook'], runner })).rejects.toThrow('componentResourceChanged');
  });

  // Test Value Gate: real preparation freezes local scripts; native projection must not depend on the host cwd.
  it.each(['cursor', 'antigravity', 'opencode', 'pi', 'gemini', 'copilot', 'grok'] as const)(
    'freezes and locates %s Hook/MCP scripts and imports from another cwd', async (platform) => {
      const item = await plugin();
      const trace = path.join(item.rootDir, 'hook-trace.txt');
      item.manifest.artifacts!.sourceDirs = ['./scripts'];
      item.manifest.extensions = { hooks: [{ id: 'guard', event: 'before_tool', feedback: 'notify',
        command: `"${process.execPath}" ./scripts/guard.mjs` }] };
      await fs.outputFile(path.join(item.rootDir, 'scripts/helper.mjs'), 'export const value = "verified-package";\n');
      await fs.outputFile(path.join(item.rootDir, 'scripts/server.mjs'), 'import {value} from "./helper.mjs"; console.log(value);\n');
      await fs.outputFile(path.join(item.rootDir, 'scripts/guard.mjs'), `import fs from 'node:fs'; import {value} from './helper.mjs'; fs.appendFileSync(${JSON.stringify(trace)},value+'\\n');\n`);
      const facts = { ...capabilities(), platform };
      const protocol = getHookHandlerContract(platform, 'common', 'before_tool').protocol;
      if (protocol) facts.features['hook.common.before_tool'] = { status: 'supported', reasonCodes: [], values: ['notify'] };
      else delete facts.features['hook.common.before_tool'];
      const argument = platform === 'pi' ? 'scripts/server.mjs' : './scripts/server.mjs';
      const prepared = await prepare(item, { platform, kinds: ['hook', 'mcp'], capabilities: facts,
        runner: renderer(() => ({ ...empty, components: [{ id: 'server', name: 'server', kind: 'mcp',
          content: { type: 'stdio', command: process.execPath, args: [argument] } }] })) });
      expect(prepared.resources.bundleFiles.map((file) => file.path)).toEqual(protocol
        ? ['scripts/guard.mjs', 'scripts/helper.mjs', 'scripts/server.mjs'] : ['scripts/helper.mjs', 'scripts/server.mjs']);
      if (!protocol) expect(prepared.expected.unmet).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'hook' })]));
      await fs.remove(path.join(item.rootDir, 'scripts'));
      const env = { HOME: path.join(item.rootDir, 'home with spaces'), AW_HOME: path.join(item.rootDir, 'aw'),
        CODEX_HOME: path.join(item.rootDir, 'codex'), CLAUDE_CONFIG_DIR: path.join(item.rootDir, 'claude') };
      const ctx = { cwd: item.rootDir, env, stagingRoot: path.join(item.rootDir, 'projection') };
      const resolution = await resolveDeployments(ctx, { plugin: { sourceId: 'test', sourceIdentity: `sha256:${'a'.repeat(64)}`,
        pluginId: item.pluginId!, version: item.manifest.version }, scope: { kind: 'user' }, operation: 'ensure', recoveryCandidates: [],
        discovery: { platform, availability: 'available', diagnostics: [], installations: [{ id: 'controlled', product: 'cli',
          availability: 'available', version: '1.0.0', reasonCodes: [], entry: { kind: 'cli', executable: platform, configRoot: path.join(item.rootDir, 'host with spaces') } }] } });
      const binding = resolution.bindings[0]!;
      const unit = resolution.renderUnits.find((entry) => entry.output === 'package')!;
      const input: ProjectionInput = { binding, renderUnit: unit, components: prepared.expected.components,
        capabilities: facts, resources: prepared.resources, policy: { platform, permissions: [] } };
      const projected = await projectPlatform(ctx, input);
      const packageRoot = (await getDeploymentLayout(ctx, binding)).packageRoot;
      await fs.copy(projected.bundle!.stagingRoot, packageRoot);
      const unrelated = path.join(item.rootDir, 'unrelated cwd');
      await fs.ensureDir(unrelated);
      let command: string;
      let args: string[];
      let hook: (() => Promise<unknown>) | undefined;
      if (platform === 'pi' || platform === 'opencode') {
        let server: { command: string | string[]; args?: string[] } | undefined;
        if (platform === 'opencode') {
          const stub = path.join(packageRoot, 'node_modules/@opencode/plugin');
          await fs.outputJson(path.join(stub, 'package.json'), { name: '@opencode/plugin', type: 'module', exports: './index.mjs' });
          await fs.outputFile(path.join(stub, 'index.mjs'), 'export const Plugin = { define: value => value };\n');
        }
        const extension = await import(/* @vite-ignore */ pathToFileURL(path.join(packageRoot, 'index.mjs')).href);
        if (platform === 'pi') extension.default({ registerMcpServer: (_name: string, value: typeof server) => { server = value; },
          on: (_event: string, handler: () => Promise<unknown>) => { hook = handler; } });
        else await extension.default.setup({ mcp: { transform: async (update: (editor: unknown) => void) => {
          update({ get: () => undefined, set: (_name: string, value: typeof server) => { server = value; } }); return { dispose() {} };
        } }, tool: { hook: async (_event: string, handler: () => Promise<unknown>) => { hook = handler; return { dispose() {} }; } } });
        command = Array.isArray(server!.command) ? server!.command[0]! : server!.command;
        args = Array.isArray(server!.command) ? server!.command.slice(1) : server!.args!;
      } else {
        const configPath = platform === 'gemini' ? 'gemini-extension.json' : platform === 'antigravity' ? 'mcp_config.json'
          : platform === 'cursor' || platform === 'copilot' ? 'mcp.json' : '.mcp.json';
        const server = (await fs.readJson(path.join(packageRoot, configPath))).mcpServers.server;
        command = server.command; args = server.args;
        if (platform === 'antigravity') {
          const value = (await fs.readJson(path.join(packageRoot, 'hooks.json'))).guard.PreToolUse[0].hooks[0].command;
          hook = () => promisify(exec)(value, { cwd: unrelated });
        }
      }
      expect(path.isAbsolute(args[0]!)).toBe(true);
      expect((await promisify(execFile)(command, args, { cwd: unrelated })).stdout.trim()).toBe('verified-package');
      expect((await promisify(execFile)(command, args, { cwd: item.rootDir })).stdout.trim()).toBe('verified-package');
      if (protocol) {
        expect(hook).toBeDefined();
        await hook!();
        expect(await fs.readFile(trace, 'utf8')).toBe('verified-package\n');
      }
    },
  );

  it('rejects undeclared command files, escaping imports and unverified resource expansion', async () => {
    const item = await plugin();
    item.manifest.artifacts!.sourceDirs = ['./scripts'];
    await fs.outputFile(path.join(item.rootDir, 'scripts/server.mjs'), 'export {};\n');
    await fs.outputFile(path.join(item.rootDir, 'outside.mjs'), 'export {};\n');
    for (const argument of ['./outside.mjs', './scripts/../outside.mjs', '${UNKNOWN_PLUGIN_ROOT}/scripts/server.mjs']) {
      await expect(prepare(item, { kinds: ['mcp'], runner: renderer(() => ({ ...empty, components: [{ id: 'server', name: 'server', kind: 'mcp',
        content: { type: 'stdio', command: process.execPath, args: [argument] } }] })) })).rejects.toThrow(/componentResource/u);
    }
    await fs.outputFile(path.join(item.rootDir, 'scripts/server.mjs'), 'import "../outside.mjs";\n');
    await expect(prepare(item, { kinds: ['mcp'], runner: renderer(() => ({ ...empty, components: [{ id: 'server', name: 'server', kind: 'mcp',
      content: { type: 'stdio', command: process.execPath, args: ['./scripts/server.mjs'] } }] })) })).rejects.toThrow('Command import escapes declared inputs');
  });

  it('rejects one native handler repeated across real static normalization and dynamic rendering', async () => {
    const item = await plugin();
    item.manifest.extensions = { hooks: [{ id: 'static', event: 'before_tool', feedback: 'notify', command: 'echo guard' }] };
    const facts = capabilities();
    facts.features['hook.native.PreToolUse'] = { status: 'supported', reasonCodes: [], values: ['notify'] };
    facts.features['hook.matcher'] = { status: 'supported', reasonCodes: [], values: ['native.PreToolUse'] };
    await expect(prepare(item, { kinds: ['hook'], capabilities: facts, runner: renderer(() => ({ ...empty, components: [{
      id: 'dynamic', name: 'dynamic', kind: 'hook', content: { dialect: 'native', event: 'PreToolUse', feedback: 'notify', matcher: '*', command: 'echo guard' },
    }] })) })).rejects.toThrow(/duplicate codex hook handler/iu);
  });

  // Test Value Gate: final native handlers must retain the same effective ranges that passed complete-set validation.
  it.each([
    ['codex', 'single'], ['claude', 'single'],
    ['codex', 'dynamic'], ['claude', 'dynamic'],
    ['codex', 'mixed'], ['claude', 'mixed'],
  ] as const)('preserves %s SessionStart matcher semantics through %s preparation and final projection', async (platform, source) => {
    const item = await plugin();
    const command = 'echo aw-session';
    const common: PluginComponent = { id: 'public-start', name: 'public-start', kind: 'hook',
      content: { dialect: 'common', event: 'session_start', feedback: 'notify', command } };
    const native: PluginComponent = { id: 'native-start', name: 'native-start', kind: 'hook',
      content: { dialect: 'native', event: 'SessionStart', feedback: 'notify', matcher: '*', command } };
    const facts = { ...capabilities(), platform, features: {
      'hook.common.session_start': { status: 'supported' as const, reasonCodes: [], values: ['notify'] },
      'hook.native.SessionStart': { status: 'supported' as const, reasonCodes: [], values: ['notify'] },
      'hook.matcher': { status: 'supported' as const, reasonCodes: [], values: ['common.session_start', 'native.SessionStart'] },
    } };
    if (source === 'mixed') item.manifest.extensions = { hooks: [{ id: 'public-start', event: 'session_start',
      feedback: 'notify', matcher: 'resume|startup|clear', command }] };
    const dynamic = source === 'mixed' ? [native] : source === 'single' ? [common] : [common, native];
    const prepared = await prepare(item, { platform, kinds: ['hook'], capabilities: facts,
      runner: renderer(() => ({ ...empty, components: dynamic })) });
    expect(prepared.expected.unmet).toEqual([]);
    expect(prepared.expected.components).toHaveLength(source === 'single' ? 1 : 2);
    if (source === 'mixed') expect(prepared.expected.sources['hook:public-start']).toBe('static');
    const input: ProjectionInput = {
      binding: { id: 'binding', platform, plugin: { sourceId: 'test', sourceIdentity: `sha256:${'a'.repeat(64)}`,
        pluginId: item.pluginId!, version: item.manifest.version }, scope: { kind: 'user' },
        route: platform === 'codex' ? 'codex-marketplace' : 'claude-marketplace', consumers: [],
        physicalKey: 'fixture-placement', activationKey: 'fixture-activation', renderUnitIds: ['unit'] },
      renderUnit: { id: 'unit', physicalKey: 'fixture-placement', renderScope: { kind: 'user' }, output: 'package', kinds: ['hook'], consumers: [] },
      capabilities: facts, components: prepared.expected.components, resources: prepared.resources, policy: { platform, permissions: [] },
    };
    const result = await projectPlatform({ cwd: item.rootDir, stagingRoot: path.join(item.rootDir, 'stage'),
      env: { HOME: path.join(item.rootDir, 'home'), AW_HOME: path.join(item.rootDir, 'aw'), CODEX_HOME: path.join(item.rootDir, 'codex') } }, input);
    const hooks = (await fs.readJson(path.join(result.bundle!.stagingRoot, 'hooks/hooks.json'))).hooks.SessionStart as Array<{
      matcher: string; hooks: Array<{ type: string; command: string }>;
    }>;
    const expected = source === 'single' ? ['startup|resume|clear'] : ['startup|resume|clear', '*'];
    expect(hooks.map((hook) => hook.matcher).sort()).toEqual(expected.sort());
    expect(hooks.every((hook) => hook.hooks.length === 1 && hook.hooks[0]!.command === command)).toBe(true);
    const commonHandler = hooks.find((hook) => hook.matcher !== '*')!;
    expect(commonHandler.matcher.split('|')).not.toContain('compact');
    expect(commonHandler.matcher.split('|')).not.toContain('fork');
  });

  it.each([
    ['codex', 'dynamic'], ['claude', 'dynamic'], ['codex', 'mixed'], ['claude', 'mixed'],
  ] as const)('rejects equivalent %s SessionStart handlers from a %s complete set before projection', async (platform, source) => {
    const item = await plugin();
    const command = 'echo aw-session';
    const common: PluginComponent = { id: 'public-start', name: 'public-start', kind: 'hook',
      content: { dialect: 'common', event: 'session_start', feedback: 'notify', command } };
    const native: PluginComponent = { id: 'native-start', name: 'native-start', kind: 'hook',
      content: { dialect: 'native', event: 'SessionStart', feedback: 'notify', matcher: 'startup|resume|clear', command } };
    const facts = { ...capabilities(), platform, features: {
      'hook.common.session_start': { status: 'supported' as const, reasonCodes: [], values: ['notify'] },
      'hook.native.SessionStart': { status: 'supported' as const, reasonCodes: [], values: ['notify'] },
      'hook.matcher': { status: 'supported' as const, reasonCodes: [], values: ['native.SessionStart'] },
    } };
    if (source === 'mixed') item.manifest.extensions = { hooks: [{ id: 'public-start', event: 'session_start', feedback: 'notify', command }] };
    await expect(prepare(item, { platform, kinds: ['hook'], capabilities: facts,
      runner: renderer(() => ({ ...empty, components: source === 'mixed' ? [native] : [common, native] })) }))
      .rejects.toThrow(`duplicate ${platform} hook handler for SessionStart`);
  });

  it('freezes an exact declared runtime import as a command resource and rejects undeclared metadata', async () => {
    const item = await plugin();
    const relative = '.agents-plugin/runtime-imports/helper.mjs';
    const location = path.join(item.rootDir, relative);
    await fs.outputFile(location, 'console.log("verified-runtime-import");\n');
    item.manifest.artifacts!.runtimeImports = [{ name: 'helper.mjs', plugin: 'provider', export: 'helper', resolved: {
      path: `./${relative}`, digest: await calculateFileDigest(location), providerPluginId: 'test/provider',
      providerVersion: '1.0.0', source: './helper.mjs', requiredCapabilities: [], capabilitySetDigest: `sha256:${'0'.repeat(64)}`,
    } }];
    const run = (argument: string) => renderer(() => ({ ...empty, components: [{ id: 'server', name: 'server', kind: 'mcp',
      content: { type: 'stdio', command: process.execPath, args: [argument] } }] }));
    const prepared = await prepare(item, { kinds: ['mcp'], runner: run(`./${relative}`) });
    expect(prepared.resources.bundleFiles.map((file) => file.path)).toEqual([relative]);
    const ctx = { cwd: item.rootDir, stagingRoot: path.join(item.rootDir, 'stage'), env: {
      HOME: path.join(item.rootDir, 'home'), AW_HOME: path.join(item.rootDir, 'aw'), CODEX_HOME: path.join(item.rootDir, 'codex'),
    } };
    const resolution = await resolveDeployments(ctx, { plugin: { sourceId: 'test', sourceIdentity: `sha256:${'a'.repeat(64)}`,
      pluginId: item.pluginId!, version: '1.0.0' }, scope: { kind: 'user' }, operation: 'ensure', recoveryCandidates: [],
      discovery: { platform: 'codex', availability: 'available', diagnostics: [], installations: [{ id: 'controlled', product: 'cli',
        version: '1.0.0', availability: 'available', reasonCodes: [], entry: { kind: 'cli', executable: 'codex', configRoot: ctx.env.CODEX_HOME } }] } });
    const binding = resolution.bindings[0]!;
    await fs.remove(location);
    const projected = await projectPlatform(ctx, { binding, renderUnit: resolution.renderUnits[0]!, capabilities: capabilities(),
      components: prepared.expected.components, resources: prepared.resources, policy: { platform: 'codex', permissions: [] } });
    const packageRoot = (await getDeploymentLayout(ctx, binding)).packageRoot;
    await fs.copy(projected.bundle!.stagingRoot, packageRoot);
    const server = (await fs.readJson(path.join(packageRoot, '.mcp.json'))).mcpServers.server;
    expect((await promisify(execFile)(server.command, server.args, { cwd: item.rootDir })).stdout.trim()).toBe('verified-runtime-import');
    await fs.outputFile(location, 'console.log("verified-runtime-import");\n');
    await fs.outputFile(path.join(item.rootDir, '.agents-plugin/runtime-imports/unlisted.mjs'), 'export {};\n');
    await expect(prepare(item, { kinds: ['mcp'], runner: run('./.agents-plugin/runtime-imports/unlisted.mjs') })).rejects.toThrow('outside declared inputs');
    item.manifest.artifacts!.runtimeImports![0]!.resolved = { ...item.manifest.artifacts!.runtimeImports![0]!.resolved!,
      path: './.agents-plugin/plugin.json', digest: await calculateFileDigest(item.manifestPath) };
    await expect(prepare(item, { kinds: ['mcp'], runner: run('./.agents-plugin/plugin.json') })).rejects.toThrow('componentResourceReserved');
  });

  it('rejects undeclared, traversing and linked sources and renderer reserved paths', async () => {
    const item = await plugin();
    item.manifest.artifacts!.sourceDirs = ['./resources'];
    await fs.outputFile(path.join(item.rootDir, 'resources/SKILL.md'), '---\nname: task\ndescription: Task\n---\nTask\n');
    await fs.outputFile(path.join(item.rootDir, 'outside.md'), 'outside');
    for (const source of [
      { kind: 'bundle', path: 'outside.md' }, { kind: 'bundle', path: 'resources/../outside.md' },
      { kind: 'runtime-import', name: 'unknown', path: 'file.mjs' },
    ]) {
      await expect(prepare(item, { kinds: ['skill'], runner: renderer(() => ({ ...empty, components: [skill('task', { 'SKILL.md': { source } })] })) })).rejects.toThrow();
    }
    await expect(prepare(item, { kinds: ['skill'], runner: renderer(() => ({ ...empty, components: [skill('task', {
      'scripts/aw-runtime-config.mjs': { text: 'export const fake = true;' },
    })] })) })).rejects.toThrow(/reserved/iu);
    if (process.platform !== 'win32') {
      await fs.symlink(path.join(item.rootDir, 'outside.md'), path.join(item.rootDir, 'resources/linked.md'));
      await expect(prepare(item, { kinds: ['skill'], runner: renderer(() => empty) })).rejects.toThrow(/links/iu);
    }
  });

  it.runIf(process.platform !== 'win32')('preserves executable and plain UTF-8 modes from static normalization through projection', async () => {
    const item = await plugin();
    delete item.manifest.artifacts;
    delete item.manifest.scripts;
    item.manifest.skills = './skills';
    const root = path.join(item.rootDir, 'skills/task');
    await fs.outputFile(path.join(root, 'SKILL.md'), '---\nname: task\ndescription: Run the task.\n---\nUse the scripts.\n');
    const content = '#!/bin/sh\nprintf "done\\n"\n';
    for (const [file, mode] of [['executable.sh', 0o755], ['plain.sh', 0o644]] as const) {
      const location = path.join(root, 'scripts', file);
      await fs.outputFile(location, content);
      await fs.chmod(location, mode);
    }
    const facts = capabilities();
    const prepared = await prepare(item, { kinds: ['skill'], capabilities: facts });
    await fs.remove(path.join(root, 'scripts'));
    const input: ProjectionInput = {
      binding: { id: 'binding', platform: 'codex', plugin: { sourceId: 'test', sourceIdentity: `sha256:${'a'.repeat(64)}`,
        pluginId: 'test/dynamic-test', version: item.manifest.version }, scope: { kind: 'user' }, route: 'codex-marketplace',
        consumers: [], physicalKey: 'fixture-placement', activationKey: 'fixture-activation', renderUnitIds: ['unit'] },
      renderUnit: { id: 'unit', physicalKey: 'fixture-placement', renderScope: { kind: 'user' }, output: 'package', kinds: ['skill'], consumers: [] },
      capabilities: facts, components: prepared.expected.components, policy: { platform: 'codex', permissions: [] }, resources: prepared.resources,
    };
    const projected = await projectPlatform({ cwd: item.rootDir, stagingRoot: path.join(item.rootDir, 'stage'),
      env: { AW_HOME: path.join(item.rootDir, 'aw'), CODEX_HOME: path.join(item.rootDir, 'codex') } }, input);
    for (const [file, mode] of [['executable.sh', 0o755], ['plain.sh', 0o644]] as const) {
      const location = path.join(projected.bundle!.stagingRoot, 'skills/task/scripts', file);
      expect(await fs.readFile(location, 'utf8')).toBe(content);
      expect((await fs.stat(location)).mode & 0o777).toBe(mode);
    }
  });

  it('excludes only a verified static requirements receipt from sensitive text scanning', async () => {
    const item = await plugin();
    item.manifest.name = 'private-token-value';
    item.manifest.skills = './skills';
    delete item.manifest.artifacts;
    delete item.manifest.scripts;
    await fs.writeJson(item.manifestPath, item.manifest);
    const root = path.join(item.rootDir, 'skills/task');
    await fs.outputFile(path.join(root, 'SKILL.md'), '---\nname: task\ndescription: Run the task.\n---\nSafe task.\n');
    const receipt = createAwPluginRequirementsReceipt({ name: item.manifest.name, version: item.manifest.version }, []);
    const receiptPath = path.join(root, 'aw-plugin-requirements.json');
    await fs.outputJson(receiptPath, receipt);
    const result = await prepare(item, { kinds: ['skill'] });
    expect(result.resources.files.find((file) => file.path === 'aw-plugin-requirements.json')?.bytes.toString('utf8')).toContain(item.manifest.name);
    await fs.outputJson(receiptPath, { ...receipt, plugin: { ...receipt.plugin, version: '2.0.0' } });
    await expect(prepare(item, { kinds: ['skill'] })).rejects.toThrow('does not match');
    await fs.outputJson(receiptPath, receipt);
    await fs.outputFile(path.join(root, 'body.md'), 'private-token-value');
    await expect(prepare(item, { kinds: ['skill'] })).rejects.toThrow('componentSensitiveConfigExposed');
  });

  it('creates runtime snapshots from the actual component and actual render scope', async () => {
    const item = await plugin();
    item.manifest.requires = { aw: { capabilities: ['aw.installed-runtime-config.v2'] } };
    const component = { ...skill(), runtimeConfig: { keys: ['count'] } };
    const result = await prepare(item, { kinds: ['skill'], runner: renderer(() => ({ ...empty, components: [component] })) });
    expect(result.runtimeConfigSnapshots.task).toMatchObject({ allowedKeys: ['count'], effectiveValues: { count: 0 },
      installedIdentity: { platform: 'codex', scope: 'user', configScope: 'user', artifactId: 'task', skillKey: 'task' } });
  });
});

describe('shared renderer process boundary', () => {
  it('uses isolated homes, exposes the v1 surface and removes the private context after completion', async () => {
    const item = await plugin(`import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
console.log(JSON.stringify({surface: process.env.AW_PLUGIN_SURFACE, home: process.env.HOME, awHome: process.env.AW_HOME, contextPath: process.env.AW_PLUGIN_CONTEXT, schemaVersion: context.schemaVersion}));`);
    const result = await runPreparedArtifactRenderer({ plugin: item, context: { schemaVersion: 1, surface: 'agent-plugin', platform: 'codex', scope: 'user' },
      sensitiveValues: [], cwd: item.rootDir, commandEnv: { PATH: process.env.PATH, HOME: '/host-home', AW_HOME: '/host-aw-home' } });
    const output = result.value as { surface: string; home: string; awHome: string; contextPath: string; schemaVersion: number };
    expect(output).toMatchObject({ surface: 'agent-plugin', schemaVersion: 1 });
    expect(output.home).not.toBe('/host-home'); expect(output.awHome).not.toBe('/host-aw-home');
    expect(await fs.pathExists(output.contextPath)).toBe(false);
  });

  it.each([
    { exitCode: 2, signal: null, stdout: '{}', stderr: 'private-token-value', timedOut: false },
    { exitCode: null, signal: null, stdout: '{}', stderr: '', timedOut: true },
    { exitCode: 0, signal: null, stdout: 'not JSON private-token-value', stderr: '', timedOut: false },
    { exitCode: 0, signal: null, stdout: JSON.stringify({ leaked: 'private-token-value' }), stderr: '', timedOut: false },
    { exitCode: 0, signal: null, stdout: '{}', stderr: '', timedOut: false, stdoutTruncated: true },
  ])('rejects process or output failures without returning an empty collection', async (failure) => {
    const item = await plugin();
    let contextPath = '';
    const running = runPreparedArtifactRenderer({ plugin: item, context: { surface: 'agent-plugin', scope: 'user' }, cwd: item.rootDir,
      sensitiveValues: ['private-token-value'], runner: { run: async (invocation, options) => {
        contextPath = invocation.env.AW_PLUGIN_CONTEXT!;
        expect(options.maxStdoutBytes).toBe(ARTIFACT_RENDERER_MAX_STDOUT_BYTES);
        return failure;
      } } });
    await expect(running).rejects.toThrow();
    await running.catch((error: Error) => expect(error.message).not.toContain('private-token-value'));
    expect(await fs.pathExists(contextPath)).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('terminates inherited-pipe descendants before an abort completes', async () => {
    const item = await plugin(`import {spawn} from 'node:child_process'; import fs from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(124),30000);setInterval(()=>{},1000)'], {stdio:['ignore','inherit','inherit'],detached:true});
fs.writeFileSync('child.pid', String(child.pid)); setTimeout(()=>process.exit(124),30000);setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    const running = runPreparedArtifactRenderer({ plugin: item, context: { surface: 'agent-plugin', scope: 'user' }, cwd: item.rootDir,
      sensitiveValues: [], signal: controller.signal });
    const pidFile = path.join(item.rootDir, 'child.pid');
    for (let attempt = 0; attempt < 150 && !await fs.pathExists(pidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await fs.pathExists(pidFile)).toBe(true);
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    controller.abort(reason);
    try {
      await expect(running).rejects.toBe(reason);
      let runningChild = true;
      try { process.kill(pid, 0); } catch { runningChild = false; }
      expect(runningChild).toBe(false);
    } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
  });
});
