import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { getComponentFeatureRequirements, getPlatformFeatureRegistry, type PlatformId, type PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';
import type { ProjectionInput, StageContext } from '../../src/platforms/contracts.js';
import { projectPlatform } from '../../src/platforms/projection.js';
import { projectPlatformMarketplace } from '../../src/platforms/projection-marketplace.js';
import { getDeploymentLayout } from '../../src/platforms/layout.js';
import { commandResourceReferences } from '../../src/utils/component-resources.js';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.remove(root)));
});

async function fixture(platform: PlatformId, components: PluginComponent[], output: 'package' | 'supplement' | 'generic' = 'package') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-platform-projection-'));
  temporaryRoots.push(root);
  const kinds = [...new Set(components.map((component) => component.kind))];
  const input: ProjectionInput = {
    binding: {
      id: 'binding', platform, plugin: { sourceId: 'source', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'source/example', version: '1.2.3' },
      scope: { kind: 'user' }, route: ({ codex: 'codex-marketplace', claude: 'claude-marketplace', cursor: 'cursor-workspace-hook',
        antigravity: 'antigravity-directory', opencode: 'opencode-directory', pi: 'pi-package', gemini: 'gemini-extension',
        copilot: 'copilot-marketplace', grok: 'grok-cli', generic: 'generic-skills' } as const)[platform],
      consumers: [{ id: 'consumer', product: platform === 'generic' ? 'generic' : 'cli', version: '1.2.3', availability: platform === 'generic' ? 'notApplicable' : 'available', reasonCodes: [],
        entry: platform === 'generic' ? { kind: 'generic', root: path.join(root, 'home/.agents/skills') } : { kind: 'cli', executable: path.join(root, 'client'), configRoot: path.join(root, 'client-home') } }],
      physicalKey: 'physical', activationKey: 'activation', renderUnitIds: ['unit'],
    },
    renderUnit: { id: 'unit', physicalKey: 'physical', renderScope: { kind: 'user' }, output, kinds, consumers: [] },
    capabilities: {
      schemaVersion: 1, platform, scope: 'user', basis: 'profile', profileId: 'test', consumers: [],
      kinds: Object.fromEntries(['skill', 'mcp', 'agent', 'hook', 'instruction'].map((kind) => [kind, { status: 'supported', reasonCodes: [], delivery: ['native-package'] }])) as unknown as ProjectionInput['capabilities']['kinds'],
      features: {},
    },
    components, policy: { platform, permissions: [] }, resources: { resources: [], files: [], bundleFiles: [], commandResources: [], digest: 'closure' },
  };
  for (const component of components) for (const requirement of getComponentFeatureRequirements(component)) {
    if (getPlatformFeatureRegistry()[requirement.feature]?.derivedFromKind) continue;
    const previous = input.capabilities.features[requirement.feature];
    input.capabilities.features[requirement.feature] = { status: 'supported', reasonCodes: [],
      ...(requirement.values ? { values: [...new Set([...(previous?.values ?? []), ...requirement.values])] } : {}) };
  }
  const ctx: StageContext = { cwd: root, stagingRoot: path.join(root, 'stage'), env: { HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'), AW_HOME: path.join(root, 'aw') } };
  return { root, input, ctx };
}
const skill: PluginComponent = { id: 'skill:check', kind: 'skill', name: 'check', content: { files: {
  'SKILL.md': { text: '---\nname: check\ndescription: Check the input.\n---\nRun the check.\n' },
  'scripts/check.mjs': { text: 'console.log("checked");\n' },
} } };
const agent: PluginComponent = { id: 'agent:review', kind: 'agent', name: 'review', content: { description: 'Review a change.', prompt: 'Review this change.' } };
const instruction: PluginComponent = { id: 'instruction:policy', kind: 'instruction', name: 'policy', content: {
  title: 'Policy', content: 'Preserve the source files.', coverage: ['main', 'plugin-agents'],
} };

describe('platform projection', () => {
  it.each([
    ['codex', '.agents/plugins/marketplace.json'], ['claude', '.claude-plugin/marketplace.json'],
    ['copilot', '.github/plugin/marketplace.json'],
  ] as const)('builds the complete %s marketplace descriptor with its frozen namespace', async (platform, relativePath) => {
    const { input } = await fixture(platform, [skill]);
    const policy = { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } as const;
    const descriptor = projectPlatformMarketplace({ binding: input.binding, marketplaceName: 'aw-source-namespace', entries: [
      { name: 'second', source: './plugins/second', description: 'Second package.', category: 'development', strict: true, policy },
      { name: 'example', source: './plugins/example', description: 'Example package.', category: 'development', strict: true, policy },
    ] });
    expect(descriptor.relativePath).toBe(relativePath);
    const manifest = JSON.parse(descriptor.bytes.toString('utf8'));
    expect(manifest.name).toBe('aw-source-namespace');
    expect(manifest.plugins.map((entry: { name: string }) => entry.name)).toEqual(['example', 'second']);
    if (platform === 'copilot') expect(manifest.plugins[0]).not.toHaveProperty('policy');
    else expect(manifest.plugins[0].policy).toEqual({ ...policy, products: [platform === 'codex' ? 'CODEX' : 'CLAUDE'] });
  });
  // These parse final consumer artifacts. They protect native package routing and
  // the generic writer exception; they do not establish client qualification.
  it.each([
    ['codex', '.codex-plugin/plugin.json'], ['claude', '.claude-plugin/plugin.json'],
    ['cursor', '.cursor-plugin/plugin.json'], ['antigravity', '.antigravity-plugin/plugin.json'],
    ['opencode', 'package.json'], ['pi', 'package.json'], ['gemini', 'gemini-extension.json'],
    ['copilot', 'plugin.json'], ['grok', '.grok-plugin/plugin.json'],
  ] as const)('generates the %s package and preserves complete skill resources', async (platform, manifest) => {
    const { input, ctx } = await fixture(platform, [skill]);
    const result = await projectPlatform(ctx, input);
    expect(result.bundle).not.toBeNull();
    const bundle = result.bundle!.stagingRoot;
    expect(await fs.readJson(path.join(bundle, manifest))).toMatchObject({ name: 'example', version: '1.2.3' });
    expect(await fs.readFile(path.join(bundle, 'skills/check/scripts/check.mjs'), 'utf8')).toBe('console.log("checked");\n');
    expect(result.components).toEqual([{ id: 'skill:check', nativeName: 'check', relativeOutputs: expect.arrayContaining(['skills/check/SKILL.md', 'skills/check/scripts/check.mjs']) }]);
  });

  it.each(['codex', 'claude'] as const)('injects %s instruction text for the exact main and subagent events', async (platform) => {
    const { input, ctx } = await fixture(platform, [instruction]);
    const result = await projectPlatform(ctx, input);
    const bundle = result.bundle!.stagingRoot;
    const hooks = await fs.readJson(path.join(bundle, 'hooks/hooks.json'));
    for (const event of ['SessionStart', 'SubagentStart']) {
      expect(hooks.hooks[event]).toHaveLength(1);
      const { stdout } = await promisify(execFile)(process.execPath, [path.join(bundle, 'scripts/aw-instructions.mjs'), event]);
      expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: event, additionalContext: 'Preserve the source files.' } });
    }
  });

  it('delivers Pi agents as declarations without an execution extension', async () => {
    const { input, ctx } = await fixture('pi', [agent]);
    const result = await projectPlatform(ctx, input);
    const manifest = await fs.readJson(path.join(result.bundle!.stagingRoot, 'package.json'));
    expect(manifest.pi).toEqual({ subagents: { agents: ['./agents'] } });
    expect(await fs.pathExists(path.join(result.bundle!.stagingRoot, 'index.mjs'))).toBe(false);
    expect(result.components[0]!.nativeName).toBe('aw-source-example-review');
  });

  it.each(['grok', 'gemini', 'copilot'] as const)('combines the same input instruction text into %s agents', async (platform) => {
    const { input, ctx } = await fixture(platform, [agent, instruction]);
    if (platform === 'grok') input.renderUnit.kinds = ['agent'];
    const result = await projectPlatform(ctx, input);
    const projected = result.components.find((component) => component.id === agent.id)!;
    const text = await fs.readFile(path.join(result.bundle!.stagingRoot, projected.relativeOutputs[0]!), 'utf8');
    expect(text).toContain('Preserve the source files.');
    expect(text).toContain('Review this change.');
    if (platform === 'grok') expect(result.components.map((component) => component.id)).toEqual([agent.id]);
  });

  it('rejects an unsupported required Hook feedback before staging any package', async () => {
    const hook: PluginComponent = { id: 'hook:guard', name: 'guard', kind: 'hook', content: { dialect: 'common', event: 'before_tool', feedback: 'block', command: 'node guard.mjs' } };
    const { input, ctx } = await fixture('claude', [hook]);
    input.capabilities.features['hook.common.before_tool']!.values = ['notify'];
    await expect(projectPlatform(ctx, input)).rejects.toThrow('platformProjectionCapabilityUnsupported');
    expect(await fs.pathExists(ctx.stagingRoot)).toBe(false);
  });

  it('rejects escaped Skill paths and mapped native-name collisions without writing outside staging', async () => {
    const { input, ctx, root } = await fixture('claude', [skill]);
    input.components = [{ ...skill, content: { files: { ...skill.content.files, '../escape': { text: 'unsafe' } } } }];
    await expect(projectPlatform(ctx, input)).rejects.toThrow(/Invalid/u);
    expect(await fs.pathExists(path.join(root, 'escape'))).toBe(false);
    input.components = [skill, { ...skill, id: 'second', name: 'CHECK' }];
    await expect(projectPlatform(ctx, input)).rejects.toThrow('platformProjectionNameConflict');
  });

  it('keeps generic output limited to complete Skills and avoids creating an empty package', async () => {
    const { input, ctx } = await fixture('generic', [skill], 'generic');
    const result = await projectPlatform(ctx, input);
    expect(result.bundle).toBeNull();
    expect(result.supplements).toHaveLength(1);
    expect(await fs.readFile(path.join(result.supplements[0]!.stagingPath, 'SKILL.md'), 'utf8')).toContain('description: Check the input.');
    expect(path.basename(result.supplements[0]!.destination)).toBe('aw-source-example-check');
    expect(await fs.readFile(path.join(result.supplements[0]!.stagingPath, 'SKILL.md'), 'utf8')).toContain('name: aw-source-example-check');
    input.components = [];
    expect((await projectPlatform(ctx, input)).bundle).toBeNull();
  });

  it.each(['true', '"yes"', '1'])('maps Codex automatic invocation control %s to its native Skill policy', async (value) => {
    const controlled: PluginComponent = { ...skill, content: { files: {
      'SKILL.md': { text: `---\nname: check\ndescription: Check input.\ndisable-model-invocation: ${value}\n---\nRun explicitly.\n` },
    } } };
    const { input, ctx } = await fixture('codex', [controlled]);
    input.capabilities.features['skill.invocation.model'] = { status: 'supported', reasonCodes: [], values: ['false'] };
    const result = await projectPlatform(ctx, input);
    const policy = await fs.readFile(path.join(result.bundle!.stagingRoot, 'skills/check/agents/openai.yaml'), 'utf8');
    expect(policy).toContain('allow_implicit_invocation: false');
  });

  it('uses frozen resource bytes and preserves executable mode without reopening the source', async () => {
    const sourced: PluginComponent = { ...skill, content: { files: { ...skill.content.files,
      'scripts/native.mjs': { source: { kind: 'bundle', path: 'missing/native.mjs' } },
    } } };
    const { input, ctx } = await fixture('claude', [sourced]);
    input.resources.files.push({ componentId: sourced.id, path: 'scripts/native.mjs', source: { kind: 'bundle', path: 'missing/native.mjs' }, bytes: Buffer.from('console.log("frozen");'), mode: 0o755 });
    const result = await projectPlatform(ctx, input);
    const file = path.join(result.bundle!.stagingRoot, 'skills/check/scripts/native.mjs');
    expect(await fs.readFile(file, 'utf8')).toBe('console.log("frozen");');
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o111).toBe(0o111);
  });

  it('keeps Cursor workspace loading outside the package and bound to project activation', async () => {
    const { input, ctx, root } = await fixture('cursor', [skill]);
    input.binding.scope = { kind: 'project', projectRoot: path.join(root, 'project with spaces') };
    input.renderUnit.renderScope = input.binding.scope;
    input.capabilities.scope = 'project';
    const result = await projectPlatform(ctx, input);
    const contribution = result.supplements[0]!;
    expect(contribution.kind).toBe('config-entry');
    expect(contribution.destination).toBe(path.join(root, 'project with spaces/.cursor/hooks.json'));
    expect(contribution.mergeKey).toBe('workspaceOpen:aw-source-example');
    const hook = await fs.readJson(contribution.stagingPath);
    expect(hook.hooks.workspaceOpen[0].command).toContain('aw internal cursor-workspace-open --scope project --project-root');
    expect(path.relative(result.bundle!.stagingRoot, contribution.stagingPath)).toMatch(/^\.\./u);
  });

  it('registers Pi MCP and directly appends Instructions through the generated extension', async () => {
    const mcp: PluginComponent = { id: 'mcp:docs', name: 'docs', kind: 'mcp', content: { type: 'stdio', command: 'node', args: ['server.mjs'] } };
    const { input, ctx } = await fixture('pi', [mcp, instruction]);
    input.resources.bundleFiles.push({ path: 'server.mjs', bytes: Buffer.from('export {};') });
    input.resources.commandResources.push({ componentId: mcp.id, field: 'args', index: 0,
      original: 'server.mjs', start: 0, end: 'server.mjs'.length, path: 'server.mjs' });
    const result = await projectPlatform(ctx, input);
    const extension = await import(/* @vite-ignore */ pathToFileURL(path.join(result.bundle!.stagingRoot, 'index.mjs')).href);
    const handlers = new Map<string, (event: { systemPrompt: string }) => { systemPrompt: string }>();
    const registered: unknown[][] = [];
    extension.default({ registerMcpServer: (...args: unknown[]) => registered.push(args), on: (event: string, handler: (event: { systemPrompt: string }) => { systemPrompt: string }) => handlers.set(event, handler) });
    expect(registered).toEqual([['docs', { ...mcp.content, args: [path.join(result.bundle!.stagingRoot, 'server.mjs')] }]]);
    expect(handlers.get('before_agent_start')!({ systemPrompt: 'Host prompt.' }).systemPrompt).toBe('Host prompt.\n\nPreserve the source files.');
  });

  it.each([
    ['gemini', 'gemini-extension.json', 'httpUrl'], ['antigravity', 'mcp_config.json', 'serverUrl'],
  ] as const)('uses the documented %s remote MCP transport field', async (platform, relative, urlKey) => {
    const mcp: PluginComponent = { id: 'mcp:docs', name: 'docs', kind: 'mcp', content: { type: 'http', url: 'https://example.test/mcp', headers: { 'X-Client': 'aw' } } };
    const { input, ctx } = await fixture(platform, [mcp]);
    const result = await projectPlatform(ctx, input);
    const config = await fs.readJson(path.join(result.bundle!.stagingRoot, relative));
    expect(config.mcpServers.docs).toEqual({ [urlKey]: 'https://example.test/mcp', headers: { 'X-Client': 'aw' } });
  });

  it('wraps Antigravity Hook groups and keeps conditional rules out of always-on Instructions', async () => {
    const hook: PluginComponent = { id: 'hook:guard', kind: 'hook', name: 'guard', content: { dialect: 'common', event: 'before_tool', feedback: 'notify', matcher: 'read', command: 'node ./scripts/guard.mjs' } };
    const conditional: PluginComponent = { ...instruction, content: { ...instruction.content, paths: ['src/**/*.ts'] } };
    const { input, ctx } = await fixture('antigravity', [hook, conditional]);
    input.capabilities.features['instruction.paths'] = { status: 'supported', reasonCodes: [] };
    input.resources.bundleFiles.push({ path: 'scripts/guard.mjs', bytes: Buffer.from('process.stdout.write("{}");') });
    input.resources.commandResources.push(...commandResourceReferences(hook.content.command, true, 'antigravity')
      .map((reference) => ({ ...reference, original: hook.content.command, componentId: hook.id, field: 'command' as const })));
    const result = await projectPlatform(ctx, input);
    const root = result.bundle!.stagingRoot;
    const command = (await fs.readJson(path.join(root, 'hooks.json'))).guard.PreToolUse[0].hooks[0].command;
    expect(command).toContain(path.join((await getDeploymentLayout(ctx, input.binding)).packageRoot, 'scripts/guard.mjs'));
    expect(await fs.pathExists(path.join(root, 'rules/AGENTS.md'))).toBe(false);
    expect(await fs.readFile(path.join(root, 'rules/policy.md'), 'utf8')).toContain('trigger: "glob"');
  });

  it('freezes Claude scope-specific permissions while preserving shared package bytes and command prefix semantics', async () => {
    const { input, ctx, root } = await fixture('claude', [skill]);
    const permission = { command: { set: 'checks', key: 'run', variant: 'default' }, argsPrefix: ['--check'] };
    input.policy.permissions = [{ name: 'checks', allow: [permission], sandbox: { excludedCommands: [permission] } }];
    ctx.commandResolver = () => 'cmdp_0123456789abcdef';
    const result = await projectPlatform(ctx, input);
    const contribution = result.supplements[0]!;
    expect(contribution.destination).toBe(path.join(root, 'client-home/settings.json'));
    expect(contribution.mergeKey).toBe('claude-permissions:aw-source-example');
    expect(await fs.readJson(contribution.stagingPath)).toEqual({ kind: 'claude-permissions', permissions: {
      allow: ['Bash(aw command run cmdp_0123456789abcdef -- --check *)'], ask: [], deny: [],
      excludedCommands: ['aw command run cmdp_0123456789abcdef -- --check *'],
    } });
    input.binding.scope = { kind: 'project', projectRoot: path.join(root, 'project') };
    const project = await projectPlatform(ctx, input);
    expect(project.supplements[0]!.destination).toBe(path.join(root, 'project/.claude/settings.local.json'));
    expect(project.bundle!.contentDigest).toBe(result.bundle!.contentDigest);
    expect(project.bundle!.stagingRoot).not.toBe(result.bundle!.stagingRoot);
    expect(await fs.pathExists(contribution.stagingPath)).toBe(true);
  });

  it('retains Codex role permissions when its package unit has no package components', async () => {
    const { input, ctx, root } = await fixture('codex', [agent]);
    input.renderUnit.kinds = ['skill', 'mcp', 'hook', 'instruction'];
    input.policy.permissions = [{ name: 'invoke', allow: ['node checker.mjs'] }];
    const result = await projectPlatform(ctx, input);
    expect(result.bundle).toBeNull();
    expect(result.components).toEqual([]);
    expect(result.supplements).toHaveLength(1);
    expect(result.supplements[0]!.destination).toBe(path.join(root, 'client-home/rules/aw-source-example-invoke.rules'));
    expect(result.supplements[0]!.componentIds).toEqual([agent.id]);
    input.components = [];
    input.policy.permissions = [];
    const empty = await projectPlatform(ctx, input);
    expect(empty.bundle).toBeNull();
    expect(empty.supplements).toEqual([]);
  });

  it('rejects unknown capability fields and unsafe staging links without changing an existing package', async () => {
    const { input, ctx, root } = await fixture('claude', [skill]);
    const first = await projectPlatform(ctx, input);
    const original = await fs.readFile(path.join(first.bundle!.stagingRoot, '.claude-plugin/plugin.json'));
    (input.capabilities.features as Record<string, unknown>)['invented.feature'] = { status: 'supported', reasonCodes: [] };
    await expect(projectPlatform(ctx, input)).rejects.toThrow('Invalid platform capabilities');
    delete input.capabilities.features['invented.feature'];
    ctx.stagingRoot = path.join(root, 'linked-stage');
    await fs.symlink(first.bundle!.stagingRoot, ctx.stagingRoot, 'dir');
    await expect(projectPlatform(ctx, input)).rejects.toThrow('platformProjectionStagingInvalid');
    expect(await fs.readFile(path.join(first.bundle!.stagingRoot, '.claude-plugin/plugin.json'))).toEqual(original);
  });
});
