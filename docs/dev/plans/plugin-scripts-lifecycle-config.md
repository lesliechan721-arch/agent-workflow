# 插件脚本、生命周期回调与自定义配置计划

## 结论

这次要补的是 AW 自己的插件运行时能力，不是 Claude / Codex 的 agent runtime hook。当前基线已经有 `extensions.hooks` 和 `extensions.nativeHooks`，那一层负责 agent 会话里的工具、提示、停止等事件；本计划新增的是插件安装链路、插件配置和插件作者脚本测试链路。

已确认首版产品边界：

- 插件自定义配置由 AW 自管，统一覆盖 Claude 和 Codex；Claude 原生 `userConfig` 保持可选桥接，不作为 AW 配置的主存储。
- 生命周期脚本默认自动执行且不提供跳过开关；跳过会让插件处于未初始化或未清理状态，脚本失败必须阻断命令。
- 插件脚本测试属于开发期能力，不暴露为 `aw` 客户端子命令；单独提供 Node 测试 runner，并由根 `package.json` 脚本维护。

首版目标是把这三件事做成一套共同的插件脚本基础设施：

- `.agents-plugin/plugin.json` 新增 `scripts` 和 `config` contract。
- build 阶段把 AW 管理脚本复制进 bundle root，并校验路径、Node 类型和 bundle layout。
- 安装、升级、卸载命令在安全点调用插件生命周期脚本，并把配置、平台、scope、路径和已生成产物作为 JSON context 传给脚本。
- 新增 `aw config ...` 命令管理插件配置，配置值按 `project/user` scope 存储，并由生命周期脚本、普通自定义脚本和 Claude 命令结果填充脚本读取。
- 新增 `package.json` 维护的插件脚本测试入口，例如 `pnpm plugin:test`，只支持 Node.js 测试，运行在临时 bundle 和隔离 AW_HOME 中，不污染用户真实安装状态。

## 当前基线调研

- `packages/cli/src/types.ts`：`PluginManifestSource` 目前包含 `skills`、`skillTriggers`、`mcpServers`、`apps`、`extensions`、`buildConfig`，没有 AW 自定义脚本和 AW 自管配置字段。`PlatformAdapter` 只有 install/uninstall/upgrade/status 和 repo-managed artifacts 接口。
- `packages/cli/src/utils/manifest.ts`：source manifest 严格拒绝未知字段；新增 `scripts` / `config` 必须同步类型、normalizer、source-only 校验、bundle-mode 校验和测试。
- `packages/cli/src/generators/local-plugin.ts`：build 只把声明过的平台能力复制进 `claude/`、`codex/` 子目录，`.agents-plugin/plugin.json` 会复制到 bundle root。生命周期脚本不是平台原生能力，不能塞进 `manifestOverrides`，需要新增 AW-managed files 复制路径。
- `packages/cli/src/utils/bundle-layout.ts`：当前校验 Claude/Codex runtime manifest 和平台文件，不校验 bundle root 下的 AW 脚本文件。新增脚本后，layout 校验要检查 `.agents-plugin/plugin.json` 中声明的脚本路径在 bundle root 内存在。
- `packages/cli/src/commands/install.ts`：安装顺序是 skill trigger 物化、`adapter.installPlugin()`、`adapter.installExtensions()`、tracking、ledger。生命周期脚本应插入在平台状态和 repo-managed artifacts 写完之后、tracking/ledger 提交之前，这样失败时还能进入现有回滚和 degraded ledger 语义。
- `packages/cli/src/commands/upgrade.ts`：upgrade 复用 uninstall + install 的编排。需要区分用户真实 uninstall 和 upgrade 内部为了 capabilityChanged 做的清理，避免 upgrade 误触发插件 `uninstall` 生命周期。
- `packages/cli/src/commands/uninstall.ts`：卸载会先调用平台原生 uninstall，再清理 artifacts、tracking、ledger。插件卸载脚本如果要读取配置、旧 tracking 或旧 bundle，必须在平台卸载和 artifact 清理之前执行；失败则中止卸载。
- `packages/cli/src/utils/local-marketplace.ts`：`~/.aw` 当前会被 `initializeLocalMarketplace()` 原子替换，只保留 `installed.json`，并重放 skill trigger 偏好。若把用户配置直接放到 `~/.aw`，必须在重建时显式保留配置目录，否则会被刷新删除。
- `packages/cli/src/utils/paths.ts`：已有 `resolveAwHome()`、`resolveClaudePaths()`、`resolveCodexPaths()`、repo root 解析。新增配置 store 应复用这些路径规则，project scope 走 repo root，而不是当前子目录。
- `docs/plugin-authoring.md` 和 `.agents/skills/create-agent-workflows-plugin/references/*`：作者文档已说明 Claude-only `userConfig` 和命令结果填充；这次要把 AW 自管配置写成独立入口，避免读者误以为只能靠 Claude 原生 `userConfig`。
- 测试基线：unit / integration 保持 build-free，使用 `tests/helpers/embedded-root.ts` 生成 synthetic embedded root；smoke 层才跑真实 `pnpm build` / pack。插件脚本测试 runner 也应遵守这个分层，并作为开发工具放在 `.agents/skills/create-agent-workflows-plugin/` 下。

