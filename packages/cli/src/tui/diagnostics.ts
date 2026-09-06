import os from 'node:os';
import path from 'node:path';

import { redactString } from '../output/redact.js';
import { collectSensitiveTokenRepresentations } from '../utils/sensitive-content.js';

export type DiagnosticImpactState = 'blocked' | 'preserved' | 'degraded';

export interface DiagnosticImpactEntryViewModel {
  state: DiagnosticImpactState;
  message: string;
}

export type DiagnosticContextKey =
  | 'platform'
  | 'scope'
  | 'pluginId'
  | 'dependencyPluginId'
  | 'field'
  | 'storeEntry'
  | 'compatibility';

export interface DiagnosticTechnicalViewModel {
  code: string;
  stage?: string;
  sourceId?: string;
  requestedRef?: string;
  resolvedCommit?: string;
  context?: Array<{ key: DiagnosticContextKey; value: string }>;
  sanitizedCause?: string;
  checks?: string[];
}

export interface DiagnosticSummaryViewModel {
  severity: 'warning' | 'error';
  title: string;
  userMessage: string;
  impact: DiagnosticImpactEntryViewModel[];
  nextStep: string;
  technical?: DiagnosticTechnicalViewModel;
}

const MAX_DIAGNOSTIC_TEXT_LENGTH = 240;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/u;
const ANSI_ESCAPE = /(?:\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))|\u009B[0-?]*[ -/]*[@-~])/gu;
const NON_WHITESPACE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const RAW_OUTPUT_LINE = /^[^\r\n]*(?:\bstderr\b|stack\s*trace|\bfatal\s*:|\bremote\s*:)[^\r\n]*$/gimu;
const NATIVE_CAUSE = /(?:\bstderr\b|stack\s*trace|\bfatal\s*:|\bremote\s*:|\b(?:git|native)\b[^\r\n]{0,80}\b(?:failed|failure|error|exit|returned)\b|\bspawn\b|child\s+process|\bexited?\s+(?:with\s+)?(?:code\s+)?\d+|\b(?:caused\s+by|cause|error)\s*:|\bat\s+\S+\s*\()/iu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceRoot(value: string, root: string): string {
  const normalized = path.resolve(root);
  const variants = new Set([
    normalized,
    normalized.replaceAll('\\', '/'),
    ...(normalized.startsWith('/var/') ? [`/private${normalized}`] : []),
    ...(normalized.startsWith('/private/var/') ? [normalized.slice('/private'.length)] : []),
  ]);
  let output = value;
  for (const variant of variants) {
    output = output.replace(new RegExp(escapeRegExp(variant), 'gu'), '[private-path]');
  }
  return output;
}

export function safeDiagnosticCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : fallback;
}

export function sanitizeDiagnosticText(
  value: string,
  sensitiveRoots: readonly string[] = [],
  sensitiveValues: readonly string[] = [],
): string {
  let output = value;
  for (const representation of collectSensitiveTokenRepresentations(sensitiveValues)) {
    output = output.replace(new RegExp(escapeRegExp(representation), 'gu'), '[REDACTED]');
  }
  output = output
    .replace(ANSI_ESCAPE, '')
    .replace(NON_WHITESPACE_CONTROL, '')
    .replace(RAW_OUTPUT_LINE, '[diagnostic-omitted]')
    .replace(/[\r\n\t]+/gu, ' ');
  output = redactString(output)
    .replace(/\bAuthorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/giu, '[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/([?&;])(?:token|access(?:[_-]|%5f|%2d)?token|password|passwd|secret|key|api(?:[_-]|%5f|%2d)?key|access(?:[_-]|%5f|%2d)?key|private(?:[_-]|%5f|%2d)?key|authorization|cookie|session)=[^&#;\s]*/giu, '$1[redacted]')
    .replace(/(["']?)(?:token|access[_-]?token|password|passwd|secret|key|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|cookie|session)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&"']+)/giu, '[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/giu, '[REDACTED]')
    .replace(/\b(?:sha(?:-|_)?256|[A-Za-z][A-Za-z0-9_-]*digest)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9+/_=-]{4,})/giu, '[REDACTED]');
  const roots = new Set([
    os.homedir(),
    process.cwd(),
    os.tmpdir(),
    process.env.TMPDIR,
    process.env.TEMP,
    process.env.TMP,
    ...sensitiveRoots,
  ].filter((entry): entry is string => Boolean(entry?.trim())));
  for (const root of roots) output = replaceRoot(output, root);
  output = output
    .replace(/(^|[\s("'=])\/(?:[^/\s]+\/)+[^\s,;)]*/gu, '$1[private-path]')
    .replace(/(^|[\s("'=])[A-Za-z]:\\(?:[^\\\s]+\\)+[^\s,;)]*/gu, '$1[private-path]')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  return output.length <= MAX_DIAGNOSTIC_TEXT_LENGTH
    ? output
    : `${output.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH - 1)}…`;
}

export function sanitizeDiagnosticCause(value: string | undefined): string | undefined {
  if (!value || NATIVE_CAUSE.test(value)) return undefined;
  const sanitized = sanitizeDiagnosticText(value);
  return sanitized && !sanitized.includes('[REDACTED]') && !sanitized.includes('[private-path]')
    ? sanitized
    : undefined;
}
