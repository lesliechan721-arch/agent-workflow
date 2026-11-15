import path from 'node:path';
import type { PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';
import { commandResourceReferences, type VerifiedCommandResource } from '../utils/component-resources.js';
import type { ProjectionInput } from './contracts.js';

function references(input: ProjectionInput, componentId: string, field: 'command' | 'args', index: number | undefined,
  original: string, shell: boolean): VerifiedCommandResource[] {
  const component = input.components.find((entry) => entry.id === componentId);
  const executable = component?.kind === 'mcp' && component.content.type === 'stdio' ? component.content.command : undefined;
  const parsed = commandResourceReferences(original, shell, input.binding.platform, executable);
  const verified = (input.resources.commandResources ?? []).filter((reference) => reference.componentId === componentId
    && reference.field === field && reference.index === index).sort((left, right) => left.start - right.start);
  if (parsed.length !== verified.length || verified.some((reference, position) => reference.original !== original
    || reference.start !== parsed[position]!.start || reference.end !== parsed[position]!.end || reference.path !== parsed[position]!.path
    || !input.resources.bundleFiles.some((file) => file.path === reference.path))) {
    throw new Error('platformProjectionCommandResourceUnverified');
  }
  return verified;
}

function pieces(original: string, bindings: readonly VerifiedCommandResource[], replacement: (relative: string) => string): string[] {
  const output: string[] = [];
  let offset = 0;
  for (const binding of bindings) {
    if (binding.start < offset || binding.end > original.length) throw new Error('platformProjectionCommandResourceConflict');
    output.push(original.slice(offset, binding.start), replacement(binding.path));
    offset = binding.end;
  }
  output.push(original.slice(offset));
  return output;
}

function shellArgument(value: string, host: NodeJS.Platform): string {
  if (host === 'win32') {
    if (/[%!"\r\n]/u.test(value)) throw new Error('platformProjectionShellArgumentUnsupported');
    return `"${value}"`;
  }
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

/** Directory/JSON hosts receive the actual managed package location, never the caller's cwd. */
export function bindPlatformCommandResources(input: ProjectionInput, packageRoot: string, host: NodeJS.Platform): PluginComponent[] {
  return input.components.map((component) => {
    if (component.kind === 'hook') {
      const original = component.content.command;
      const bindings = references(input, component.id, 'command', undefined, original, true);
      const command = pieces(original, bindings, (relative) => shellArgument(path.join(packageRoot, ...relative.split('/')), host)).join('');
      return { ...component, content: { ...component.content, command } };
    }
    if (component.kind !== 'mcp' || component.content.type !== 'stdio') return component;
    const bind = (original: string, field: 'command' | 'args', index?: number): string => pieces(original,
      references(input, component.id, field, index, original, false), (relative) => path.join(packageRoot, ...relative.split('/'))).join('');
    return { ...component, content: { ...component.content, command: bind(component.content.command, 'command'),
      ...(component.content.args ? { args: component.content.args.map((value, index) => bind(value, 'args', index)) } : {}) } };
  });
}

/** Code extensions resolve their own package root, including after a package copy. */
export function commandResourceExpression(input: ProjectionInput, componentId: string, original: string,
  field: 'command' | 'args', index?: number, shell = false): string {
  const bindings = references(input, componentId, field, index, original, shell);
  const expressions: string[] = [];
  let offset = 0;
  for (const binding of bindings) {
    expressions.push(JSON.stringify(original.slice(offset, binding.start)));
    const relativeUrl = `./${binding.path.split('/').map(encodeURIComponent).join('/')}`;
    const resource = `fileURLToPath(new URL(${JSON.stringify(relativeUrl)}, import.meta.url))`;
    expressions.push(shell ? `awQuotePackagePath(${resource})` : resource);
    offset = binding.end;
  }
  expressions.push(JSON.stringify(original.slice(offset)));
  return expressions.join(' + ');
}

export const COMMAND_RESOURCE_SHELL_HELPER = `function awQuotePackagePath(value) {
  if (process.platform === 'win32') {
    if (/[%!"\\r\\n]/u.test(value)) throw new Error('Unsupported package shell path');
    return '"' + value + '"';
  }
  return "'" + value.replaceAll("'", "'\\\"'\\\"'") + "'";
}`;