## Source Contract

### 1. 新增 `scripts`

在 `.agents-plugin/plugin.json` 顶层新增可选 `scripts`：

```json
{
  "scripts": {
    "runtime": "node",
    "lifecycle": {
      "install": "./scripts/lifecycle.mjs",
      "upgrade": "./scripts/lifecycle.mjs",
      "uninstall": "./scripts/lifecycle.mjs"
    },
    "tests": {
      "node": ["./scripts/**/*.test.mjs"]
    }
  }
}
```

规则：

- `scripts.runtime` 首版只允许 `"node"`；省略时如果声明了 lifecycle/tests，也按 `"node"` 处理。
- lifecycle 支持三个事件：`install`、`upgrade`、`uninstall`。字段值必须是插件内 `./` 相对路径，不能是绝对路径，不能逃出插件根目录。
- 脚本文件扩展名首版只允许 `.js`、`.mjs`、`.cjs`。推荐 `.mjs`，避免和仓库 `"type": "module"`、外部插件包边界混淆。
- `scripts.tests.node` 是开发期 source-only glob 数组，相对于插件根目录。只运行匹配到的 Node 测试文件；不隐式扫描整个插件目录；运行时安装不会读取它。
- `scripts` 是 AW CLI contract，不会写入 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- build 后 lifecycle 和配置 helper 脚本保留在 bundle root 的同一相对路径，例如 `~/.aw/plugins/<name>/scripts/lifecycle.mjs`，供 AW CLI 和插件自定义脚本读取；测试文件不复制进发布 runtime bundle。

首版不支持：

- 任意 shell lifecycle，例如 `"npm run setup"`。
- lifecycle 参数拼接或 shell 插值。
- 多个 lifecycle 脚本数组。需要复用时，由插件自己的 Node 入口按事件分发。
- per-platform lifecycle 覆盖。脚本 context 会带 `platform`，插件可自行分支；如果后续需要源级按平台裁剪，再扩展 schema。

### 2. 新增 `config`

在 `.agents-plugin/plugin.json` 顶层新增可选 `config`：

```json
{
  "config": {
    "schema": {
      "apiKey": {
        "type": "string",
        "title": "API Key",
        "description": "外部服务 API Key",
        "required": true,
        "sensitive": true
      },
      "maxFiles": {
        "type": "number",
        "title": "最大文件数",
        "default": 10,
        "min": 1,
        "max": 100
      },
      "autoFix": {
        "type": "boolean",
        "title": "自动修复",
        "default": false
      }
    }
  }
}
```

规则：

- `config.schema` 的 key 是配置项名，只允许 `/^[A-Za-z][A-Za-z0-9_]*$/`，方便脚本和命令结果填充读取。
- 首版类型支持 `string`、`number`、`boolean`、`enum`、`file`、`directory`。`enum` 使用 `values: string[]`。
- `required: true` 表示安装或升级前必须能解析出有效值，值可以来自用户配置，也可以来自 `default`。
- `sensitive: true` 首版只表示 CLI 输出、status 和测试日志需要脱敏；不承诺系统 keychain 或加密存储。落盘文件使用 `0600` 权限 best effort。
- 配置 schema 是 AW 自管配置的唯一真值。`buildConfig.manifestOverrides.claude.userConfig` 仍是 Claude 原生能力，可用于桥接，但不参与 AW config 命令的读写。

首版不支持：

