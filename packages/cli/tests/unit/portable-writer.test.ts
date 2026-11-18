import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { observePortableSkill, portableOwnedTreeDigest, publishPortableSkill, removePortableSkill,
  scanPortableSkills, type PortableOwnerIdentity } from '../../src/portable/writer.js';
import { portableJsonDigest } from '../../src/portable/historical-materialization.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import { inspectPortableExtraInstalled } from '../../src/portable/recovery.js';

async function fixture() {
  const isolated = getCurrentSourceTestIsolation();
  const root = await fs.mkdtemp(path.join(isolated.layout.fixtureCwd, 'writer-'));
  const source = path.join(root, 'source', 'alpha');
  const destinationRoot = path.join(root, 'agent', 'skills');
  await fs.outputFile(path.join(source, 'SKILL.md'), '---\nname: alpha\ndescription: Test skill\n---\nRead [guide](references/guide.md).\n');
  await fs.outputFile(path.join(source, 'README.md'), 'Use this skill.\n');
  await fs.outputFile(path.join(source, 'references', 'guide.md'), 'A complete local guide.\n');
  await fs.outputFile(path.join(source, 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n');
  await fs.chmod(path.join(source, 'scripts', 'run.sh'), 0o755);
  const identity: PortableOwnerIdentity = { pluginId: 'team/plugin', logicalIdentity: 'catalog-identity',
    platform: 'generic', scope: 'project', skill: 'alpha' };
  const configDigest = portableJsonDigest('generic-config');
  const observe = (expectedDigest?: string) => observePortableSkill({ destinationRoot, skill: 'alpha', identity,
    ...(expectedDigest ? { expectedDigest, configDigest } : {}) });
  const install = async () => {
    const expectedDigest = await portableOwnedTreeDigest(source);
    await publishPortableSkill({ sourceDir: source, destinationRoot, identity, configDigest, expectedDigest,
      observed: await observe(expectedDigest) });
    return expectedDigest;
  };
  return { root, source, destinationRoot, identity, configDigest, observe, install,
    output: path.join(destinationRoot, 'alpha') };
}

describe('AW Portable writer', () => {
  // Test Value Gate: precise queries keep known residual identities while only
  // reading selected content; default scans still inspect every owned package.
  it('skips unrelated Portable content without treating it as healthy or removable', async () => {
    const value = await fixture();
    await value.install();
    const unrelated = path.join(value.destinationRoot, 'beta');
    await fs.copy(value.output, unrelated);
    const markerPath = path.join(unrelated, SKILL_OWNER_MARKER);
    await fs.writeJson(markerPath, { ...await fs.readJson(markerPath), pluginId: 'team/unrelated', skill: 'beta' });
    await fs.appendFile(path.join(unrelated, 'README.md'), 'Unrelated damaged content.\n');
    const inspect = () => scanPortableSkills({ destinationRoot: value.destinationRoot, platform: 'generic', scope: 'project',
      checkContent: (identity) => identity.pluginId === 'team/plugin' });
    const reads = vi.spyOn(fs, 'readFile');
    try {
      const selected = await inspect();
      expect(selected).toMatchObject({ complete: true, targets: [
        { skill: 'alpha', ownership: 'aw', observation: 'satisfied' },
        { skill: 'beta', ownership: 'aw', observation: 'unknown', contentState: 'unknown',
          recoverableIdentity: { pluginId: 'team/unrelated' } },
      ] });
      const beta = selected.targets.find((target) => target.skill === 'beta')!;
      expect(beta.installedDigest).toBeUndefined();
      expect(reads.mock.calls.some(([file]) => String(file) === path.join(value.output, 'README.md'))).toBe(true);
      expect(reads.mock.calls.some(([file]) => String(file).startsWith(`${unrelated}${path.sep}`)
        && String(file) !== markerPath)).toBe(false);
      await expect(removePortableSkill({ destinationRoot: value.destinationRoot, identity: beta.recoverableIdentity!, observed: beta, force: true }))
        .rejects.toThrow('operationReviewStale');
      reads.mockClear();
      const full = await scanPortableSkills({ destinationRoot: value.destinationRoot, platform: 'generic', scope: 'project' });
      expect(full.targets.find((target) => target.skill === 'beta')).toMatchObject({ observation: 'drifted', contentState: 'damaged' });
      expect(reads.mock.calls.some(([file]) => String(file) === path.join(unrelated, 'README.md'))).toBe(true);
      await fs.appendFile(path.join(value.output, 'README.md'), 'Selected damaged content.\n');
      expect((await inspect()).targets.find((target) => target.skill === 'alpha'))
        .toMatchObject({ observation: 'drifted', contentState: 'damaged' });
    } finally { reads.mockRestore(); }
  });

  // Test Value Gate: unknown identity and unsafe marker paths cannot be hidden
  // by an apparently unrelated selection or provide complete request coverage.
  it.each(['unknown-marker', 'marker-link', 'output-link'] as const)('keeps %s Portable coverage incomplete during selection', async (kind) => {
    const value = await fixture();
    await value.install();
    const markerPath = path.join(value.output, SKILL_OWNER_MARKER);
    if (kind === 'unknown-marker') await fs.writeFile(markerPath, '{broken');
    else {
      const foreign = path.join(value.root, 'foreign');
      await fs.copy(value.output, foreign);
      const link = kind === 'marker-link' ? markerPath : value.output;
      await fs.remove(link);
      await fs.symlink(kind === 'marker-link' ? path.join(foreign, SKILL_OWNER_MARKER) : foreign, link,
        kind === 'marker-link' ? 'file' : 'junction');
    }
    const scanned = await scanPortableSkills({ destinationRoot: value.destinationRoot, platform: 'generic', scope: 'project', checkContent: () => false });
    expect(scanned.complete).toBe(false);
    expect(scanned.targets[0]).toMatchObject({ observation: kind === 'unknown-marker' ? 'unknown' : 'conflict' });
  });

  // Test Value Gate: the extra inventory exposes shallow residuals as unknown,
  // and a bare selector for an installed plugin still receives content checks.
  it('projects selected and shallow extra Portable observations without hiding residuals', async () => {
    const value = await fixture();
    await value.install();
    await fs.ensureDir(path.join(value.root, '.git'));
    const destination = path.join(value.root, '.agents', 'skills');
    await fs.move(value.destinationRoot, destination);
    const isolated = getCurrentSourceTestIsolation();
    const context = await createScopeContext({ scope: 'project', cwd: value.root, env: isolated.env, readOnly: true });
    try {
      const options = { scope: 'project' as const, context, env: isolated.env };
      expect(await inspectPortableExtraInstalled({ ...options, plugins: new Set(['other/selected']) })).toMatchObject({ complete: true,
        targets: [{ pluginId: 'team/plugin', observation: 'unknown', content: 'unknown' }] });
      await fs.appendFile(path.join(destination, 'alpha', 'README.md'), 'Damaged selected content.\n');
      expect(await inspectPortableExtraInstalled({ ...options, plugins: new Set(['plugin']) })).toMatchObject({ complete: true,
        targets: [{ pluginId: 'team/plugin', observation: 'unknown', content: 'drifted', contentState: 'damaged' }] });
      expect(await inspectPortableExtraInstalled(options)).toMatchObject({ complete: true,
        targets: [{ pluginId: 'team/plugin', content: 'drifted', contentState: 'damaged' }] });
    } finally { await context.dispose(); }
  });

  // Test Value Gate: a complete real copy must remain usable after the temporary source disappears.
  it('publishes a complete independent copy and preserves executable files', async () => {
    const value = await fixture();
    const digest = await value.install();
    await fs.remove(path.dirname(value.source));
    expect(await value.observe(digest)).toMatchObject({ ownership: 'aw', observation: 'satisfied', contentState: 'current' });
    expect(await fs.readFile(path.join(value.output, 'references', 'guide.md'), 'utf8')).toBe('A complete local guide.\n');
    expect((await fs.lstat(value.output)).isSymbolicLink()).toBe(false);
    if (process.platform !== 'win32') expect((await fs.stat(path.join(value.output, 'scripts', 'run.sh'))).mode & 0o111).toBeTruthy();
    expect(await scanPortableSkills({ destinationRoot: value.destinationRoot, platform: 'generic', scope: 'project' }))
      .toMatchObject({ complete: true, targets: [{ ownership: 'aw', observation: 'satisfied' }] });
  });

  // Test Value Gate: old content, damaged content, unavailable ownership and another source require distinct actions.
  it('distinguishes stale, damaged, unknown and foreign outputs', async () => {
    const value = await fixture();
    const original = await value.install();
    expect(await value.observe(portableJsonDigest('next-tree'))).toMatchObject({ observation: 'drifted', contentState: 'stale' });
    await fs.appendFile(path.join(value.output, 'README.md'), 'User edit.\n');
    expect(await value.observe(original)).toMatchObject({ ownership: 'aw', observation: 'drifted', contentState: 'damaged' });
    expect(await observePortableSkill({ destinationRoot: value.destinationRoot, skill: 'alpha',
      identity: { ...value.identity, pluginId: 'other/plugin' } })).toMatchObject({ ownership: 'external', observation: 'conflict' });
    await fs.writeFile(path.join(value.output, SKILL_OWNER_MARKER), '{broken');
    expect(await value.observe(original)).toMatchObject({ ownership: 'unknown', observation: 'unknown', blocker: 'portableOwnerInvalid' });
  });

  // Test Value Gate: complete candidate validation must precede replacement of a working Skill.
  it('keeps the existing copy when the candidate has a missing resource or symlink', async () => {
    const value = await fixture();
    await value.install();
    const before = await fs.readFile(path.join(value.output, 'SKILL.md'), 'utf8');
    await fs.remove(path.join(value.source, 'references', 'guide.md'));
    await expect(value.install()).rejects.toThrow('missing');
    expect(await fs.readFile(path.join(value.output, 'SKILL.md'), 'utf8')).toBe(before);
    await fs.symlink(path.join(value.output, 'README.md'), path.join(value.source, 'references', 'guide.md'));
    await expect(value.install()).rejects.toThrow();
    expect(await fs.readFile(path.join(value.output, 'SKILL.md'), 'utf8')).toBe(before);
  });

  // Test Value Gate: old third-party locks and matching bytes never authorize adoption or deletion.
  it('preserves markerless copies beside an old third-party lock', async () => {
    const value = await fixture();
    await fs.copy(value.source, value.output);
    await fs.writeJson(path.join(value.root, 'skills-lock.json'), { version: 1,
      skills: { alpha: { source: value.source, sourceType: 'local', computedHash: 'old-provider' } } });
    const observed = await value.observe(await portableOwnedTreeDigest(value.source));
    expect(observed).toMatchObject({ ownership: 'external', observation: 'conflict' });
    await expect(value.install()).rejects.toThrow('portableOutputConflict');
    await expect(removePortableSkill({ destinationRoot: value.destinationRoot, identity: value.identity, observed, force: true }))
      .rejects.toThrow('portableOutputConflict');
    expect(await fs.pathExists(value.output)).toBe(true);
  });

  // Test Value Gate: no writer or force cleanup may follow a link to foreign data.
  it.each(['root', 'output', 'owner', 'nested'] as const)('preserves foreign content at a %s link', async (kind) => {
    const value = await fixture();
    await value.install();
    const foreign = path.join(value.root, 'foreign');
    await fs.copy(value.output, foreign);
    const linkPath = kind === 'root' ? value.destinationRoot : kind === 'output' ? value.output
      : kind === 'owner' ? path.join(value.output, SKILL_OWNER_MARKER) : path.join(value.output, 'references');
    const linkTarget = kind === 'owner' ? path.join(foreign, SKILL_OWNER_MARKER)
      : kind === 'nested' ? path.join(foreign, 'references') : kind === 'root' ? path.dirname(foreign) : foreign;
    await fs.remove(linkPath);
    await fs.symlink(linkTarget, linkPath, kind === 'owner' ? 'file' : 'junction');
    const observed = await value.observe();
    expect(observed.observation).toBe('conflict');
    await expect(value.install()).rejects.toThrow();
    await expect(removePortableSkill({ destinationRoot: value.destinationRoot, identity: value.identity, observed, force: true }))
      .rejects.toThrow();
    expect(await fs.readFile(path.join(foreign, 'README.md'), 'utf8')).toBe('Use this skill.\n');
  });

  // Test Value Gate: force recovers damaged weak metadata only with a complete matching AW identity.
  it('requires force for damaged digest metadata and protects another identity', async () => {
    const value = await fixture();
    await value.install();
    const markerPath = path.join(value.output, SKILL_OWNER_MARKER);
    const marker = await fs.readJson(markerPath);
    delete marker.filesDigest;
    await fs.writeJson(markerPath, marker);
    const observed = await value.observe();
    expect(observed).toMatchObject({ ownership: 'aw', blocker: 'portableOwnerDamaged' });
    await expect(removePortableSkill({ destinationRoot: value.destinationRoot, identity: value.identity, observed }))
      .rejects.toThrow('portableOwnerDamaged');
    await expect(removePortableSkill({ destinationRoot: value.destinationRoot,
      identity: { ...value.identity, pluginId: 'team/foreign' }, observed, force: true })).rejects.toThrow();
    await removePortableSkill({ destinationRoot: value.destinationRoot, identity: value.identity, observed, force: true });
    expect(await fs.pathExists(value.output)).toBe(false);
  });

  // Test Value Gate: a Review snapshot does not authorize a later changed output.
  it('rejects changes after observation before publish or cleanup', async () => {
    const value = await fixture();
    const digest = await value.install();
    const observed = await value.observe(digest);
    await fs.appendFile(path.join(value.output, 'README.md'), 'Changed after Review.\n');
    await expect(publishPortableSkill({ sourceDir: value.source, destinationRoot: value.destinationRoot,
      identity: value.identity, configDigest: value.configDigest, expectedDigest: digest, observed })).rejects.toThrow('operationReviewStale');
    await expect(removePortableSkill({ destinationRoot: value.destinationRoot, identity: value.identity, observed, force: true }))
      .rejects.toThrow('operationReviewStale');
    expect(await fs.readFile(path.join(value.output, 'README.md'), 'utf8')).toContain('Changed after Review.');
  });
});
