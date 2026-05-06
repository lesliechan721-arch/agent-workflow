import path from 'node:path';

import fs from 'fs-extra';

function packageLockfile(): string {
  return [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      yaml:',
    '        specifier: 2.8.3',
    '        version: 2.8.3',
    '    devDependencies:',
    '      fs-extra:',
    '        specifier: 11.3.4',
    '        version: 11.3.4',
    '',
    'packages:',
    '',
    '  fs-extra@11.3.4:',
    '    resolution: {integrity: sha512-CTXd6rk/M3/ULNQj8FBqBWHYBVYybQ3VPBw0xGKFe3tuH7ytT6ACnvzpIQ3UZtB8yvUKC2cXn1a+x+5EVQLovA==}',
    "    engines: {node: '>=14.14'}",
    '',
    '  graceful-fs@4.2.11:',
    '    resolution: {integrity: sha512-RbJ5/jmFcNNCcDV5o9eTnBLJ/HszWV0P73bc+Ff4nS/rJj+YaS6IGyiOL0VoBYX+l1Wrl3k63h/KrH+nhJ0XvQ==}',
    '',
    '  jsonfile@6.2.1:',
    '    resolution: {integrity: sha512-zwOTdL3rFQ/lRdBnntKVOX6k5cKJwEc1HdilT71BWEu7J41gXIB2MRp+vxduPSwZJPWBxEzv4yH1wYLJGUHX4Q==}',
    '',
    '  universalify@2.0.1:',
    '    resolution: {integrity: sha512-gptHNQghINnc/vTGIk0SOFGFNXw7JVrlRUtConJRlvaw6DuX0wO5Jeko9sWrMBhh+PsYAZ7oXAiOnf/UKogyiw==}',
    "    engines: {node: '>= 10.0.0'}",
    '',
    '  yaml@2.8.3:',
    '    resolution: {integrity: sha512-AvbaCLOO2Otw/lW5bmh9d/WEdcDFdQp2Z2ZUH3pX9U2ihyUY0nvLv7J6TrWowklRGPYbB/IuIMfYgxaCPg5Bpg==}',
    "    engines: {node: '>= 14.6'}",
    '    hasBin: true',
    '',
    'snapshots:',
    '',
    '  fs-extra@11.3.4:',
    '    dependencies:',
    '      graceful-fs: 4.2.11',
    '      jsonfile: 6.2.1',
    '      universalify: 2.0.1',
    '',
    '  graceful-fs@4.2.11: {}',
    '',
    '  jsonfile@6.2.1:',
    '    dependencies:',
    '      universalify: 2.0.1',
    '    optionalDependencies:',
    '      graceful-fs: 4.2.11',
    '',
    '  universalify@2.0.1: {}',
    '',
    '  yaml@2.8.3: {}',
    '',
  ].join('\n');
}

export async function writeNodeScriptFixture(repoRootPath: string): Promise<void> {
  const pluginRoot = path.join(repoRootPath, 'plugins', 'git-commit');
  const scriptsRoot = path.join(pluginRoot, 'scripts');
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);

  manifest.marketplace.policy.products = ['CLAUDE'];
  delete manifest.apps;
  manifest.scripts = {
    lifecycle: {
      install: {
        default: {
          runner: 'node',
          path: './scripts/runtime.mjs',
        },
      },
    },
    node: {
      packageRoot: './scripts',
      build: {
        runner: 'node',
        path: './scripts/build.mjs',
      },
    },
    tests: {
      node: ['./scripts/source-only.test.mjs'],
    },
  };

  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(path.join(pluginRoot, '.app.json'));
  await fs.ensureDir(scriptsRoot);
  await fs.writeJson(
    path.join(scriptsRoot, 'package.json'),
    {
      name: 'git-commit-smoke-scripts',
      version: '0.1.0',
      type: 'module',
      dependencies: {
        yaml: '2.8.3',
      },
      devDependencies: {
        'fs-extra': '11.3.4',
      },
    },
    { spaces: 2 },
  );
  await fs.writeFile(path.join(scriptsRoot, 'pnpm-lock.yaml'), packageLockfile(), 'utf8');
  await fs.writeFile(
    path.join(scriptsRoot, 'runtime-helper.mjs'),
    'export const runtimeSuffix = "runtime-helper";\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(scriptsRoot, 'runtime.mjs'),
    [
      'import YAML from "yaml";',
      'import { runtimeSuffix } from "./runtime-helper.mjs";',
      '',
      'export function parseSmokeConfig(source) {',
      '  const parsed = YAML.parse(source);',
      '  return `${parsed.name}:${runtimeSuffix}`;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(scriptsRoot, 'source-only.test.mjs'),
    'throw new Error("source test glob should have been replaced by the manifest build");\n',
    'utf8',
  );

  const generatedTestSource = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { readFile } from "node:fs/promises";',
    'import fsExtra from "fs-extra";',
    'import { parseSmokeConfig } from "./runtime.mjs";',
    '',
    'test("staged smoke generated test", async () => {',
    '  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
    '  assert.equal(context.plugin.name, "git-commit");',
    '  assert.equal(context.platform, "codex");',
    '  assert.equal(context.plugin.version, "0.1.0");',
    '  assert.equal(process.cwd(), context.cwd);',
    '  assert.notEqual(context.plugin.rootDir, context.sourceRoot);',
    '  assert.equal(parseSmokeConfig("name: smoke\\n"), "smoke:runtime-helper");',
    '  assert.equal(await fsExtra.pathExists(process.env.AW_PLUGIN_CONTEXT), true);',
    '});',
    '',
  ].join('\n');

  await fs.writeFile(
    path.join(scriptsRoot, 'build.mjs'),
    [
      'import fsExtra from "fs-extra";',
      'import { readFile, writeFile } from "node:fs/promises";',
      '',
      'const manifestUrl = new URL("../.agents-plugin/plugin.json", import.meta.url);',
      'const generatedTestUrl = new URL("./generated.test.mjs", import.meta.url);',
      'const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));',
      '',
      'if (typeof fsExtra.pathExists !== "function") {',
      '  throw new Error("dev dependency was not available to the manifest build");',
      '}',
      '',
      `await writeFile(generatedTestUrl, ${JSON.stringify(generatedTestSource)}, "utf8");`,
      'manifest.description = "Built smoke description";',
      'manifest.marketplace.policy.products = ["CODEX"];',
      'manifest.scripts.tests.node = ["./scripts/generated.test.mjs"];',
      'await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\\n`, "utf8");',
      '',
    ].join('\n'),
    'utf8',
  );
}
