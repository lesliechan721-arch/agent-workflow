# AW Scripts / Config / Lifecycle 作者指南

本文说明插件作者如何开发 AW 自管配置、标准配置 helper、安装生命周期脚本和插件脚本测试。字段级 schema 仍以 `references/plugin-manifest-spec.md` 为准；这里关注“怎么写、怎么运行、怎么排障”。

适用场景：

- 插件需要跨 Claude Code 和 Codex 共享配置，例如 API Key、模式开关、工作目录或文件路径。
- 插件安装、升级、卸载时需要创建或清理 AW 受管状态。
- 插件需要根据 AW config 动态生成 Codex developer instructions 或 agent role。
- Claude 命令结果填充、lifecycle 或测试脚本需要读取同一份 AW config。
- 插件包含 Node runtime helper、lifecycle 或测试，需要用 `pnpm plugin:test` 验证。

## 推荐目录

```text
plugins/<name>/
├── .agents-plugin/
│   └── plugin.json
└── scripts/
    ├── aw-config.mjs          # 标准配置 helper，建议从 assets/aw-config.mjs 复制
    ├── lifecycle.mjs          # install / upgrade / uninstall 入口
    └── lifecycle.test.mjs     # Node 测试入口，pnpm plugin:test 执行
```

`scripts.helpers.config`、`scripts.lifecycle`、`scripts.tests.node` 都必须在 manifest 中显式声明。CLI 不会因为文件名叫 `aw-config.mjs` 或 `lifecycle.mjs` 就自动扫描。

```json
{
  "scripts": {
    "timeoutMs": 30000,
    "lifecycle": {
      "install": "./scripts/lifecycle.mjs",
      "upgrade": "./scripts/lifecycle.mjs",
      "uninstall": "./scripts/lifecycle.mjs"
    },
    "helpers": {
      "config": "./scripts/aw-config.mjs"
    },
    "tests": {
      "node": ["./scripts/**/*.test.mjs"]
    }
  },
  "config": {
    "schema": {
      "apiKey": {
        "type": "string",
        "title": "API key",
        "required": true,
        "sensitive": true
      },
      "mode": {
        "type": "enum",
        "values": ["standard", "strict"],
        "default": "standard"
      }
    }
  }
}
```

## AW Config

`config.schema` 是 AW config 的唯一真值。首版支持 `string`、`number`、`boolean`、`enum`、`file`、`directory`。字段可声明 `title`、`description`、`default`、`required`、`sensitive`；`enum` 用 `values`，`number` 可用 `min` / `max`。

配置有两层 store：

| scope | 路径 |
|------|------|
| `user` | `<AW_HOME>/plugin-config/<plugin>/config.json` |
| `project` | `<repo-or-workspace-root>/.agent-workflows/plugin-config/<plugin>/config.json` |

读取 effective config 的顺序是 `manifest default < user < project`。写命令默认写 `user`；读命令默认读 effective。`project` scope 是平台中立的 AW 项目配置，同一个仓库里的 Claude 和 Codex 安装默认读到同一份项目配置。

`file` / `directory` 类型写入时按 AW project root 解析相对路径，并以 canonical absolute realpath 落盘。每次读取 effective config 都会重新校验路径存在且类型正确；路径失效时，`aw status` 显示 `invalid-config`，lifecycle 和 helper 会 fail closed。

`sensitive: true` 表示 AW CLI、status、lifecycle 输出、debug log 和插件测试失败摘要要脱敏；它不是系统 keychain 或加密存储承诺。插件自己的脚本如果读取了原始值，不能把它打印到 stdout、stderr 或日志里。

### CLI 用法

```bash
aw config list <plugin>
aw config get <plugin>
aw config get <plugin> apiKey
aw config get <plugin> --scope user --json

aw config set <plugin> apiKey sk-test
aw config set <plugin> maxFiles 20 --value-json
aw config set <plugin> enabled true --value-json --scope project

aw config unset <plugin> apiKey --scope user
aw config reset <plugin> --scope project --yes
```

要点：

