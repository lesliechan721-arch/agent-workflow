import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';
import { isAuthorOnlySkillCollection, normalizeStaticPluginComponents, validateSourcePluginManifest, COMPONENT_KINDS, type PlatformCapabilitiesV1 } from '../../src/manifest.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });
const raw = { schemaVersion: 4, name: 'example', version: '1.0.0', description: 'Example', marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } } };
const profile: PlatformCapabilitiesV1 = { schemaVersion: 1, platform: 'codex', scope: 'user', basis: 'profile', profileId: 'test', consumers: [], kinds: Object.fromEntries(COMPONENT_KINDS.map((kind) => [kind, { status: 'supported', reasonCodes: [], delivery: ['native-package'] }])) as PlatformCapabilitiesV1['kinds'], features: {} };
async function root(): Promise<string> { const value = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-author-only-')); roots.push(value); return value; }
it('accepts Eval-only Skill source trees without declaring or publishing static components', async () => {
  const directory = await root();
  await fs.outputJson(path.join(directory, 'skills/dynamic/evals/manifest.json'), { schemaVersion: 1 });
  expect(await isAuthorOnlySkillCollection(path.join(directory, 'skills'))).toBe(true);
  const manifest = await validateSourcePluginManifest(directory, raw);
  expect((await normalizeStaticPluginComponents({ pluginRoot: directory, manifest, platform: 'codex', capabilities: profile })).components).toEqual([]);
  await fs.outputFile(path.join(directory, 'skills/static/SKILL.md'), '---\nname: static\ndescription: Check.\n---\nCheck.\n');
  expect(await isAuthorOnlySkillCollection(path.join(directory, 'skills'))).toBe(false);
  await expect(validateSourcePluginManifest(directory, raw)).rejects.toThrow(/missing "skills" declaration/u);
  const mixed = await validateSourcePluginManifest(directory, { ...raw, skills: './skills' });
  const components = await normalizeStaticPluginComponents({ pluginRoot: directory, manifest: mixed, platform: 'codex', capabilities: profile });
  expect(components.components.map((entry) => entry.id)).toEqual(['skill:static']);
  await fs.outputFile(path.join(directory, 'skills/dynamic/runtime.mjs'), 'export {};');
  await expect(normalizeStaticPluginComponents({ pluginRoot: directory, manifest: mixed, platform: 'codex', capabilities: profile })).rejects.toThrow(/missing file.*SKILL\.md/u);
});
it('preserves executable UTF-8 source semantics without granting inline renderer chmod authority', async () => {
  const directory = await root();
  await fs.outputFile(path.join(directory, 'skills/check/SKILL.md'), '---\nname: check\ndescription: Check.\n---\nCheck.\n');
  const script = '#!/bin/sh\nprintf ok\n';
  await fs.outputFile(path.join(directory, 'skills/check/scripts/execute.sh'), script, { mode: 0o755 });
  await fs.outputFile(path.join(directory, 'skills/check/scripts/read.sh'), script, { mode: 0o644 });
  const manifest = await validateSourcePluginManifest(directory, { ...raw, skills: './skills' });
  const result = await normalizeStaticPluginComponents({ pluginRoot: directory, manifest, platform: 'codex', capabilities: profile });
  const component = result.components[0]!;
  expect(component.kind).toBe('skill');
  if (component.kind !== 'skill') throw new Error('Expected Skill.');
  expect(component.content.files['scripts/execute.sh']).toEqual({ source: { kind: 'bundle', path: 'skills/check/scripts/execute.sh' } });
  expect(component.content.files['scripts/read.sh']).toEqual({ text: script });
});
it('does not treat symlinks or loose root runtime files as author-only evaluation input', async () => {
  const directory = await root();
  await fs.outputJson(path.join(directory, 'skills/dynamic/evals/manifest.json'), {});
  await fs.symlink('/tmp', path.join(directory, 'skills/dynamic/evals/escape'));
  expect(await isAuthorOnlySkillCollection(path.join(directory, 'skills'))).toBe(false);
  await expect(validateSourcePluginManifest(directory, raw)).rejects.toThrow(/symbolic links/u);
});

it('accepts declared dynamic Skill source directories without publishing them as static Skills', async () => {
  const directory = await root();
  await fs.outputFile(path.join(directory, 'scripts/render.mjs'), 'console.log(JSON.stringify({ version: 3, components: [], omitted: [], unmet: [] }));');
  for (const name of ['first', 'second']) await fs.outputFile(path.join(directory, `skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: Check.\n---\nCheck.\n`);
  await fs.outputJson(path.join(directory, 'skills/eval-only/evals/manifest.json'), {});
  const declaration = { ...raw, scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } }, artifacts: { configKeys: [], sourceDirs: ['./skills/first', './skills/second'] } };
  const manifest = await validateSourcePluginManifest(directory, declaration);
  expect(manifest.skills).toBeUndefined();
  expect((await normalizeStaticPluginComponents({ pluginRoot: directory, manifest, platform: 'codex', capabilities: profile })).components).toEqual([]);
  await fs.outputFile(path.join(directory, 'skills/first-extra/SKILL.md'), 'Uncovered sibling.');
  await expect(validateSourcePluginManifest(directory, declaration)).rejects.toThrow(/missing "skills" declaration/u);
  await fs.remove(path.join(directory, 'skills/first-extra'));
  await fs.outputFile(path.join(directory, 'skills/second/scripts/helper.mjs'), 'export {};');
  await expect(validateSourcePluginManifest(directory, { ...declaration, artifacts: { configKeys: [], sourceDirs: ['./skills/first', './skills/second/scripts'] } })).rejects.toThrow(/missing "skills" declaration/u);
  await expect(validateSourcePluginManifest(directory, { ...declaration, artifacts: { configKeys: [], sourceDirs: ['../escape'] } })).rejects.toThrow();
  await fs.symlink('/tmp', path.join(directory, 'skills/first/escape'));
  await expect(validateSourcePluginManifest(directory, declaration)).rejects.toThrow(/symbolic links/u);
});