- 嵌套对象配置。
- 配置项间依赖、动态 default 或安装时交互式 prompt。
- 把敏感配置写入 Claude `userConfig` keychain。后续若要桥接，需要单独设计迁移和同步策略。

## 配置存储与 CLI

新增路径 helper，例如 `packages/cli/src/utils/plugin-config.ts`：

- user scope：`<AW_HOME>/plugin-config/<plugin>/config.json`
- project scope：`<repoRoot>/.agent-workflows/plugin-config/<plugin>/config.json`

project scope 用 repo root，而不是命令执行子目录；Codex 现有 project key 也是先解析 repo root，这样同一个仓库不同子目录读到同一份配置。

`~/.aw` 重建时必须保留 `plugin-config/`。实现上可以让 `initializeLocalMarketplace()` 在 staging 替换前复制旧的 `plugin-config/`，或把用户配置移到与 marketplace bundle 不同的目录。首版若继续放在 `AW_HOME` 下，就必须把“重建不删除配置”写进测试。

新增 CLI 命令：

```bash
aw config list <plugin> [--scope project|user]
aw config get <plugin> [key] [--scope project|user] [--json]
aw config set <plugin> <key> <value> [--scope project|user] [--json]
aw config unset <plugin> <key> [--scope project|user]
aw config reset <plugin> [--scope project|user]
```

行为：

- 命令读取 current catalog / embedded catalog 中的插件 manifest，校验插件声明了对应 `config.schema`。
- `set` 按 schema 解析值；`--json` 允许给 number / boolean / enum 显式传 JSON literal，普通模式按字符串再转类型。
- `get` 默认输出脱敏后的值；`--json` 输出结构化 JSON，敏感值仍默认 redacted，后续可加 `--show-sensitive`，但首版不建议开放。
- `list` 输出 schema、是否已配置、是否来自 default、是否 required，不打印敏感值。
- `reset` 删除该 scope 下插件配置文件。删除后如果 required 项没有 default，后续 install/upgrade/lifecycle 会失败并提示 `aw config set ...`。
- install / upgrade 在执行 lifecycle 前调用 `resolvePluginConfig()`。缺 required 配置时，在写 native state 前失败。

配置解析顺序：

1. project scope 命令只读 project store。
2. user scope 命令只读 user store。
3. 生命周期 context 按本次安装 scope 读取对应 store；如果未来要支持 project 覆盖 user，需要单独加配置继承开关，首版不隐式合并。
4. 对缺失值应用 manifest default。
5. 输出给脚本前保留真实值，但 context 文件权限用 `0600`，并避免通过环境变量直接传敏感值。

## 标准配置 API

为了让生命周期脚本、自定义脚本和 Claude 命令结果填充都能读配置，提供两层 Node API。

第一层是 CLI 执行脚本时的 context API：

```js
import { readFile } from 'node:fs/promises';

export async function readAwContext() {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) throw new Error('AW_PLUGIN_CONTEXT is not set.');
  return JSON.parse(await readFile(contextPath, 'utf8'));
}

export async function getConfig() {
  return (await readAwContext()).config.values;
}
```

AW lifecycle runner 运行 lifecycle 时、开发期测试 runner 运行 test 时，都会写一个临时 JSON context 文件，并把路径放到 `AW_PLUGIN_CONTEXT`。这个方式不依赖 Node 的 package resolution，外部插件也能稳定使用。

第二层是 CLI 外运行的配置读取脚本，服务 Claude 命令结果填充：

```bash
node ./scripts/aw-config.mjs get apiKey
node ./scripts/aw-config.mjs json
```

这个脚本通过 `import.meta.url` 找插件根目录，通过 `process.cwd()` 查找 project store，通过 `os.homedir()` / `AW_HOME` 查找 user store。插件作者可以把它放进 Claude command 的命令结果填充：

```markdown
当前配置：!`node ${CLAUDE_PLUGIN_ROOT}/scripts/aw-config.mjs json`
```

实现计划：

- 在 `.agents/skills/create-agent-workflows-plugin/` 增加标准 helper 模板，例如 `assets/aw-config.mjs`。
- `init_plugin.js` 增加可选 `--with-config-api` / `--with-lifecycle`，生成脚本样板。
- `validate_plugin.js` 检查 helper 引用的配置 key 是否存在于 manifest schema。
- 文档明确：生命周期脚本优先读 `AW_PLUGIN_CONTEXT`；Claude 命令结果填充读落盘 config store，不依赖 AW CLI 正在执行。