- `list` 展示 schema key 的来源、required/default 状态和配置问题。
- `get` 不带 key 时按 `key=value` 输出所有可见配置；带 key 时只输出该值。敏感值在 AW CLI 输出中会显示为 `[redacted]`。
- `--json` 控制命令输出格式；`--value-json` 只用于 `set`，表示把传入的 `<value>` 当 JSON literal 解析，适合 number、boolean，以及需要保留 JSON 字符串语义的值。
- 交互式配置向导只在 `aw` 主控制台中提供；脚本化写配置只使用 `set`、`unset` 和 `reset`。
- 插件只要能从当前 catalog 解析，即使还没有安装，也可以先用 `set` 预配置。
- `unset` 删除某一层 store 中的单个 key，不会删除其它 key。
- `reset` 删除整个 scope store。目标 store 存在时脚本化调用需要 `--yes`；目标 store 不存在时是 no-op。
- `reset` 不需要当前 catalog 里仍有这个插件，因此可以用来清理已卸载或已从 catalog 移除的插件残留配置。
- `aw uninstall` 默认保留 AW config；需要清理时显式运行 `aw config reset <plugin> -s user|project --yes`。

### 输出分层和 receipt

默认人类输出只承诺展示完成状态、友好原因和必要下一步，不适合脚本解析。内部诊断词，例如 marketplace、app-server、RPC、cache、recovery breadcrumb、ledger、healthSource、tracking、config/script health 等，不应出现在默认成功输出里；需要诊断时使用 `--verbose` 或 `--debug`。

所有脚本化写命令的 `--json` stdout 都是单一 JSON receipt，可直接 `JSON.parse`。`init/install/uninstall/upgrade/config set/unset/reset --json` 至少包含 `ok`、`command`、`warnings`、`nextSteps`；安装、卸载、升级会按实际结果补充 `plugins`、`targets`、`actions`、`artifacts`、`native` 等字段；配置写命令会返回 `updatedKeys` / `removedKeys` 和稳定的 `artifactRefresh`。`config list/get --json` 保留既有数据结构，同时包含稳定的 `ok` 和 `command`。

`aw status` 是只读投影：默认输出是友好摘要，`aw status --verbose` 在诊断小节展示内部字段，`aw status --json` 保留旧矩阵字段并追加 `ok`、`command`、`friendlySummaries`、`consoleItems`。status 失败路径也必须守住 stdout 机器合同：stdout 为空或仍是单一可解析 JSON，错误说明写 stderr。

## 标准配置 Helper

新插件推荐直接复用 `.agents/skills/create-agent-workflows-plugin/assets/aw-config.mjs`，脚手架 `--with-config-api` 会自动复制它。helper 支持两个命令：

```bash
node scripts/aw-config.mjs get apiKey
node scripts/aw-config.mjs json
node scripts/aw-config.mjs get mode --scope user
node scripts/aw-config.mjs json --scope project
```

helper 的读取路径分两种：

- 有 `AW_PLUGIN_CONTEXT` 时，优先读取 context 里的 `config.values`、`config.sources`、`config.schema` 和 `paths.configStores`。lifecycle、`pnpm plugin:test` 和受 AW 管理的脚本都走这条路径。
- 没有 `AW_PLUGIN_CONTEXT` 时，从当前 helper 文件向上定位同一个 bundle 内的 `.agents-plugin/plugin.json`，用该 manifest 的 schema/default/redaction 解释 AW config store。

无 context fallback 使用的是“当前 bundle 视图”，而 `aw config get/list` 使用的是“当前 catalog 视图”。升级或刷新过程中两者可能短暂不同，这是预期行为。helper 找不到 bundle manifest、manifest 损坏或 schema 校验失败时必须 fail closed，不能回退到 current catalog，也不能 schema-less 读取 raw store。

`get` 输出原始值，供脚本使用；`json` 同时包含 `values` 和 `redactedValues`。调试、日志和错误消息应优先使用 `redactedValues`。

## 动态 Artifact Renderer

动态 artifact 用于“产物内容或启用状态由 AW config 决定，但写盘必须由 AW 管理”的 Codex 能力。首版 target 只有：

- `codex.developerInstructionsBlock`：写入当前 scope 的 Codex AW managed developer instructions block。
- `codex.agentRole`：写入 role layer 文件，并在当前 scope Codex config 中注册 `[agents.<roleKey>]`。

manifest 中要同时声明 `scripts.artifacts.render` 和 `artifacts.targets`。`artifacts.targets` 是安装前能力真值，负责 installability、project preflight、status current catalog 和 ledger snapshot；renderer 只负责根据当前 config 输出 `ArtifactPlan`。

```json
{
  "scripts": {
    "artifacts": {
      "render": {
        "runner": "node",
        "path": "./scripts/render-artifacts.mjs"
      }
    }
  }
}
```

