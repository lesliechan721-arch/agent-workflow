import type { PlatformName, TemplateValue, TemplateVarByPlatform } from './types.js';

function resolveTemplateValue(
  vars: Record<string, TemplateVarByPlatform>,
  platform: PlatformName,
): Record<string, TemplateValue> {
  return Object.fromEntries(
    Object.entries(vars).map(([key, value]) => [key, value[platform]]),
  );
}

function replaceConditionalBlocks(
  input: string,
  resolvedVars: Record<string, TemplateValue>,
  tagName: 'if' | 'unless',
): string {
  const pattern = new RegExp(
    `{{#${tagName}\\s+([a-zA-Z0-9_]+)}}([\\s\\S]*?){{\\/${tagName}}}`,
    'g',
  );

  return input.replace(pattern, (_match, rawKey: string, content: string) => {
    const value = resolvedVars[rawKey];
    const truthy = value === true;
    if (tagName === 'if') {
      return truthy ? content : '';
    }

    return truthy ? '' : content;
  });
}

export function renderTemplate(
  input: string,
  vars: Record<string, TemplateVarByPlatform>,
  platform: PlatformName,
): string {
  const resolvedVars = resolveTemplateValue(vars, platform);
  const withConditionals = replaceConditionalBlocks(
    replaceConditionalBlocks(input, resolvedVars, 'if'),
    resolvedVars,
    'unless',
  );

  return withConditionals.replace(/{{([a-zA-Z0-9_]+)}}/g, (_match, rawKey: string) => {
    const value = resolvedVars[rawKey];
    if (value === undefined) {
      return '';
    }

    return String(value);
  });
}
