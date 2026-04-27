import { describe, expect, it } from 'vitest';

import {
  CLAUDE_NATIVE_HOOK_EVENTS,
  CODEX_NATIVE_HOOK_EVENTS,
  NATIVE_HOOK_EVENT_CONTRACTS,
  parseCodexSharedHooksFile,
  planCodexSharedHooksUpdate,
  serializeTrackedHookGroupIdentity,
  subtractTrackedHookGroupIdentities,
  trackedHookGroupsContainAll,
} from '../../src/utils/hooks-contract.js';

describe('hooks contract', () => {
  it('locks the complete Claude native hook allowlist', () => {
    expect(CLAUDE_NATIVE_HOOK_EVENTS).toEqual([
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'Notification',
      'UserPromptSubmit',
      'SessionStart',
      'SessionEnd',
      'Stop',
      'StopFailure',
      'SubagentStart',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
      'PermissionRequest',
      'PermissionDenied',
      'Setup',
      'TeammateIdle',
      'TaskCreated',
      'TaskCompleted',
      'Elicitation',
      'ElicitationResult',
      'ConfigChange',
      'WorktreeCreate',
      'WorktreeRemove',
      'InstructionsLoaded',
      'CwdChanged',
      'FileChanged',
    ]);
  });

  it('covers every Claude allowlist event exactly once in the matcher contract', () => {
    const contractEvents = Object.keys(NATIVE_HOOK_EVENT_CONTRACTS.claude).sort();
    const allowlistEvents = [...CLAUDE_NATIVE_HOOK_EVENTS].sort();

    expect(contractEvents).toEqual(allowlistEvents);
  });

  it('splits Claude matcher-capable and matcherless events without gaps', () => {
    const matcherEvents = Object.entries(NATIVE_HOOK_EVENT_CONTRACTS.claude)
      .filter(([, contract]) => contract.matcherAllowed)
      .map(([event]) => event)
      .sort();
    const matcherlessEvents = Object.entries(NATIVE_HOOK_EVENT_CONTRACTS.claude)
      .filter(([, contract]) => !contract.matcherAllowed)
      .map(([event]) => event)
      .sort();

    expect(matcherEvents).toEqual([
      'ConfigChange',
      'Elicitation',
      'ElicitationResult',
      'FileChanged',
      'InstructionsLoaded',
      'Notification',
      'PermissionDenied',
      'PermissionRequest',
      'PostCompact',
      'PostToolUse',
      'PostToolUseFailure',
      'PreCompact',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Setup',
      'StopFailure',
      'SubagentStart',
      'SubagentStop',
    ]);
    expect(matcherlessEvents).toEqual([
      'CwdChanged',
      'Stop',
      'TaskCompleted',
      'TaskCreated',
      'TeammateIdle',
      'UserPromptSubmit',
      'WorktreeCreate',
      'WorktreeRemove',
    ]);
    expect([...matcherEvents, ...matcherlessEvents].sort()).toEqual(
      [...CLAUDE_NATIVE_HOOK_EVENTS].sort(),
    );
  });

  it('keeps FileChanged matcher-capable and Codex native allowlist aligned', () => {
    expect(NATIVE_HOOK_EVENT_CONTRACTS.claude.FileChanged.matcherAllowed).toBe(true);
    expect(CODEX_NATIVE_HOOK_EVENTS).toEqual([
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
    ]);
    expect(Object.keys(NATIVE_HOOK_EVENT_CONTRACTS.codex)).toEqual(
      CODEX_NATIVE_HOOK_EVENTS,
    );
  });

  it('canonicalizes Codex shared matcher variants and matcherless inert matchers', () => {
    const parsed = parseCodexSharedHooksFile({
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: 'echo pre' }],
          },
          {
            matcher: null,
            hooks: [{ type: 'command', command: 'echo pre' }],
          },
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'echo pre' }],
          },
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo pre' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo write' }],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: 'ignored',
            hooks: [{ type: 'command', command: 'echo prompt' }],
          },
        ],
        Stop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo stop' }],
          },
        ],
      },
    });

    const identities = parsed.managedIdentities.map(serializeTrackedHookGroupIdentity);
    expect(identities.slice(0, 4)).toEqual([
      '["PreToolUse",null,"echo pre"]',
      '["PreToolUse",null,"echo pre"]',
      '["PreToolUse",null,"echo pre"]',
      '["PreToolUse",null,"echo pre"]',
    ]);
    expect(parsed.managedIdentities[4]).toEqual({
      event: 'PreToolUse',
      matcher: 'Write',
      command: 'echo write',
    });
    expect(parsed.managedIdentities[5]).toEqual({
      event: 'UserPromptSubmit',
      command: 'echo prompt',
    });
    expect(parsed.managedIdentities[6]).toEqual({
      event: 'Stop',
      command: 'echo stop',
    });
  });

  it('preserves runtime-valid foreign Codex shared groups without claiming ownership', () => {
    const parsed = parseCodexSharedHooksFile({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo managed' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo external', timeout: 1000 }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo external', statusMessage: 'running' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo async', async: true }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'prompt' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo one' }, { type: 'command', command: 'echo two' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo mixed' }, { type: 'agent' }],
          },
        ],
      },
    });

    expect(parsed.managedIdentities).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Write',
        command: 'echo managed',
      },
    ]);
    expect(parsed.opaqueRawGroups).toHaveLength(6);
    expect(parsed.opaqueRawGroups[0].hooks[0]).toMatchObject({
      type: 'command',
      command: 'echo external',
      timeout: 1000,
    });
    expect(parsed.opaqueRawGroups[1].hooks[0]).toMatchObject({
      type: 'command',
      command: 'echo external',
      statusMessage: 'running',
    });
  });

  it('rejects invalid Codex shared matcher and runtime field types', () => {
    const parsedWithInvalidRegex = parseCodexSharedHooksFile({
      hooks: {
        PreToolUse: [
          {
            matcher: '[',
            hooks: [{ type: 'command', command: 'echo invalid regex' }],
          },
        ],
      },
    });
    expect(parsedWithInvalidRegex.managedIdentities).toEqual([]);
    expect(parsedWithInvalidRegex.opaqueRawGroups).toHaveLength(1);
    expect(parsedWithInvalidRegex.opaqueRawGroups[0]).toMatchObject({
      event: 'PreToolUse',
      matcher: '[',
    });

    expect(() =>
      parseCodexSharedHooksFile({
        hooks: {
          PreToolUse: [
            {
              matcher: false,
              hooks: [{ type: 'command', command: 'echo invalid matcher' }],
            },
          ],
        },
      }),
    ).toThrow('expected undefined, null, or string');

    expect(() =>
      parseCodexSharedHooksFile({
        hooks: {
          PreToolUse: [
            {
              hooks: [{ type: 'command', command: 'echo timeout', timeout: -1 }],
            },
          ],
        },
      }),
    ).toThrow('timeout');

    expect(() =>
      parseCodexSharedHooksFile({
        hooks: {
          PreToolUse: [
            {
              hooks: [{ type: 'command', command: 'echo async', async: 'yes' }],
            },
          ],
        },
      }),
    ).toThrow('async');

    expect(() =>
      parseCodexSharedHooksFile({
        hooks: {
          PreToolUse: [
            {
              hooks: [{ type: 'command', command: 'echo status', statusMessage: 1 }],
            },
          ],
        },
      }),
    ).toThrow('statusMessage');
  });

  it('plans Codex shared updates by rerendered, historical, and foreign raw groups', () => {
    const parsed = parseCodexSharedHooksFile({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo rerendered' }],
          },
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo historical' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
        ],
      },
    });

    const plan = planCodexSharedHooksUpdate(parsed, {
      rerenderedIdentities: [
        { event: 'PreToolUse', matcher: 'Write', command: 'echo rerendered' },
      ],
      historicalIdentities: [
        { event: 'PreToolUse', matcher: 'Edit', command: 'echo historical' },
      ],
    });

    expect(plan.rerenderedAwRawGroups).toHaveLength(1);
    expect(plan.preservedHistoricalAwRawGroups).toHaveLength(1);
    expect(plan.preservedForeignRawGroups).toHaveLength(1);
    expect(plan.preservedForeignRawGroups[0].hooks[0]).toMatchObject({
      type: 'command',
      command: 'echo foreign',
      timeout: 1000,
    });
  });

  it('compares and subtracts tracked hook identities as multisets', () => {
    const groups = [
      { event: 'PreToolUse', command: 'echo pre' },
      { event: 'PreToolUse', command: 'echo pre' },
      { event: 'Stop', command: 'echo stop' },
    ];

    expect(trackedHookGroupsContainAll(groups, [
      { event: 'PreToolUse', command: 'echo pre' },
      { event: 'Stop', command: 'echo stop' },
    ])).toBe(true);
    expect(trackedHookGroupsContainAll(groups, [
      { event: 'Stop', command: 'echo stop' },
      { event: 'Stop', command: 'echo stop' },
    ])).toBe(false);

    expect(subtractTrackedHookGroupIdentities(groups, [
      { event: 'PreToolUse', command: 'echo pre' },
      { event: 'Stop', command: 'echo stop' },
    ])).toEqual([
      { event: 'PreToolUse', command: 'echo pre' },
    ]);
  });
});
