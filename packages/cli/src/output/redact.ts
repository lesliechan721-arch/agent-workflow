const SENSITIVE_KEY_PATTERN =
  /(token|password|passwd|secret|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key|credential|session)/i;

const STRING_REDACTIONS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+/gi, '$1$2[REDACTED]'],
  [/(cookie\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]'],
  [/((?:token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential)\s*[:=]\s*)[^\s,;&"']+/gi, '$1[REDACTED]'],
  [/((?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)=)[^\s,;&"']+/g, '$1[REDACTED]'],
];

function isSensitiveKey(key: string | undefined): boolean {
  return key !== undefined && SENSITIVE_KEY_PATTERN.test(key);
}

export function redactString(value: string): string {
  return STRING_REDACTIONS.reduce(
    (next, [pattern, replacement]) => next.replace(pattern, replacement),
    value,
  );
}

export function redactValue(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (isSensitiveKey(key)) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, undefined, seen));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      redactValue(entryValue, entryKey, seen),
    ]),
  );
}

export function stringifyRedacted(value: unknown): string {
  return JSON.stringify(redactValue(value));
}
