import { describe, expect, it } from 'vitest';

import {
  CLAUDE_NATIVE_HOOK_EVENTS,
  CODEX_NATIVE_HOOK_EVENTS,
  NATIVE_HOOK_EVENT_CONTRACTS,
} from '../../src/utils/hooks-contract.js';
import { validateRenderedHooksContent } from '../../src/utils/rendered-contract.js';

describe('rendered contract validators', () => {
  it('accepts the complete Claude and Codex native hook allowlists in strict mode', () => {
    for (const event of CLAUDE_NATIVE_HOOK_EVENTS) {
      expect(() =>
        validateRenderedHooksContent({
          hooks: {
            [event]: [
              {
                ...(NATIVE_HOOK_EVENT_CONTRACTS.claude[event].matcherAllowed
                  ? { matcher: '*' }
                  : {}),
                hooks: [{ type: 'command', command: `echo ${event}` }],
              },
            ],
          },
        }, 'claude.hooks'),
      ).not.toThrow();
    }

    for (const event of CODEX_NATIVE_HOOK_EVENTS) {
      expect(() =>
        validateRenderedHooksContent({
          hooks: {
            [event]: [
              {
                ...(NATIVE_HOOK_EVENT_CONTRACTS.codex[event].matcherAllowed
                  ? { matcher: '*' }
                  : {}),
                hooks: [{ type: 'command', command: `echo ${event}` }],
              },
            ],
          },
        }, 'codex.hooks'),
      ).not.toThrow();
    }
  });

  it('rejects unsupported rendered hook events inferred from platform field names', () => {
    expect(() =>
      validateRenderedHooksContent({
        hooks: {
          sessionStop: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'echo done' }],
            },
          ],
        },
      }, 'claude.hooks'),
    ).toThrow('claude.hooks.hooks.sessionStop');

    expect(() =>
      validateRenderedHooksContent({
        hooks: {
          SessionEnd: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'echo done' }],
            },
          ],
        },
      }, 'codex.hooks'),
    ).toThrow('codex.hooks.hooks.SessionEnd');
  });

  it('rejects matcherless matchers in strict generated mode', () => {
    expect(() =>
      validateRenderedHooksContent({
        hooks: {
          Stop: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'echo stop' }],
            },
          ],
        },
      }, 'claude.hooks'),
    ).toThrow('does not allow matcher');

    expect(() =>
      validateRenderedHooksContent({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: 'ignored',
              hooks: [{ type: 'command', command: 'echo prompt' }],
            },
          ],
        },
      }, 'codex.hooks'),
    ).toThrow('does not allow matcher');
  });

  it('rejects non-minimal handler shapes in strict generated mode', () => {
    expect(() =>
      validateRenderedHooksContent({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Write',
              hooks: [
                { type: 'command', command: 'echo one' },
                { type: 'command', command: 'echo two' },
              ],
            },
          ],
        },
      }, 'codex.hooks'),
    ).toThrow('expected exactly one hook handler');

    for (const handler of [
      { type: 'command', command: 'echo timeout', timeout: 1000 },
      { type: 'command', command: 'echo async', async: true },
      { type: 'command', command: 'echo status', statusMessage: 'working' },
      { type: 'prompt', command: 'echo prompt' },
      { type: 'agent', command: 'echo agent' },
    ]) {
      expect(() =>
        validateRenderedHooksContent({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Write',
                hooks: [handler],
              },
            ],
          },
        }, 'codex.hooks'),
      ).toThrow();
    }
  });
});
