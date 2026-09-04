export function findSensitiveTokenPath(
  files: Readonly<Record<string, string | Buffer>>,
  sensitiveValues: readonly string[],
): string | undefined {
  for (const [relativePath, content] of Object.entries(files)) {
    const text = typeof content === 'string' ? content : content.toString('utf8');
    if (sensitiveValues.some((value) => value.length > 0 && text.includes(value))) {
      return relativePath;
    }
  }
  return undefined;
}