## 生命周期脚本运行时

新增模块建议：`packages/cli/src/utils/plugin-scripts.ts`。

脚本执行方式：

- 用 `process.execPath` 启动 Node：`node <scriptPath>`。
- 不通过 shell，不拼接命令字符串。
- `cwd` 使用用户执行 `aw` 的 `options.cwd`。
- `scriptPath` 来自 bundle root 内声明路径，先 realpath，再确认仍在插件 bundle root。
- context 写入临时文件，环境变量只传 `AW_PLUGIN_CONTEXT`、`AW_PLUGIN_EVENT`、`AW_PLUGIN_NAME`、`AW_PLUGIN_ROOT`、`PATH/HOME/TMPDIR` 等最小集合。
- 默认超时 30 秒；manifest 可加 `scripts.timeoutMs`，CLI 可加 `--script-timeout <ms>` 覆盖，但需要上下限，例如 1 秒到 5 分钟。
- stdout/stderr 捕获后按行转成 debug / warning 信息。敏感配置不进入 stdout/stderr，日志里也要用 config schema 做脱敏扫描。

context 结构建议：

```json
{
  "version": 1,
  "event": "install",
  "plugin": {
    "name": "code-review",
    "version": "0.2.0",
    "rootDir": "/Users/me/.aw/plugins/code-review"
  },
  "platform": "claude",
  "scope": "project",
  "cwd": "/Users/me/project",
  "paths": {
    "awHome": "/Users/me/.aw",
    "configStore": "/Users/me/project/.agent-workflows/plugin-config/code-review/config.json",
    "trackingDir": "/Users/me/project/.claude"
  },
  "config": {
    "values": {
      "apiKey": "secret",
      "maxFiles": 10
    },
    "schema": {}
  },
  "artifacts": {
    "generated": []
  }
}
```

事件时机：

- `install`：`adapter.installPlugin()` 和 `adapter.installExtensions()` 成功后、tracking / ledger 写入前执行。脚本失败时进入现有安装回滚；native state 已写过，必要时 ledger 标记 degraded。
- `upgrade`：显式 `aw upgrade` 或 `upgrade --all` 的重新安装阶段执行 `upgrade`，不是 `install`。如果 upgrade 内部因为 capabilityChanged 先清旧 extension，那次内部清理不触发 `uninstall` lifecycle。
- `uninstall`：在 `adapter.uninstallPlugin()` 前执行。脚本失败则中止卸载，不删除平台原生状态、repo-managed artifacts、tracking 和 ledger。

失败策略：

- 默认脚本失败会让命令失败。
- 不提供 `--no-scripts` 或“脚本失败但继续”的全局开关。生命周期脚本是插件可用性 contract 的一部分；如果允许跳过，安装后插件可能缺少初始化产物，卸载时也可能留下外部资源。
- 生命周期脚本产生的外部副作用无法由 CLI 通用回滚；文档要求插件脚本自己保持幂等，并在 uninstall 中清理自己创建的外部资源。

后续可选扩展：

- 允许脚本返回 `{ warnings, managedArtifacts }`，把插件自管产物写入 tracking，供 status 和 uninstall context 使用。首版可以先只支持 warnings，避免把任意脚本 side effect 自动删除做得过早。

## 命令接入

### install

- `InstallCommandOptions` 增加 `scriptTimeoutMs?: number`。
- CLI 增加 `--script-timeout <ms>`，不增加跳过脚本选项。
- `installTargetsOnPlatforms()` 增加 operation 参数，默认 `"install"`；upgrade 调用时传 `"upgrade"`。
- 在 `installExtensions()` 之后、tracking 写入之前调用 lifecycle runner。
- 传入 `generatedArtifacts` 作为 context，便于脚本知道本轮 CLI 已写了哪些 repo-managed artifacts。

### upgrade

- 显式 upgrade 调用 `installTargetsOnPlatforms(..., { operation: "upgrade" })`。
- `upgrade --all` 同样传 `upgrade`。
- capabilityChanged 时调用内部 uninstall 清理，但使用不对 CLI 暴露的内部清理标记，避免误触发插件 `uninstall` lifecycle。
- 如果 upgrade 的 lifecycle 脚本失败，命令失败，并复用安装路径回滚和 degraded ledger 处理。

