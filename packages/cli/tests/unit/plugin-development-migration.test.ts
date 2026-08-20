import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { verifyPluginDevelopmentMigration } from '../../../../scripts/migration/verify-plugin-development-migration.mjs';

const roots: string[] = [];
const contractSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/plugin-development-migration.json',
);
const legacyRouteLinks = [
  '[create-aw-plugin](.agents/skills/create-aw-plugin/SKILL.md)',
  '[skill-review](.agents/skills/skill-review/SKILL.md)',
];
const replacementRouteLink = '[author-aw-plugin](plugins/aw-plugin-development/skills/author-aw-plugin/SKILL.md)';
const hiddenRouteCases: Array<[string, (route: string) => string]> = [
  ['a multiline HTML comment', (route) => `<!--\n${route}\n-->`],
  ['an unclosed HTML comment', (route) => `<!--\n${route}`],
  ['a backtick fence', (route) => `\`\`\`markdown\n${route}\n\`\`\``],
  ['a tilde fence', (route) => `~~~markdown\n${route}\n~~~`],
  ['a blockquote fence', (route) => `> > \`\`\`markdown\n> > ${route}\n> > \`\`\``],
  ['an HTML pre block', (route) => `<PRE class="example">\n${route}\n</PRE>`],
  ['an HTML code block', (route) => `<code>\n${route}\n</code>`],
  ['indented code', (route) => `    ${route}`],
  ['inline code', (route) => `\`${route}\``],
  ['multiline inline code', (route) => `\`hidden\n${route}\ncontent\``],
];

async function writeFile(root: string, relative: string, content = 'fixture\n'): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
}

