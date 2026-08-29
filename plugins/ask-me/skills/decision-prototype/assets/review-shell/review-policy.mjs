export function annotationTargets(config) {
  if (!config.allowAnnotations) return [];
  const targets = [];
  if (config.options.some((option) => option.kind === 'image')) targets.push('image');
  if (config.mode !== 'high-fidelity' && config.options.some((option) => option.kind === 'html')) targets.push('dom');
  return targets;
}