### uninstall

- `CommandOptions` 增加 `scriptTimeoutMs?: number`。
- CLI 增加 `--script-timeout <ms>`，不增加跳过脚本选项。
- `uninstallTargetsOnPlatforms()` 在读取 status、baseline ledger、tracking 后，平台卸载前执行 `uninstall` lifecycle。
- historical fallback 且当前 catalog / active local bundle 找不到可执行 lifecycle 时，记录 warning 后按老插件清理路径继续；不能因为历史安装缺少 bundle 而阻塞用户清理。

### status

首版 status 只展示配置和脚本声明的健康摘要，不执行脚本：

- `config`: `configured | missing-required | no-schema`
- `scripts`: `declared | not_declared | missing-from-bundle`
- lifecycle drift 只检查 bundle 路径存在，不尝试判断脚本内部行为。

## 插件脚本开发测试（package.json 入口）

不新增 `aw plugin test`，避免把插件作者的开发期工具暴露给普通客户端用户。测试 runner 放在 `.agents/skills/create-agent-workflows-plugin/scripts/`，由根 `package.json` 维护入口，例如：

```json
{
  "scripts": {
    "plugin:test": "node .agents/skills/create-agent-workflows-plugin/scripts/test_plugin_scripts.js"
  }
}
```

开发者通过包脚本运行：

```bash
pnpm plugin:test <plugin> [--scope project|user] [--platform codex|claude|both|auto] [--test-name <pattern>]
pnpm plugin:test --all [--scope project|user] [--platform codex|claude|both|auto] [--test-name <pattern>]
```

首版语义：

- 单插件测试是主路径：`pnpm plugin:test <plugin>` 只读取、打包并运行指定插件的测试，不能因为其它插件 manifest、脚本或测试损坏而失败。
- 批量测试必须显式传 `--all`；首版不建议把无参数默认为全量，避免用户想测一个插件时误跑整个 marketplace。
- 只从 source repo 的 `plugins/` 读取插件，不读取 `~/.aw`。
- 对指定插件优先生成单插件临时 bundle，复用 `bundleLocalPlugin()`；`--all` 才使用 `bundlePlugins()` 生成完整 synthetic embedded root。两条路径都要保证生命周期脚本测试的是 build 后结构。
- 为每个插件创建隔离的临时 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 和 `TMPDIR`。
- 按 source manifest 中的 `scripts.tests.node` glob 找测试文件，运行 `node --test <files...>`；测试文件从源码插件读取，不复制进发布 runtime bundle。
- 注入 `AW_PLUGIN_CONTEXT`，其中 `event: "test"`，`plugin.rootDir` 指向临时 bundle，`sourceRoot` 指向源码插件。
- 测试文件可以 import 插件自己的 lifecycle/config helper，也可以直接读取 context。
- 测试失败时保留 stderr 摘要，默认删除临时目录；后续可加 `--keep-temp` 便于调试。

这个包脚本不替代仓库自身 Vitest。它面向插件作者，用来测试插件内 Node 脚本；CLI 主仓库仍用 Vitest 覆盖实现。`.agents/skills/create-agent-workflows-plugin/SKILL.md` 需要说明这个入口，避免作者误以为应通过 `aw` 客户端测试插件脚本。

## 实现步骤

### Phase 1：Manifest 与 bundle contract

- 修改 `packages/cli/src/types.ts`：
  - 新增 `PluginScriptsConfig`、`PluginLifecycleScripts`、`PluginConfigSchema` 等类型。
  - `PluginManifestSource` 增加 `scripts?: ...`、`config?: ...`。
  - `PlatformPluginManifest` 不增加这些字段。
- 修改 `packages/cli/src/utils/manifest.ts`：
  - 顶层 allowlist 增加 `scripts`、`config`。
  - 校验脚本路径、runtime、测试 glob、timeout。
  - 校验 config schema 类型、默认值、required、sensitive、enum values。
  - source mode 校验 lifecycle 脚本路径和测试 glob；bundle mode 只校验 runtime lifecycle/config，不要求测试 glob。
