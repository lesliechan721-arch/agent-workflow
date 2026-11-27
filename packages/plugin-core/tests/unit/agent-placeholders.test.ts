import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  computeAwCapabilitySetDigest, parseAgentNamePlaceholders, replaceAgentNamePlaceholders, resolvePluginRequirements,
  scanSkillAgentReferences, validateSourcePluginManifest, type PluginManifestSource,
} from '../../src/manifest.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });

describe('Skill references to plugin Agents', () => {
  it('resolves normalized names while preserving all text outside the reference', () => {
    const reference = '{{aw.agent:Audit.Role}}';
    const text = 'λ ' + reference + reference + ' {{target}} {{aw.command}}';
    expect(parseAgentNamePlaceholders(text)).toEqual([2, 2 + reference.length].map((start) => ({
      name: 'Audit.Role', normalizedName: 'audit-role', start, end: start + reference.length,
    })));
    expect(replaceAgentNamePlaceholders(text, (name) => 'demo:' + name)).toBe('λ demo:audit-roledemo:audit-role {{target}} {{aw.command}}');
    for (const bad of ['{{aw.agent}}', '{{aw.agent:}}', '{{aw.agent:a b}}', '{{aw.agent:a\nb}}', '{{aw.agent:a',
      '{{aw.agent:a}', '{{aw.agent:\u0080a}}', '{{aw.agent:../a}}', '{{aw.agent:---}}', '{{aw.agent:{{role}}}}', '{{aw.agent:role{alias}}']) {
      expect(() => parseAgentNamePlaceholders(bad)).toThrow(/^agentReferenceInvalid/u);
    }
  });

  it('rejects name references before ordinary frontmatter validation and scans other fields and code', () => {
    for (const name of ['"{{aw.agent:role}}"', '{{aw.agent:role}}', "'{{aw.agent:role'", '|\n  {{aw.agent:role}}']) {
      expect(() => scanSkillAgentReferences('SKILL.md', '---\nname: ' + name + '\n---\n')).toThrow(/^agentReferenceInvalid/u);
    }
    expect(() => scanSkillAgentReferences('SKILL.md', '---\nname: "\\x7B\\x7Baw.agent:role}}"\n---\n')).toThrow(/^agentReferenceInvalid/u);
    const text = '---\nname: demo\ndescription: "Use {{aw.agent:role}}"\n---\n~~~text\n{{aw.agent:role}}\n~~~';
    expect(scanSkillAgentReferences('SKILL.md', text)).toHaveLength(2);
    for (const description of ['Use {{aw.agent:role}}.', '"Use \\x7B\\x7Baw.agent:role}}"',
      '"{{aw.agent:role}} and \\x7B\\x7Baw.agent:role}}"']) {
      expect(() => scanSkillAgentReferences('SKILL.md', '---\nname: demo\ndescription: ' + description + '\nuser-invocable: true\n---\n')).toThrow(/^agentReferenceInvalid/u);
    }
    for (const metadata of ['metadata:\n  reviewer: {{aw.agent:role}}', 'metadata: { reviewer: {{aw.agent:role}} }',
      'metadata: [{{aw.agent:role}}]', 'metadata: &reviewer {{aw.agent:role}}']) {
      expect(() => scanSkillAgentReferences('SKILL.md', '---\nname: demo\ndescription: Demo\n' + metadata + '\n---\n')).toThrow(/^agentReferenceInvalid/u);
    }
    const quoted = '---\n# {{aw.agent:role}}\nname: demo\ndescription: &about "Use {{aw.agent:role}}"\n'
      + "metadata: { other: *about, reviewer: '{{aw.agent:role}}' } # {{aw.agent:role}}\n---\n";
    expect(scanSkillAgentReferences('SKILL.md', quoted)).toHaveLength(4);
    expect(scanSkillAgentReferences('evals/case.md', '{{aw.agent:bad')).toEqual([]);
    expect(scanSkillAgentReferences('references/raw.txt', '{{aw.agent:bad')).toEqual([]);
  });

  it('derives exact requirements from shipped Markdown and validates stable, omitted and dynamic names', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-agent-references-'));
    roots.push(root);
    const manifest: PluginManifestSource = {
      schemaVersion: 4, name: 'demo', description: 'Demo', version: '1.0.0', platforms: ['codex', 'generic'], skills: './skills',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      extensions: { agents: [
        { name: 'audit', prompt: 'Audit.', description: 'Auditor.', agentOverrides: { codex: { name: 'renamed' } } },
        { name: '审阅员', prompt: 'Review.', description: 'Independent reviewer.', agentOverrides: { codex: { name: 'extra-reviewer' } } },
      ] },
    };
    const skill = path.join(root, 'skills/demo');
    await fs.outputFile(path.join(skill, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n{{target}}');
    await fs.outputFile(path.join(skill, 'reports/bad.md'), '{{aw.agent:');
    await fs.outputFile(path.join(root, 'skills/eval-only/evals/bad.md'), '{{aw.agent:');
    const requirements = () => resolvePluginRequirements({ pluginRoot: root, manifest, implementedCapabilities: [] });
    expect((await requirements()).effective).not.toContain('aw.skill-agent-placeholder.v1');
    const file = path.join(skill, 'references/evals/role.md');
    for (const fields of ['description: "Use \\x7B\\x7Baw.agent:audit}}"', 'description: Demo\nmetadata:\n  reviewer: {{aw.agent:audit}}']) {
      await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: demo\n' + fields + '\n---\n');
      await expect(validateSourcePluginManifest(root, manifest)).rejects.toThrow(/^agentReferenceInvalid/u);
      await expect(requirements()).rejects.toThrow(/^agentReferenceInvalid/u);
    }
    await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n{{target}}');
    await fs.outputFile(file, '{{aw.agent:AUDIT}}');
    const found = await requirements();
    for (const ids of [found.derived, found.effective, found.unsupportedByCurrentAw]) expect(ids).toContain('aw.skill-agent-placeholder.v1');
    expect(found.detected).not.toContain('aw.skill-agent-placeholder.v1');
    expect(found.capabilitySetDigest).toBe(computeAwCapabilitySetDigest(found.effective));
    await expect(validateSourcePluginManifest(root, manifest)).resolves.toMatchObject({ name: 'demo' });
    // An independent Agent's actual projected name does not become a reference alias.
    for (const invalid of ['{{aw.agent:审阅员}}', '{{aw.agent:extra-reviewer}}']) {
      await fs.writeFile(file, invalid);
      await expect(validateSourcePluginManifest(root, manifest)).rejects.toThrow(/^agentReferenceInvalid/u);
    }
    await fs.writeFile(file, '{{aw.agent:renamed}}');
    await expect(validateSourcePluginManifest(root, manifest)).rejects.toThrow(/^agentReferenceInvalid/u);
    const mixed = { ...manifest, artifacts: { configKeys: [] }, scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } } };
    await fs.outputFile(path.join(root, 'render.mjs'), '');
    await expect(validateSourcePluginManifest(root, mixed)).resolves.toMatchObject({ name: 'demo' });
    await fs.writeFile(file, '{{aw.agent:audit}}');
    const omitted = { agents: [{ ...manifest.extensions!.agents![0]!, agentOverrides: { generic: null } }] };
    for (const raw of [manifest, mixed]) {
      await expect(validateSourcePluginManifest(root, { ...raw, extensions: omitted })).rejects.toThrow(/^agentReferenceInvalid/u);
    }
    await fs.writeFile(file, '{{aw.agent:bad');
    await expect(requirements()).rejects.toThrow(/^agentReferenceInvalid/u);
  });
});
