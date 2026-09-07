const MINIMUM_BLOCKED_SENSITIVE_CODE_POINTS = 8;

export function resolveSensitiveTokenRepresentations(value: string): string[] {
  if (value === '') return [];
  const encoded = JSON.stringify(value).slice(1, -1);
  return encoded === value ? [value] : [value, encoded];
}

export function containsBlockedSensitiveToken(
  value: string,
  sensitiveValues: readonly string[],
): boolean {
  return [...new Set(sensitiveValues)].some((sensitiveValue) => {
    if ([...sensitiveValue].length < MINIMUM_BLOCKED_SENSITIVE_CODE_POINTS) return false;
    return resolveSensitiveTokenRepresentations(sensitiveValue)
      .some((token) => value.includes(token));
  });
}

export function collectSensitiveTokenRepresentations(
  sensitiveValues: readonly string[],
): string[] {
  const representations = new Set<string>();
  for (const value of sensitiveValues) {
    if (value.length === 0) continue;
    representations.add(value);
    representations.add(JSON.stringify(value).slice(1, -1));
  }
  return [...representations].sort((left, right) => right.length - left.length);
}

export function findSensitiveTokenPath(
  files: Readonly<Record<string, string | Buffer>>,
  sensitiveValues: readonly string[],
): string | undefined {
  for (const [relativePath, content] of Object.entries(files)) {
    const text = typeof content === 'string' ? content : content.toString('utf8');
    if (containsBlockedSensitiveToken(relativePath, sensitiveValues)) return '[REDACTED_PATH]';
    if (containsBlockedSensitiveToken(text, sensitiveValues)) return relativePath;
  }
  return undefined;
}