- 修改 `packages/cli/src/generators/local-plugin.ts`：
  - 收集 `scripts.lifecycle.*` 和配置 helper 等 runtime 脚本，复制到 bundle root。
  - `createBundleSourceManifest()` 深拷贝 runtime 需要的 `scripts.lifecycle` / `config`，剥离 `scripts.tests`。
- 修改 `packages/cli/src/utils/bundle-layout.ts`：
  - 校验 source manifest 中声明的 lifecycle AW 脚本在 bundle root 存在。
  - 不把 AW 脚本要求写入 Claude/Codex platform manifest。

### Phase 2：配置存储与 CLI

- 新增 `packages/cli/src/utils/plugin-config.ts`：
  - resolve config paths。
  - read/write/reset config。
  - schema validate / coerce / apply defaults / redact。
- 修改 `packages/cli/src/index.ts`：
  - 新增 `config` command group。
  - 输出保持机器可读和中文错误信息。
- 修改 `packages/cli/src/utils/local-marketplace.ts`：
  - 保留 `plugin-config/`，避免 `aw init --force` 或 bundle refresh 删除用户配置。
- 给 install/upgrade 增加 required config preflight。

### Phase 3：脚本运行时与 lifecycle 接入

- 新增 `packages/cli/src/utils/plugin-scripts.ts`：
  - 解析脚本路径。
  - 写 context temp file。
  - spawn Node、处理 timeout、收集输出、脱敏日志。
- 修改 `packages/cli/src/commands/install.ts`：
  - `installTargetsOnPlatforms()` 支持 lifecycle event。
  - 在 tracking / ledger 前执行 install/upgrade lifecycle。
- 修改 `packages/cli/src/commands/upgrade.ts`：
  - upgrade 路径传 `operation: "upgrade"`。
  - capabilityChanged 内部卸载标记为 upgrade internal cleanup，不把它当作用户发起的 `uninstall` lifecycle 事件。
- 修改 `packages/cli/src/commands/uninstall.ts`：
  - 平台卸载前执行 uninstall lifecycle。
  - historical fallback 无脚本时 warning 后继续。
- 修改 `packages/cli/src/commands/status.ts` / formatter：
  - 展示配置缺失和脚本声明健康状态。

### Phase 4：插件脚本测试 runner

- 根 `package.json` 新增 `plugin:test` 脚本，指向 `.agents/skills/create-agent-workflows-plugin/scripts/test_plugin_scripts.js`。
- 新增 `.agents/skills/create-agent-workflows-plugin/scripts/test_plugin_scripts.js`，作为插件作者开发工具维护。
- 不修改 `packages/cli/src/index.ts`，不增加 `aw plugin test` 子命令。
- `pnpm plugin:test <plugin>` 走单插件执行路径，只调用 `readPluginManifest()` / `bundleLocalPlugin()` 处理指定插件。
- `pnpm plugin:test --all` 才走批量路径，调用 `bundlePlugins()` 生成完整临时 embedded root。
- 参数校验要求 `<plugin>` 和 `--all` 二选一；两者同时出现时报错。
- 按 manifest glob 发现 Node 测试文件，用 `node --test` 运行。
- 注入测试 context 和临时 config store。
- 在 `.agents/skills/create-agent-workflows-plugin/SKILL.md` 说明测试入口和适用场景。

### Phase 5：作者工具与文档

- 更新 `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md`：
  - 新增 `scripts` / `config` 字段规范。
- 新增或更新 references：
  - `plugin-scripts.md`
  - `plugin-config.md`
  - Claude 命令结果填充如何调用 AW config helper。
- 更新 `docs/plugin-authoring.md`、`docs/architecture.md`、`docs/testing.md`、`docs/plugin-installation.md`。
- 更新 `.agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js`：
  - 可选生成 lifecycle、config schema、Node test、config helper。
- 更新 `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`：
  - 校验脚本路径、Node 扩展名、config schema、helper 引用。
- 更新 `.agents/skills/create-agent-workflows-plugin/SKILL.md`：
  - 说明插件脚本测试通过 `pnpm plugin:test` 运行，属于开发期包脚本，不通过 `aw` 客户端入口。

## 测试计划

### Unit

- `manifest.test.ts` / `manifest-coverage.test.ts`
  - 接受合法 `scripts` / `config`。
  - 拒绝未知 runtime、逃逸路径、绝对路径、非 Node 扩展名、非法 config type/default。
  - `createBundleSourceManifest()` 保留 runtime lifecycle/config，剥离 source-only test glob。
