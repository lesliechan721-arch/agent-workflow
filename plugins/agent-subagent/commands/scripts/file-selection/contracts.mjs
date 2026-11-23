export const LIMITS = Object.freeze({
  inputBytes: 1024 * 1024,
  outputBytes: 16 * 1024 * 1024,
  selectors: 4096,
  patterns: 8192,
  patternBytes: 32768,
  braceRange: 1000,
  expandedPatterns: 8192,
  entries: 100000,
  operations: 500000,
  files: 100000,
  ignoreFileBytes: 1024 * 1024,
  ignoreTotalBytes: 4 * 1024 * 1024,
  durationMs: 30000,
});

export function fail(code, message, exitCode = 1) {
  throw Object.assign(new Error(message), { code, exitCode });
}

// This validation has no filesystem access. Keep valid original values unchanged.
export function validateSelectors(selectors) {
  if (!Array.isArray(selectors)) fail('fileSelectionInputInvalid', 'selectors must be a string array.', 2);
  for (const value of selectors) {
    if (typeof value !== 'string' || value.includes('\0')) {
      fail('fileSelectionInputInvalid', 'Each selector must be a string without NUL.', 2);
    }
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (!parts.length || parts.some((part) => part.startsWith('!') && !part.slice(1).trim())) {
      fail('fileSelectionInputInvalid', 'Each selector needs a nonempty path or pattern; an exclusion needs a pattern.', 2);
    }
  }
  return selectors;
}

export function parseSelectors(selectors, limits = LIMITS) {
  validateSelectors(selectors);
  if (selectors.length > limits.selectors) fail('fileSelectionLimitExceeded', 'Too many selectors. Reduce the selection.');
  const parts = [];
  let expanded = 0;
  for (const value of selectors) {
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (trimmed) {
        if (Buffer.byteLength(trimmed) > limits.patternBytes) fail('fileSelectionLimitExceeded', 'A pattern exceeds its byte limit. Shorten the pattern.');
        // Commas already separate selectors. Numeric/character brace ranges
        // are the remaining expansion source; cap their product before the
        // glob library can allocate the expanded array synchronously.
        let count = 1;
        const ranges = trimmed.matchAll(/(?<!\\)\{(-?\d+|[^{}.,\\])\.\.(-?\d+|[^{}.,\\])(?:\.\.(-?\d+))?\}/gu);
        for (const [, start, end, stride] of ranges) {
          const numeric = /^-?\d+$/.test(start) && /^-?\d+$/.test(end);
          if (!numeric && (start.length !== 1 || end.length !== 1)) continue;
          const distance = Math.abs(numeric ? Number(end) - Number(start) : end.codePointAt(0) - start.codePointAt(0));
          const length = Math.floor(distance / (Math.abs(Number(stride)) || 1)) + 1;
          if (!Number.isFinite(length) || length > limits.braceRange) fail('fileSelectionLimitExceeded', 'A brace range exceeds its expansion limit. Reduce the range.');
          count *= length;
          if (count > limits.expandedPatterns) fail('fileSelectionLimitExceeded', 'Brace ranges exceed the expanded pattern limit. Reduce the ranges.');
        }
        expanded += count;
        if (expanded > limits.expandedPatterns) fail('fileSelectionLimitExceeded', 'The selection exceeds its expanded pattern limit. Reduce the selection.');
        parts.push(trimmed);
      }
      if (parts.length > limits.patterns) fail('fileSelectionLimitExceeded', 'Too many comma-separated patterns. Reduce the selection.');
    }
  }
  return parts;
}

export function publicError(error) {
  const known = new Set(['fileSelectionInputInvalid', 'fileSelectionPathMissing', 'fileSelectionEmpty',
    'fileSelectionReadFailed', 'fileSelectionLimitExceeded', 'fileSelectionFailed']);
  if (known.has(error?.code)) return { code: error.code, message: error.message, exitCode: error.exitCode ?? 1 };
  return { code: 'fileSelectionFailed', message: 'File selection failed. Check the input and sync or reinstall the Guide.', exitCode: 1 };
}
