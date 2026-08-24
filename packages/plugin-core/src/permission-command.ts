export function parsePermissionCommand(value: string, fieldName = 'permission'): { tokens: string[] } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid ${fieldName}: expected a non-empty command prefix.`);
  }
  if (/["'\\*;&|<>`$()]/u.test(trimmed)) {
    throw new Error(
      `Invalid ${fieldName}: only plain token prefixes are supported; quotes, escapes, shell control characters and "*" are not allowed.`,
    );
  }
  return { tokens: trimmed.split(/\s+/u) };
}