async function writeFixture(mutate?: (contract: Record<string, any>) => void): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-migration-'));
  roots.push(root);
  const contract = JSON.parse(await fs.readFile(contractSource, 'utf8'));
  mutate?.(contract);
  await writeFile(root, 'docs/plugin-development-migration.json', `${JSON.stringify(contract, null, 2)}\n`);

  const files = new Set<string>([
    ...contract.legacyEntrypoints,
    ...contract.replacementEntrypoints,
    ...contract.capabilityMatrix.map((entry: { owner: string }) => entry.owner).filter(Boolean),
  ]);
  for (const gate of contract.cutoverGates) {
    for (const item of gate.implementationEvidence ?? []) {
      for (const relative of item.paths) files.add(relative);
    }
    for (const requirement of gate.requiredSuites ?? []) files.add(requirement.manifest);
  }
  for (const relative of files) await writeFile(root, relative);

  const routes = contract.legacyRoutes.map((route: { contains: string }) => route.contains).join('\n');
  await writeFile(root, 'AGENTS.md', `${routes}\n`);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('plugin development migration gate', () => {
  it('accepts only the canonical parallel migration and never claims cutover readiness', async () => {
    const result = await verifyPluginDevelopmentMigration({ root: await writeFixture() });

    expect(result).toMatchObject({
      ok: true,
      status: 'parallel',
      cutoverReady: false,
      capabilityCounts: { migrated: 9, legacyRetained: 3 },
      gateCount: 7,
      errors: [],
    });
  });

  it.each(['ready-for-cutover', 'retired'])('fails closed for self-reported %s status', async (status) => {
    const result = await verifyPluginDevelopmentMigration({
      root: await writeFixture((contract) => {
        contract.status = status;
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.cutoverReady).toBe(false);
    expect(result.errors).toContain('cutover verification unavailable; status must remain parallel');
  });

  it('rejects retired state that deletes legacy routes and entrypoints', async () => {
    const result = await verifyPluginDevelopmentMigration({
      root: await writeFixture((contract) => {
        contract.status = 'retired';
        contract.legacyRoutes = [];
        contract.legacyEntrypoints = [];
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('legacyRoutes must exactly match the canonical migration contract');
    expect(result.errors).toContain('legacyEntrypoints must exactly match the canonical migration contract');
  });

  it.each([
    ['deleted capability', (contract: Record<string, any>) => contract.capabilityMatrix.pop(), 'capabilityMatrix'],
    ['redirected capability', (contract: Record<string, any>) => { contract.capabilityMatrix[0].owner = 'README.md'; }, 'capabilityMatrix'],
    ['extra capability', (contract: Record<string, any>) => { contract.capabilityMatrix.push({ id: 'extra', disposition: 'migrated', owner: 'README.md' }); }, 'capabilityMatrix'],
    ['changed gate suite target', (contract: Record<string, any>) => { contract.cutoverGates[2].requiredSuites[0].suite = 'trigger'; }, 'cutoverGates'],
    ['changed implementation evidence', (contract: Record<string, any>) => { contract.cutoverGates[0].implementationEvidence[0].paths = []; }, 'cutoverGates'],
    ['non-null model evidence', (contract: Record<string, any>) => { contract.cutoverGates[2].modelEvidence[0].evidencePath = 'fake.json'; }, 'cutoverGates'],
  ])('rejects a parallel contract with %s', async (_name, mutate, section) => {
    const result = await verifyPluginDevelopmentMigration({ root: await writeFixture(mutate) });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`${section} must exactly match the canonical migration contract`);
  });

  it('rejects a missing legacy route and a missing replacement entrypoint', async () => {
    const root = await writeFixture();
    // Static contract exception: removing the public repository route makes the retained workflow unreachable; behavior test is not suitable because AGENTS.md is the routing contract consumed by the agent host.
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'no legacy routes\n');
    await fs.rm(path.join(root, 'plugins/aw-plugin-development/skills/author-aw-plugin/SKILL.md'));

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('legacy route must be present: AGENTS.md');
    expect(result.errors).toContain('replacement entrypoint is missing or unsafe: plugins/aw-plugin-development/skills/author-aw-plugin/SKILL.md');
  });

  it.each(hiddenRouteCases)('rejects a legacy route hidden in %s', async (_name, hideRoute) => {
    const root = await writeFixture();
    // Static contract exception: a hidden public repository route makes the retained workflow unreachable; behavior test is not suitable because AGENTS.md is the routing contract consumed by the agent host.
    await fs.writeFile(
      path.join(root, 'AGENTS.md'),
      `${legacyRouteLinks[0]}\n${hideRoute(legacyRouteLinks[1])}\n`,
    );

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('legacy route must be present: AGENTS.md');
  });

  it.each(hiddenRouteCases)('does not activate a replacement route hidden in %s', async (_name, hideRoute) => {
    const root = await writeFixture();
    // Static contract exception: a hidden future route must not block the parallel migration; behavior test is not suitable because AGENTS.md is the routing contract consumed by the agent host.
    await fs.appendFile(path.join(root, 'AGENTS.md'), `${hideRoute(replacementRouteLink)}\n`);

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(true);
  });

  it('rejects a replacement route that claims to be active during parallel migration', async () => {
    const root = await writeFixture();
    // Static contract exception: activating the future public route early can silently replace the retained workflow; behavior test is not suitable because AGENTS.md is the routing contract consumed by the agent host.
    await fs.appendFile(
      path.join(root, 'AGENTS.md'),
      `${replacementRouteLink}\n`,
    );

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('replacement route must not be active while status is parallel: AGENTS.md');
  });

  it('rejects an external final entrypoint symlink without disclosing its referent', async () => {
    const root = await writeFixture();
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-migration-external-'));
    roots.push(external);
    const relative = 'plugins/aw-plugin-development/skills/author-aw-plugin/SKILL.md';
    const target = path.join(root, relative);
    const externalFile = path.join(external, 'secret');
    await fs.writeFile(externalFile, 'secret\n');
    await fs.rm(target);
    await fs.symlink(externalFile, target);

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`replacement entrypoint is missing or unsafe: ${relative}`);
    expect(result.errors.join('\n')).not.toContain(externalFile);
  });

  it('rejects an external parent symlink without disclosing its referent', async () => {
    const root = await writeFixture();
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-migration-parent-'));
    roots.push(external);
    const parent = path.join(root, '.agents/skills/create-aw-plugin/scripts');
    await fs.rm(parent, { recursive: true });
    await fs.symlink(external, parent);

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('legacy entrypoint is missing or unsafe: .agents/skills/create-aw-plugin/scripts/add_skill.mjs');
    expect(result.errors.join('\n')).not.toContain(external);
  });
});
