import {
  CODEX_NATIVE_RENDER_RECEIPT_PATH,
  createCodexNativeRenderReceipt,
  parseCodexNativeRenderReceipt,
  type CodexNativeRenderReceipt,
  type CreateCodexNativeRenderProjectionInput,
} from './codex-native-render-receipt.js';

export const CLAUDE_NATIVE_RENDER_RECEIPT_PATH = '.agents-plugin/aw-claude-native-render.json';

export type ClaudeNativeRenderReceipt = Omit<CodexNativeRenderReceipt, 'kind'> & {
  kind: 'aw-claude-native-render';
};
export type NativeSkillRenderReceipt = CodexNativeRenderReceipt | ClaudeNativeRenderReceipt;

/** Both Native platforms use the same shared-user projection evidence contract. */
export function createClaudeNativeRenderReceipt(
  input: CreateCodexNativeRenderProjectionInput & { payloadDigest: string },
): ClaudeNativeRenderReceipt {
  return { ...createCodexNativeRenderReceipt(input), kind: 'aw-claude-native-render' };
}

export function parseClaudeNativeRenderReceipt(value: string | unknown): ClaudeNativeRenderReceipt {
  const raw: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || (raw as Record<string, unknown>).kind !== 'aw-claude-native-render') {
    throw new Error('Invalid Claude native render receipt kind.');
  }
  const validated = parseCodexNativeRenderReceipt({ ...raw, kind: 'aw-codex-native-render' });
  return { ...validated, kind: 'aw-claude-native-render' };
}

export function nativeSkillRenderReceiptPath(platform: 'codex' | 'claude'): string {
  return platform === 'codex' ? CODEX_NATIVE_RENDER_RECEIPT_PATH : CLAUDE_NATIVE_RENDER_RECEIPT_PATH;
}

export function parseNativeSkillRenderReceipt(platform: 'codex' | 'claude', value: unknown): NativeSkillRenderReceipt {
  return platform === 'codex' ? parseCodexNativeRenderReceipt(value) : parseClaudeNativeRenderReceipt(value);
}

export function serializeNativeSkillRenderReceipt(receipt: NativeSkillRenderReceipt): string {
  const platform = receipt.kind === 'aw-codex-native-render' ? 'codex' : 'claude';
  return `${JSON.stringify(parseNativeSkillRenderReceipt(platform, receipt), null, 2)}\n`;
}