renderer 只在 `install`、`upgrade`、config-triggered `refresh` 这些写路径执行。`aw status` 不执行 renderer，也不执行 lifecycle。renderer 通过 `AW_PLUGIN_CONTEXT` 读取 JSON context，常用字段包括：

- `event`、`platform`、`scope`
- 插件 `name`、`version`、`rootDir`、`manifestPath`
- `artifactRenderConfig.values`，以及兼容字段 `renderConfig.values`
- `changedConfigKeys`，仅 refresh 事件表示本次命中的配置 key
- `previousArtifacts`、AW/Codex/Claude home 和 renderer digest 等诊断信息

artifact render config 和 `aw config get/list` 的 effective config 不同：

- user scope artifact 只按 `schema default < user store` 渲染。
- project scope artifact 按 `schema default < user store < 当前 project store` 渲染。
- project config 不会影响 user artifact 的内容、digest、stale 判断或 refresh 结果。

renderer stdout 必须只输出 JSON：

```json
{
  "version": 1,
  "artifacts": [
    {
      "id": "lightweight-instruction",
      "kind": "instruction",
      "platform": "codex",
      "target": "codex.developerInstructionsBlock",
      "state": "present",
      "refreshKeys": ["enableInstruction"],
      "content": "Use the explorer role for read-only codebase exploration."
    },
    {
      "id": "codex-explorer-role",
      "kind": "codexRole",
      "platform": "codex",
      "target": "codex.agentRole",
      "state": "present",
      "roleKey": "codex-explorer",
      "refreshKeys": ["explorerModel"],
      "content": {
        "registration": { "description": "Read-only explorer role." },
        "roleFile": {
          "name": "codex-explorer",
          "description": "Read-only explorer role.",
          "developer_instructions": "Read only. Do not edit files."
        }
      }
    }
  ]
}
```

`disabled` artifact 可以省略 `content`，但必须保留声明过的 `refreshKeys`，并建议写 `disabledReason: "config"`。同一插件声明多个 `codex.developerInstructionsBlock` artifact 时，AW 会按 `artifact.id` 稳定排序后合成为一个 managed block；disabled instruction artifact 只会从合成内容里省略自己的 fragment，所有 instruction artifact 都 disabled 时才移除该插件的 managed block。status 和 refresh preflight 会按合成后的 managed block digest 诊断用户编辑造成的 content drift。`codex.agentRole` 的 `roleKey` 和 `roleFile.name` 必须与 manifest 静态 `artifacts.targets[].roleKey` 一致；`registration.config_file` 和 role layer 路径由 AW 生成，renderer 不能提供。

renderer 不能直接写 `.codex/config.toml`、`.codex/agents/*.toml`、`.agent-workflows-manifest.json`、ledger 或其它 AW 受管文件。写盘、回滚、tracking、status 和 uninstall 都集中在 AW target apply。

配置写入后的 refresh 只覆盖当前命令能定位到的 target：user config 写入刷新 user target，并在当前 repo 安装了 project target 时刷新当前 repo；project config 写入只刷新当前 repo project target。CLI 不扫描所有历史 project，tracking 会用 `refreshReach` 记录本次刷新范围和其它已知 project target 是否可能 stale。refresh 失败不会回滚已经写入的 config store，但 `lastRefresh` 会记录失败摘要，`aw status`、`aw status --json.consoleItems` 和 JSON receipt 会把它投影为 recent refresh failed / `artifactRefreshFailed`，并给出重新应用配置的下一步。artifact drift 或 missing 会投影为 `artifactDrift`；`disabledReason: "config"` 不是故障。

refresh-only 动作用于重新应用已有配置，不修改 config store。它优先使用 tracking 中失败 artifact 的 `refreshKeys`；没有失败记录时，退回当前目标可定位的 tracked refresh keys。成功后更新对应 artifact 的 `lastRefresh` 和 tracking 诊断；失败后保留配置，并把本次错误写入 receipt 的 `artifactRefresh.error` 和后续 status 可读取的 tracking 诊断；没有可定位 tracked dynamic artifact 时返回 `artifactRefresh.status = "skipped"`。

动态 artifact 写动作必须来自明确的 location target。多位置状态可以被 status 或控制台汇总展示，但不能把汇总位置解释成隐式批量写。执行配置保存、refresh-only、安装、升级、卸载或 cleanup 前，调用方必须明确 platform、scope 和 project root；renderer 仍只返回 plan，不能自行写 `.codex/config.toml`、`.codex/agents/*.toml`、tracking 或 ledger。

## Lifecycle

