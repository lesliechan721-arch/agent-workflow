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
  const representations = collectSensitiveTokenRepresentations(sensitiveValues);
  for (const [relativePath, content] of Object.entries(files)) {
    const text = typeof content === 'string' ? content : content.toString('utf8');
    if (representations.some((representation) => text.includes(representation))) {
      return relativePath;
    }
  }
  return undefined;
}
