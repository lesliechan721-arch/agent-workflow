import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseSkillFrontmatter,
  validateSkillDirectory,
} from '../../src/utils/skill-validation.js';

const roots: string[] = [];

async function createSkill(
  name: string,
  options: { skill?: string; openai?: string; asset?: string } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-validation-'));
  roots.push(root);
  const skillRoot = path.join(root, name);
  await fs.ensureDir(skillRoot);
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), options.skill ?? [
    '---',
    `name: ${name}`,
    'description: >-',
    '  Validate one standalone Agent Skill directory.',
    '---',
    '',
    'Perform the requested validation.',
    '',
  ].join('\n'));
  if (options.openai !== undefined) {
    await fs.ensureDir(path.join(skillRoot, 'agents'));
    await fs.writeFile(path.join(skillRoot, 'agents', 'openai.yaml'), options.openai);
  }
  if (options.asset !== undefined) {
    await fs.ensureDir(path.join(skillRoot, 'assets'));
    await fs.writeFile(path.join(skillRoot, 'assets', 'icon.svg'), options.asset);
  }
  return skillRoot;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('standalone Skill validation', () => {
  it('parses YAML frontmatter without reducing it to line-based key values', () => {
    const parsed = parseSkillFrontmatter([
      '---',
      'name: demo-skill',
      'description: >-',
      '  Validate one',
      '  demo Skill.',
      'metadata:',
      '  owner: agent-workflows',
      '---',
      '',
    ].join('\n'));

    expect(parsed.errors).toEqual([]);
    expect(parsed.frontmatter).toMatchObject({
      name: 'demo-skill',
      description: 'Validate one demo Skill.',
      metadata: { owner: 'agent-workflows' },
    });
  });

  it('validates portable frontmatter, Codex policy, and referenced assets together', async () => {
    const skillRoot = await createSkill('demo-skill', {
      openai: [
        'interface:',
        '  short_description: Validate one standalone Agent Skill directory.',
        '  icon_small: assets/icon.svg',
        '  default_prompt: Use $demo-skill to validate this Skill.',
        'policy:',
        '  allow_implicit_invocation: true',
        '  products: [codex]',
        '',
      ].join('\n'),
      asset: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });

    await expect(validateSkillDirectory({
      skillDirectory: skillRoot,
      frontmatterProfile: 'portable-agent-skills',
      codexMetadata: 'required',
    })).resolves.toMatchObject({ ok: true, errors: [] });
  });

  it('fails on the selected profile and missing Codex assets', async () => {
    const skillRoot = await createSkill('demo-skill', {
      skill: [
        '---',
        'name: demo-skill',
        'description: Validate one standalone Agent Skill directory.',
        'background: true',
        'metadata:',
        '  short-description: false',
        '---',
        '',
      ].join('\n'),
      openai: [
        'interface:',
        '  icon_small: assets/icon.svg',
        'policy:',
        '  allow_implicit_invocation: true',
        '',
      ].join('\n'),
    });

    const result = await validateSkillDirectory({
      skillDirectory: skillRoot,
      frontmatterProfile: 'portable-agent-skills',
      codexMetadata: 'required',
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'portable-profile-platform-extension' }),
      expect.objectContaining({
        code: 'known-field-invalid-type-value',
        path: 'SKILL.md#metadata.short-description',
      }),
      expect.objectContaining({ code: 'missing-codex-asset' }),
    ]));
  });

  it('applies the Codex metadata policy explicitly', async () => {
    const skillRoot = await createSkill('demo-skill');

    const optional = await validateSkillDirectory({
      skillDirectory: skillRoot,
      frontmatterProfile: 'portable-agent-skills',
      codexMetadata: 'optional',
    });
    expect(optional.ok).toBe(true);

    const required = await validateSkillDirectory({
      skillDirectory: skillRoot,
      frontmatterProfile: 'portable-agent-skills',
      codexMetadata: 'required',
    });
    expect(required.errors).toContainEqual(expect.objectContaining({
      code: 'missing-codex-metadata',
    }));
  });

  it('counts Unicode code points for public frontmatter length limits', async () => {
    const skillRoot = await createSkill('unicode-skill', {
      skill: [
        '---',
        'name: unicode-skill',
        `description: ${'😀'.repeat(600)}`,
        '---',
        '',
      ].join('\n'),
    });

    const result = await validateSkillDirectory({
      skillDirectory: skillRoot,
      frontmatterProfile: 'portable-agent-skills',
      codexMetadata: 'optional',
    });
    expect(result.errors).not.toContainEqual(expect.objectContaining({ code: 'string-too-long' }));
  });
});