支持的事件只有 `install`、`upgrade`、`uninstall`。`aw install`、`aw upgrade`、`aw uninstall` 会自动运行对应 lifecycle；客户端首版没有 `--no-scripts` 跳过开关。脚本失败或超时会让命令失败，所以 lifecycle 必须尽量短、小、幂等。

可用 runner：

- `node`、`sh`、`bash`、`pwsh`、`powershell`、`cmd`
- `auto` 会按扩展名推断：`.js` / `.mjs` / `.cjs` 为 Node，`.sh` 为 `sh`，`.ps1` 为 PowerShell，`.cmd` / `.bat` 为 Windows cmd

生命周期声明可以用字符串简写：

```json
{
  "scripts": {
    "lifecycle": {
      "install": "./scripts/lifecycle.mjs"
    }
  }
}
```

也可以按 OS selector 分流：

```json
{
  "scripts": {
    "lifecycle": {
      "uninstall": {
        "unix": { "runner": "sh", "path": "./scripts/uninstall.sh" },
        "windows": { "runner": "powershell", "path": "./scripts/uninstall.ps1" }
      }
    }
  }
}
```

解析顺序：

| OS | selector 顺序 |
|----|---------------|
| Linux | `linux -> unix -> default` |
| macOS | `darwin -> unix -> default` |
| Windows | `win32 -> windows -> default` |

脚本路径必须在插件根内，不能写内联 shell 命令。Windows 插件优先写 Node 入口；确实需要 shell 时，单独提供 `.ps1` 或 `.cmd`。

超时优先级固定为 CLI `--script-timeout <ms>` > manifest `scripts.timeoutMs` > 默认 `30000`。合法范围是 `1000..300000` 的整数。

### 幂等要求

lifecycle 可能在这些情况下被再次调用：用户重复安装、升级失败后重试、卸载历史版本、双平台安装同一个插件。脚本应遵守：

- 不改写源码树和 generated bundle。
- 写入 AW 受管状态前先创建目录，已有内容按可重复执行处理。
- 清理操作允许目标不存在。
- 不依赖当前 marketplace 中的同名插件；`uninstall` 可能使用安装时快照里的 historical bundle。
- 把 `context.plugin.rootDir` 或 `AW_PLUGIN_ROOT` 当作 runtime 真值，不从 `process.cwd()` 推断插件根。

`aw status` 只读展示 config/script 健康，不会运行 lifecycle、刷新 marketplace、创建 config store 或修复 bundle。默认输出会把这些内部诊断投影成用户可理解的状态、位置和下一步；`--verbose` / `--json` 才暴露机器字段。常见底层状态包括：

| 维度 | 状态 |
|------|------|
| config | `configured`、`missing-required`、`invalid-config`、`no-schema` |
| scripts | `declared`、`not_declared`、`missing-from-bundle`、`unsupported-on-current-os` |
| healthSource | `installSnapshot`、`currentCatalog`、`historical`、`none` |

## 运行时 Context

AW 会为 lifecycle 和 `pnpm plugin:test` 写入一个临时 JSON context，并把路径放到 `AW_PLUGIN_CONTEXT`。Node 入口建议这样读取：

```js
import { readFile } from 'node:fs/promises';

async function readAwContext() {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) {
    throw new Error('AW_PLUGIN_CONTEXT is required.');
  }
  return JSON.parse(await readFile(contextPath, 'utf8'));
}

const context = await readAwContext();
```

稳定字段：

| 字段 | 说明 |
|------|------|
| `event` | `install` / `upgrade` / `uninstall` / `test` |
| `plugin.name`、`plugin.version` | 插件身份 |
| `plugin.rootDir` | 当前运行的 bundle root，等同 `AW_PLUGIN_ROOT` |
| `sourceRoot` | 仅 `pnpm plugin:test` 提供，指向原始源码插件根 |
| `platform` | `codex` 或 `claude` |
| `scope` | `user` 或 `project` |
| `cwd` | 命令项目根或测试 runner 的隔离项目根 |
| `paths.awHome` | 当前 AW home |
| `paths.codexHome` / `paths.claudeHome` | 平台 home，lifecycle context 提供 |
| `paths.manifestPath` | 当前 bundle manifest 路径，lifecycle context 提供 |
| `paths.configStores.user/project` | user/project raw store 路径，有 config schema 时提供 |
| `config.schema` | 当前 schema |
| `config.values` | 已校验的 effective values |
| `config.sources` | 每个 key 的来源：`default`、`user`、`project`、`missing` |
| `config.issues` | 配置问题，lifecycle 正常执行前应为空 |
| `script.runner`、`script.path`、`script.args`、`script.source` | 当前脚本解析结果；`pnpm plugin:test` 中 `script.path` 可为 `null` |
| `artifacts` | install/upgrade 过程中生成的 managed artifacts |

