#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const localRoot = path.dirname(fileURLToPath(import.meta.url));
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = context?.sourceRoot ?? path.resolve(localRoot, '..');
const root = context
  ? path.join(context.plugin.rootDir, context.platform, 'skills/review-aw-plugin/scripts')
  : localRoot;
const releaseCheck = path.join(root, 'check-aw-plugin-release.mjs');
const temp = await mkdtemp(path.join(os.tmpdir(), 'aw-light-review-'));

try {
  const plugin = path.join(temp, 'plugins', 'demo-plugin');
  const source = path.join(plugin, 'skills', 'demo');
  const finalRoot = path.join(temp, 'final');
  const final = path.join(finalRoot, 'demo');
  await mkdir(source, { recursive: true });
  await mkdir(path.join(source, 'agents'), { recursive: true });
  await mkdir(path.join(final, 'references'), { recursive: true });
  await mkdir(path.join(final, 'agents'), { recursive: true });
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(path.join(plugin, 'scripts'), { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'demo-plugin',
    version: '1.0.0',
    description: 'Demo',
    compatibility: { aw: { minVersion: '0.1.0' } },
    skills: './skills',
    scripts: { node: { build: { runner: 'node', path: './scripts/build.mjs', args: [] } } },
    buildConfig: {
      skillRuntimeFiles: [{
        skill: 'demo', target: 'references/generated.md',
        import: { plugin: 'fixture-provider', export: 'generated-guide' },
      }],
    },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
    },
  }));
  await writeFile(path.join(plugin, 'scripts', 'build.mjs'), '');
  const provider = path.join(temp, 'plugins', 'fixture-provider');
  await mkdir(path.join(provider, '.agents-plugin'), { recursive: true });
  await writeFile(path.join(provider, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'fixture-provider',
    version: '1.0.0',
    description: 'Fixture provider.',
    compatibility: { aw: { minVersion: '0.1.0' } },
    extensions: { instructions: [{ name: 'provider', title: 'Provider', content: 'Provider.' }] },
    buildConfig: { runtimeExports: [{ name: 'generated-guide', source: './generated.md' }] },
    marketplace: {
      category: 'workflow', strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
    },
  }));
  await writeFile(path.join(provider, 'generated.md'), '# Generated\n\nReturn the supplied value.\n');
  await writeFile(path.join(provider, 'README.md'), '# Fixture Provider\n');
  await writeFile(path.join(temp, 'plugins', 'marketplace-source.json'), JSON.stringify({
    owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
    interface: { displayName: 'Fixture Workspace' },
    catalog: { version: '1.0.0' },
  }));
  const skill = '---\nname: demo\ndescription: Perform the demo task.\n---\n\n# Demo\n\nRead [the generated guide](references/generated.md).\n';
  await writeFile(path.join(source, 'SKILL.md'), skill);
  await writeFile(path.join(source, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
  await writeFile(path.join(final, 'SKILL.md'), skill);
  await writeFile(path.join(source, 'README.md'), '# Demo Skill\n');
  await writeFile(path.join(final, 'README.md'), '# Demo Skill\n');
  await writeFile(path.join(plugin, 'README.md'), '# Demo Plugin\n');
  await writeFile(path.join(final, 'references', 'generated.md'), '# Generated\n\nReturn the supplied value.\n');
  await writeFile(path.join(final, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');

  const sharedScripts = context
    ? root
    : path.resolve(root, '..', '..', 'agent-skill-toolkit', 'scripts');
  const checker = path.join(sharedScripts, 'check-agent-skill.mjs');
  const skillValidatorBin = path.resolve(sourceRoot, '..', '..', 'packages', 'cli', 'dist', 'index.js');
  const publicBin = path.join(temp, 'public-bin');
  const publicAw = path.join(publicBin, 'aw');
  await mkdir(publicBin, { recursive: true });
  await writeFile(publicAw, `#!/bin/sh\nexec "${process.execPath}" "${skillValidatorBin}" "$@"\n`);
  await chmod(publicAw, 0o755);
  const { stdout: checkStdout } = await execFileAsync(process.execPath, [checker, final, '--root-kind', 'materialized', '--profile', 'codex-project', '--format', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${publicBin}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  const check = JSON.parse(checkStdout);
  const review = path.join(temp, 'review.json');
  await writeFile(review, JSON.stringify({
    schemaVersion: 1,
    target: { name: 'demo', digest: check.target.digest },
    mode: 'full',
    design: 'pass',
    complexity: 'proportionate',
    findings: [],
    unknowns: [],
    dimensions: [
      'specification', 'problem_value', 'triggering', 'scope_composition',
      'instruction_design', 'minimum_control', 'context_disclosure', 'architecture',
      'scripts', 'evals', 'reliability', 'maintainability'
    ].map((id) => ({ id, score: 4, confidence: 'medium', basis: `${id} is supported by the fixture.` }))
  }));

  const env = {
    ...process.env,
    PATH: `${publicBin}${path.delimiter}${process.env.PATH ?? ''}`,
  };

  const help = await execFileAsync(process.execPath, [releaseCheck, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /--workspace-root <dir>/u);

  const run = await execFileAsync(process.execPath, [
    releaseCheck,
    plugin,
    '--workspace-root', temp,
    '--review', review,
    '--profile', 'codex-project',
    '--final', `codex-project=${finalRoot}`,
    '--format', 'json'
  ], { encoding: 'utf8', env, cwd: os.tmpdir() });
  assert.equal(JSON.parse(run.stdout).ready, true);

  const executableOverrideSentinel = path.join(temp, 'executable-override-ran');
  const executableOverride = path.join(temp, 'executable-override.mjs');
  await writeFile(executableOverride, `
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(executableOverrideSentinel)}, 'executed');
process.stdout.write('{}');
`);
  const overrideRun = await execFileAsync(process.execPath, [
    releaseCheck,
    plugin,
    '--workspace-root', temp,
    '--review', review,
    '--profile', 'codex-project',
    '--final', `codex-project=${finalRoot}`,
    '--format', 'json',
  ], {
    encoding: 'utf8',
    cwd: os.tmpdir(),
    env: {
      ...env,
      AW_PLUGIN_VALIDATOR_BIN: executableOverride,
      AW_SKILL_VALIDATOR_BIN: executableOverride,
      AW_SKILL_CHECK_BIN: executableOverride,
      AW_REVIEW_LITE_VALIDATOR: executableOverride,
      AW_EVAL_AUDIT_VALIDATOR: executableOverride,
      AW_EVAL_BUNDLE_VALIDATOR: executableOverride,
    },
  });
  assert.equal(JSON.parse(overrideRun.stdout).ready, true);
  await assert.rejects(readFile(executableOverrideSentinel), /ENOENT/u);

  let blocked;
  try {
    await execFileAsync(process.execPath, [
      releaseCheck,
      plugin,
      '--workspace-root', temp,
      '--review', review,
      '--profile', 'codex-project',
      '--format', 'json'
    ], { encoding: 'utf8', env });
  } catch (error) {
    blocked = JSON.parse(error.stdout);
  }
  assert.equal(blocked.ready, false);
  assert.ok(blocked.reasons.some((reason) => reason.includes('is missing')));

  const outsideSkills = path.join(temp, 'outside-skills');
  await mkdir(outsideSkills, { recursive: true });
  await writeFile(path.join(outsideSkills, 'SKILL.md'), 'private-review-sentinel\n');
  await rm(path.join(plugin, 'skills'), { recursive: true, force: true });
  await symlink(outsideSkills, path.join(plugin, 'skills'));

  const isolatedChecker = path.join(temp, 'reviewer', 'scripts', 'check-aw-plugin-release.mjs');
  const privateCli = path.join(temp, 'packages', 'cli', 'dist', 'index.js');
  const privateCliSentinel = path.join(temp, 'private-cli-ran');
  await mkdir(path.dirname(isolatedChecker), { recursive: true });
  await mkdir(path.dirname(privateCli), { recursive: true });
  await copyFile(releaseCheck, isolatedChecker);
  await copyFile(
    path.join(path.dirname(releaseCheck), 'review-skill-leaf-plan.mjs'),
    path.join(path.dirname(isolatedChecker), 'review-skill-leaf-plan.mjs'),
  );
  await writeFile(privateCli, `
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(privateCliSentinel)}, 'executed');
process.stdout.write(JSON.stringify({ ok: true, errors: [] }));
`);
  await writeFile(publicAw, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":false,"errors":["PATH aw rejected fixture"]}\'\n');
  await chmod(publicAw, 0o755);
  let publicValidationFailure;
  try {
    await execFileAsync(process.execPath, [
      isolatedChecker,
      plugin,
      '--workspace-root', temp,
      '--review', review,
      '--profile', 'codex-project',
      '--final', `codex-project=${finalRoot}`,
      '--format', 'json',
    ], {
      encoding: 'utf8',
      env: {
        ...env,
      },
    });
  } catch (error) {
    publicValidationFailure = JSON.parse(error.stdout);
  }
  assert.equal(publicValidationFailure.ready, false);
  assert.ok(publicValidationFailure.reasons.some((reason) => reason.includes('PATH aw rejected fixture')));
  assert.equal(publicValidationFailure.targets.length, 0);
  assert.doesNotMatch(JSON.stringify(publicValidationFailure), /private-review-sentinel/u);
  await assert.rejects(readFile(privateCliSentinel), /ENOENT/u);
  process.stdout.write('AW lightweight review contracts passed\n');
} finally {
  await rm(temp, { recursive: true, force: true });
}
