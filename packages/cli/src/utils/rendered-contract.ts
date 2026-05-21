import type { ClaudePermissions } from '../generators/permissions.js';
import type { PlatformName } from '../types.js';
import {
  assertHookMatcherAllowed,
  assertNativeHookEvent,
  parseCodexSharedHooksFile,
} from './hooks-contract.js';

function inferRenderedHooksPlatform(fieldName: string): PlatformName | undefined {
  if (fieldName === 'claude' || fieldName.startsWith('claude.')) {
    return 'claude';
  }
  if (fieldName === 'codex' || fieldName.startsWith('codex.')) {
    return 'codex';
  }
  return undefined;
}

function assertRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }

  return value as Record<string, unknown>;
}

function assertStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an array.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`Invalid ${fieldName}[${index}]: expected a non-empty string.`);
    }
    return entry;
  });
}

export function validateRenderedClaudePermissions(
  permissions: ClaudePermissions,
  fieldName = 'claude.permissions',
): void {
  const input = assertRecord(permissions, fieldName);
  for (const decision of ['allow', 'ask', 'deny'] as const) {
    const rules = assertStringArray(input[decision], `${fieldName}.${decision}`);
    for (const [index, rule] of rules.entries()) {
      if (!/^Bash\([^"'\\*;&|<>`$()]+\)$/.test(rule)) {
        throw new Error(`Invalid ${fieldName}.${decision}[${index}]: expected a plain Bash(...) token prefix.`);
      }
    }
  }
}

export function validateRenderedCodexRules(
  content: string,
  fieldName = 'codex.permissions',
): void {
  for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const match = /^prefix_rule\(pattern = (\[[^\n]*\]), decision = "(allow|prompt|forbidden)"\)$/.exec(trimmed);
    if (!match) {
      throw new Error(`Invalid ${fieldName}:${lineIndex + 1}: expected prefix_rule(...).`);
    }

    let pattern: unknown;
    try {
      pattern = JSON.parse(match[1]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid ${fieldName}:${lineIndex + 1}: expected JSON token array (${message}).`);
    }

    const tokens = assertStringArray(pattern, `${fieldName}:${lineIndex + 1}.pattern`);
    if (tokens.length === 0) {
      throw new Error(`Invalid ${fieldName}:${lineIndex + 1}.pattern: expected at least one token.`);
    }
    for (const [tokenIndex, token] of tokens.entries()) {
      if (/\s/.test(token) || /["'\\*;&|<>`$()]/.test(token)) {
        throw new Error(
          `Invalid ${fieldName}:${lineIndex + 1}.pattern[${tokenIndex}]: expected a plain command token.`,
        );
      }
    }
  }
}

export function validateRenderedHooksContent(
  content: unknown,
  fieldName: string,
  platform?: PlatformName,
): void {
  const root = assertRecord(content, fieldName);
  const extraRootKeys = Object.keys(root).filter((key) => key !== 'hooks');
  if (extraRootKeys.length > 0) {
    throw new Error(
      `Invalid ${fieldName}: unsupported fields ${extraRootKeys.map((key) => `"${key}"`).join(', ')}.`,
    );
  }
  const hooks = assertRecord(root.hooks, `${fieldName}.hooks`);
  const renderedPlatform = platform ?? inferRenderedHooksPlatform(fieldName);

  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!renderedPlatform) {
      throw new Error(`Invalid ${fieldName}: unable to infer rendered hooks platform.`);
    }

    assertNativeHookEvent(
      eventName,
      renderedPlatform,
      `${fieldName}.hooks.${eventName}`,
    );

    if (!Array.isArray(groups)) {
      throw new Error(`Invalid ${fieldName}.hooks.${eventName}: expected an array of hook groups.`);
    }

    for (const [groupIndex, group] of groups.entries()) {
      const groupField = `${fieldName}.hooks.${eventName}[${groupIndex}]`;
      const groupRecord = assertRecord(group, groupField);
      const extraGroupKeys = Object.keys(groupRecord).filter((key) => key !== 'matcher' && key !== 'hooks');
      if (extraGroupKeys.length > 0) {
        throw new Error(
          `Invalid ${groupField}: unsupported fields ${extraGroupKeys.map((key) => `"${key}"`).join(', ')}.`,
        );
      }
      const matcher = groupRecord.matcher;
      if (matcher !== undefined && typeof matcher !== 'string') {
        throw new Error(`Invalid ${groupField}.matcher: expected a string.`);
      }
      assertHookMatcherAllowed({
        kind: 'native',
        platform: renderedPlatform,
        event: eventName,
        matcher: matcher as string | undefined,
        fieldName: `${groupField}.matcher`,
      });

      if (!Array.isArray(groupRecord.hooks)) {
        throw new Error(`Invalid ${groupField}.hooks: expected an array.`);
      }
      if (groupRecord.hooks.length !== 1) {
        throw new Error(`Invalid ${groupField}.hooks: expected exactly one hook handler.`);
      }

      for (const [handlerIndex, handler] of groupRecord.hooks.entries()) {
        const handlerField = `${groupField}.hooks[${handlerIndex}]`;
        const handlerRecord = assertRecord(handler, handlerField);
        if (handlerRecord.type !== 'command') {
          throw new Error(`Invalid ${handlerField}.type: expected "command".`);
        }
        if (typeof handlerRecord.command !== 'string' || handlerRecord.command.trim() === '') {
          throw new Error(`Invalid ${handlerField}.command: expected a non-empty string.`);
        }
        const extraKeys = Object.keys(handlerRecord).filter((key) => key !== 'type' && key !== 'command');
        if (extraKeys.length > 0) {
          throw new Error(
            `Invalid ${handlerField}: unsupported fields ${extraKeys.map((key) => `"${key}"`).join(', ')}.`,
          );
        }
      }
    }
  }
}

export function validateRenderedClaudeHooksContent(
  content: unknown,
  fieldName = 'claude.hooks',
): void {
  validateRenderedHooksContent(content, fieldName, 'claude');
}

export function validateRenderedCodexHooksContent(
  content: unknown,
  fieldName = 'codex.hooks',
): void {
  validateRenderedHooksContent(content, fieldName, 'codex');
}

export function validateCodexSharedHooksContent(
  content: unknown,
  fieldName = 'codex.hooks',
): void {
  parseCodexSharedHooksFile(content, fieldName);
}
