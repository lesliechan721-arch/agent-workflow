export function iframeSandbox(config) {
  return config.htmlExecution === 'sandboxed' ? 'allow-scripts' : 'allow-same-origin';
}

export function annotationTargets(config) {
  if (!config.allowAnnotations) return [];
  const targets = [];
  if (config.options.some((option) => option.kind === 'image')) targets.push('image');
  if (config.htmlExecution === 'static' && config.options.some((option) => option.kind === 'html')) {
    targets.push('dom', 'text', 'node');
  }
  return targets;
}

export function markedAnnotationTarget(optionId, elementId, markerKind) {
  if (!optionId || !elementId) return null;
  const kind = markerKind || 'dom';
  if (!['dom', 'text', 'node'].includes(kind)) return null;
  return { kind, value: { optionId, elementId } };
}

export function imageAnnotationTarget(optionId, x, y) {
  if (!optionId || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { kind: 'point', value: { optionId, x, y } };
}
