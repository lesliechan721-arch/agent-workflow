import os from 'node:os';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { DiagnosticSummary, diagnosticDetailRowCount } from '../../src/tui/components.js';
import {
  safeDiagnosticCode,
  sanitizeDiagnosticCause,
  sanitizeDiagnosticText,
  type DiagnosticSummaryViewModel,
} from '../../src/tui/diagnostics.js';

afterEach(() => cleanup());

describe('TUI diagnostic projection', () => {
  it('redacts injected credentials, private paths, digests, raw output, and controls in real Ink output', () => {
    const privateSourceRoot = '/private/source/root';
    const injected = [
      '\u001B[31mAuthorization\u001B[0m: Bearer authorization-secret',
      '"Authorization":"Basic json-authorization-secret"',
      '\u009B31mBearer c1-ansi-secret',
      'https://alice:url-secret@example.test/catalog?access%5Ftoken=encoded-secret&KEY=query-key',
      'token=text-token password=text-password "access_token":"json-secret"',
      os.homedir(),
      process.cwd(),
      os.tmpdir(),
      privateSourceRoot,
      'snapshotDigest=sha256:0123456789abcdef',
      'control\u0000value\u007f',
    ].join(' · ');
    const diagnostic: DiagnosticSummaryViewModel = {
      severity: 'error',
      title: injected,
      userMessage: injected,
      impact: [{ state: 'blocked', message: injected }],
      nextStep: injected,
      technical: {
        code: 'catalogSourceUnavailable',
        stage: 'resolve-source',
        sourceId: 'team-tools',
        requestedRef: 'refs/heads/release-v5',
        resolvedCommit: '0123456789abcdef0123456789abcdef01234567',
        context: [{ key: 'field', value: injected }],
        sanitizedCause: 'Error: wrapper; caused by Error: git stderr Bearer nested-secret /private/cause',
        checks: ['git stderr: fatal: native-secret /private/native'],
      },
    };

    const product = render(<DiagnosticSummary diagnostic={diagnostic} />).lastFrame() ?? '';
    const technical = render(<DiagnosticSummary diagnostic={diagnostic} technical compact offset={0} limit={6} />).lastFrame() ?? '';
    const output = `${product}\n${technical}`;

    expect(technical).toContain('catalogSourceUnavailable');
    expect(technical).toContain('refs/heads/release-v5');
    expect(technical).toContain('0123456789abcdef0123456789abcdef01234567');
    expect(technical).not.toContain('cause');
    for (const secret of [
      'authorization-secret', 'json-authorization-secret', 'c1-ansi-secret', 'alice', 'url-secret', 'encoded-secret', 'query-key',
      'text-token', 'text-password', 'json-secret', 'nested-secret', 'native-secret',
      os.homedir(), process.cwd(), os.tmpdir(), privateSourceRoot, '/private/cause', '/private/native',
      'sha256:', '\u001B', '\u0000', '\u007f', 'git stderr', 'fatal:',
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('keeps safe code, ref, and commit values while bounding text and omitting unsafe causes', () => {
    const commit = 'fedcba9876543210fedcba9876543210fedcba98';
    const secret = 'private "value"\npath\\tail';
    const escaped = JSON.stringify(secret).slice(1, -1);
    expect(safeDiagnosticCode('configReadFailed.v2', 'fallbackCode')).toBe('configReadFailed.v2');
    expect(safeDiagnosticCode('bad code: token=secret', 'fallbackCode')).toBe('fallbackCode');
    expect(sanitizeDiagnosticText('refs/heads/release-v5')).toBe('refs/heads/release-v5');
    expect(sanitizeDiagnosticText(commit)).toBe(commit);
    expect(sanitizeDiagnosticText('x'.repeat(400))).toHaveLength(240);
    expect(sanitizeDiagnosticText('x'.repeat(400))).toMatch(/…$/u);
    expect(sanitizeDiagnosticText(
      `raw=${secret} escaped=${escaped}`,
      [],
      [secret],
    )).toBe('raw=[REDACTED] escaped=[REDACTED]');
    expect(sanitizeDiagnosticCause('git fetch returned an error')).toBeUndefined();
    expect(sanitizeDiagnosticCause('token=cause-secret')).toBeUndefined();
    expect(sanitizeDiagnosticCause('已验证缓存不可用')).toBe('已验证缓存不可用');
  });

  it('paginates all safe diagnostic fields and checks in real Ink output', () => {
    const diagnostic: DiagnosticSummaryViewModel = {
      severity: 'error',
      title: '来源不可用',
      userMessage: '无法读取来源。',
      impact: [],
      nextStep: '检查来源。',
      technical: {
        code: 'catalogSourceUnavailable',
        stage: 'resolve-source',
        sourceId: 'team-tools',
        requestedRef: 'refs/heads/release-v5',
        resolvedCommit: '0123456789abcdef0123456789abcdef01234567',
        context: [
          { key: 'platform', value: 'codex' },
          { key: 'scope', value: 'project' },
        ],
        sanitizedCause: '已验证缓存不可用',
        checks: ['检查网络连接。', '重新检查来源。', '升级 AW 后重试。'],
      },
    };

    const total = diagnosticDetailRowCount(diagnostic);
    const first = render(<DiagnosticSummary diagnostic={diagnostic} technical offset={0} limit={3} />).lastFrame() ?? '';
    const last = render(<DiagnosticSummary diagnostic={diagnostic} technical offset={total - 2} limit={3} />).lastFrame() ?? '';

    expect(total).toBe(11);
    expect(first).toContain('code');
    expect(first).toContain('stage');
    expect(first).toContain('sourceId');
    expect(first).toContain('1 / 4');
    expect(first).toContain('下一页 →');
    expect(first).not.toContain('建议 3');
    expect(last).toContain('4 / 4');
    expect(last).toContain('← 上一页');
    expect(last).toContain('建议 2');
    expect(last).toContain('建议 3');
    expect(last).not.toContain('后面还有');
  });
});
