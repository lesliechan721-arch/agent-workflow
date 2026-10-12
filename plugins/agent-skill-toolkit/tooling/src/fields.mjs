import { parseDocument } from 'yaml';
import { diagnostic } from './common.mjs';

export const RULESET = 'authoring-2026-10-10';
export const codePoints = value => [...value].length;
export const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseYaml(content, file, diagnostics, lineOffset = 0) {
  try {
    const doc = parseDocument(content, { schema: 'core', customTags: [], uniqueKeys: true, strict: true, lineCounter: undefined });
    for (const error of [...doc.errors, ...doc.warnings]) {
      const line = error.linePos?.[0]?.line ? error.linePos[0].line + lineOffset : undefined;
      diagnostics.push(diagnostic('error', error.code === 'DUPLICATE_KEY' ? 'duplicate-key' : 'invalid-frontmatter', file,
        'YAML 不能安全解析。', '修复 YAML 语法、重复键或不支持的标签。', line));
    }
    if (doc.errors.length || doc.warnings.length) return null;
    const value = doc.toJS({ mapAsMap: true, maxAliasCount: 100 });
    const active = new Set();
    function convert(item) {
      if (item === null || typeof item !== 'object') return item;
      if (active.has(item)) throw new Error('cyclic alias');
      active.add(item);
      let result;
      if (item instanceof Map) {
        result = Object.create(null);
        for (const [key, child] of item) {
          if (typeof key !== 'string') throw new Error('non-string mapping key');
          result[key] = convert(child);
        }
      } else if (Array.isArray(item)) result = item.map(convert);
      else throw new Error('unsupported YAML value');
      active.delete(item);
      return result;
    }
    const result = convert(value);
    if (!isMapping(result)) throw new Error('non-mapping root');
    return result;
  } catch {
    diagnostics.push(diagnostic('error', 'invalid-frontmatter', file, 'YAML 根必须是映射，别名展开必须在限制内。', '使用字符串键映射并减少或移除别名。'));
    return null;
  }
}

export function validateIdentity(name, description, directoryName, file = 'SKILL.md') {
  const diagnostics = [];
  if (typeof name !== 'string') diagnostics.push(diagnostic('error', name === undefined ? 'required-field' : 'field-type', file, 'name 必须是字符串。', '填写 name。'));
  else {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || codePoints(name) > 64)
      diagnostics.push(diagnostic('error', 'invalid-name', file, 'name 必须是 1–64 个 ASCII 小写字母、数字和单个连字符。', '使用合法名称。'));
    if (name !== directoryName) diagnostics.push(diagnostic('error', 'name-directory-mismatch', file, 'name 与目录名不一致。', '使 name 与目录名一致。'));
  }
  if (typeof description !== 'string') diagnostics.push(diagnostic('error', description === undefined ? 'required-field' : 'field-type', file, 'description 必须是字符串。', '填写 description。'));
  else if (!description.trim() || codePoints(description) > 1024)
    diagnostics.push(diagnostic('error', 'invalid-description', file, 'description 必须非空且不超过 1024 个 Unicode 字符。', '填写有效任务描述。'));
  return diagnostics;
}

export function validateFrontmatter(fields, directoryName, diagnostics) {
  const file = 'SKILL.md';
  diagnostics.push(...validateIdentity(fields.name, fields.description, directoryName));
  const fail = (key, message) => diagnostics.push(diagnostic('error', 'field-type', file, `${key}：${message}`, '修正字段类型或内容。'));
  for (const key of ['license', 'compatibility', 'argument-hint']) {
    if (Object.hasOwn(fields, key) && typeof fields[key] !== 'string') fail(key, '必须是字符串。');
  }
  if (typeof fields.compatibility === 'string' && (!fields.compatibility.trim() || codePoints(fields.compatibility) > 500)) fail('compatibility', '必须为 1–500 个 Unicode 字符。');
  if (Object.hasOwn(fields, 'metadata') && (!isMapping(fields.metadata) || Object.values(fields.metadata).some(value => typeof value !== 'string'))) fail('metadata', '必须是字符串键到字符串值的映射。');
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (Object.hasOwn(fields, key) && typeof fields[key] !== 'boolean') fail(key, '必须是布尔值。');
  }
  if (Object.hasOwn(fields, 'allowed-tools') && typeof fields['allowed-tools'] !== 'string') {
    if (Array.isArray(fields['allowed-tools']) && fields['allowed-tools'].every(value => typeof value === 'string'))
      diagnostics.push(diagnostic('warning', 'nonstandard-field-form', file, 'allowed-tools 字符串数组是兼容写法。', '标准创作使用空格分隔的字符串。'));
    else fail('allowed-tools', '必须是字符串，或兼容的字符串数组。');
  }
  if (fields['disable-model-invocation'] === true && fields['user-invocable'] === false)
    diagnostics.push(diagnostic('info', 'invocation-disabled', file, '两个常用调用入口均关闭。', '核对这个包的用途。'));
  const known = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools', 'argument-hint', 'disable-model-invocation', 'user-invocable']);
  for (const key of Object.keys(fields)) if (!known.has(key)) diagnostics.push(diagnostic('info', 'unknown-extension', file, `未评估扩展字段 ${key}。`, '按目标客户端的当前文档核对扩展。'));
}

export function validateCommonMetadata(fields, diagnostics) {
  const file = 'agents/openai.yaml';
  const icons = [];
  const unknown = key => diagnostics.push(diagnostic('info', 'unknown-extension', file, `未评估扩展字段 ${key}。`, '按目标客户端的当前文档核对扩展。'));
  const fail = key => diagnostics.push(diagnostic('error', 'field-type', file, `${key} 的类型不正确。`, '使用规定的映射、字符串或布尔值。'));
  for (const key of Object.keys(fields)) if (!['interface', 'policy'].includes(key)) unknown(key);
  if (Object.hasOwn(fields, 'interface')) {
    if (!isMapping(fields.interface)) fail('interface');
    else {
      const known = new Set(['display_name', 'short_description', 'default_prompt', 'icon_small', 'icon_large', 'brand_color']);
      for (const [key, value] of Object.entries(fields.interface)) {
        if (!known.has(key)) unknown(`interface.${key}`);
        else if (typeof value !== 'string') fail(`interface.${key}`);
        else if (key === 'icon_small' || key === 'icon_large') icons.push(value);
      }
    }
  }
  if (Object.hasOwn(fields, 'policy')) {
    if (!isMapping(fields.policy)) fail('policy');
    else for (const [key, value] of Object.entries(fields.policy)) {
      if (key !== 'allow_implicit_invocation') unknown(`policy.${key}`);
      else if (typeof value !== 'boolean') fail(`policy.${key}`);
    }
  }
  return icons;
}
