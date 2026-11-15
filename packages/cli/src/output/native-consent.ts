import type { Diagnostic } from './public-result.js';

export function geminiNativeConsentDiagnostic(): Diagnostic {
  return { code: 'nativeConsentGranted', severity: 'warning', subject: { target: 'gemini' },
    message: 'This request explicitly authorizes Gemini native extension consent. Gemini may persist trust for the source folder and current workspace. This permission applies only to the current frozen operation; AW stores no automatic approval setting.' };
}