- `bundle-layout.test.ts`
  - bundle root 中缺 lifecycle 脚本时报错。
  - AW 脚本不会进入平台 manifest。
- 新增 `plugin-config.test.ts`
  - set/get/unset/reset。
  - default、required、enum、number/boolean coercion。
  - sensitive redaction。
- 新增 `plugin-scripts.test.ts`
  - context 写入、Node spawn、timeout、exit code、stderr 摘要。
  - 路径逃逸和 shell 字符串不会被执行。

### Integration

- `cli-entry.test.ts`
  - `aw config ...` 参数解析、stdout/stderr、错误码。
  - `aw --help` / 子命令 help 不出现插件脚本测试入口，也不出现 `--no-scripts`。
- `cli.test.ts`
  - install 成功后执行 lifecycle，脚本看到 config 和 generatedArtifacts。
  - install lifecycle 失败触发现有回滚 / degraded ledger 语义。
  - uninstall lifecycle 在平台卸载前执行，失败不删除状态。
- `upgrade-command.test.ts`
  - upgrade 执行 `upgrade` lifecycle。
  - capabilityChanged 内部清理不触发 `uninstall` lifecycle。
- `runtime-env.test.ts`
  - `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 和 project config store 覆写正确。
- `authoring-tools.test.ts`
  - 脚手架生成 lifecycle/config/test 样板。
  - validate script 拒绝坏脚本路径和坏 config schema。
  - `plugin:test` runner 覆盖没有测试文件、测试通过、测试失败。
  - `plugin:test <plugin>` 只处理指定插件；fixture 中加入另一个坏 manifest 插件时，单插件测试仍应通过。
  - `plugin:test --all` 才会被其它插件的 manifest / bundle / test 失败阻断。

### Smoke

- `pnpm test:smoke:build`
  - 真实 `pnpm build` 后，声明的 lifecycle/config helper 进入 `plugins-dist`，source-only 测试文件不进入发布 runtime bundle。
  - `validateBundleLayout()` 通过。
- `pnpm test:smoke:pack`
  - npm tarball 包含 AW 脚本和配置 helper。
  - `dist/index.js --help` 不暴露 `plugin test` 或 `--no-scripts`。

## 风险与收口

- 生命周期脚本副作用无法通用回滚。首版通过“受限 Node、默认超时、无 shell、失败中止、脚本自行幂等”收口，不承诺自动撤销外部系统变更。
- `~/.aw` 既是 marketplace 镜像又要保存 user config，重建时必须保留 `plugin-config/`。如果实现时发现这个边界让 `~/.aw` 职责过重，可以把 user config store 改到 `~/.aw-config/` 或同级目录，但需要先同步路径决策。
- 敏感配置首版不是强安全密钥存储，只做权限和脱敏。需要 keychain 时另起方案。
- Claude 原生 `userConfig` 与 AW 自管配置可能同时存在。文档必须明确：AW config 供 AW 脚本和 AW helper 读取；Claude `userConfig` 仍只服务 Claude 原生 plugin manifest。
- `plugin:test` 使用 Node built-in test runner，不引入 Vitest 到插件运行时，也不把测试入口暴露给 `aw` 客户端。仓库内部仍用 Vitest 测 CLI。

## 验收标准

- 插件可以在 manifest 中声明 lifecycle Node 脚本、开发期 Node 测试 glob 和 AW 自管配置 schema。
- `pnpm build` 后，runtime 需要的脚本和配置 schema 保留在 bundle source manifest，生命周期脚本存在于 bundle root，测试文件不进入发布 runtime bundle。
- `aw config set/get/list/unset/reset` 能按 project/user scope 管理配置，并校验 schema。
- `aw install`、`aw upgrade`、`aw uninstall` 能自动执行 lifecycle，且客户端不提供 `--no-scripts` 跳过。
- 生命周期脚本能通过 `AW_PLUGIN_CONTEXT` 读取 config、scope、platform、plugin root 和 generated artifacts。
- Claude 命令结果填充可以通过标准 Node helper 读取 AW config。
- `pnpm plugin:test` 能在隔离临时环境中运行插件 Node 测试，不依赖真实 `~/.aw`，并在 `.agents/skills/create-agent-workflows-plugin` 插件开发技能内说明。
