import type { PlatformTarget, TemplateValue, TemplateVarByPlatform } from './types.js';

function resolveTemplateValue(
  input: string,
  vars: Record<string, TemplateVarByPlatform>,
  platform: PlatformTarget,
): Record<string, TemplateValue> {
  const referencedKeys = new Set([...input.matchAll(/{{(?:#(?:if|unless)\s+)?([a-zA-Z0-9_]+)}}/g)]
    .map((match) => match[1]!));
  const output: Record<string, TemplateValue> = {};
  for (const [key, value] of Object.entries(vars)) {
    const resolved = value[platform];
    if (resolved !== undefined) output[key] = resolved;
    else if (referencedKeys.has(key)) {
      throw new Error(`Missing template variable ${JSON.stringify(key)} for platform ${JSON.stringify(platform)}.`);
    }
  }
  return output;
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
  platform: PlatformTarget,
): string {
  const resolvedVars = resolveTemplateValue(input, vars, platform);
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
