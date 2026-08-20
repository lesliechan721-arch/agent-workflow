# AW 脚本打包与测试

只在插件包含 Node runtime dependency、build 入口或 `scripts.tests.node` 时读取。

## Node 依赖与打包

没有声明 `scripts.node.packageRoot` 时，Node lifecycle/helper/test 只能使用 `node:`
内置模块和插件内相对 import。相对 import 不能逃出插件根。

需要第三方依赖时：

- 在 manifest 声明 `scripts.node.packageRoot`。
- 在该目录提交 `package.json` 和 `pnpm-lock.yaml`。
- runtime 依赖必须写在 `dependencies`，不能依赖仓库根 `node_modules`。
- 只允许 registry-backed dependency specifier；不支持
  `workspace:`、`file:`、`link:`、`portal:`、git/GitHub shortcut、HTTP(S) URL 或 tarball URL。
- 发布 bundle 只带 runtime 入口、可静态识别的相对依赖闭包、packageRoot
  production 依赖；测试文件不会进入 runtime bundle。

`scripts.node.build` 是唯一支持的 manifest build 入口，运行在隔离 staging 目录。`package.json`
scripts、`preinstall`、`postinstall`、`prepare` 等 npm lifecycle 不会被 AW 自动执行。

## 插件脚本测试

```bash
pnpm plugin:test <plugin>
pnpm plugin:test <plugin> --platform codex --scope project
pnpm plugin:test <dual-platform-plugin> --platform both --scope project
pnpm plugin:test <plugin> --test-name "reads config"
pnpm plugin:test --all
```

`pnpm plugin:test` 会先编译 CLI，再用 staging 模式准备 source，并从 build 后 staging
manifest 解析最终支持平台。省略 `--platform` 时按 `both` 处理；`--platform auto` 无效并会失败；显式
`claude` 或 `codex` 遇到任一选中插件不支持该平台时，会在测试执行前失败；`both`
按每个插件最终支持平台集合展开，单平台插件只跑自己支持的平台，双平台插件分别跑 Codex 和 Claude 两轮。

校验通过后，runner 会准备临时 bundle、隔离 `AW_HOME` 和受管临时 project root，然后执行
`scripts.tests.node` 匹配到的 Node 测试。无匹配测试时是 skipped/no-op，退出码为 0。

测试进程的 `process.cwd()`、`AW_PLUGIN_CONTEXT.cwd` 和 helper
fallback 看到的是同一个隔离项目根，不是源码仓库。测试中需要读源码 fixture 时用
`AW_PLUGIN_CONTEXT.sourceRoot`；运行 helper/lifecycle 时应从临时 bundle 里的相对路径 import 或执行，不要从
`sourceRoot` 直接 import runtime 文件。

示例：

```js
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);

test('config helper reads AW_PLUGIN_CONTEXT', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'plugin-config-'));
  const contextPath = join(tempDir, 'context.json');
  await writeFile(
    contextPath,
    JSON.stringify({
      plugin: { name: 'example-plugin' },
      config: {
        values: { apiKey: 'test-key', mode: 'strict' },
        sources: { apiKey: 'user', mode: 'projectShared' },
        schema: {
          apiKey: { type: 'string', sensitive: true, required: true },
          mode: { type: 'enum', values: ['standard', 'strict'], default: 'standard' },
        },
      },
      paths: { configStores: {} },
    }),
    'utf8',
  );

  const helperPath = join(dirname(fileURLToPath(import.meta.url)), 'aw-config.mjs');
  const { stdout } = await execFileAsync(process.execPath, [helperPath, 'get', 'mode'], {
    cwd: tempDir,
    env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath },
  });

  assert.equal(stdout.trim(), 'strict');
});
```

## 示例插件

完整组合示例见 `references/.examples/code-review/`：

- `.agents-plugin/plugin.json` 同时声明
  `config.schema`、`scripts.helpers.config`、`scripts.lifecycle` 和 `scripts.tests.node`。
- `scripts/aw-config.mjs` 展示标准 helper。
- `scripts/lifecycle.mjs` 展示如何读取 context、effective config 和 AW home。
- `scripts/lifecycle.test.mjs` 展示 helper 与 lifecycle 的 Node 测试写法。
