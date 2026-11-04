import { fail } from '../runtime/contracts.mjs';

// Adapter v5 validates presence at its wire boundary. Pure argument helpers
// also serve existing callers, where an omitted selection means default.
export function permissionMode(request) {
  const mode = request.permissionMode ?? 'default';
  if (!['default', 'auto', 'full-access'].includes(mode)) fail('adapterProtocolInvalid', 'The permission mode must be default, auto, or full-access.');
  return mode;
}

/** A backend warning must never silently replace the selected auto policy. */
export function permissionModeFallback(text) {
  return /(?:auto(?:matic)?(?:[_ -](?:review|mode|permissions?))?|permission[_ -]mode)[^\r\n]{0,180}(?:not (?:available|supported|enabled)|unavailable|unsupported|fall(?:ing)? back|continuing in (?:the )?default)|(?:fall(?:ing)? back|continuing in (?:the )?default)[^\r\n]{0,180}auto/i.test(text);
}

// Keep a bounded suffix so a warning split across stderr chunks still counts.
export function watchPermissionFallback(context, selected = permissionMode(context.request)) {
  if (selected !== 'auto') return;
  let pending = '';
  context.onBackendStderr = (chunk) => {
    pending = (pending + chunk.toString('utf8')).slice(-8192);
    if (permissionModeFallback(pending)) context.abort('permissionModeUnavailable');
  };
}
