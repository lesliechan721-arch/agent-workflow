import { fail, object } from '../runtime/contracts.mjs';
import { introspectExecutor } from './models.mjs';
import { executorPresentation } from './presentation.mjs';

const byteLimit = 32 * 1024;
const escape = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function directoryText(result) {
  const lines = [
    `executor ${escape(result.executor)} adapter=${escape(result.adapter)} source=${result.source} environment=${result.environment}`
    + (result.defaultModel ? ` default_model=${escape(result.defaultModel)}` : '') + (result.defaultEffort ? ` default_effort=${escape(result.defaultEffort)}` : ''),
  ];
  if (result.description) lines.push('description: ' + escape(result.description));
  if (result.supportedEfforts?.length) lines.push('efforts: ' + result.supportedEfforts.map(escape).join(', '));
  lines.push('<models>');
  for (const m of result.models) lines.push(escape(m.id) + (m.isDefault ? ' [default]' : '')
    + (m.origin ? ' [origin=' + m.origin + ']' : '') + (m.efforts?.length ? ' [efforts=' + m.efforts.map(escape).join(',') + ']' : '')
    + (m.displayName || m.description ? ' — ' + [m.displayName, m.description].filter(Boolean).map(escape).join(' — ') : ''));
  lines.push('</models>');
  for (const d of result.diagnostics) lines.push(`<diagnostic code="${escape(d.code)}">${escape(d.message)}</diagnostic>`);
  return lines.join('\n');
}

function boundedDirectory(result, json) {
  const render = () => (json ? JSON.stringify(result) : directoryText(result)) + '\n';
  const output = render();
  if (Buffer.byteLength(output) <= byteLimit) return output;
  const exceedsLimit = () => Buffer.byteLength(render()) > byteLimit;
  result.diagnostics.push({ code: 'introspectionTruncated', message: 'The model directory exceeded the output limit. Remaining items were omitted.' });
  // Keep the leading cause and fallback advice, together with the truncation notice.
  while (result.diagnostics.length > 3 && exceedsLimit()) result.diagnostics.splice(-2, 1);
  while (result.models.length && exceedsLimit()) {
    const removed = result.models.pop();
    if (removed.id === result.defaultModel) {
      delete result.defaultModel;
      delete result.defaultEffort;
    }
  }
  if (exceedsLimit()) delete result.supportedEfforts;
  if (exceedsLimit()) delete result.description;
  if (exceedsLimit()) result.executor = '[omitted]';
  return render();
}

export async function inspectRegistry(commands, request, options) {
  const { env } = options;
  if (!Array.isArray(commands) || commands.some((entry) => !object(entry))) fail('registryInvalid', 'Configure an executor registry.');
  if (request.executor === undefined) {
    const lines = ['key\tadapter\tmodels_policy\tstatic_models\tcommunication\tresume\tdescription'];
    for (const executor of commands) {
      const { display } = executorPresentation(executor, env);
      const line = [executor.key, executor.adapter, executor.modelsPolicy ?? 'merge', executor.models?.length ?? 0,
        executor.communication ?? true, executor.resume ?? true, executor.description ?? '']
        .map(display).join('\t');
      if (Buffer.byteLength(lines.join('\n') + '\n' + line) > byteLimit - 64) { lines.push('Further executors omitted (output limit).'); break; }
      lines.push(line);
    }
    return (commands.length ? lines.join('\n') : 'No external executors configured.') + '\n';
  }
  if (request.executor === 'native') fail('nativeUnsupported', 'Use the host tools for native execution.');
  const executor = commands.find((e) => e.key === request.executor);
  if (!executor) fail('executorUnknown', 'The selected executor is not configured.');
  return boundedDirectory(await introspectExecutor(executor, options), request.json);
}
