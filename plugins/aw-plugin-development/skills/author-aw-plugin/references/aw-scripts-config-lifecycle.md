# AW Scripts / Config / Lifecycle 作者指南

本文说明插件作者如何开发 AW 自管配置、标准配置 helper、安装生命周期脚本和插件脚本测试。字段级 schema 仍以 `references/plugin-manifest-spec.md` 为准；这里关注“怎么写、怎么运行、怎么排障”。

适用场景：

- 插件需要跨 Claude Code 和 Codex 共享配置，例如 API Key、模式开关、工作目录或文件路径。
- 插件安装、升级、卸载时需要创建或清理 AW 受管状态。
- 插件需要根据 AW config 动态生成 Codex skill、developer instructions 或 agent role。
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

配置有三层 store：

| scope | 路径 |
|------|------|
| `user` | `<AW_HOME>/plugin-config/<sourceId>/<pluginName>/config.json` |
| `project shared` | `<repo-or-workspace-root>/.agent-workflows/plugin-config/<sourceId>/<pluginName>/config.json` |
| `project local` | `<repo-or-workspace-root>/.agent-workflows/plugin-config.local/<sourceId>/<pluginName>/config.json` |

每个 store 是 schema 2 envelope，固定绑定 `sourceId`、`sourceIdentity`、`pluginName` 和 `values`。裸 plugin name store 属于 legacy state，helper 和 CLI 都 fail closed。JSON、owner、receipt 和诊断使用 canonical `sourceId/pluginName`。

project shared config 是平台中立的 AW 项目配置，同一个仓库里的 Claude 和 Codex 安装默认读到同一份项目配置，并且它是 repo-visible project artifacts 的唯一共享配置输入。project local config 是本机私有覆盖层，默认应被 ignore，只影响本机读命令、lifecycle 和 helper，不触发 repo-visible artifact refresh。

读取 project effective config 的顺序是 `manifest default < user < project shared < project local`。写命令默认写 `user`；`aw config set --scope project` 写 project shared store，`aw config set --scope project --local` 写 project local store；读命令默认读 effective。

`file` / `directory` 类型写入时按 AW project root 解析相对路径，并以 canonical absolute realpath 落盘。每次读取本机 effective config 都会重新校验路径存在且类型正确；路径失效时，lifecycle 和 helper 会 fail closed。路径型 key 不能写入 project shared config，也不能进入 project artifact render config、digest、stale 判断或 refresh；需要项目内本机路径时，用 `--scope project --local`。

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
aw config set <plugin> workspaceDir ./tmp --scope project --local

