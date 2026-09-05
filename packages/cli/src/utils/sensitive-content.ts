export function findSensitiveTokenPath(
  files: Readonly<Record<string, string | Buffer>>,
  sensitiveValues: readonly string[],
): string | undefined {
  for (const [relativePath, content] of Object.entries(files)) {
    const text = typeof content === 'string' ? content : content.toString('utf8');
    if (sensitiveValues.some((value) => {
      if (value.length === 0) return false;
      const encoded = JSON.stringify(value).slice(1, -1);
      return text.includes(value) || (encoded !== value && text.includes(encoded));
    })) {
      return relativePath;
    }
  }
  return undefined;
}
