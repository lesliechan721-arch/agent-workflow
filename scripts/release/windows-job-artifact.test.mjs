import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = async (name) => parse(await fs.readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const stepsFor = (job, action) => job.steps.filter((step) => step.uses?.startsWith(`actions/${action}@`)).map((step) => step.with);

// Test Value Gate: the published candidate must contain exactly the original
// native artifacts and the two reports, not the qualification-only JS runtime.
// Model download selection and extraction against the actual workflow's artifact plan.
test('the release workflow receives the candidate and both qualification reports without auxiliary runtime files', async () => {
  const { jobs } = await workflow('windows-job');
  const candidateFiles = ['manifest.json', 'candidate.json', 'reproducibility.json',
    'x64/aw-windows-job.exe', 'arm64/aw-windows-job.exe',
    'lesliechan721-aw-windows-job-win32-x64-1.2.3.tgz', 'lesliechan721-aw-windows-job-win32-arm64-1.2.3.tgz'];
  const runtimeFiles = ['packages/agent-skill-eval/dist/index.js', 'packages/cli/plugins-dist/plugins/agent-subagent/commands/index.mjs'];
  const artifacts = new Map();
  for (const upload of stepsFor(jobs.candidate, 'upload-artifact')) {
    artifacts.set(upload.name, upload.path.startsWith('${{ runner.temp }}/') ? runtimeFiles : candidateFiles);
  }
  for (const { arch } of jobs.qualification.strategy.matrix.include) {
    for (const upload of stepsFor(jobs.qualification, 'upload-artifact')) {
      const expand = (value) => value.replaceAll('${{ matrix.arch }}', arch);
      artifacts.set(expand(upload.name), [path.posix.basename(expand(upload.path))]);
    }
  }
  const downloadedFiles = [];
  for (const download of stepsFor(jobs.qualified, 'download-artifact')) {
    const selected = [...artifacts].filter(([name]) => download.name ? name === download.name : path.posix.matchesGlob(name, download.pattern));
    assert.ok(selected.length, `No artifacts selected by ${download.name ?? download.pattern}`);
    for (const [name, files] of selected) {
      const destination = download.name || download['merge-multiple'] ? download.path : path.posix.join(download.path, name);
      downloadedFiles.push(...files.map((file) => path.posix.join(destination, file)));
    }
  }
  const [qualified] = stepsFor(jobs.qualified, 'upload-artifact');
  const qualifiedRoot = path.posix.normalize(qualified.path).replace(/\/$/u, '');
  artifacts.set(qualified.name, downloadedFiles.filter((file) => file.startsWith(`${qualifiedRoot}/`)).map((file) => path.posix.relative(qualifiedRoot, file)));
  const release = await workflow('release-candidate');
  const download = stepsFor(release.jobs.prepare, 'download-artifact').find((step) => step.name === qualified.name);
  assert.ok(download, 'Release must consume the qualified artifact');
  const expected = [...candidateFiles, 'qualification-x64.json', 'qualification-arm64.json'];
  assert.deepEqual(artifacts.get(download.name).sort(), expected.sort());
});
