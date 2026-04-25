import { describe, expect, it } from 'vitest';

import { renderTemplate } from '../../src/utils/template-engine.js';

describe('template engine', () => {
  it('renders variables and conditional blocks per platform', () => {
    const template = [
      '# {{agent_name}}',
      '{{#if thinking_support}}supports thinking{{/if}}',
      '{{#unless thinking_support}}no thinking{{/unless}}',
    ].join('\n');

    expect(
      renderTemplate(
        template,
        {
          agent_name: {
            claude: 'Claude Code',
            codex: 'Codex',
          },
          thinking_support: {
            claude: true,
            codex: false,
          },
        },
        'claude',
      ),
    ).toContain('supports thinking');

    expect(
      renderTemplate(
        template,
        {
          agent_name: {
            claude: 'Claude Code',
            codex: 'Codex',
          },
          thinking_support: {
            claude: true,
            codex: false,
          },
        },
        'codex',
      ),
    ).toContain('no thinking');
  });
});