环境变量白名单：

| 变量 | 说明 |
|------|------|
| `AW_HOME` | AW home |
| `AW_CODEX_HOME` / `AW_CLAUDE_HOME` | 平台 home |
| `AW_PLUGIN_CONTEXT` | context JSON 文件路径 |
| `AW_PLUGIN_ROOT` | 当前 bundle root |
| `AW_PLUGIN_NAME` / `AW_PLUGIN_VERSION` | 插件身份 |
| `AW_PLUGIN_EVENT` | 当前事件 |
| `AW_PLUGIN_PLATFORM` | 当前平台 |
| `AW_PLUGIN_SCOPE` | 当前 scope |
| `PATH` | 由命令环境透传 |

POSIX 运行时会使用隔离 `HOME` / `TMPDIR`；Windows 运行时会使用隔离 `USERPROFILE` / `TEMP` / `TMP`。不要读取真实用户 home 或系统临时目录来保存插件状态。

## Node 依赖与打包

没有声明 `scripts.node.packageRoot` 时，Node lifecycle/helper/test 只能使用 `node:` 内置模块和插件内相对 import。相对 import 不能逃出插件根。

需要第三方依赖时：

- 在 manifest 声明 `scripts.node.packageRoot`。
- 在该目录提交 `package.json` 和 `pnpm-lock.yaml`。
- runtime 依赖必须写在 `dependencies`，不能依赖仓库根 `node_modules`。
- 只允许 registry-backed dependency specifier；不支持 `workspace:`、`file:`、`link:`、`portal:`、git/GitHub shortcut、HTTP(S) URL 或 tarball URL。
- 发布 bundle 只带 runtime 入口、可静态识别的相对依赖闭包、packageRoot production 依赖；测试文件不会进入 runtime bundle。

`scripts.node.build` 是唯一支持的 manifest build 入口，运行在隔离 staging 目录。`package.json` scripts、`preinstall`、`postinstall`、`prepare` 等 npm lifecycle 不会被 AW 自动执行。

## 插件脚本测试

```bash
pnpm plugin:test <plugin>
pnpm plugin:test <plugin> --platform both --scope project
pnpm plugin:test <plugin> --test-name "reads config"
pnpm plugin:test --all
```

`pnpm plugin:test` 会先编译 CLI，再准备临时 bundle、隔离 `AW_HOME` 和受管临时 project root，然后执行 `scripts.tests.node` 匹配到的 Node 测试。无匹配测试时是 skipped/no-op，退出码为 0。

测试进程的 `process.cwd()`、`AW_PLUGIN_CONTEXT.cwd` 和 helper fallback 看到的是同一个隔离项目根，不是源码仓库。测试中需要读源码 fixture 时用 `AW_PLUGIN_CONTEXT.sourceRoot`；运行 helper/lifecycle 时应从临时 bundle 里的相对路径 import 或执行，不要从 `sourceRoot` 直接 import runtime 文件。

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
  await writeFile(contextPath, JSON.stringify({
    plugin: { name: 'example-plugin' },
    config: {
      values: { apiKey: 'test-key', mode: 'strict' },
      sources: { apiKey: 'user', mode: 'project' },
      schema: {
        apiKey: { type: 'string', sensitive: true, required: true },
        mode: { type: 'enum', values: ['standard', 'strict'], default: 'standard' }
      }
    },
    paths: { configStores: {} }
  }), 'utf8');

  const helperPath = join(dirname(fileURLToPath(import.meta.url)), 'aw-config.mjs');
  const { stdout } = await execFileAsync(process.execPath, [helperPath, 'get', 'mode'], {
    cwd: tempDir,
    env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath }
  });

  assert.equal(stdout.trim(), 'strict');
});
```

## 示例插件

完整组合示例见 `references/.examples/code-review/`：

- `.agents-plugin/plugin.json` 同时声明 `config.schema`、`scripts.helpers.config`、`scripts.lifecycle` 和 `scripts.tests.node`。
- `scripts/aw-config.mjs` 展示标准 helper。
- `scripts/lifecycle.mjs` 展示如何读取 context、effective config 和 AW home。
- `scripts/lifecycle.test.mjs` 展示 helper 与 lifecycle 的 Node 测试写法。
