import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { observePortableSkill, portableOwnedTreeDigest, publishPortableSkill, removePortableSkill,
  scanPortableSkills, type PortableOwnerIdentity } from '../../src/portable/writer.js';
import { portableJsonDigest } from '../../src/portable/historical-materialization.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

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
    platform: 'cursor', scope: 'project', skill: 'alpha' };
  const configDigest = portableJsonDigest('cursor-config');
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
  // Test Value Gate: a complete real copy must remain usable after the temporary source disappears.
  it('publishes a complete independent copy and preserves executable files', async () => {
    const value = await fixture();
    const digest = await value.install();
    await fs.remove(path.dirname(value.source));
    expect(await value.observe(digest)).toMatchObject({ ownership: 'aw', observation: 'satisfied', contentState: 'current' });
    expect(await fs.readFile(path.join(value.output, 'references', 'guide.md'), 'utf8')).toBe('A complete local guide.\n');
    expect((await fs.lstat(value.output)).isSymbolicLink()).toBe(false);
    if (process.platform !== 'win32') expect((await fs.stat(path.join(value.output, 'scripts', 'run.sh'))).mode & 0o111).toBeTruthy();
    expect(await scanPortableSkills({ destinationRoot: value.destinationRoot, platform: 'cursor', scope: 'project' }))
      .toMatchObject({ complete: true, targets: [{ ownership: 'aw', observation: 'satisfied' }] });
  });

  // Test Value Gate: old content, damaged content, unavailable ownership and another target require distinct actions.
  it('distinguishes stale, damaged, unknown and foreign outputs', async () => {
    const value = await fixture();
    const original = await value.install();
    expect(await value.observe(portableJsonDigest('next-tree'))).toMatchObject({ observation: 'drifted', contentState: 'stale' });
    await fs.appendFile(path.join(value.output, 'README.md'), 'User edit.\n');
    expect(await value.observe(original)).toMatchObject({ ownership: 'aw', observation: 'drifted', contentState: 'damaged' });
    expect(await observePortableSkill({ destinationRoot: value.destinationRoot, skill: 'alpha',
      identity: { ...value.identity, platform: 'pi' } })).toMatchObject({ ownership: 'external', observation: 'conflict' });
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