aw config unset <plugin> apiKey --scope user
aw config reset <plugin> --scope project --yes
aw config list <plugin> --scope project --local
```

要点：

- `list` 展示 schema key 的来源、required/default 状态和配置问题。
- `get` 不带 key 时按 `key=value` 输出所有可见配置；带 key 时只输出该值。敏感值在 AW CLI 输出中会显示为 `[redacted]`。
- `--json` 控制命令输出格式；`--value-json` 只用于 `set`，表示把传入的 `<value>` 当 JSON literal 解析，适合 number、boolean，以及需要保留 JSON 字符串语义的值。
- 交互式配置向导只在 `aw` 主控制台中提供；脚本化写配置只使用 `set`、`unset` 和 `reset`。
- 插件只要能从当前 catalog 解析，即使还没有安装，也可以先用 `set` 预配置。
- `aw config set --scope project` 会写 project shared config；如果 key 是 `file` / `directory` 类型，命令会在写入前失败，请改用 user store 或 `--scope project --local`。
- `aw config get/list --scope project` 必须区分 project shared、project local 和最终 effective value；project local 覆盖不表示 repo-visible project artifacts 会刷新。
- `unset` 删除某一层 store 中的单个 key，不会删除其它 key。
- `reset` 删除整个 scope store。目标 store 存在时脚本化调用需要 `--yes`；目标 store 不存在时是 no-op。
- `reset` 不需要当前 catalog 里仍有这个插件，因此可以用来清理已卸载或已从 catalog 移除的插件残留配置。
- `aw uninstall` 和 `aw cleanup` 保留 AW config。只想删除配置时显式运行 `aw config reset <plugin> -s user|project`。

### 输出分层和 receipt

默认人类输出只承诺展示完成状态、友好原因和必要下一步，不适合脚本解析。需要详细诊断时使用 `--verbose` 或 `--debug`。

所有脚本化写命令的 `--json` stdout 都是单一 JSON receipt。五个写命令和配置写命令使用 receipt schema 4，并返回 canonical plugin identity；配置写命令还返回 `updatedKeys` / `removedKeys` 和 target reinstall 结果。

`aw status` 是 live ownership 只读投影：默认输出友好摘要，`aw status --verbose` 展示组件检查，`aw status --json` 输出 `schemaVersion: 4`、multi-source catalog、filters、targets 和 errors。每个 target 的状态只允许 `present`、`absent`、`partial`、`error`。

## 标准配置 Helper

新插件推荐复用当前 Skill 的 `assets/aw-config.mjs`；`scripts/init_plugin.mjs --with-config-api` 会自动复制它。helper 支持两个命令：

```bash
node scripts/aw-config.mjs get apiKey
node scripts/aw-config.mjs json
node scripts/aw-config.mjs get mode --scope user
node scripts/aw-config.mjs json --scope project
node scripts/aw-config.mjs json --scope project-local
```

helper 的读取路径分两种：

- 有 `AW_PLUGIN_CONTEXT` 时，优先读取 context 里的 `config.values`、`config.sources`、`config.schema` 和 `paths.configStores`。lifecycle、`pnpm plugin:test` 和受 AW 管理的脚本都走这条路径。
- 没有 `AW_PLUGIN_CONTEXT` 时，从当前 helper 文件定位 bundle manifest，并要求它位于 `<AW_HOME>/marketplaces/<sourceId>/plugins/<pluginName>`。helper 验证 marketplace `config.json` 的 schema 2 source identity，再读取同 source 的 namespaced schema 2 config envelope。

无 context fallback 使用的是“当前 namespaced marketplace bundle 视图”，而 `aw config get/list` 使用的是当前 multi-source resolution。helper 找不到 bundle manifest、不能验证 source identity、发现旧裸名 store、envelope identity 不匹配或 schema 校验失败时必须 fail closed，不能回退到其它 source 或 schema-less raw store。

`get` 输出原始值，供脚本使用；`json` 同时包含 `values` 和 `redactedValues`。调试、日志和错误消息应优先使用 `redactedValues`。

## 动态 Artifact Renderer

动态 artifact 用于“产物内容或启用状态由 AW config 决定，但写盘必须由 AW 管理”的平台能力。当前 target 包括：

- `codex.skill`：写入 Codex skill 目录。配置驱动的 skill 优先使用它，而不是 lifecycle 直接改 `.agents/skills/**` 或用户级 Codex runtime。
- `claude.skill`：写入独立的 Claude user/project skill 目录，不使用插件 namespace。
- `codex.developerInstructionsBlock`：写入当前 scope 的 Codex AW managed developer instructions block。
- `codex.agentRole`：写入 role layer 文件，并在当前 scope Codex config 中注册 `[agents.<roleKey>]`。

manifest 中要同时声明 `scripts.artifacts.render` 和 `artifacts.targets`。`artifacts.targets` 是 rebuild 和 live status 的能力真值；renderer 只负责根据当前 config 输出 `ArtifactPlan`。

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

renderer 在 install、upgrade、reinstall 和配置触发的 reinstall 中执行。`aw status` 不执行 renderer 或 lifecycle。renderer 通过 `AW_PLUGIN_CONTEXT` 读取 JSON context，常用字段包括：

- `event`、`platform`、`scope`
- `plugin.name`、`plugin.version`、`plugin.rootDir`、`paths.manifestPath`
- `artifactSources`，包含 target 的已暂存 `sourceDirs` 绝对路径；renderer 只能读取这些目录
- `config.mode`、`config.targetScope`、`config.values`、`config.sources` 和 `config.issues`
- `changedConfigKeys`，仅 refresh 事件表示本次命中的配置 key
- `previousArtifacts`、AW/Codex/Claude home 和 renderer digest 等诊断信息

artifact render config 和 `aw config get/list` 的 effective config 不同：

- user scope artifact 只按 `schema default < user store` 渲染。
- project scope artifact 只按 `schema default < project shared store` 中可共享的非路径 key 渲染。
- project config 不会影响 user artifact 的内容、digest、stale 判断或 refresh 结果。
user store、project local store 和 `file` / `directory` key 只影响本机 effective config、lifecycle 或 helper，不进入 repo-visible artifact truth。

renderer stdout 必须只输出 JSON：

```json
{
  "version": 2,
  "artifacts": [
    {
      "id": "codex-explore-skill",
      "kind": "skill",
      "platform": "codex",
      "target": "codex.skill",
      "state": "present",
      "skillKey": "codex-explore",
      "refreshKeys": ["explorerModel", "modelReasoningEffort"],
      "content": {
        "files": {
          "SKILL.md": "---\nname: codex-explore\n---\n# Codex Explore\n",
          "references/config.md": "Model: gpt-5.6-terra\n"
        }
      }
    }
  ]
}
```

`ArtifactPlan` 只接受 V2。V1 会失败，并要求用户升级或重新安装插件。`disabled` artifact 可以省略 `content`，但必须保留声明过的 `refreshKeys`，并建议写 `disabledReason: "config"`。

`codex.skill` / `claude.skill` 必须在 manifest 静态声明 `skillKey`。静态完整目录来自 `sourceDirs`：AW 按声明顺序做字节级合并，后面的目录覆盖前面的文件。renderer 的 `content.files` 再覆盖静态树，只接受 UTF-8 字符串和安全的 POSIX 相对路径。最终 Codex tree 必须有 `SKILL.md` 与 `agents/openai.yaml`；最终 Claude tree 必须有 `SKILL.md`。AW apply 阶段 patch 对应平台的触发字段。同一插件声明多个 `codex.developerInstructionsBlock` artifact 时，AW 会按 `artifact.id` 稳定排序后合成为一个 managed block；disabled instruction artifact 只会从合成内容里省略自己的 fragment，所有 instruction artifact 都 disabled 时才移除该插件的 managed block。status 和 refresh preflight 会按合成后的 managed block digest 诊断用户编辑造成的 content drift。`codex.agentRole` 的 `roleKey` 和 `roleFile.name` 必须与 manifest 静态 `artifacts.targets[].roleKey` 一致；`registration.config_file` 和 role layer 路径由 AW 生成，renderer 不能提供。

renderer 不能直接写 Codex/Claude Skill runtime、`.codex/config.toml`、`.codex/agents/*.toml` 或其它 AW 受管文件。写盘和 ownership inspection 集中在 rebuild target apply。

配置写入只覆盖当前命令能定位到的 target，并对这些 target 运行完整 reinstall。CLI 不扫描其它历史 project；receipt 会提示其它项目需要手动 reinstall。动态 artifact 写动作必须来自明确的 platform、scope 和 project root，renderer 仍只返回 plan，不能自行写 AW 受管输出。

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
- uninstall lifecycle 使用 lifecycle active store 保存的最后一次成功脚本输入，不读取旧安装状态文件。
- 把 `context.plugin.rootDir` 或 `AW_PLUGIN_ROOT` 当作 runtime 真值，不从 `process.cwd()` 推断插件根。

`aw status` 只读取当前 multi-source resolution、现场 owner marker 和平台原生状态。它不会运行 lifecycle、renderer，不会刷新 marketplace，也不会创建 config store。target 状态只允许 `present`、`absent`、`partial`、`error`：全部期望组件存在时是 `present`，全部缺失时是 `absent`，部分存在或不完整时是 `partial`，检查失败时是 `error`。没有声明 `config.schema`、`scripts.lifecycle` 或 `artifacts.targets` 不是问题，只表示插件没有对应能力。

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
| `plugin.name`、`plugin.version` | 插件名称和版本 |
| `plugin.sourceId`、`plugin.sourceIdentity` | namespaced source identity；真实 multi-source lifecycle 提供 |
| `plugin.pluginId` | canonical `sourceId/pluginName`；由已验证的 source identity 和插件名构造 |
| `plugin.rootDir` | 当前运行的 bundle root，等同 `AW_PLUGIN_ROOT` |
| `sourceRoot` | 仅 `pnpm plugin:test` 提供，指向原始源码插件根 |
| `platform` | `codex` 或 `claude` |
| `scope` | `user` 或 `project` |
| `cwd` | 命令项目根或测试 runner 的隔离项目根 |
| `paths.awHome` | 当前 AW home |
| `paths.codexHome` / `paths.claudeHome` | 平台 home，lifecycle context 提供 |
| `paths.manifestPath` | 当前 bundle manifest 路径，lifecycle context 提供 |
| `paths.configStores.user/project/projectLocal` | user、project shared、project local raw store 路径，有 config schema 时提供 |
| `config.schema` | 当前 schema |
| `config.values` | 已校验的 effective values |
| `config.sources` | 每个 key 的来源：`default`、`user`、`projectShared`、`projectLocal`、`missing` |
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

作者 validator 执行 renderer fixture 时使用同一最小环境合同：只传上表变量、隔离 home/temp 和 Windows 启动 Node 所需的系统变量。它不会把父进程的其它环境变量传给插件 renderer。

## Node 依赖与打包

没有声明 `scripts.node.packageRoot` 时，Node lifecycle/helper/test 只能使用 `node:` 内置模块和插件内相对 import。作者 validator 识别 static import、export-from、dynamic import、`require()` 和 `require.resolve()` 的字符串 specifier；字符串、注释、正则和 template literal 文本不算依赖，但 `${...}` 内的代码仍会检查。相对 import 不能逃出插件根。

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
pnpm plugin:test <plugin> --platform codex --scope project
pnpm plugin:test <dual-platform-plugin> --platform both --scope project
pnpm plugin:test <plugin> --test-name "reads config"
pnpm plugin:test --all
```

`pnpm plugin:test` 会先编译 CLI，再用 staging 模式准备 source，并从 build 后 staging manifest 解析最终支持平台。省略 `--platform` 时按 `both` 处理；`--platform auto` 无效并会失败；显式 `claude` 或 `codex` 遇到任一选中插件不支持该平台时，会在测试执行前失败；`both` 按每个插件最终支持平台集合展开，单平台插件只跑自己支持的平台，双平台插件分别跑 Codex 和 Claude 两轮。

校验通过后，runner 会准备临时 bundle、隔离 `AW_HOME` 和受管临时 project root，然后执行 `scripts.tests.node` 匹配到的 Node 测试。无匹配测试时是 skipped/no-op，退出码为 0。

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
      sources: { apiKey: 'user', mode: 'projectShared' },
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
