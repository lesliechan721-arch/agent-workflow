import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import YAML from 'yaml';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { partitionStaticPluginComponents, type PlatformId, type PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';
import type { ProjectionInput, StageContext } from '../../src/platforms/contracts.js';
import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';
import { projectPlatform, projectSupplementFile } from '../../src/platforms/projection.js';
import { projectPlatformMarketplace } from '../../src/platforms/projection-marketplace.js';
import { prepareProjectionRoot, ProjectionFiles } from '../../src/platforms/projection-files.js';
import { getDeploymentLayout } from '../../src/platforms/layout.js';
import { gapSupplementFiles, staticSupplementFiles } from '../../src/platforms/supplement-layout.js';
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
        antigravity: 'antigravity-directory', opencode: 'opencode-directory', pi: 'pi-package',
        copilot: 'copilot-marketplace', grok: 'grok-cli', generic: 'generic-skills' } as const)[platform],
      consumers: [{ id: 'consumer', product: platform === 'generic' ? 'generic' : 'cli', version: '1.2.3', availability: platform === 'generic' ? 'notApplicable' : 'available', reasonCodes: [],
        entry: platform === 'generic' ? { kind: 'generic', root: path.join(root, 'home/.agents/skills') } : { kind: 'cli', executable: path.join(root, 'client'), configRoot: path.join(root, 'client-home') } }],
      physicalKey: 'physical', activationKey: 'activation', renderUnitIds: ['unit'],
    },
    renderUnit: { id: 'unit', physicalKey: 'physical', renderScope: { kind: 'user' }, output, kinds, consumers: [] },
    capabilities: getAuthoringPlatformCapabilities(platform, 'user'),
    components, policy: { platform, permissions: [] }, resources: { resources: [], files: [], bundleFiles: [], commandResources: [], digest: 'closure' },
  };
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
  it.each(['codex', 'claude', 'cursor', 'antigravity', 'opencode', 'pi', 'copilot', 'grok', 'generic'] as const)(
    'delivers the supported %s roles and Hooks in both scopes', (platform) => {
      const hook: PluginComponent = { id: 'notify', kind: 'hook', name: 'notify',
        content: { dialect: 'common', event: 'before_tool', feedback: 'notify', command: 'echo ready' } };
      for (const scope of ['user', 'project'] as const) {
        const capabilities = getAuthoringPlatformCapabilities(platform, scope);
        const expected = partitionStaticPluginComponents([skill, agent, hook], capabilities);
        const installed = expected.components.map(({ kind }) => kind);
        expect(installed).toContain('skill');
        expect(installed.includes('agent')).toBe(platform !== 'opencode' && platform !== 'generic');
        expect(installed.includes('hook')).toBe(platform !== 'cursor' && platform !== 'generic');
        expect(capabilities.features['hook.common.before_tool']?.status).toBe(installed.includes('hook') ? 'supported' : 'unsupported');
        if (platform === 'pi') expect(capabilities.features['agent.declaration-protocol']).toMatchObject(
          { status: 'supported', values: ['aw.pi.agents.v1'] });
      }
    });
  it('keeps an unmapped command policy out of the host while publishing the Skill', async () => {
    const { input, ctx } = await fixture('pi', [skill]);
    input.policy.permissions = [{ name: 'run-check', allow: ['node checker.mjs'] }];
    const result = await projectPlatform(ctx, input);
    expect(result.components.map(({ id }) => id)).toEqual([skill.id]);
    expect(result.supplements).toEqual([]);
    expect(result.diagnostics).toMatchObject([{ code: 'invocationPolicyNotApplied', severity: 'warning',
      subject: { field: 'permissions.run-check', pluginId: 'source/example', target: 'pi', scope: 'user' } }]);
  });
  it.each([
    ['codex', '.agents/plugins/marketplace.json'], ['claude', '.claude-plugin/marketplace.json'],
    ['copilot', '.github/plugin/marketplace.json'],
  ] as const)('builds the complete %s marketplace descriptor with a source-based name', async (platform, relativePath) => {
    const { input, ctx } = await fixture(platform, [skill]);
    const { marketplaceName, nativeIdentity } = await getDeploymentLayout(ctx, input.binding);
    const policy = { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } as const;
    const descriptor = projectPlatformMarketplace({ binding: input.binding, marketplaceName: marketplaceName!, entries: [
      { name: 'second', source: './plugins/second', description: 'Second package.', category: 'development', strict: true, policy },
      { name: 'example', source: './plugins/example', description: 'Example package.', category: 'development', strict: true, policy },
    ] });
    expect(descriptor.relativePath).toBe(relativePath);
    const manifest = JSON.parse(descriptor.bytes.toString('utf8'));
    expect(manifest.name).toBe('aw-source');
    expect(nativeIdentity.registrationId).toBe('example@aw-source');
    expect(manifest.plugins.map((entry: { name: string }) => entry.name)).toEqual(['example', 'second']);
    if (platform === 'copilot') expect(manifest.plugins[0]).not.toHaveProperty('policy');
    else expect(manifest.plugins[0].policy).toEqual({ ...policy, products: [platform === 'codex' ? 'CODEX' : 'CLAUDE'] });
  });
  // These parse final consumer artifacts. They protect native package routing and
  // the generic writer exception; they do not establish client qualification.
  it.each([
    ['codex', '.codex-plugin/plugin.json'], ['claude', '.claude-plugin/plugin.json'],
    ['cursor', '.cursor-plugin/plugin.json'], ['antigravity', '.antigravity-plugin/plugin.json'],
    ['opencode', 'package.json'], ['pi', 'package.json'],
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
    const policy: PluginComponent = platform === 'codex' ? { ...instruction, content: { ...instruction.content, coverage: ['main', 'plugin-agents', 'other-agents'] } } : instruction;
    const { input, ctx } = await fixture(platform, [policy]);
    ctx.stagingRoot = path.join(ctx.cwd, 'stage with spaces');
    const result = await projectPlatform(ctx, input);
    const bundle = result.bundle!.stagingRoot;
    const hooks = await fs.readJson(path.join(bundle, 'hooks/hooks.json'));
    const rootVariable = platform === 'codex' ? 'PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
    const env = { ...process.env, CODEX_PLUGIN_ROOT: undefined, PLUGIN_ROOT: undefined, CLAUDE_PLUGIN_ROOT: undefined, [rootVariable]: bundle };
    const runHook = (event: string, agentType: string): string => {
      const command: string = hooks.hooks[event][0].hooks[0].command;
      // Native placeholder expansion precedes shell execution, including on Windows.
      return execSync(command.replaceAll('${' + rootVariable + '}', bundle), {
        cwd: ctx.cwd, env, input: JSON.stringify({ agent_type: agentType }), encoding: 'utf8',
      });
    };
    for (const event of ['SessionStart', 'SubagentStart']) {
      expect(hooks.hooks[event]).toHaveLength(1);
      const stdout = runHook(event, 'example:review');
      expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: event, additionalContext: 'Preserve the source files.' } });
    }
    if (platform === 'claude') {
      expect(runHook('SubagentStart', 'other:review')).toBe('');
    }
  });

  // The native payload and the projection receipt must use the same host-visible
  // name. Distinct sources and plugins may declare the same public role.
  it.each(['claude', 'codex', 'pi', 'antigravity', 'cursor', 'copilot', 'grok'] as const)(
    'projects %s Agent file, metadata and receipt names consistently', async (platform) => {
      const role = { ...agent, name: 'reviewer' };
      const { input, ctx } = await fixture(platform, [role], platform === 'codex' ? 'supplement' : 'package');
      const identities: Array<[string, string]> = platform === 'claude' ? [['official', 'demo']] : [['official', 'demo'], ['official', 'other'], ['partner', 'demo']];
      const observedNames = new Set<string>();
      for (const [sourceId, pluginName] of identities) {
        input.binding.plugin = { ...input.binding.plugin, sourceId, pluginId: `${sourceId}/${pluginName}` };
        const nativeName = platform === 'claude' ? 'reviewer' : `aw-${sourceId}-${pluginName}-reviewer`;
        const relative = platform === 'codex' ? `${nativeName}.toml` : platform === 'copilot'
          ? `com.github.copilot/agents/${nativeName}.agent.md` : `agents/${nativeName}.md`;
        const result = await projectPlatform(ctx, input);
        expect(result.components).toEqual([{ id: role.id, nativeName, relativeOutputs: [relative] }]);
        observedNames.add(result.components[0]!.nativeName);
        if (platform === 'codex') {
          const layout = await getDeploymentLayout(ctx, input.binding);
          const destination = path.join(layout.supplementRoot!, relative);
          expect(result.supplements).toMatchObject([{ id: role.id, destination }]);
          const text = await fs.readFile(result.supplements[0]!.stagingPath, 'utf8');
          expect(getStaticTOMLValue(parseTOML(text)).name).toBe(nativeName);
          expect(gapSupplementFiles(input.binding, layout, [{ id: role.id, kind: 'agent', name: role.name,
            requiredFeatures: [{ feature: 'agent.model' }], reasonCode: 'interface-unsupported' }]).map(({ path }) => path)).toEqual([destination]);
          expect(staticSupplementFiles(input.binding, layout, { extensions: { agents: [{ name: role.name,
            description: role.content.description, prompt: role.content.prompt }] } }).map(({ path }) => path)).toEqual([destination]);
        } else {
          const text = await fs.readFile(path.join(result.bundle!.stagingRoot, relative), 'utf8');
          expect(YAML.parse(text.split('---')[1]!).name).toBe(nativeName);
        }
      }
      expect(observedNames.size).toBe(identities.length);
    });

  it.each(['codex', 'pi', 'antigravity', 'cursor', 'copilot', 'grok'] as const)(
    'checks the full prefixed %s Agent name before staging', async (platform) => {
      const roleName = 'a'.repeat(128 - 'aw-source-example-'.length);
      const { input, ctx } = await fixture(platform, [{ ...agent, name: roleName }], platform === 'codex' ? 'supplement' : 'package');
      expect((await projectPlatform(ctx, input)).components[0]!.nativeName).toHaveLength(128);
      const invalidRoot = path.join(ctx.stagingRoot, 'invalid');
      const invalidRole = { ...agent, name: `${roleName}a` };
      input.components = [invalidRole];
      await expect(projectPlatform({ ...ctx, stagingRoot: invalidRoot }, input)).rejects.toThrow('platformProjectionNameInvalid');
      expect(await fs.pathExists(invalidRoot)).toBe(false);
      if (platform === 'codex') {
        // Read-only static inspection and recovery cannot address a file that
        // could never have been a valid projected role.
        expect(() => projectSupplementFile(input.binding, invalidRole)).toThrow('platformProjectionNameInvalid');
        const layout = await getDeploymentLayout(ctx, input.binding);
        expect(gapSupplementFiles(input.binding, layout, [{ id: invalidRole.id, kind: 'agent', name: invalidRole.name,
          requiredFeatures: [{ feature: 'agent.model' }], reasonCode: 'interface-unsupported' }])).toEqual([]);
        expect(() => staticSupplementFiles(input.binding, layout, { extensions: { agents: [{ name: invalidRole.name,
          description: invalidRole.content.description, prompt: invalidRole.content.prompt }] } })).toThrow('platformProjectionNameInvalid');
      }
    });

  it('writes Claude roles in the default discovery directory without overriding the scan', async () => {
    const restricted: PluginComponent = { ...agent, content: { ...agent.content, tools: ['Read'] } };
    const { input, ctx } = await fixture('claude', [skill, restricted]);
    const result = await projectPlatform(ctx, input);
    const bundle = result.bundle!.stagingRoot;
    const manifest = await fs.readJson(path.join(bundle, '.claude-plugin/plugin.json'));
    expect(manifest).toMatchObject({ name: 'example', version: '1.2.3', skills: './skills/' });
    expect(manifest).not.toHaveProperty('agents');
    const text = await fs.readFile(path.join(bundle, 'agents/review.md'), 'utf8');
    expect(YAML.parse(text.split('---')[1]!)).toEqual({ name: 'review', description: 'Review a change.', tools: ['Read'] });
    expect(text).toContain('Review this change.');
  });

  it('delivers Pi agents as declarations without an execution extension', async () => {
    const { input, ctx } = await fixture('pi', [agent]);
    const result = await projectPlatform(ctx, input);
    const manifest = await fs.readJson(path.join(result.bundle!.stagingRoot, 'package.json'));
    expect(manifest.pi).toEqual({ subagents: { agents: ['./agents'] } });
    expect(await fs.pathExists(path.join(result.bundle!.stagingRoot, 'index.mjs'))).toBe(false);
    expect(result.components[0]!.nativeName).toBe('aw-source-example-review');
  });

  it.each(['grok', 'copilot'] as const)('combines the same input instruction text into %s agents', async (platform) => {
    const { input, ctx } = await fixture(platform, [agent, instruction]);
    if (platform === 'grok') input.renderUnit.kinds = ['agent'];
    const result = await projectPlatform(ctx, input);
    const projected = result.components.find((component) => component.id === agent.id)!;
    const text = await fs.readFile(path.join(result.bundle!.stagingRoot, projected.relativeOutputs[0]!), 'utf8');
    expect(text).toContain('Preserve the source files.');
    expect(text).toContain('Review this change.');
    if (platform === 'grok') expect(result.components.map((component) => component.id)).toEqual([agent.id]);
  });

  it.each(['grok', 'copilot'] as const)('delivers %s role-only instructions inside same-package role files', async (platform) => {
    const roleOnly: PluginComponent = { ...instruction, content: { ...instruction.content, coverage: ['plugin-agents'] } };
    const capabilities = getAuthoringPlatformCapabilities(platform, 'user');
    const expected = partitionStaticPluginComponents([roleOnly, agent], capabilities);
    expect(expected.unmet).toEqual([]);
    expect(partitionStaticPluginComponents([roleOnly], capabilities)).toMatchObject({ components: [], unmet: [
      { id: roleOnly.id, requiredFeatures: [{ feature: 'instruction.coverage', values: ['plugin-agents'] }] },
    ] });
    const restrictiveRole: PluginComponent = { ...agent, content: { ...agent.content, promptMode: 'append' } };
    expect(partitionStaticPluginComponents([roleOnly, restrictiveRole], capabilities).components).toEqual([]);
    const conditional: PluginComponent = { ...roleOnly, content: { ...roleOnly.content, paths: ['src/**'] } };
    expect(partitionStaticPluginComponents([conditional, agent], capabilities).components).toEqual([agent]);

    const { input, ctx } = await fixture(platform, expected.components);
    input.capabilities = capabilities;
    if (platform === 'grok') input.renderUnit.kinds = ['agent'];
    const result = await projectPlatform(ctx, input);
    const rolePath = platform === 'grok' ? 'agents/aw-source-example-review.md' : 'com.github.copilot/agents/aw-source-example-review.agent.md';
    expect(result.components.find(({ id }) => id === roleOnly.id)?.relativeOutputs).toEqual([rolePath]);
    expect(await fs.readFile(path.join(result.bundle!.stagingRoot, rolePath), 'utf8')).toContain('Preserve the source files.');
    expect(await fs.pathExists(path.join(result.bundle!.stagingRoot, 'com.github.copilot/rules'))).toBe(false);
    if (platform === 'grok') {
      const supplement = await projectPlatform(ctx, { ...input, renderUnit: { ...input.renderUnit, output: 'supplement', kinds: ['instruction'] } });
      expect(supplement).toMatchObject({ bundle: null, supplements: [], components: [] });
    }
  });

  it('rejects an unsupported required Hook feedback before staging any package', async () => {
    const hook: PluginComponent = { id: 'hook:guard', name: 'guard', kind: 'hook', content: { dialect: 'common', event: 'before_tool', feedback: 'block', command: 'node guard.mjs' } };
    const { input, ctx } = await fixture('claude', [hook]);
    input.capabilities.features['hook.common.before_tool']!.values = ['notify'];
    await expect(projectPlatform(ctx, input)).rejects.toThrow('platformProjectionCapabilityUnsupported');
    expect(await fs.pathExists(ctx.stagingRoot)).toBe(false);
  });

  it('rejects escaped Skill paths and mapped native-name collisions without writing outside staging', async () => {
    const { input, ctx, root } = await fixture('claude', [skill, agent]);
    input.components = [{ ...skill, content: { files: { ...skill.content.files, '../escape': { text: 'unsafe' } } } }];
    await expect(projectPlatform(ctx, input)).rejects.toThrow(/Invalid/u);
    expect(await fs.pathExists(path.join(root, 'escape'))).toBe(false);
    input.components = [agent, { ...agent, id: 'second', name: 'REVIEW' }];
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

  it('carries explicit invocation requirements through Generic even without host fields', async () => {
    const controlled: PluginComponent = { ...skill, requires: [
      { feature: 'skill.invocation.model', values: ['true', 'false'] }, { feature: 'skill.visibility' },
    ] };
    const { input, ctx } = await fixture('generic', [controlled], 'generic');
    const result = await projectPlatform(ctx, input);
    const text = await fs.readFile(path.join(result.supplements[0]!.stagingPath, 'SKILL.md'), 'utf8');
    expect(YAML.parse(text.split('---')[1]!).metadata).toEqual({ 'skill.invocation.model': 'false,true', 'skill.visibility': '' });
  });

  it.each([
    ['true', 'true', false, true],
    ['"yes"', 'true', false, true],
    ['1', 'true', false, true],
    ['"  true  "', '"  YeS  "', false, true],
    ['false', 'false', true, false],
    ['"  OfF  "', '"  nO  "', true, false],
  ] as const)(
    'maps Codex invocation controls %s and %s to the projected Skill', async (disableModel, manual, implicit, visible) => {
      const controlled: PluginComponent = { ...skill, content: { files: {
        'SKILL.md': { text: `---\nname: check\ndescription: Check input.\nuser-invocable: ${manual}\ndisable-model-invocation: ${disableModel}\n---\nRun explicitly.\n` },
      } } };
      const { input, ctx } = await fixture('codex', [controlled]);
      const result = await projectPlatform(ctx, input);
      const skillRoot = path.join(result.bundle!.stagingRoot, 'skills/check');
      const definition = YAML.parse(await fs.readFile(path.join(skillRoot, 'agents/openai.yaml'), 'utf8'));
      expect(definition.policy.allow_implicit_invocation).toBe(implicit);
      const projected = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
      const { metadata } = YAML.parse(projected.split('---')[1]!);
      expect(metadata?.['skill.visibility']).toBe(visible ? undefined : 'hidden');
    },
  );

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

  it.each(['claude', 'copilot', 'grok', 'antigravity', 'pi', 'opencode'] as const)(
    'emits the %s native automatic invocation policy for accepted author boolean spellings', async (platform) => {
      const controlled: PluginComponent = { ...skill, content: { files: {
        'SKILL.md': { text: '---\nname: check\ndescription: Check input.\nuser-invocable: "yes"\ndisable-model-invocation: 1\n---\nRun explicitly.\n' },
      } } };
      const { input, ctx } = await fixture(platform, [controlled]);
      const result = await projectPlatform(ctx, input);
      const projected = await fs.readFile(path.join(result.bundle!.stagingRoot, 'skills/check/SKILL.md'), 'utf8');
      const metadata = YAML.parse(projected.split('---')[1]!);
      if (platform === 'opencode') expect(metadata.metadata['opencode/autoinvoke']).toBe('false');
      else expect(metadata['disable-model-invocation']).toBe(true);
      if (['claude', 'copilot', 'grok'].includes(platform)) expect(metadata['user-invocable']).toBe(true);
      else expect(metadata).not.toHaveProperty('user-invocable');
    },
  );

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
    const { input, ctx } = await fixture('pi', [mcp, { ...instruction, content: { ...instruction.content, coverage: ['main'] } }]);
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

  it('uses the Antigravity remote MCP transport field', async () => {
    const mcp: PluginComponent = { id: 'mcp:docs', name: 'docs', kind: 'mcp', content: { type: 'http', url: 'https://example.test/mcp', headers: { 'X-Client': 'aw' } } };
    const { input, ctx } = await fixture('antigravity', [mcp]);
    const result = await projectPlatform(ctx, input);
    const config = await fs.readJson(path.join(result.bundle!.stagingRoot, 'mcp_config.json'));
    expect(config.mcpServers.docs).toEqual({ serverUrl: 'https://example.test/mcp', headers: { 'X-Client': 'aw' } });
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

  it('freezes OpenCode rules and reports only actions that the host could not deliver', async () => {
    const { root, input, ctx } = await fixture('opencode', [skill]);
    ctx.platform = 'linux';
    input.policy.invocationSelector = 'source/example';
    input.policy.permissions = [{ name: 'checks', allow: ['git', { argsPrefix: ['show'] }],
      deny: ['git show #note'], ask: ['node check'] }];
    const destination = path.join(root, 'client-home/opencode.json');
    await fs.outputJson(destination, { permissions: [{ action: 'shell', resource: 'node check *', effect: 'deny' }] });
    const projection = await projectPlatform(ctx, input);
    expect(projection.supplements).toHaveLength(1);
    const [permission] = projection.supplements;
    expect(permission).toMatchObject({ kind: 'config-entry', destination, mergeKey: 'opencode-permissions:aw-source-example' });
    const staged = await fs.readJson(permission!.stagingPath);
    expect(staged.effective).toEqual([{ action: 'shell', resource: 'aw command run source/example -- show *', effect: 'allow' }]);
    expect(projection.diagnostics.filter(({ code }) => code === 'invocationPolicyNotApplied')).toMatchObject([
      { subject: { field: 'permissions.checks' }, detail: { reasonCode: 'permission-rule-conflict', skippedPermissionActions: ['allow', 'ask'] } },
      { subject: { field: 'permissions.checks' }, detail: { reasonCode: 'permission-prefix-unrepresentable', skippedPermissionActions: ['deny'] } },
    ]);
  });

  it('uses an absolute OpenCode global override and retains the Skill when a relative override cannot be located', async () => {
    const { root, input, ctx } = await fixture('opencode', [skill]);
    input.policy.permissions = [{ name: 'checks', allow: ['git status'] }];
    const override = path.join(root, 'override');
    ctx.env!.OPENCODE_CONFIG_DIR = override;
    const absolute = await projectPlatform(ctx, input);
    expect(absolute.supplements[0]?.destination).toBe(path.join(override, 'opencode.json'));
    ctx.env!.OPENCODE_CONFIG_DIR = 'relative-config';
    const relative = await projectPlatform(ctx, input);
    expect(relative.bundle).toBeTruthy();
    expect(relative.supplements).toEqual([]);
    expect(relative.diagnostics).toContainEqual(expect.objectContaining({ code: 'invocationPolicyNotApplied',
      detail: { reasonCode: 'permission-config-path-unconfirmed', skippedPermissionActions: ['allow'] } }));
  });

  it('projects the platform-qualified invocation into Grok Bash permissions', async () => {
    const { input, ctx, root } = await fixture('grok', [skill]);
    ctx.env!.GROK_HOME = path.join(root, 'client-home');
    input.policy.invocationSelector = 'source/example/grok';
    input.policy.permissions = [{ name: 'checks', deny: [{ argsPrefix: ['blocked'] }] }];
    const result = await projectPlatform(ctx, input);
    const contribution = result.supplements.find(({ mergeKey }) => mergeKey?.startsWith('grok-permissions:'));
    expect(contribution).toBeDefined();
    const staged = await fs.readJson(contribution!.stagingPath);
    expect(staged.effective).toContainEqual({ action: 'shell', resource: 'aw command run source/example/grok -- blocked', effect: 'deny' });
  });

  it('freezes Claude scope-specific permissions while preserving shared package bytes and command prefix semantics', async () => {
    const { input, ctx, root } = await fixture('claude', [skill]);
    const permission = { argsPrefix: ['--check'] };
    input.policy.invocationSelector = 'source/example';
    input.policy.permissions = [{ name: 'checks', allow: [permission], sandbox: { excludedCommands: [permission] } }];
    const result = await projectPlatform(ctx, input);
    const contribution = result.supplements[0]!;
    expect(contribution.destination).toBe(path.join(root, 'client-home/settings.json'));
    expect(contribution.mergeKey).toBe('claude-permissions:aw-source-example');
    expect(await fs.readJson(contribution.stagingPath)).toEqual({ kind: 'claude-permissions', permissions: {
      allow: ['Bash(aw command run source/example -- --check *)'], ask: [], deny: [],
      excludedCommands: ['aw command run source/example -- --check *'],
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

  // Test Value Gate: Windows Eval projection staging can exceed MAX_PATH;
  // returned paths must remain usable for writing and scoped cleanup.
  it('writes projected files beyond 260 characters and returns an ordinary canonical staging path', async () => {
    const { root } = await fixture('claude', [skill]);
    const stagingRoot = path.join(root, 'a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80));
    expect(stagingRoot.length).toBeGreaterThan(260);
    const projectionRoot = await prepareProjectionRoot(stagingRoot);
    expect(path.dirname(projectionRoot)).toBe(await fs.realpath(stagingRoot));
    expect(projectionRoot.startsWith('\\\\?\\')).toBe(false);
    const files = new ProjectionFiles();
    files.add('skills/check/SKILL.md', 'Check the input.\n');
    await files.write(projectionRoot);
    expect(await fs.readFile(path.join(projectionRoot, 'skills/check/SKILL.md'), 'utf8')).toBe('Check the input.\n');

    await fs.remove(projectionRoot);
    expect(await fs.readdir(stagingRoot)).toEqual([]);
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
