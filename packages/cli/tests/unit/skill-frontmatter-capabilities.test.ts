import { describe, expect, it } from 'vitest';

import {
  getSkillFrontmatterCapabilityRegistry,
  validateSkillFrontmatterCapabilities,
} from '../../src/utils/skill-frontmatter-capabilities.js';

const portable = {
  name: 'example-skill',
  description: 'Use this Skill for the example workflow.',
  license: 'Apache-2.0',
  compatibility: 'Requires Node.js 20+.',
  metadata: { owner: 'agent-workflows' },
  'allowed-tools': 'Read Grep',
};

describe('Skill frontmatter capability registry', () => {
  it('keeps portable, minimum Claude, and current Claude profiles distinct', () => {
    const registry = getSkillFrontmatterCapabilityRegistry();

    expect(registry.schemaVersion).toBe(1);
    expect(registry.profiles['claude-2.1.88'].targetVersion).toBe('2.1.88');
    expect(registry.fields.background.introducedVersion).toBe('2.1.218');
    expect(validateSkillFrontmatterCapabilities(portable, 'portable-agent-skills')).toEqual([]);

    const minimumClaude = {
      ...portable,
      'allowed-tools': ['Read', 'Grep'],
      when_to_use: 'Use for the example workflow.',
      'argument-hint': '[path]',
      arguments: ['path'],
      version: '0.1.0',
      'disable-model-invocation': false,
      'user-invocable': true,
      model: 'inherit',
      effort: 'high',
      context: 'fork',
      agent: 'general-purpose',
      hooks: {},
      paths: ['src/**'],
      shell: 'bash',
    };
    expect(validateSkillFrontmatterCapabilities(minimumClaude, 'claude-2.1.88')).toEqual([]);
    expect(validateSkillFrontmatterCapabilities({
      ...portable,
      effort: 75,
      context: 'inline',
    }, 'claude-2.1.88')).toEqual([]);

    expect(validateSkillFrontmatterCapabilities({
      ...minimumClaude,
      metadata: { owner: { team: 'agent-workflows' }, priority: 1 },
      'disallowed-tools': ['AskUserQuestion'],
      background: false,
    }, 'claude-current')).toEqual([]);
  });

  it('uses profile-specific Claude boolean tokens', () => {
    for (const value of [true, false, 'true', 'false']) {
      expect(validateSkillFrontmatterCapabilities({
        ...portable,
        'disable-model-invocation': value,
        'user-invocable': value,
      }, 'claude-2.1.88')).toEqual([]);
    }

    for (const value of [true, false, 'true', 'TRUE', 'false', 'yes', 'NO', 'On', 'off', '1', '0', 1, 0]) {
      expect(validateSkillFrontmatterCapabilities({
        ...portable,
        context: 'fork',
        background: value,
        'disable-model-invocation': value,
        'user-invocable': value,
      }, 'claude-current')).toEqual([]);
    }

    for (const value of ['TRUE', 'yes', 1]) {
      expect(validateSkillFrontmatterCapabilities({
        ...portable,
        'user-invocable': value,
      }, 'claude-2.1.88')).toEqual(expect.arrayContaining([
        expect.objectContaining({
          field: 'user-invocable',
          code: 'known-field-invalid-type-value',
        }),
      ]));
    }
    for (const value of ['enabled', 2]) {
      expect(validateSkillFrontmatterCapabilities({
        ...portable,
        'user-invocable': value,
      }, 'claude-current')).toEqual(expect.arrayContaining([
        expect.objectContaining({
          field: 'user-invocable',
          code: 'known-field-invalid-type-value',
        }),
      ]));
    }

    for (const profile of ['claude-2.1.88', 'claude-current'] as const) {
      expect(validateSkillFrontmatterCapabilities({
        ...portable,
        context: 'FORK',
      }, profile)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          field: 'context',
          code: 'known-field-invalid-type-value',
        }),
      ]));
    }
  });

  it('registers Claude version and keeps current metadata free-form', () => {
    expect(validateSkillFrontmatterCapabilities({
      ...portable,
      version: '0.1.0',
    }, 'claude-2.1.88')).toEqual([]);
    expect(validateSkillFrontmatterCapabilities({
      ...portable,
      metadata: { owner: { team: 'agent-workflows' }, priority: 1 },
    }, 'claude-current')).toEqual([]);
    expect(validateSkillFrontmatterCapabilities({
      ...portable,
      metadata: { owner: { team: 'agent-workflows' } },
    }, 'claude-2.1.88')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'metadata',
        code: 'known-field-invalid-type-value',
      }),
    ]));
    expect(validateSkillFrontmatterCapabilities({
      ...portable,
      version: '0.1.0',
    }, 'portable-agent-skills')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'version',
        code: 'portable-profile-platform-extension',
      }),
    ]));
  });

  it.each([
    ['when_to_uses', 'unknown-field'],
    ['disallowed-tools', 'known-field-not-supported-by-target-version'],
    ['background', 'known-field-not-supported-by-target-version'],
  ])('classifies %s against the minimum profile', (field, code) => {
    const diagnostics = validateSkillFrontmatterCapabilities({
      name: 'example-skill',
      description: 'Example.',
      [field]: field === 'background' ? false : ['Read'],
    }, 'claude-2.1.88');

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ field, code }),
    ]));
  });

  it('distinguishes portable extensions, invalid values, and related-field requirements', () => {
    expect(validateSkillFrontmatterCapabilities({
      ...portable,
      'user-invocable': true,
    }, 'portable-agent-skills')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'portable-profile-platform-extension' }),
    ]));

    expect(validateSkillFrontmatterCapabilities({
      ...portable,
      when_to_use: false,
    }, 'claude-2.1.88')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'when_to_use',
        code: 'known-field-invalid-type-value',
      }),
    ]));

    expect(validateSkillFrontmatterCapabilities({
      ...portable,
      agent: 'general-purpose',
    }, 'claude-2.1.88')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'agent',
        code: 'known-field-requires-related-field',
      }),
    ]));

    expect(validateSkillFrontmatterCapabilities({
      ...portable,
      effort: 1.5,
    }, 'claude-2.1.88')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'effort',
        code: 'known-field-invalid-type-value',
      }),
    ]));
    expect(validateSkillFrontmatterCapabilities({
      ...portable,
      effort: 75,
      context: 'inline',
    }, 'claude-current')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'effort',
        code: 'known-field-invalid-type-value',
      }),
      expect.objectContaining({
        field: 'context',
        code: 'known-field-invalid-type-value',
      }),
    ]));
  });
});
