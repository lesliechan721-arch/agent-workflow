import { redact, validateDiagnostics } from './contracts.mjs';

/** Validate raw entries before redaction, then explicitly omit expanded fields. */
export function sanitizeDiagnostics(diagnostics, environment = {}, secretValues = []) {
  if (!Array.isArray(diagnostics)) validateDiagnostics(diagnostics);
  return diagnostics.map((entry) => {
    validateDiagnostics([entry]);
    let message = redact(entry.message, environment, secretValues);
    let field = entry.field === undefined ? undefined : redact(entry.field, environment, secretValues);
    if (Buffer.byteLength(message) > 2048) message = 'Diagnostic message omitted: redaction exceeded its 2048-byte limit.';
    if (field !== undefined && Buffer.byteLength(field) > 512) {
      field = undefined;
      const notice = 'Diagnostic field path omitted: redaction exceeded its 512-byte limit.';
      message = Buffer.byteLength(`${message}\n${notice}`) <= 2048 ? `${message}\n${notice}` : `${notice} Diagnostic message omitted to keep this notice within the byte limit.`;
    }
    return { code: entry.code, message, ...(field === undefined ? {} : { field }) };
  });
}

/** Keep safe diagnostics inside the existing control-frame and parent output budgets. */
export function summarizeDiagnostics(diagnostics, environment = {}, secretValues = []) {
  const safe = sanitizeDiagnostics(diagnostics, environment, secretValues);
  if (safe.length <= 64 && Buffer.byteLength(JSON.stringify(safe)) <= 2800) return safe;
  const groups = new Map();
  for (const entry of safe) {
    const field = entry.field?.split(/[.[]/, 1)[0] || 'initialization';
    const key = `${entry.code}:${field}`;
    const group = groups.get(key) ?? { code: entry.code, field, count: 0 };
    group.count++; groups.set(key, group);
  }
  const summary = [{ code: 'diagnosticsSummarized', message: `${safe.length} initialization diagnostics were grouped. Ignored profile overrides do not disable base or project configuration.` }];
  let included = 0;
  for (const group of groups.values()) {
    const entry = { code: group.code, field: group.field, message: `${group.count} diagnostics in this field group.` };
    if (summary.length < 15 && Buffer.byteLength(JSON.stringify([...summary, entry])) <= 2400) { summary.push(entry); included++; }
  }
  if (included < groups.size) summary.push({ code: 'diagnosticsSummarized', message: `${groups.size - included} additional field groups are included in the total.` });
  return summary;
}
