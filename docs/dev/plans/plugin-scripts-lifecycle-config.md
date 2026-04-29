# 插件脚本、生命周期回调与自定义配置计划

## 结论

这次要补的是 AW 自己的插件运行时能力，不是 Claude / Codex 的 agent runtime hook。当前基线已经有 `extensions.hooks` 和 `extensions.nativeHooks`，那一层负责 agent 会话里的工具、提示、停止等事件；本计划新增的是插件安装链路、插件配置和插件作者脚本测试链路。

已确认首版产品边界：

- 插件自定义配置由 AW 自管，统一覆盖 Claude 和 Codex；Claude 原生 `userConfig` 保持可选桥接，不作为 AW 配置的主存储。
- 生命周期脚本默认自动执行且不提供跳过开关；跳过会让插件处于未初始化或未清理状态，脚本失败必须阻断命令。首版支持 Node 脚本和受控 shell 脚本文件，但不执行内联命令字符串。
- 插件脚本测试属于开发期能力，不暴露为 `aw` 客户端子命令；单独提供 Node 测试 runner，并由根 `package.json` 脚本维护。

当前新基线影响评估（`docs/dev/plans/codex-install-native-interactive-ux.md` 已合入当前分支）：

- 本计划不再等待或补齐另一套命令 runtime。`commands/runtime.ts`、`commands/options.ts`、`commands/discovery.ts`、`commands/interactive.ts` 和新的 `statusCommand()` 矩阵已经是基线；`aw config`、lifecycle runner、配置 preflight、status 健康展示都必须直接复用现有 `CommandExecutionContext`，通过同一份 `env`、`prompt`、`reporter`、`debugLogger` 和 `diagnostics` 走线接入。
- 执行型命令的默认 scope 已经统一为 `user`。`aw config set/unset/reset/configure` 默认写 user store；`aw config get/list` 默认展示聚合后的 effective config，project store 高于 user store。写 project config 必须显式传 `--scope project` 或在交互式 prompt 中选择。
- `status` 的 `--scope` / `--platform` 已经是过滤条件，不继承执行型命令默认值。插件配置和脚本健康信息只能作为 status 矩阵上的只读诊断维度接入，不能触发 marketplace 同步、配置写入或 lifecycle 执行。
- status 健康展示现在应接到已有 `StatusMatrixCell` / `StatusMatrixReport` 结构上：先由 discovery + adapter status 得到每个 `platform + scope + plugin` 格子，再追加 config/script health 和 `healthSource`。不要恢复旧的单 scope `statusCommand()` 思路。
- 交互式配置是首版能力的一部分：`aw config configure <plugin>` 提供 schema 驱动的配置向导；`install` / `upgrade` 在交互可用且缺 required config 时，可在写 native state 前补问配置。非 TTY、`CI=true`、`--no-interactive` 或缺少 prompt 注入时必须确定性失败，并给出可复制的 `aw config configure` / `aw config set` 建议。

首版目标是把这三件事做成一套共同的插件脚本基础设施：

- `.agents-plugin/plugin.json` 新增 `scripts` 和 `config` contract。
- build 阶段把 AW 管理脚本和可选 Node production 依赖复制进 bundle root，并校验路径、脚本 runner、跨平台可解析性、依赖声明和 bundle layout。
- 安装、升级、卸载命令在安全点调用插件生命周期脚本，并把配置、平台、scope、路径和已生成产物作为 JSON context 传给脚本；脚本、`config.schema` 和 default 合并必须来自同一份 source manifest，不能把旧 bundle 的脚本和新 catalog 的配置 contract 混用。
- 新增 `aw config ...` 命令管理插件配置，配置值按 `project/user` scope 分层存储，读取时聚合为 effective config，支持交互式配置，并由生命周期脚本、普通自定义脚本和 Claude 命令结果填充脚本读取。
- 新增 `package.json` 维护的插件脚本测试入口，例如 `pnpm plugin:test`，只支持 Node.js 测试，运行在 build 后临时 bundle、受管临时 project root 和隔离 AW_HOME 中，不污染用户真实安装状态。

## 当前基线调研

- `packages/cli/src/types.ts`：`PluginManifestSource` 目前包含 `skills`、`skillTriggers`、`mcpServers`、`apps`、`extensions`、`buildConfig`，没有 AW 自定义脚本和 AW 自管配置字段。`PlatformAdapter` 只有 install/uninstall/upgrade/status 和 repo-managed artifacts 接口。
- `packages/cli/src/utils/manifest.ts`：source manifest 严格拒绝未知字段；新增 `scripts` / `config` 必须同步类型、normalizer、source-only 校验、bundle-mode 校验和测试。
- `packages/cli/src/generators/local-plugin.ts`：build 只把声明过的平台能力复制进 `claude/`、`codex/` 子目录，`.agents-plugin/plugin.json` 会复制到 bundle root。生命周期脚本不是平台原生能力，不能塞进 `manifestOverrides`，需要新增 AW-managed files 复制路径。
- `packages/cli/src/utils/bundle-layout.ts`：当前校验 Claude/Codex runtime manifest 和平台文件，不校验 bundle root 下的 AW 脚本文件。新增脚本后，layout 校验要检查 `.agents-plugin/plugin.json` 中声明的脚本路径在 bundle root 内存在。
- `packages/cli/src/commands/runtime.ts`：已经提供 `CommandExecutionContext`、`createCommandExecutionContext()`、`createCliExecutionContext()`、统一 `CliPrompt`、instrumented native runner、reporter 和 debug logger。配置向导必须扩展现有 `CliPrompt`，不能新建一套交互/TTY/CI 判断；但当前默认 `createReadlinePrompt()` 仍把 prompt 文案写到 `process.stdout`，`createCliExecutionContext()` 也用 `stdin.isTTY && stdout.isTTY` 判定交互可用性，还没有隐藏输入能力。`aw config configure --json` 和需要确认的 `reset --json` 落地前，必须先把这层 runtime 合同补齐。
- `packages/cli/src/commands/options.ts`：执行型命令已经默认 `scope=user`、`platform=auto`；`normalizeStatusCommandOptions()` 已经把 `scope/platform` 当过滤条件处理。`aw config` 可以复用 `parseScopeValue()`，但需要自己的读写默认语义，不能复用执行型命令的 `platform` 推断。
- `packages/cli/src/commands/discovery.ts` 和 `status.ts`：status 已经通过 discovery 枚举 ledger、tracking、原生配置、runtime evidence 和 current catalog，并输出 `StatusMatrixReport`。config/script health 应作为矩阵 cell 的派生健康信息接入，输入使用安装时快照、`currentCatalog` 和 historical evidence。`activeLocalBundle` 只能作为当前 runtime/local marketplace 证据和漂移诊断，不能直接当作“已安装那一版 bundle”的真值。
- `packages/cli/src/commands/install.ts`：安装顺序是 skill trigger 物化、`adapter.installPlugin()`、`adapter.installExtensions()`、tracking、ledger。生命周期脚本应插入在平台状态和 repo-managed artifacts 写完之后、tracking/ledger 提交之前，这样失败时还能进入现有回滚和 degraded ledger 语义。
- `packages/cli/src/commands/upgrade.ts`：upgrade 复用 uninstall + install 的编排。需要区分用户真实 uninstall 和 upgrade 内部为了 capabilityChanged 做的清理，避免 upgrade 误触发插件 `uninstall` 生命周期。
- `packages/cli/src/commands/uninstall.ts`：卸载会先调用平台原生 uninstall，再清理 artifacts、tracking、ledger。插件卸载脚本如果要读取配置、旧 tracking 或旧 bundle，必须在平台卸载和 artifact 清理之前执行；失败则中止卸载。
- `packages/cli/src/utils/local-marketplace.ts`：`~/.aw` 当前会被 `initializeLocalMarketplace()` 原子替换，只保留 `installed.json`，并重放 skill trigger 偏好。若把用户配置和安装时 lifecycle/config 快照直接放到 `~/.aw`，必须在重建时显式保留对应目录，否则刷新会让 uninstall/status 静默滑到新 marketplace 版本。
- `packages/cli/src/utils/paths.ts`：已有 `resolveAwHome()`、`resolveClaudePaths()`、`resolveCodexPaths()`、repo root 解析。新增 AW 自管配置 store 应复用这些路径规则；project config 走 repo root，但不能和 Claude/Codex 平台安装 identity 混用。
- `docs/plugin-authoring.md` 和 `.agents/skills/create-agent-workflows-plugin/references/*`：作者文档已说明 Claude-only `userConfig` 和命令结果填充；这次要把 AW 自管配置写成独立入口，避免读者误以为只能靠 Claude 原生 `userConfig`。
- 测试基线：unit / integration 保持 build-free，使用 `tests/helpers/embedded-root.ts` 生成 synthetic embedded root；真实 `pnpm install`、manifest build、production dependency closure 扫描和完整 `plugin:test` staging 回归只能放到 smoke 或单独 opt-in suite，不能进入常规 `pnpm test`。插件脚本测试 runner 也应遵守这个分层，入口源码放在 `packages/cli/scripts/*.ts`，由包脚本先做 CLI compile-only 再运行已编译入口；`.agents/skills/create-agent-workflows-plugin/` 只维护作者技能说明、脚手架和校验工具。

## Source Contract

### 1. 新增 `scripts`

在 `.agents-plugin/plugin.json` 顶层新增可选 `scripts`：

```json
{
  "scripts": {
    "timeoutMs": 30000,
    "lifecycle": {
      "install": "./scripts/lifecycle.mjs",
      "upgrade": {
        "default": { "runner": "node", "path": "./scripts/lifecycle.mjs" }
      },
      "uninstall": {
        "unix": { "runner": "sh", "path": "./scripts/uninstall.sh" },
        "windows": { "runner": "powershell", "path": "./scripts/uninstall.ps1" }
      }
    },
    "helpers": {
      "config": "./scripts/aw-config.mjs"
    },
    "node": {
      "packageRoot": "./scripts",
      "build": {
        "runner": "node",
        "path": "./scripts/build.mjs",
        "args": []
      }
    },
    "tests": {
      "node": ["./scripts/**/*.test.mjs"]
    }
  }
}
```

规则：

- lifecycle 支持三个事件：`install`、`upgrade`、`uninstall`。每个事件可以写成插件内 `./` 相对路径简写，也可以写成按 OS 选择的对象。所有脚本路径都必须在插件根目录内，不能是绝对路径，不能逃出插件根目录。
- 字符串简写等价于 `{ "default": { "runner": "auto", "path": "<value>" } }`。`auto` 按扩展名选择 runner：`.js` / `.mjs` / `.cjs` 用 Node，`.sh` 用 POSIX `sh`，`.ps1` 用 Windows PowerShell，`.cmd` / `.bat` 用 Windows `cmd`。无法在当前 OS 上解析时，安装、升级、卸载必须在写 native state 前失败，并给出明确错误。
- 结构化 lifecycle entry 支持 `default`、`unix`、`windows`、`linux`、`darwin`、`win32` 这些 selector；解析顺序按当前 OS 固定为“窄 selector -> 宽 selector -> `default`”：Linux 使用 `linux -> unix -> default`，macOS 使用 `darwin -> unix -> default`，Windows 使用 `win32 -> windows -> default`。宽 selector 只在对应窄 selector 缺失时兜底，不能覆盖窄 selector。
- 结构化脚本条目形如 `{ "runner": "node|sh|bash|pwsh|powershell|cmd|auto", "path": "./scripts/file", "args": [] }`。`args` 必须是字符串数组，由 AW 作为 argv 传入，不经过 shell 拼接。
- Node 脚本推荐 `.mjs`，避免和仓库 `"type": "module"`、外部插件包边界混淆。shell 脚本推荐为 Windows 单独提供 `.ps1` 或 `.cmd`，不要假设 Windows 存在 `sh` / `bash`。
- 发布包里的每个 lifecycle 事件必须能在 `linux`、`darwin`、`win32` 至少解析到一个脚本条目，除非 manifest 后续新增明确的 OS 支持范围字段。这样不强迫所有插件用同一个脚本文件，但不能让 Windows 用户在安装中途才发现没有可执行 lifecycle。
- `scripts.helpers.config` 是首版唯一标准 helper 显式声明，值为插件内 `./` 相对路径，必须指向 Node 可运行文件（`.js` / `.mjs` / `.cjs`）。它是 build 复制、bundle-layout 校验、脚手架生成、作者工具验证和 smoke 断言的共同真值；字段缺失时，CLI 不会隐式复制 `./scripts/aw-config.mjs`，也不承诺 Claude 命令结果填充可用。
- `scripts.node` 是可选的 Node 包与构建声明。缺省时保持纯文件模式：Node lifecycle、helper 和测试只能使用 `node:` 内置模块和插件内相对 import。声明后，`packageRoot` 必须是插件内 `./` 相对目录，目录下必须提交 `package.json` 和 `pnpm-lock.yaml`；运行时第三方依赖写在 `dependencies`，只供 build/test 使用的依赖写在 `devDependencies`。首版只支持 pnpm lockfile，不自动识别 npm/yarn/bun。
- `scripts.node.packageRoot/package.json` 首版只接受 registry-backed 依赖 specifier：普通 semver range、dist-tag 和 `npm:` alias。`dependencies` / `devDependencies` 中出现 `workspace:`、`file:`、`link:`、`portal:`、本地路径、git 协议、GitHub/GitLab/Bitbucket shortcut、HTTP(S) URL 或 tarball URL 时，manifest / authoring 校验必须在对应 staging install 前确定性报错。首版也不接受 `optionalDependencies` / `bundledDependencies` 作为 runtime 依赖入口；需要平台可选依赖时，先用 manifest build 入口生成纯 JS runtime 输出。
- staging install 使用 `pnpm install --frozen-lockfile --ignore-scripts`。声明 `scripts.node.build` 时，build 前的 install 只为构建入口提供受控依赖环境：必须先校验 source manifest 中 `packageRoot` 的 package metadata 和依赖来源，避免在 build 前下载非 registry 依赖，但不能把这次 install、lockfile 或 production closure 当作最终发布真值。manifest build 完成并重新读取 staging manifest 后，只要最终 manifest 仍声明 `scripts.node.packageRoot`，就必须以最终 `packageRoot/package.json` 和 `pnpm-lock.yaml` 重新执行依赖来源校验、`pnpm install --frozen-lockfile --ignore-scripts`，再扫描最终 production dependency closure 中每个包的 `package.json`。只要最终 runtime 依赖闭包里有 `preinstall`、`install`、`postinstall` 或 `prepare`，就把它判为首版不支持的 dependency install script，并以 authoring validation 错误结束，不产出半成品 bundle。`devDependencies` 若依赖 install script，只能在 `--ignore-scripts` 环境下自证 build/test 可用；它们不进入 runtime bundle。
- `scripts.node.build` 是可选的构建期入口，必须用 manifest 显式声明，不能从 `package.json` scripts、`preinstall`、`postinstall`、`prepare` 或其它 npm lifecycle 隐式触发。首版 build 入口只支持 `{ "runner": "node", "path": "./...", "args": [] }`，路径必须在插件根目录内；需要 TypeScript、代码生成或打包时，由这个 Node build 文件读取 `scripts.node.packageRoot` 中安装好的 dev 依赖完成。
- `pnpm build` / `plugin:test` 遇到 `scripts.node` 时，先把插件 source 复制到隔离 staging 目录。声明 `scripts.node.build` 时，先按 source manifest 的 `packageRoot` 做 build 前依赖来源校验和 install，再在 staging 插件根运行该 build 文件；未声明 build 时，复制后的 staging source 就是最终校验基准。源码树不被修改。
- `scripts.node.build` 允许改写 staging 目录里的 `.agents-plugin/plugin.json`、`scripts.node.packageRoot`、`package.json`、`pnpm-lock.yaml` 和依赖声明。build 完成后，staging manifest 是发布真值：marketplace entry、bundle source manifest、Claude/Codex platform manifest base、脚本路径校验、runtime 文件收集和 `plugin:test` 测试入口发现都必须从 staging manifest 重新读取。插件 identity `name` 必须和 source manifest 保持一致，避免命令选择、bundle 输出路径和 marketplace source 分叉；如果 build 后 `name` 改变，打包阶段必须报错。
- build 后最终 manifest 如果声明 `scripts.node.packageRoot`，打包和 `plugin:test` 必须重新读取最终 packageRoot，完整重跑依赖来源校验、`pnpm install --frozen-lockfile --ignore-scripts` 和最终 production dependency closure 扫描；这一步即使 packageRoot 路径看似没变也必须执行，不能复用 build 前 `node_modules`、package metadata、lockfile 或闭包扫描结果。build 后新增非 registry 依赖、runtime dependency install script、未声明 bare import，或最终 packageRoot 缺失 metadata / lockfile，都必须在 authoring validation 阶段失败。build 后移除 `scripts.node` 时，最终 runtime import contract 回到纯文件模式，不复制旧 packageRoot 的依赖。
- 发布 bundle 只携带运行时需要的 production 依赖：构建完成后把 `packageRoot/package.json`、`pnpm-lock.yaml` 和 production `node_modules` 放入 bundle 中相同相对目录，`devDependencies` 和构建中间缓存不进入 runtime bundle。`aw install`、`aw upgrade`、`aw uninstall` 和 lifecycle 执行期间绝不联网安装依赖，也不借用宿主或仓库根的 `node_modules`。
- Node import contract 改为声明式：没有 `scripts.node.packageRoot` 时继续拒绝所有第三方 bare package import；声明后，位于 packageRoot 内的 lifecycle/helper/runtime 模块可以 import `dependencies` 中声明的第三方包，测试和 build 文件还可以 import `devDependencies`。任何未声明 bare specifier、从 packageRoot 外部 runtime 文件引用第三方依赖、或通过相对路径逃出插件根 / staging bundle 的 import 都必须在 build/test 前报错。
- runtime Node 文件闭包是发布 bundle 的一等合同：从每个 Node lifecycle 入口、`scripts.helpers.config` helper，以及这些文件递归引用的 runtime 模块出发，收集可静态识别的相对 `import` / `export ... from` / `require()` / literal dynamic `import()`。收集到的相对依赖文件按插件内原路径复制进 bundle root，并继续参与 import contract 扫描；未被这个闭包命中的测试文件、test-only helper、build 入口和 dev-only 模块不进入发布 runtime bundle。相对依赖仍必须留在插件根 / staging bundle 内；不可静态识别的运行时加载不作为发布依赖入口，作者需要改成静态 literal 引用，或在 manifest build 中产出可静态扫描的 runtime 文件。
- `scripts.timeoutMs` 是可选的脚本级默认超时，挂在 `scripts` 顶层，单位毫秒，只接受整数。首版合法范围固定为 `1000` 到 `300000`，默认值为 `30000`。manifest validator 对缺失值使用默认值，对越界、非整数、非数字直接报错；normalizer 不做 clamp，避免用户以为写入的值被原样采用。
- 有效超时优先级固定为：CLI `--script-timeout <ms>` > manifest `scripts.timeoutMs` > runtime 默认 `30000`。CLI 覆盖同样必须是 `1000..300000` 的整数，解析失败或越界时在命令入口返回业务错误，不进入 lifecycle spawn。
- `scripts.tests.node` 是开发期 glob 数组，相对于当前测试基准插件根目录。未声明 `scripts.node.build` 时，它来自 source manifest；声明 build 时，`plugin:test` 必须先完成 staging build、重新读取 staging `.agents-plugin/plugin.json`，再使用最终 staging manifest 中的 `scripts.tests.node` 发现测试入口。manifest build 可以新增或改写测试入口 glob；运行时安装不会读取它。
- `scripts.tests.node` 只决定测试入口文件，不要求把所有 test-only helper 都写进 glob。`plugin:test` 会从匹配到的测试入口出发，递归扫描可静态识别的相对 import / require，把尚不存在于临时 bundle 的 test-only helper 复制到相同相对路径；如果目标路径已经是 bundle runtime 文件，测试 import 必须命中该 runtime 文件，runner 不覆盖它。递归复制仍然只能发生在当前测试基准插件根目录内，不能把 `sourceRoot` 当作 runtime import 根。
- `scripts` 是 AW CLI contract，不会写入 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- build 后 `scripts.lifecycle.*`、`scripts.helpers.*`、`scripts.node.packageRoot`、`scripts.timeoutMs` 和 `config` 保留在 bundle source manifest；runtime 入口文件、这些入口的相对依赖闭包、配置 helper 依赖闭包，以及 `scripts.node.packageRoot` 下的 production 运行时依赖都保留在 bundle root 的同一相对路径，例如 `~/.aw/plugins/<name>/scripts/lifecycle.mjs`、`~/.aw/plugins/<name>/scripts/lib/context.mjs`、`~/.aw/plugins/<name>/scripts/aw-config.mjs` 和 `~/.aw/plugins/<name>/scripts/node_modules`，供 AW CLI、生命周期脚本和插件自定义脚本读取；测试文件和 test-only helper 不复制进发布 runtime bundle。OS selector 下声明的所有 lifecycle 文件都要复制，不能只复制当前构建机可运行的那一个。

首版不支持：

- 内联命令字符串，例如 `"npm run setup"`、管道、重定向或环境变量插值。需要 shell 时必须提供脚本文件和可选 `args` 数组。
- 用 `shell: true` 执行 lifecycle。即使 runner 是 `sh`、`powershell` 或 `cmd`，也必须由 AW 显式构造可测试的 argv。
- 多个 lifecycle 脚本数组。需要复用时，由插件自己的 Node 入口按事件分发。
- per-Claude/Codex lifecycle 覆盖。脚本 context 会带 `platform`，插件可自行分支；本轮只支持按操作系统选择脚本，避免把平台 scope、OS 和 runtime 三种维度混在同一层。
- per-event 或 per-selector timeout 覆盖。首版只支持 `scripts.timeoutMs` 一个顶层默认值；如果后续要让 uninstall 更长或 Windows 脚本单独配置超时，需要另起 contract 并同步 runner、validator 和测试。
- 运行时安装依赖、运行时执行 package manager、从仓库根或用户全局环境借用依赖。所有第三方依赖都必须在 `pnpm build` / `plugin:test` 的隔离 staging 阶段安装并进入 bundle。
- npm/yarn/bun lockfile、多 packageRoot、非 registry 依赖来源、runtime dependency install scripts、`package.json` lifecycle scripts 自动执行。首版只允许 pnpm + registry 依赖 + 显式 manifest build 入口，先保证发布 bundle 可复现、运行时离线。

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
- 首版类型支持 `string`、`number`、`boolean`、`enum`、`file`、`directory`。配置项字段使用严格 allowlist：所有类型都只接受 `type`、`title`、`description`、`default`、`required`、`sensitive`；`enum` 额外接受 `values`；`number` 额外接受 `min`、`max`。其它字段按未知字段报 manifest validation 错误，避免 normalizer 默默吞掉作者拼写错误。
- `title` 是可选字符串，用于 `configure` prompt、`list` 和 JSON schema 摘要；缺失时显示 key。`description` 是可选字符串，用于 prompt 说明和 schema 摘要；它不是敏感值，作者不能把 secret 示例写进 description。`title` / `description` 不参与脚本 context 的 `config.values`。
- `enum.values` 必须是非空字符串数组，`default` 和写入值必须命中其中一个值。
- `number.min` / `number.max` 是可选有限数字，语义是闭区间边界；同时存在时必须满足 `min <= max`。`default`、`config set` 和 `configure` 写入的 number 都必须落在边界内；边界校验失败时返回 schema validation 或 config validation 错误，不做 clamp。非 `number` 类型写 `min` / `max` 必须报错。
- `required: true` 表示安装或升级前必须能解析出有效值，值可以来自用户配置，也可以来自 `default`。
- `sensitive: true` 首版只表示 CLI 输出、status 和测试日志需要脱敏；不承诺系统 keychain 或加密存储。落盘文件使用 `0600` 权限 best effort。
- 配置 schema 是 AW 自管配置的唯一真值。`buildConfig.manifestOverrides.claude.userConfig` 仍是 Claude 原生能力，可用于桥接，但不参与 AW config 命令的读写。

首版不支持：

- 嵌套对象配置。
- 配置项间依赖、动态 default 或脚本自定义 prompt。交互式配置只由 AW CLI 按静态 schema 统一渲染，插件脚本不能自行接管安装 prompt。
- 把敏感配置写入 Claude `userConfig` keychain。后续若要桥接，需要单独设计迁移和同步策略。

## 配置存储与 CLI

新增路径 helper，例如 `packages/cli/src/utils/plugin-config.ts`：

- user scope：`<AW_HOME>/plugin-config/<plugin>/config.json`
- project scope：`<repoRoot>/.agent-workflows/plugin-config/<plugin>/config.json`

project scope 是 AW 自管配置 scope，保持平台中立：用 repo root，而不是命令执行子目录。这样同一个仓库中的 Claude / Codex 插件默认读到同一份项目配置。它不能被拿来推断平台安装 identity；当前 discovery / status 仍按平台区分 project key：Codex project 证据锚定 repo root，Claude project 安装证据锚定调用目录 realpath。

如果 `cwd` 不在 git repo 或 `pnpm-workspace.yaml` 工作区内，AW project config root 明确退回 normalized command `cwd`，也就是 `<cwd>/.agent-workflows/plugin-config/<plugin>/config.json`。这沿用 `resolveRepoRootSync(cwd)` 当前行为，和 `file` / `directory` 相对路径锚点保持一致；CLI entry、direct command、install/upgrade preflight、status 健康检查和无 `AW_PLUGIN_CONTEXT` 的 helper fallback 都必须调用同一份 AW project root resolver，不能在非仓库目录下各自猜测或拒绝。

`<plugin>` 必须先经过统一的 config store path segment 校验，再进入 `path.join()`：只允许非空单段插件名，拒绝 `/`、`\`、`.`、`..`、绝对路径、URL-like 值和任何会在当前平台或另一平台变成路径分隔的输入。这个校验不能依赖 current catalog 是否存在，因为 `aw config reset <plugin>` 在 catalog 缺失时也要能走 raw-store 清理路径；非法插件名必须返回确定性业务错误，不能尝试读取或删除文件。

`~/.aw` 重建时必须保留 `plugin-config/`。实现上可以让 `initializeLocalMarketplace()` 在 staging 替换前复制旧的 `plugin-config/`，或把用户配置移到与 marketplace bundle 不同的目录。首版若继续放在 `AW_HOME` 下，就必须把“重建不删除配置”写进测试。

新增 CLI 命令：

```bash
aw config list <plugin> [-s|--scope project|user] [-j|--json]
aw config get <plugin> [key] [-s|--scope project|user] [-j|--json]
aw config set <plugin> <key> <value> [-s|--scope project|user] [--value-json] [-j|--json]
aw config configure <plugin> [-s|--scope project|user] [-i|--interactive] [--no-interactive] [-j|--json]
aw config unset <plugin> <key> [-s|--scope project|user] [-j|--json]
aw config reset <plugin> [-s|--scope project|user] [-i|--interactive] [--no-interactive] [-y|--yes] [-j|--json]
```

行为：

- `set` / `unset` / `reset` / `configure` 是写命令，默认写 user store；`project` 必须显式传 `--scope project` 或在交互式 prompt 中选择。
- `get` / `list` 是读命令，未传 `--scope` 时展示 effective config；传 `--scope user|project` 时只展示对应 store 与 schema/default 的关系，方便排查某一层到底写了什么。
- config 命令也接入通用 `-v/--verbose`、`-D/--debug`、`--log-file <path>` 和 `-j/--json`；这些开关只影响输出 / reporter / debug log，不改变配置读写语义。`--json` 在整个 `aw config` 命令组里只表示机器可读输出，不参与 `<value>` 解析。
- `set` / `configure` / `unset` / `get` / `list` 读取 current catalog / embedded catalog 中的插件 manifest，校验插件声明了对应 `config.schema`。读取 catalog 必须使用 `CommandExecutionContext.env`，config 命令实现不能回落到 `process.env`。
- `aw config` 的 schema-aware 命令只要求插件存在于 current catalog 且声明了 schema，不要求目标 `scope` 已安装该插件，也不能因为配置文件存在就把该插件判断为已安装。这样 user scope 安装的插件可以有 project 配置覆盖，project scope 安装的插件也可以使用 user 默认配置。
- `set` 按 schema 解析值；普通模式把 CLI `<value>` 当字符串再按 schema 转类型。需要显式传 JSON literal 时使用 `--value-json`，先对 `<value>` 做 `JSON.parse`，再按 schema validate/coerce。`--value-json` 只影响输入值解析，不改变 stdout 格式；`--json` 只影响输出格式。`--value-json --json` 可以组合，语义是“按 JSON literal 解析输入，并输出 JSON receipt”。
- `file` / `directory` 配置值本质上是路径字符串。`set` / `configure` 写入时，相对路径统一按 AW project root 解析，也就是 `resolveRepoRootSync(cwd)` 的结果；没有 git repo 时才退回 normalized command `cwd`。这条规则不随命令调用子目录变化，因此在 repo root 和 repo 子目录用同一个相对路径写同一个配置，得到同一个目标路径。绝对路径按原路径解析；`~`、环境变量和 glob 不做展开，避免 shell 与 API 入口行为分叉。
- `file` / `directory` 写入前必须 `realpath`，并校验存在且类型正确。落盘值固定为 canonical absolute realpath 字符串，user store 和 project store 都一样；首版优先保证所有入口解释一致，不尝试保存 repo-root-relative 路径。后续如果需要可迁移的相对路径格式，需要另起字段或版本化迁移。
- manifest default 中的 `file` / `directory` 值也按同一个 AW project root 锚点解析。default 不落盘，但进入 `config.values`、helper 输出和 lifecycle context 时必须是已经解析后的 absolute realpath。
- 每次调用 `resolveEffectivePluginConfig()` 都要重新校验 `file` / `directory` 的存在性和类型，不只在写入当下校验。路径被删除、类型变化或 default 失效时，该 key 进入 `invalid-config` issue；`aw config get/list` 要明确展示问题并给出 `set` / `unset` / `reset` 修复建议，install / upgrade preflight、lifecycle context 和无 `AW_PLUGIN_CONTEXT` 的 helper fallback 必须 fail closed，不能把失效路径交给脚本。`unset` / `reset` 仍可清理失效值，不被重校验阻塞。
- `configure` 是 schema 驱动的交互式配置向导：TTY 且允许交互时默认进入 prompt；先读取 effective config 作为当前展示值，再按 required、缺失值和用户选择的 key 渲染输入；`sensitive: true` 的 string 用隐藏输入；`enum` 用候选选择；`boolean` 用确认；`file` / `directory` 校验路径存在和类型。prompt 返回的更新值必须再次按 schema validate/coerce，不能信任 UI token。
- 配置向导的 prompt 合同必须显式支持写入层选择：调用方传入 `initialScope`、`allowedScopes` 和 effective 当前值，prompt 返回 `selectedScope`、本次显式更新的 `updates` 以及 `updatedKeys`。`aw config configure` 未显式传 `--scope` 时使用 `initialScope: "user"`、`allowedScopes: ["user", "project"]`；显式传 `--scope user|project` 时，该参数是硬约束，命令必须传 `initialScope: <scope>`、`allowedScopes: [<scope>]`，prompt 不能改写到另一层。install / upgrade preflight 不属于显式 `config configure --scope` 语义，仍使用命令目标 scope 作为 `initialScope`，并允许用户在 prompt 中改写到另一层。命令层只能把 `updates` patch 到 `selectedScope` 的原始 store 上，不能把 effective config 的整份 values 全量写入目标层。prompt UI 如果内部维护整张表单，也必须返回 dirty key set；未修改 key，尤其是另一层已有的 sensitive key，不得因为切换 scope 被复制到目标 store。写完后必须重新解析 effective config，再继续 required 校验和 lifecycle。
- prompt 返回 `cancelled: true` 时，命令必须以确定性的业务错误结束，不写入任何部分配置。`aw config configure` 取消后不创建或修改 user/project store；install / upgrade preflight 取消后必须停在 native state、repo-managed artifacts、tracking 和 ledger 写入之前，并输出 `aw config configure` / `aw config set` 的补救建议。prompt 实现应在用户最终确认前只保留内存态 values，命令层不能边问边写。
- `configure` 在非 TTY、`CI=true`、`--no-interactive` 或未注入 `prompt` 时不挂起，返回业务错误并提示等价的 `aw config set <plugin> <key> <value> -s <scope>` 命令。后续如果需要非交互批量写入，可另加 `--from-json <file>`，首版不把它混入交互式向导。
- `get` 默认输出 effective config 的脱敏值；`--json` 输出结构化 JSON，并附带每个 key 的来源 `project|user|default|missing` 和 schema/path validation issues。敏感值仍默认 redacted，后续可加 `--show-sensitive`，但首版不建议开放。
- `set` / `configure` / `unset` / `reset` 的 `--json` 输出稳定 JSON receipt，不输出人类文本到 stdout。`set` / `configure` receipt 至少包含 `ok`、`command`、`plugin`、最终写入 `scope`、本次显式更新的 `updatedKeys`，以及重新解析后的 effective config 摘要；`unset` receipt 至少包含 `ok`、`command`、`plugin`、`scope`、`removedKey`、该 key 删除前是否存在，以及重新解析后的 effective config 摘要；`reset` receipt 至少包含 `ok`、`command`、`plugin`、`scope`、目标 store 删除前是否存在、是否已删除，以及 reset 后可安全展示的剩余状态。所有摘要必须沿用统一脱敏规则，不能暴露 sensitive 值。`configure --json` 和需要确认的 `reset --json` 在交互可用时仍可进入 prompt，但 prompt 文案、verbose、warning 和 debug log 路径只能走 stderr 或 log file。
- `list` 输出 schema、是否已配置、来源层、是否来自 default、是否 required，不打印敏感值。
- `reset` 是 store 级清理命令，不需要 schema 参与。current catalog 缺失但目标 user/project config store 存在时，`aw config reset <plugin>` 仍必须能删除对应 store，避免卸载后残留的敏感配置无法清理。没有 schema 时不做脱敏展示，人类输出或 JSON receipt 只包含删除结果；如果 store 也不存在，再返回“没有可重置配置”的确定性结果。
- `reset` 删除该 scope 下插件配置文件，不删除另一层配置。删除 project store 后可能回落到 user store；删除 user store 后也可能仍被 project store 覆盖。
- 所有 config 命令，包括 schema-aware 的 `set/get/list/configure/unset` 和 raw-store 的 `reset`，都必须先调用同一份插件名 path segment 校验。`reset` 允许没有 schema，但不允许不安全路径；`unset` 虽然需要 schema，也不能把 catalog manifest name 当作绕过命令入参校验的理由。
- current catalog 缺失时，首版不提供 schema-less `get` / `list`，因为无法可靠脱敏或解释 default/source；错误信息必须提示用户可用 `aw config reset <plugin> [-s scope]` 交互清理，或在非交互环境中显式追加 `--yes`。`set` / `configure` / `unset` 同样需要 current schema。
- `reset` 是 destructive 命令。目标 store 存在且会被删除时，`--yes` 直接确认删除；未传 `--yes` 且允许交互时必须通过 `context.prompt.confirm` 二次确认，用户拒绝或取消时返回业务错误且不修改任何 store；非 TTY、`CI=true`、`--no-interactive` 或未注入 prompt 时，未传 `--yes` 必须失败并提示可复制的 `aw config reset <plugin> -s <scope> --yes`，不能误 prompt，也不能静默删除。目标 store 本来不存在时返回 no-op 结果，不需要确认。
- `--json` 的 `stdout` 必须保持单一可解析 JSON。人类诊断、debug log 路径、verbose 输出和 warning 只能进入 `stderr` 或 debug log；任何 config 子命令都不能把 `--json` 解释成输入解析开关。
- install / upgrade 在执行 lifecycle 前调用 `resolveEffectivePluginConfig()`。缺 required 配置时，如果交互可用，在写 native state 前调用同一套 `configure` prompt 并落盘；否则在写 native state 前失败。自动补问默认写入本次命令的目标 scope，但 prompt 需要允许用户改写入层。
- install / upgrade 的 required config preflight 必须按 `pluginName + schema source manifest identity` 聚合缺失项，而不是按 `platform + target` 格子逐个补问。同一个插件在同一条命令中只触发一次配置向导、只按 prompt 返回的 `selectedScope` 写一次 config store；随后对所有复用该 schema source 的 platform/target 重新解析 effective config。重复 target、`--platform both` 或 upgrade 复用 install 编排时，都不能产生二次 prompt、二次落盘、二次 receipt 或二次 warning。
- `aw uninstall` 默认保留 AW config store；卸载插件不等于删除配置。清理配置必须显式运行 `aw config reset <plugin>`，这样也支持用户先配置、后安装，或卸载后保留下一次安装要用的配置。

配置解析顺序：

1. 配置解析函数必须显式接收“schema 来源 manifest”。普通 `aw config get/list/set/configure/unset` 和 install/upgrade preflight 使用 current catalog manifest；install / upgrade lifecycle 使用本轮从 current catalog 固化出的安装快照；historical uninstall 使用 ledger 中当前 `platform + scope` 记录的安装时快照。只要 lifecycle 脚本来自安装快照，就必须用同一快照里的 `.agents-plugin/plugin.json` 解析 `config.schema` 和 default，不能混入 current catalog。
2. 标准 helper 的 schema 来源分两条：存在 `AW_PLUGIN_CONTEXT` 时直接使用 context 中已经解析好的 `config.schema`、`config.values` 和 `config.sources`；没有 context 时，helper 必须从 `import.meta.url` 定位当前 bundle 根目录，并读取同一 bundle 邻近的 `.agents-plugin/plugin.json` 作为 schema/default/redaction 真值，不解析 current catalog。CLI 升级但本地 marketplace 尚未刷新时，helper 可能和 `aw config get/list` 使用不同 schema；这是预期的 runtime-bundle 视图差异，必须在文档和测试里明确。helper 找不到或无法校验 bundle manifest 时要 fail closed，返回确定性错误；这条失败路径不能回退到 raw config store、current catalog 或任何 schema-less 输出，也不能在 stdout、stderr、debug log 或 log file 中 raw 打印落盘配置。
3. 读取 user/project raw store 后，必须先按当前“schema 来源 manifest”的 key allowlist 过滤。store 中不存在于该 schema 的旧 key 只进入 `ignoredUnknownKeys` 诊断，不能进入 effective values、helper 输出、lifecycle context、status 健康或 `aw config get/list` 的可见值；诊断最多展示 key 名和来源层，绝不打印旧值。schema-aware 写命令默认保留这些未知 key 的原始落盘内容，避免一次 `set` 意外删除用户数据；需要清理时用 `aw config reset <plugin>` 删除整个 scope store。
4. 先应用 manifest default。
5. 再合并 user store。
6. 最后合并 project store；同名 key 以 project store 为准。
7. `required` 校验只看最终 effective config。某个 key 只要被 user store、project store 或 default 满足，就不应阻塞 install/upgrade/lifecycle。
8. 生命周期 context、标准 helper、status 健康检查和 `aw config get/list` 默认都读取 effective config，并共享同一套 `file` / `directory` 重新校验结果；显式 `--scope user|project` 只用于读写单层 store。
9. status/discovery 不能反过来用 config store 判断插件是否已安装。
10. 输出给脚本前保留真实值，但 context 文件权限用 `0600`，并避免通过环境变量直接传敏感值。

## 安装快照与 manifest 真值

`activeLocalBundle` 只说明当前本地 marketplace 里有一个同名 bundle。Codex 的本地 marketplace 会在 `aw init --force`、stale refresh 和损坏重建时整体替换，所以这个路径不能证明自己仍是用户安装时那一版。首版必须为每个成功安装的 `platform + scope + plugin` 记录 lifecycle/config 安装快照，并把它作为 historical uninstall 和 status health 的首选真值。

实现约束：

- `InstalledScopeRecord` 或等价 scope ledger 记录新增 `lifecycleConfigSnapshot` 字段，至少包含 snapshot bundle root、manifest path、插件 name/version、source manifest digest、bundle fingerprint、创建时间和生成来源。scope key 必须跟现有 ledger 的 Claude / Codex user/project scope identity 对齐；每条 scope ledger 记录拥有自己的 snapshot root，不能把其它平台或其它 project 的快照拿来作为本记录的运行时根目录。
- 快照 bundle 存在于 marketplace 镜像之外，例如 `<AW_HOME>/plugin-install-snapshots/<platform>/<scope-key>/<plugin>/<digest>/bundle`，或等价的受管目录。首版明确采用按 scope 独立副本存储，不做按 digest 的全局 content-addressed 共享；digest 只用于校验和目录命名，不能作为跨 scope / project / platform 复用 bundle 路径的依据。若目录仍位于 `AW_HOME` 下，`initializeLocalMarketplace()` 必须像保留 `installed.json` 和 `plugin-config/` 一样保留它。
- install / upgrade 在写 native state 前先从本轮 current catalog 创建快照，并让 install / upgrade lifecycle、required config preflight 后的 context、以及最终 ledger 记录都引用这份快照。命令失败或回滚时要删除未被 ledger 引用的新快照，避免留下孤儿运行时代码。
- upgrade 成功后，scope ledger 指向新快照；旧快照按 exact snapshot root 引用关系清理，正常情况下只会被原 scope 记录引用。capabilityChanged 内部清理不触发用户可见的 `uninstall` lifecycle，也不能删除仍被 ledger 记录精确引用的快照目录。
- uninstall 成功后，必须先删除当前 `platform + scope + plugin` 的 ledger 记录并持久化，再按最新 ledger 引用关系回收该记录原先指向的 scope-owned 安装快照。其它 scope、project 或 platform 即使 source manifest digest 相同，也应位于自己的 snapshot root，不阻止当前 root 回收；若迁移或修复导致多个 ledger 记录精确指向同一个 snapshot root，必须等最后一个引用消失后才能删除。uninstall lifecycle 失败、平台卸载失败或 artifact/tracking/ledger 清理失败时，不触发这次快照回收。
- uninstall 和 status 先读取当前 `platform + scope` 的 ledger 快照，校验 digest、manifest path 和脚本 realpath 都在 snapshot bundle root 内；校验失败才降级到 current catalog / historical fallback，并把快照损坏或缺失写入 warning/debug 诊断。
- config/script health 的 `healthSource` 使用 `installSnapshot | currentCatalog | historical | none`。`activeLocalBundle` 可继续出现在 runtime evidence / drift 诊断中，但不能作为 `healthSource`，也不能直接参与 schema/default/lifecycle 选择。

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

AW lifecycle runner 运行 lifecycle 时、开发期测试 runner 运行 test 时，都会写一个临时 JSON context 文件，并把路径放到 `AW_PLUGIN_CONTEXT`。这个方式不依赖 Node 的 package resolution，外部插件也能稳定使用。标准 helper 在检测到 `AW_PLUGIN_CONTEXT` 时必须优先读取 context；只有在 CLI 外运行、没有 context 时，才回退到落盘 config store。

第二层是 CLI 外运行的配置读取脚本，服务 Claude 命令结果填充：

```bash
node ./scripts/aw-config.mjs get apiKey [--scope effective|user|project]
node ./scripts/aw-config.mjs json [--scope effective|user|project]
```

这个脚本不是隐式保留文件。插件必须在 manifest 中声明 `scripts.helpers.config`，build 才会把它复制进 bundle root，bundle-layout 和 pack smoke 也只检查这个字段指向的文件。脚手架生成的标准 helper 默认使用 `./scripts/aw-config.mjs`，但实现不能靠固定文件名扫描 source tree。

helper 通过 `import.meta.url` 找插件根目录，并读取同一 bundle 邻近的 `.agents-plugin/plugin.json` 作为 schema/default/redaction 真值；再通过 `process.cwd()` 解析 AW project root 和 project store，通过 `os.homedir()` / `AW_HOME` 查找 user store。默认读取 effective config，合并顺序和 `aw config get/list` 一致，并重新校验 `file` / `directory` 路径；需要排查单层配置时才显式传 `--scope user|project`。如果脚本被 lifecycle runner 或 `plugin:test` runner 启动且存在 `AW_PLUGIN_CONTEXT`，helper 直接使用 context 中已经解析好的 `config.values`、`config.sources`、`config.schema` 和 `paths.configStores`，不再重新猜测 home、project root 或 schema 来源。插件作者可以把脚手架生成的 helper 放进 Claude command 的命令结果填充：

```markdown
当前配置：!`node ${CLAUDE_PLUGIN_ROOT}/scripts/aw-config.mjs json`
```

实现计划：

- 在 `.agents/skills/create-agent-workflows-plugin/` 增加标准 helper 模板，例如 `assets/aw-config.mjs`。
- `init_plugin.js` 增加可选 `--with-config-api` / `--with-lifecycle`，生成脚本样板，并在 manifest 写入 `scripts.helpers.config`。
- `validate_plugin.js` 检查 `scripts.helpers.config` 指向的文件存在、扩展名可由 Node 运行，并复用 Node import contract 校验 helper 的依赖边界。首版不承诺静态分析任意 helper 读取了哪些配置 key；helper 输出运行时只会暴露当前 schema source allowlist 内的 key。
- 文档明确：生命周期脚本优先读 `AW_PLUGIN_CONTEXT`；Claude 命令结果填充读落盘 config store，不依赖 AW CLI 正在执行。helper 只能复用同一套 config path resolver 和 redaction 规则，不能自己拼 `~/.aw` 或 repo root 规则；无 context 时的 schema/default/redaction 永远来自当前 bundle 邻近 manifest，而不是 current catalog。

## 生命周期脚本运行时

新增模块建议：`packages/cli/src/utils/plugin-scripts.ts`。

脚本执行方式：

- 按 Source Contract 中固定的 OS selector 顺序解析当前 OS 的 lifecycle entry，再按 `runner` 构造 argv。Node runner 用 `process.execPath <scriptPath>`；`sh` / `bash` 用 `<runner> <scriptPath>`；PowerShell 用 `pwsh|powershell -NoProfile -ExecutionPolicy Bypass -File <scriptPath>`；`cmd` 用受控 quoting helper 构造 `cmd.exe /d /s /c <scriptPath>`。
- 不执行内联命令字符串，不使用 Node `spawn(..., { shell: true })`。所有 manifest `args` 都作为 argv 追加；Windows `cmd` 的脚本路径和参数必须经过专门的 quoting helper，并用单元测试锁住空格、引号和非 ASCII 路径。
- `cwd` 使用 normalized command options 中的 `cwd`；所有 env、日志、prompt 和 native runner 入口来自统一 `CommandExecutionContext`。
- `scriptPath` 来自 bundle root 内声明路径，先 realpath，再确认仍在插件 bundle root。Unix 上也通过显式 runner 启动脚本，不要求脚本有 executable bit；Windows 上 `.ps1` / `.cmd` / `.bat` 必须走对应 runner，不依赖 POSIX shell。
- lifecycle runner 写入的 `AW_PLUGIN_ROOT`、`AW_PLUGIN_CONTEXT.plugin.rootDir` 和 `resolveLifecycleScriptTarget()` 返回的 `bundleRoot` 必须是同一个 resolved lifecycle target bundle root。install / upgrade 使用本轮已创建、准备写入 ledger 的安装快照根目录；uninstall 使用当前 scope ledger 记录的安装快照根目录；只有快照缺失、损坏或无脚本并明确降级时才使用 current catalog 的 bundle root；`plugin:test` 使用每轮独立的临时测试 bundle root。脚本不能通过这两个 root 字段重新落回可被 marketplace refresh 改写的 `~/.aw/plugins/<plugin>`。
- context 写入临时文件，环境变量使用 OS-aware 白名单透传。共同白名单必须包含 `CommandExecutionContext.env` 中的 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME`、`PATH`，以及 runner 写入的 `AW_PLUGIN_CONTEXT`、`AW_PLUGIN_EVENT`、`AW_PLUGIN_NAME`、`AW_PLUGIN_ROOT`。POSIX 分支额外包含隔离后的 `HOME`、`TMPDIR`；Windows 分支额外包含隔离后的 `USERPROFILE`、`TEMP`、`TMP`，如实现需要设置 `HOMEDRIVE` / `HOMEPATH`，也只能从隔离 `USERPROFILE` 派生，不能透传宿主真实值。这样 PowerShell、`cmd`、Node `os.homedir()` / `os.tmpdir()` 和插件测试都不会回落到真实用户 home/temp；其它环境变量按 debug / redaction 合同选择性透传。
- 默认超时 30 秒；manifest 只能通过顶层 `scripts.timeoutMs` 设置脚本级默认值，CLI 可用 `--script-timeout <ms>` 覆盖。有效值必须是 `1000..300000` 的整数，优先级固定为 CLI 覆盖 > manifest 默认 > runtime 默认；runtime 执行前再次断言有效超时，不能 silent clamp。
- stdout/stderr 捕获后按行转成统一 reporter/debug logger 事件。敏感配置不进入 stdout/stderr，日志里也要复用当前 `output/redact.ts` 的 redaction 规则，并额外用 config schema 做脱敏扫描。

context 结构建议：

```json
{
  "version": 1,
  "event": "install",
  "plugin": {
    "name": "code-review",
    "version": "0.2.0",
    "rootDir": "/Users/me/.aw/plugin-install-snapshots/claude/project-abc/code-review/sha256-.../bundle"
  },
  "platform": "claude",
  "scope": "project",
  "cwd": "/Users/me/project",
  "paths": {
    "awHome": "/Users/me/.aw",
    "configStores": {
      "user": "/Users/me/.aw/plugin-config/code-review/config.json",
      "project": "/Users/me/project/.agent-workflows/plugin-config/code-review/config.json"
    },
    "trackingDir": "/Users/me/project/.claude"
  },
  "config": {
    "schemaSource": {
      "kind": "install-snapshot",
      "manifestPath": "/Users/me/.aw/plugin-install-snapshots/claude/project-abc/code-review/sha256-.../bundle/.agents-plugin/plugin.json"
    },
    "values": {
      "apiKey": "secret",
      "maxFiles": 10
    },
    "sources": {
      "apiKey": "project",
      "maxFiles": "default"
    },
    "schema": {}
  },
  "script": {
    "source": "install-snapshot",
    "runner": "node",
    "path": "/Users/me/.aw/plugin-install-snapshots/claude/project-abc/code-review/sha256-.../bundle/scripts/lifecycle.mjs"
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

- `CommandOptions` 增加 `scriptTimeoutMs?: number`，作为 install / upgrade / uninstall 的公共执行选项；`InstallCommandOptions`、`UpgradeCommandOptions` 和 `UninstallCommandOptions` 通过继承或公共字段获得这个值，status/config 这类只读或非 lifecycle 命令不消费它。
- `RawCommandOptions` 增加 `scriptTimeoutMs?: number | string`，`normalizeCommandOptions()` 统一解析 `1000..300000` 的整数；`normalizeInstallCommandOptions()`、`normalizeUpgradeCommandOptions()` 和 `normalizeUninstallCommandOptions()` 不能各自绕开或丢弃这个字段。
- CLI 增加 `--script-timeout <ms>`，不增加跳过脚本选项；该选项属于执行行为，不放进 `diagnostics`。
- install action 必须把解析后的 `scriptTimeoutMs` 传到 lifecycle runner；测试要能区分 CLI 覆盖、manifest `scripts.timeoutMs` 和 runtime 默认值，避免 install 路径声明了 option 却在命令编排中丢失。
- `installTargetsOnPlatforms()` 增加 operation 参数，默认 `"install"`；upgrade 调用时传 `"upgrade"`。
- 在任何 native state、repo-managed artifact、tracking 或 ledger 写入前，对本次 `platform x target` 计划矩阵整体执行 effective config preflight，不能放在现有逐 target 写入循环内部才检查。缺 required 配置且交互可用时，复用 `aw config configure` 的 schema prompt 写入目标 store，默认跟随命令 scope，但允许用户选择另一层；非交互时失败并提示配置命令。只要任一目标仍缺 required config，整个 install 必须在第一笔写入前结束，不能先安装其它“安全”目标。
- preflight 聚合键固定为 `pluginName + schema source manifest identity`。`--platform both`、重复插件名或同一插件同时覆盖多个 target 时，只补问一次并复用同一份解析结果；如果 prompt 把 `selectedScope` 从命令 scope 改到另一层，所有 platform cell 都必须使用这一次写入后的 effective config。
- 在 `installExtensions()` 之后、tracking 写入之前调用 lifecycle runner。脚本 target 来自本轮安装快照；runner 不直接从可被 marketplace refresh 改写的 `~/.aw/plugins/<plugin>` 读取脚本。
- 传入 `generatedArtifacts` 作为 context，便于脚本知道本轮 CLI 已写了哪些 repo-managed artifacts。

### upgrade

- `upgrade` CLI entry 增加 `--script-timeout <ms>`，并通过 `normalizeUpgradeCommandOptions()` 写入 `UpgradeCommandOptions.scriptTimeoutMs`。
- 显式 upgrade 调用 `installTargetsOnPlatforms(..., { operation: "upgrade" })`。
- `upgrade --all` 同样传 `upgrade`。
- upgrade 重新组装 install options 或调用 `installTargetsOnPlatforms()` 时必须透传 `scriptTimeoutMs`，确保 upgrade lifecycle 使用 CLI 覆盖值，而不是退回 manifest `scripts.timeoutMs` 或 runtime 默认值。
- capabilityChanged 时调用内部 uninstall 清理，但使用不对 CLI 暴露的内部清理标记，避免误触发插件 `uninstall` lifecycle。
- upgrade 与 install 共用 required config preflight，并且 preflight 必须发生在任何 target 的 capabilityChanged 内部 uninstall、install 或 lifecycle 之前。交互式显式 upgrade 和交互式“全部可升级”在任何写入前先补齐配置；非交互 `upgrade --all` 遇到缺 required config 必须 fail-fast，不能先处理安全子集。
- upgrade 复用 install 的 preflight 聚合结果。同一插件在 `--platform both` 或 `upgrade --all` 矩阵中只执行一次 schema prompt / config 写入 / receipt 输出，不能因为 capabilityChanged 或平台循环重复补问。
- 如果 upgrade 的 lifecycle 脚本失败，命令失败，并复用安装路径回滚和 degraded ledger 处理。

### uninstall

- uninstall 复用公共 `CommandOptions.scriptTimeoutMs`。
- CLI 增加 `--script-timeout <ms>`，不增加跳过脚本选项。
- uninstall action 必须把解析后的 `scriptTimeoutMs` 传到 lifecycle runner；测试要能区分 CLI 覆盖、manifest `scripts.timeoutMs` 和 runtime 默认值，避免 uninstall 路径声明了 option 却在平台卸载前执行脚本时丢失。
- `uninstallTargetsOnPlatforms()` 在读取 status、baseline ledger、tracking 后，平台卸载前执行 `uninstall` lifecycle。
- historical fallback 执行 uninstall lifecycle 前必须先解析“可执行脚本来源”，顺序固定为：当前 `platform + scope` ledger 中的安装快照 -> current catalog target -> warning fallback。
- `resolveLifecycleScriptTarget()` 不能只返回脚本路径；必须返回脚本 entry、bundle root、source manifest、manifest path 和来源类型。后续写入 `AW_PLUGIN_CONTEXT` 时，`config.schema`、default 合并和 `config.values` 都从这份返回的 manifest 解析。
- 如果 current catalog 和安装快照都能提供 lifecycle，以安装快照为准，并在 verbose/debug 里记录快照与 current catalog 的来源差异。这样卸载脚本和配置 contract 都来自 AW 实际安装出去的那一版 bundle，避免用新版 schema 解析旧版卸载脚本需要的配置。只有安装快照缺失、损坏或没有该 lifecycle 时，才回退到 current catalog。
- 安装快照的 manifest 读取入口放在 lifecycle 解析层，例如 `resolveLifecycleScriptTarget()`，只消费当前 `platform + scope` 的 ledger scope record，不能把其它 scope/platform 的 bundle 合进 historical target，也不能用 `activeLocalBundle` 的当前路径替代 ledger 快照。
- historical fallback 且 current catalog / 安装快照都找不到可执行 lifecycle 时，记录 warning 后按老插件清理路径继续；不能因为历史安装缺少 bundle 而阻塞用户清理。

### status

首版 status 只展示配置和脚本声明的健康摘要，不执行脚本：

- `config`: `configured | missing-required | invalid-config | no-schema`，并展示命中层摘要，例如 `project`、`user`、`default`、`mixed`。
- `scripts`: `declared | not_declared | missing-from-bundle | unsupported-on-current-os`
- lifecycle drift 只检查 bundle 路径、OS selector 和 runner 可解析性，不尝试判断脚本内部行为。
- 健康摘要必须按每个 `platform + scope + plugin` target 单独解析真值来源，并在 `status --json` 暴露稳定的 `healthSource` 字段：`installSnapshot | currentCatalog | historical | none`。
- 已安装 target 优先使用当前 scope ledger 记录的安装快照 manifest 作为健康真值。`config.schema`、default、required 校验、lifecycle 声明和 `scripts.helpers.config` 都必须来自这份 manifest；即使 current catalog 或 `activeLocalBundle` 同时存在且内容不同，也只把差异记录为 drift warning / debug 诊断，不能用它们计算 `config` 或 `scripts` 健康。
- 安装快照缺失、不可读、digest 不匹配或 manifest 校验失败时，status 才回退到 current catalog manifest，并把 `healthSource` 标成 `currentCatalog`，同时保留快照不可用的诊断。current catalog 也不存在时，只能基于 historical tracking / ledger 展示安装漂移；由于没有可信 schema/runtime 声明，`config` 为 `no-schema`，`scripts` 为 `not_declared`，`healthSource` 为 `historical` 或 `none`。
- `missing-from-bundle` 只在已解析到可信 manifest 且该 manifest 声明的 runtime 文件缺失时触发，包括 lifecycle 文件和 `scripts.helpers.config`。`unsupported-on-current-os` 只来自可信 manifest 中 lifecycle selector 无法在当前 OS 解析；`missing-required` 和 `invalid-config` 只用同一 manifest 的 config schema/default 解析 effective config 后判断。
- 这部分接入当前 status orchestrator 的只读矩阵：未传 `--scope` / `--platform` 时按 status 默认跨 scope/platform 展示；显式过滤时只过滤结果。status 不调用 `ensureLocalMarketplace()`、不创建 `~/.aw/plugin-config/`、不修复缺失脚本，也不为了读取 schema 写入本地 marketplace。
- `status --json` 中配置和脚本健康进入稳定字段；stdout 仍必须是纯 JSON，人类诊断只进 `stderr` 或 debug log。

### config

- `aw config` 命令组接入当前统一 runtime：CLI entry 和 direct command 都通过 `createCommandExecutionContext()` / `createCliExecutionContext()` 获得 `env`、`prompt`、`reporter`、`debugLogger` 和 `diagnostics`。
- `config` 命令不直接读取 `process.stdin.isTTY` 或 `process.env.CI`。是否允许 prompt 由 runtime 的 `interactive` 和 `prompt` 决定。
- `config configure` 只接受 schema 内 key；prompt 的候选、默认值、说明文案和敏感输入都来自 manifest schema。
- `config set` 增加 `--value-json` 输入解析开关；`--json` 不参与值解析，只选择 stdout 输出 JSON receipt。
- `config get/list/set/configure/unset/reset --json` 保持 stdout 纯 JSON；默认人类输出走 reporter，并统一脱敏。`unset --json` 和 `reset --json` 也输出 receipt，不能把删除确认、warning 或 verbose 文案写进 stdout。

## 插件脚本开发测试（package.json 入口）

不新增 `aw plugin test`，避免把插件作者的开发期工具暴露给普通客户端用户。测试 runner 源码放在 `packages/cli/scripts/test-plugin-scripts.ts`，复用同一套已编译 CLI 工具代码；根 `package.json` 只委托到 CLI 包脚本，CLI 包脚本先执行 compile-only，再运行 `dist/scripts/test-plugin-scripts.js`。这个启动路径不能调用根 `pnpm build`，也不能在解析 `<plugin>` / `--all` 前触发 `dist/scripts/bundle-plugins.js` 的全量插件打包。

根 `package.json`：

```json
{
  "scripts": {
    "plugin:test": "pnpm --filter @yiliang/aw plugin:test --",
    "test:smoke:plugin-scripts": "pnpm --filter @yiliang/aw test:smoke:plugin-scripts"
  }
}
```

`packages/cli/package.json`：

```json
{
  "scripts": {
    "plugin:test": "tsc -p tsconfig.json && node dist/scripts/test-plugin-scripts.js",
    "test:smoke:plugin-scripts": "vitest run --config vitest.smoke.config.ts tests/smoke/plugin-scripts-staging-smoke.test.ts"
  }
}
```

`test:smoke:plugin-scripts` 是显式 opt-in 的 staging 回归入口，不被根 `pnpm test`、`pnpm test:unit` 或 `pnpm test:integration` 调用。凡是会实际执行 `pnpm install --frozen-lockfile --ignore-scripts`、manifest build 入口、完整 production dependency closure 扫描，或真实 `plugin:test` 的 `scripts.node` staging 路径，都必须放进这个 smoke/opt-in 入口或现有 smoke suite。

开发者通过包脚本运行：

```bash
pnpm plugin:test <plugin> [--scope project|user] [--platform codex|claude|both|auto] [--test-name <pattern>]
pnpm plugin:test --all [--scope project|user] [--platform codex|claude|both|auto] [--test-name <pattern>]
```

首版语义：

- 单插件测试是主路径：`pnpm plugin:test <plugin>` 只读取、打包并运行指定插件的测试，不能因为其它插件 manifest、脚本或测试损坏而失败。
- 批量测试必须显式传 `--all`；首版不建议把无参数默认为全量，避免用户想测一个插件时误跑整个 marketplace。
- 只从 source repo 的 `plugins/` 读取插件，不读取 `~/.aw`。
- runner 不能直接 import `packages/cli/src/**/*.ts`，也不要求用户事先跑过 `pnpm build`。包脚本里的 `tsc -p tsconfig.json` 只负责把 `src/**/*.ts` 和 `scripts/**/*.ts` 编译到 `dist/`，不会执行 `dist/scripts/bundle-plugins.js`。因此单插件路径必须从已编译入口调用单插件 staging helper，只有 `--all` 才允许进入全量 discovery / bundle 路径。
- `--scope` 默认 `user`，只影响测试 context 的 `scope`、目标 config store 视图和 helper fallback 的当前执行视图；它不参与插件发现，也不改变 effective config 的合并规则。runner 总是创建隔离 user/project 两层临时 config store 路径，effective config 仍按 `default < user < project` 合并。
- `--platform codex|claude` 运行一次，并把对应值写入 context 的 `platform`；`--platform both` 拆成 `codex` 和 `claude` 两次运行，每次都从同一个 build 后基准 bundle 复制出独立可写测试 bundle，并使用独立 AW_HOME / 平台 home / temp，任一失败则整体失败。两次运行之间不能共享可写 `plugin.rootDir`，避免第一轮测试改动 bundle 后污染第二轮；`--platform auto` 不探测宿主机器，按 build 后 staging manifest 的 `marketplace.policy.products` 推断：只声明 `CODEX` 时等价 `codex`，只声明 `CLAUDE` 时等价 `claude`，未限制或同时允许时等价 `both`。如果 manifest build 入口改写了 `products`，auto 必须跟随最终 staging manifest，而不是 source manifest。
- `--test-name <pattern>` 原样映射为 Node 原生 `--test-name-pattern <pattern>`，不做二次 glob、正则改写或自定义过滤；失败输出保留 Node test runner 的语义。
- 对指定插件优先生成单插件临时 bundle，复用显式允许 staging build 的 `bundleLocalPlugin()` 路径；`--all` 才使用显式允许 staging build 的 `bundlePlugins()` 生成完整临时 embedded root。两条路径都要保证生命周期脚本测试的是 build 后结构。
- 如果插件声明了 `scripts.node`，`plugin:test` 使用与 `pnpm build` 相同的隔离 staging、pnpm install 和 manifest build 入口。临时测试 bundle 可以保留 full `node_modules` 供测试入口和 test-only helper 使用 `devDependencies`；但 runtime lifecycle/helper 的 import contract 仍按 production dependencies 校验，发布 bundle 也只暴露 production dependencies，避免测试借到仓库根依赖。
- 为每个平台运行创建隔离的临时 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 和受管临时 project root。`node --test` 进程的 `cwd` 固定为该临时 project root，`AW_PLUGIN_CONTEXT.cwd` 写入同一个 absolute path；该目录不能是 source repo、staging 插件根或临时 bundle root。helper 在没有 `AW_PLUGIN_CONTEXT` 时通过 `process.cwd()` 解析到的 project config store，也必须落在这个临时 project root 的 `.agent-workflows/plugin-config/` 下，不读写真实仓库。
- 按目标 OS 分支注入隔离 home/temp 变量：POSIX 使用 `HOME`、`TMPDIR`，Windows 使用 `USERPROFILE`、`TEMP`、`TMP`。在非 Windows 主机上测试 Windows 分支时，env builder 仍按纯函数生成这些变量并接受单测覆盖。
- 按最终测试基准 manifest 中的 `scripts.tests.node` glob 找测试入口文件：没有 manifest build 时使用 source manifest；声明 manifest build 时，先完成 staging build 并使用 build 后 staging manifest。runner 不在 source 树原地执行，先把匹配到的测试入口从测试基准插件根复制到临时 bundle 下的同一相对路径，再从这些入口递归扫描可静态识别的相对 import / require，把尚不存在于 bundle 的 test-only helper 复制进去，最后运行 `node --test <bundle-test-files...>`；这些测试文件和 test-only helper 只存在于临时测试 bundle，不进入发布 runtime bundle。
- 如果最终 manifest 没有声明 `scripts.tests.node`，或声明的 glob 一个入口都没有匹配到，`plugin:test` 把该插件标记为显式 skipped/no-op：退出码为 0（`--all` 中仍会被其它插件的测试失败覆盖），人类输出包含稳定的 no tests matched / skipped 摘要，并且绝不退化成裸 `node --test` 或 Node 默认测试发现。这样未被 manifest glob 选中的其它测试文件不会被意外执行。
- 复制测试入口或 test-only helper 时如果会覆盖 bundle 中已有 runtime 文件，runner 不覆盖；测试里的相对 import 必须命中已存在的 bundle runtime 文件。若入口文件自身路径与 runtime 文件冲突，直接报错，要求作者调整测试文件路径。这样相对 import（例如 `../scripts/lifecycle.mjs` 或 `./aw-config.mjs`）会解析到临时 bundle 内的运行时代码，而不是 source 树。
- 注入 `AW_PLUGIN_CONTEXT`，其中 `event: "test"`，`cwd` 指向受管临时 project root，`plugin.rootDir` 指向临时 bundle，`sourceRoot` 指向源码插件，`paths.configStores.project` 指向同一临时 project root 下的 project store。
- 测试文件可以 import 插件自己的 lifecycle/config helper，但应通过相对路径或 `AW_PLUGIN_CONTEXT.plugin.rootDir` 命中 bundle 内文件；`sourceRoot` 只用于读取源码 fixture/golden data，不能作为 runtime helper 或测试入口发现根。runner 在执行 `node --test` 前要扫描可静态识别的 import / require specifier：未声明 `scripts.node` 时拒绝所有第三方 bare package import；声明后只允许 packageRoot 内文件引用 `dependencies` / `devDependencies` 中声明的包，并清空 `NODE_PATH`。
- 测试失败时保留 stderr 摘要，默认删除临时目录；后续可加 `--keep-temp` 便于调试。

这个包脚本不替代仓库自身 Vitest。它面向插件作者，用来测试插件内 Node 脚本；CLI 主仓库仍用 Vitest 覆盖实现。`.agents/skills/create-agent-workflows-plugin/SKILL.md` 需要说明这个入口，避免作者误以为应通过 `aw` 客户端测试插件脚本；作者技能里的 JS 脚手架 / validate 工具不能承担 `plugin:test` runner 入口，也不能直接加载 TS 源文件。

普通 unit / integration 的 synthetic embedded root 仍保持 build-free。`tests/helpers/embedded-root.ts` 下现有 `createSyntheticEmbeddedRoot()` 继续只服务普通 CLI 测试，只生成 file-only 基线插件集合；它不触发 package manager、不执行 manifest build，也不能因为仓库中另一个无关插件声明 `scripts.node` 而变慢或失败。unit / integration 可以用 fake staging helper 或纯函数 fixture 覆盖 mode dispatch、参数传递和错误分类，但不能真实执行 `pnpm install`、manifest build 入口或 production dependency closure 扫描。需要覆盖这些重路径的 authoring / plugin:test 用例，必须放进 `tests/smoke/plugin-scripts-staging-smoke.test.ts` 或等价 opt-in suite，并调用 `packages/cli/scripts/**` 下显式命名的 staging helper，例如 `createStagingSyntheticEmbeddedRoot()` / `createStagingPluginBundle()`；`tests/helpers/embedded-root.ts` 不能成为 `plugin:test` runner 的直接依赖。helper 名字和 API 要让调用方一眼能看出会进入 staging build 重路径。

## 实现步骤

### Phase 0：接入已合入的 CLI runtime 与交互式合同

这一阶段不另起前置 runtime，而是在当前已经存在的 `CommandExecutionContext`、`CliPrompt`、diagnostics、discovery 和 status 矩阵上补齐本计划需要的交互合同，再把 config / lifecycle / plugin:test 能力接入。任何新增入口都只能扩展这些现有接口，不能在 config / lifecycle 里另起本地 runtime。

- 复用现有 `CommandExecutionContext` / `createCommandExecutionContext()` / `createCliExecutionContext()`，确保 config、install、upgrade、uninstall、status、lifecycle runner 和插件脚本测试都消费同一份 `env`。如果需要给 lifecycle 或 config 增加新能力，优先加在 context 或 runtime-adjacent helper 上，而不是给某个命令私有注入。
- 先改造默认 prompt runtime：`createReadlinePrompt()` 不能固定写 `process.stdout`，必须支持注入 prompt output sink；普通人类输出仍可用 stdout，但 `--json` 命令创建上下文时必须把 prompt 文案、确认问题和候选列表写到 stderr，确保 stdout 只保留最终 JSON。交互可用性不能再绑定 `stdout.isTTY`，而应按 `stdin` TTY 加 prompt output sink TTY 判定；在 `--json` stdout 被管道或重定向、stderr 仍是 TTY 时，真实 CLI 仍可进入 prompt。fake prompt 注入继续绕开真实 TTY，用于测试和 direct command。
- status 健康接入以当前 `StatusMatrixReport` 为前置：`statusCommand()` 已经完成 options normalization、discovery、adapter status、summary 和 JSON 输出，config/script health resolver 只负责给每个 cell 增补只读健康字段和 debug 诊断。
- 扩展 `CliPrompt`，新增配置向导能力，例如 `configurePluginConfig({ plugin, initialScope, allowedScopes, schema, currentValues, missingRequiredOnly }) -> { selectedScope, updates, updatedKeys, cancelled? }`，并保持测试可注入 fake prompt。
  - `sensitive: true` 的 string 必须经由默认 CLI prompt 的隐藏输入能力读取，输入过程不能把真实值回显到 stdout、stderr、debug log 或 log file；fake prompt 仍可直接返回真实值，命令层负责后续脱敏输出。
  - `initialScope` 只是默认选中项；只要 `allowedScopes` 同时包含 `user` 和 `project`，prompt 就必须允许用户改写写入层。
  - `aw config configure` 显式传入 `--scope user|project` 时，命令层必须把 `allowedScopes` 收敛为单值；fake prompt 如果返回候选外的 `selectedScope`，命令层必须拒绝并且不写任何 store。
  - `selectedScope` 是命令层唯一可信的写入目标；命令层不得继续使用调用前的默认 scope 写配置。
  - `updates` / `updatedKeys` 只包含用户本次显式修改的 key。命令层必须读取 `selectedScope` 原始 store 作为 base 做 patch，不得把 `currentValues` 或 prompt 内部表单的整份 effective config 覆盖到目标层。
  - `allowedScopes` 只有一个值时，prompt 可以不展示 scope 控件，但仍必须原样返回该值，方便命令层统一处理。
  - `cancelled: true` 表示用户主动中止，命令层必须返回业务错误且不写入部分配置；install / upgrade preflight 必须在任何 native state、repo-managed artifacts、tracking 或 ledger 写入前结束。
- 将 `-s/--scope`、`-i/--interactive`、`--no-interactive`、`-v/--verbose`、`-D/--debug`、`--log-file`、`-j/--json`、`config set --value-json` 和 `config reset -y/--yes` 的解析接到统一 diagnostics / reporter 边界；`--json` 始终只表示机器输出，`--value-json` 只存在于 `config set`，用于输入值解析。config 写命令默认 scope 为 `user`，config 读命令默认 resolution 为 effective。
- 明确 `aw config set/unset/reset/configure` 是写命令，允许创建或更新 config store；`aw config get/list` 和 `aw status` 是只读命令，只能读取已有 config store 并给出诊断。
- `config reset` 复用现有 `CliPrompt.confirm`。命令层只在确认通过或 `--yes` 存在时调用 raw-store 删除；确认拒绝、取消或非交互缺少 `--yes` 都必须在删除前返回业务错误。
- `aw config` 的 CLI action 应像 install/uninstall/upgrade/status 一样由 `createActionContext()` 创建上下文并传给 command 层；`--debug`、`AW_DEBUG=1`、`--log-file` 和 fake prompt/fake env 的行为必须和现有命令一致。
- 增加 runtime 合同测试：config command 注入 fake prompt 不访问真实 stdin；传入 fake env 后 config path、catalog 读取、lifecycle context 和 status 诊断都不回落到 `process.env`；默认 prompt 覆盖 output sink 选择、TTY 判定、`--json` 下 prompt 进入 stderr 且 stdout 保持纯 JSON，以及 `sensitive` 隐藏输入不回显到 stdout、stderr、debug log 或 log file。

### Phase 1：Manifest 与 bundle contract

- 修改 `packages/cli/src/types.ts`：
  - 新增 `PluginScriptsConfig`、`PluginLifecycleScripts`、`PluginLifecycleScriptEntry`、`PluginLifecycleOsSelector`、`PluginScriptHelpersConfig`、`PluginConfigSchema` 等类型。
  - `PluginManifestSource` 增加 `scripts?: ...`、`config?: ...`。
  - `PlatformPluginManifest` 不增加这些字段。
- 修改 `packages/cli/src/utils/manifest.ts`：
  - 顶层 allowlist 增加 `scripts`、`config`。
  - 校验脚本路径、runner、OS selector、测试 glob、顶层 `scripts.timeoutMs` 和 `scripts.helpers.config`。
  - 校验 `scripts.node.packageRoot`、package manager 边界、`package.json` / `pnpm-lock.yaml` 存在性，以及 manifest 显式 build 入口；拒绝 packageRoot 逃逸、多个 packageRoot、非 pnpm lockfile 和隐式 npm lifecycle build。声明 manifest build 时，build 前校验只约束 source packageRoot 的依赖来源和 build 入口可执行性；最终 runtime packageRoot 必须在 build 后重新校验。
  - 校验 packageRoot `package.json` 的依赖入口：只允许 `dependencies` / `devDependencies` 中的 registry-backed specifier，拒绝 `workspace:`、`file:`、`link:`、`portal:`、本地路径、git/shortcut、HTTP(S) URL、tarball URL、`optionalDependencies` 和 `bundledDependencies`；这些错误必须在 staging install 前返回。
  - manifest build 后，以最终 staging manifest 的 `scripts.node.packageRoot` 重新执行 package metadata / dependency specifier 校验、`pnpm install --frozen-lockfile --ignore-scripts` 和 production dependency closure 扫描；发现最终 runtime 依赖包声明 `preinstall` / `install` / `postinstall` / `prepare` 时返回 authoring validation 错误，避免 `--ignore-scripts` 产出不可用 runtime bundle。
  - 拒绝内联命令字符串、未知 runner、逃逸路径、绝对路径、无法覆盖 `linux` / `darwin` / `win32` 的 lifecycle 事件。
  - 拒绝 per-event / per-selector timeout，拒绝越界、非整数或非数字 `scripts.timeoutMs`；缺失时使用 runtime 默认 `30000`，不写回 manifest。
  - `scripts.helpers.config` 只接受插件内相对路径和 Node 可运行扩展名；不从固定文件名隐式推断 helper。
  - 校验 config schema 类型、字段 allowlist、`title` / `description` 字符串、默认值、required、sensitive、enum values，以及 number `min` / `max` 的闭区间合法性。
  - source mode 在无 `scripts.node.build` 时直接校验 lifecycle 脚本路径、helper 路径和测试 glob；声明 build 时先做 build 前结构校验，完整路径存在性和 import contract 以 staging build 后结果为准。bundle mode 只校验 runtime lifecycle/helper/config/packageRoot，不要求测试 glob。
  - 对 Node lifecycle、helper、build 文件和测试文件增加 import contract 扫描：未声明 `scripts.node.packageRoot` 时 literal specifier 只允许 `node:` 或相对路径；声明后允许 packageRoot 内文件引用 `package.json` 中声明的 dependencies/devDependencies，并确认相对路径 realpath 不逃出插件根或测试 bundle 根。扫描器需要能从 runtime 入口递归返回可静态识别的相对依赖闭包，供打包、bundle-layout 和 `plugin:test` 复用同一份文件集合。
- 修改 `packages/cli/src/generators/local-plugin.ts`：
  - 增加 build staging 流程：把插件 source 复制到临时目录。声明 manifest build 时，先按 source manifest 的 `scripts.node.packageRoot` 做依赖来源预检和 build 前 install，再执行 manifest build 入口；随后从 staging root 重新读取最终 manifest，并以最终 `scripts.node.packageRoot` 重新安装、重新扫描和打包插件。
  - staging helper 的顺序固定为：source package metadata / dependency specifier 预检；build 前 `pnpm install --frozen-lockfile --ignore-scripts`；执行 manifest build 入口；重新读取 staging manifest；按最终 packageRoot 重跑 package metadata / dependency specifier 校验、`pnpm install --frozen-lockfile --ignore-scripts` 和 production dependency closure lifecycle script 扫描；最后才允许 bundle 复制。未声明 manifest build 时，仍按 source manifest 走同一套最终 packageRoot 校验、install 和 closure 扫描。
  - 给 `bundleLocalPlugin()` / `bundlePlugins()` 增加显式脚本 build 模式参数，例如 `scriptBuildMode: "build-free" | "staging"`。真实 `pnpm build`、smoke 和 `plugin:test` 使用 `"staging"`；普通 unit / integration helper 使用 `"build-free"`，在该模式下只打包 file-only 基线插件，不调用 package manager 或 manifest build 入口，也不让无关 `scripts.node` 插件阻断普通测试。
  - staging 模式下，manifest build 入口执行后必须重新读取 staging `.agents-plugin/plugin.json`，重新跑 source/bundle 需要的 manifest 校验、最终依赖安装和 closure 扫描，并把最终 `PluginMeta` 作为后续 platform manifest、bundle source manifest、marketplace entry 和 `plugin:test` 入口发现的唯一输入。build 后 manifest 如果改动 `name`，打包必须失败；其它进入 catalog 或测试合同的字段以 staging 结果为准。
  - `bundleLocalPlugin()` 返回值需要携带最终 staging `PluginMeta` 或等价 manifest 快照。`bundlePlugins()` 必须先完成所有插件的 staging/bundle，再用这些最终 manifest 生成 marketplace manifest，不能继续用 build 前 `discoverPlugins()` 的 metadata 生成 catalog。
  - 收集 `scripts.lifecycle.*` 中所有 OS selector 指向的脚本，以及 `scripts.helpers.config` 显式声明的 helper；其中 Node 入口还要递归收集可静态识别的相对依赖闭包，并把入口和闭包文件都复制到 bundle root 的同一相对路径。
  - 收集 `scripts.node.packageRoot` 下的 `package.json`、`pnpm-lock.yaml` 和 production `node_modules`，复制到 bundle root 的同一相对目录；packageRoot 内 runtime 入口相对 import 的 sibling 模块必须通过同一套闭包收集进入 bundle，不复制 devDependencies、测试文件或构建缓存。
  - `createBundleSourceManifest()` 从最终 staging manifest 深拷贝 runtime 需要的 `scripts.lifecycle` / `scripts.helpers` / `scripts.node.packageRoot` / `scripts.timeoutMs` / `config`，剥离 `scripts.tests` 和 `scripts.node.build`。
- 修改 `packages/cli/src/utils/bundle-layout.ts`：
  - 校验 source manifest 中声明的 lifecycle AW 脚本在 bundle root 存在，并能按当前 OS 解析到可执行 runner；同时校验 `scripts.helpers.config` 声明的 helper 文件存在。
  - 从 bundle root 中的 Node lifecycle/helper 入口递归扫描相对依赖，确认每个可静态识别的相对 runtime 模块都存在于 bundle 内，且不会解析回 source tree、测试目录或 bundle root 外部。
  - 如果声明了 `scripts.node.packageRoot`，校验 bundle 内存在 package metadata 和 production `node_modules`，且 runtime Node 文件的第三方 bare import 能从 bundle packageRoot 解析。
  - 不把 AW 脚本要求写入 Claude/Codex platform manifest。

### Phase 2：配置存储与 CLI

- 新增 `packages/cli/src/utils/plugin-config.ts`：
  - resolve config paths，并提供单一 AW project root resolver：在 repo / workspace 内返回 repo root，不在 repo / workspace 内时退回 normalized command `cwd`。
  - 提供 `assertSafePluginConfigSegment()` 或等价 helper，作为插件名到本地配置路径 segment 的唯一入口；无论插件名来自 current manifest、CLI 入参还是 historical/raw-store reset，都必须拒绝路径分隔符、`.`、`..`、绝对路径和跨平台分隔符。
  - read/write/reset config。
  - schema validate / coerce / apply defaults / merge user/project stores / track value source / redact。
  - 提供 patch 写入 helper：`config configure` 和 install/upgrade preflight 只把 prompt 返回的 `updates` 写入 `selectedScope` 原始 store，保留同层未修改 key 和 unknown keys，不把 effective config 的其它来源值复制到目标层。
  - `file` / `directory` 写入时按 AW project root 锚定相对路径，`realpath` 后以 canonical absolute realpath 落盘；default 解析、effective config、status 和 helper fallback 复用同一个 path validator。
  - `resolveEffectivePluginConfig()` 返回 typed issues，区分 `missing-required` 与 `invalid-config`，让 config CLI、preflight、lifecycle、helper 和 status 可以共享失败语义。
  - 只通过传入的 runtime env / cwd 解析 `AW_HOME`、home 和 repo root，不能直接读 `process.env`。
- 修改 `packages/cli/src/index.ts`：
  - 新增 `config` command group。
  - 新增 `config configure` 交互式向导；`config set/get/list/unset/reset` 保持脚本友好，`config reset` 增加 `-y/--yes` 供非交互删除显式确认。
  - 输出保持机器可读和中文错误信息；`--json` stdout 保持纯 JSON。
- 修改 `packages/cli/src/types.ts` 和 `packages/cli/src/commands/options.ts`：
  - `CommandOptions` / `RawCommandOptions` 增加公共 `scriptTimeoutMs` 字段，`InstallCommandOptions` / `UpgradeCommandOptions` 继承它。
  - 新增统一 timeout parser，并让 `normalizeCommandOptions()`、`normalizeInstallCommandOptions()`、`normalizeUpgradeCommandOptions()` 走同一条解析路径；非法值在 command 执行前返回确定性业务错误。
- 修改 `packages/cli/src/utils/local-marketplace.ts`：
  - 保留 `plugin-config/` 和安装快照目录，避免 `aw init --force`、non-force stale refresh 或 `config.json` 损坏触发重建时删除用户配置或 lifecycle/config 快照。
  - 若继续把 user config 放在 `AW_HOME` 下，先写 local marketplace 刷新保护测试，再实现 staging copy 或等价保留逻辑；如果改到独立目录，需要同步本计划的路径合同和迁移说明。
- 修改 installed ledger 类型与读写：
  - `InstalledScopeRecord` 增加 `lifecycleConfigSnapshot` 或等价字段，记录 scope-owned snapshot bundle root、manifest digest、bundle fingerprint、manifest path、source package/version 和创建时间。
  - ledger validator 必须兼容旧 ledger：旧记录没有快照时仍可作为 historical evidence，但不能被 status/lifecycle 当作可信 schema/runtime manifest。新安装或 upgrade 成功后必须写入快照字段。
  - 提供按 ledger 扫描 exact snapshot root 的快照清理 helper，只删除当前 ledger 中没有任何 scope record 精确引用的 snapshot root。首版不按 digest 共享 bundle；两个 scope 或两个 platform 即使 digest 相同，也应各自拥有独立 snapshot root。该 helper 是所有命令唯一的 snapshot GC 入口：install / upgrade 在 preflight、lifecycle 或回滚失败后清理未写入 ledger 的新快照；upgrade 成功后清理旧快照；uninstall 成功删除 ledger 记录后清理刚失去引用的快照。
- config command resolver 拆成 schema-aware target 和 raw-store target：`set` / `configure` / `unset` / `get` / `list` 需要 current schema；`reset` 可以只解析 config store 路径，并在 current catalog 缺失时继续删除既有 store。两条 resolver 都必须先跑同一份插件名 path segment 校验，不能因为 raw-store 分支没有 manifest 就直接拼路径。
- `reset` raw-store resolver 必须先解析目标 store 是否存在。存在时按 `--yes` / `context.prompt.confirm` / 非交互失败三分支处理；不存在时返回 no-op receipt，不触发 confirm，也不因为 current catalog 缺失而失败。
- 给 install/upgrade 增加 required config preflight；交互可用时补问并写入 config store，非交互时在 native state 写入前失败。preflight API 接收完整 target matrix，先收集所有缺失/失效配置和 prompt 写入计划，再允许命令进入现有逐平台/逐 target 写入循环，避免多目标场景出现部分成功。
- preflight API 必须在收集阶段按 `pluginName + schema source manifest identity` 去重，并缓存 prompt 结果、`selectedScope`、`updates` / `updatedKeys`、写入 receipt 和重新解析后的 effective config。命令层消费缓存结果，不能在平台循环里再次调用 prompt 或再次写同一插件配置。

### Phase 3：脚本运行时与 lifecycle 接入

- 新增 `packages/cli/src/utils/plugin-scripts.ts`：
  - 解析 lifecycle source、OS selector、runner 和脚本路径。
  - 提供 `createLifecycleConfigSnapshot()` 或等价 helper，从 current catalog bundle 固化安装快照，并返回 snapshot metadata 供 install / upgrade lifecycle 和 ledger 写入复用。
  - 提供 `resolveLifecycleScriptTarget()` 或等价 helper，按当前 scope ledger 快照、current catalog、warning fallback 解析 lifecycle 脚本来源；返回值必须携带脚本 entry、bundle root、source manifest、manifest path、manifest digest 和来源类型，供 config resolver 复用。lifecycle context builder 和 spawn env builder 必须直接消费这份 target，不能重新从 plugin metadata、current catalog 或 `~/.aw/plugins/<plugin>` 推导 root。
  - historical 安装快照读取必须验证 ledger metadata、bundle manifest digest 和脚本 realpath 都在 snapshot bundle root 内；找不到或校验失败时只降级到 current catalog 或 warning fallback。
  - context config 解析只接收 lifecycle target 返回的 source manifest。current catalog 与安装快照同时存在但 schema 不同时，不能从 current catalog 混入 default、required 或 key allowlist。`file` / `directory` 失效时在写 context 前失败，脚本不会收到 invalid path。
  - 写 context temp file，POSIX 下使用 `0600` 权限 best effort，并确保失败路径清理临时文件。
  - 按 runner spawn Node / POSIX shell / PowerShell / cmd，处理 timeout、收集输出、脱敏日志。
  - runner argv 构造必须是纯函数，单测覆盖 `win32`、`linux`、`darwin`，尤其覆盖 Windows 路径空格和 PowerShell / cmd quoting。
  - spawn env 从 `CommandExecutionContext.env` 生成 OS-aware 白名单：共同保留 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME`、`PATH` 和 `AW_PLUGIN_CONTEXT` 系列变量；POSIX 只透传隔离 `HOME`、`TMPDIR`；Windows 只透传隔离 `USERPROFILE`、`TEMP`、`TMP`，并防止 `HOMEDRIVE` / `HOMEPATH` 回落到宿主。
  - 通过 `CommandExecutionContext.debugLogger` / reporter 记录脚本事件，不直接 `console.log` 或拼 warning 字符串。
- 修改 `packages/cli/src/commands/install.ts`：
  - `installTargetsOnPlatforms()` 支持 lifecycle event。
  - 在 native state 写入前为每个 `platform + scope + plugin` 创建 scope-owned lifecycle/config 安装快照；在 tracking / ledger 前执行 install/upgrade lifecycle；required config preflight、lifecycle、native write、tracking 或 ledger 任一步失败时，都通过统一 GC helper 清理未写入 ledger 的新快照。
- 修改 `packages/cli/src/commands/upgrade.ts`：
  - upgrade 路径传 `operation: "upgrade"`。
  - capabilityChanged 内部卸载标记为 upgrade internal cleanup，不把它当作用户发起的 `uninstall` lifecycle 事件。
  - upgrade 成功后把 scope ledger 指向新快照；旧快照等到没有任何 ledger 记录精确引用同一 snapshot root 后再清理。
- 修改 `packages/cli/src/commands/uninstall.ts`：
  - 平台卸载前执行 uninstall lifecycle。
  - historical fallback 先从同一 `platform + scope` ledger 安装快照读取 manifest；快照缺失、损坏或无脚本时，再用 current catalog 解析 lifecycle；两边都没有脚本时 warning 后继续。
  - 成功完成平台卸载、repo-managed artifact 清理、tracking 清理和 ledger 记录删除后，调用统一 snapshot GC helper 回收原 ledger 记录指向且已经无精确引用的安装快照。其它 scope/platform 的同 digest 独立副本不参与当前目录的引用计数。任何失败路径都不能提前删除快照，确保用户可重试 historical uninstall。
- 修改 `packages/cli/src/adapters/codex.ts`：
  - Codex status producer 可以继续把当前 `platform + scope + plugin` 格子的 runtime bundle evidence 写入 `PluginStatusReport.activeLocalBundle`，供 hook drift 和 runtime 诊断使用；status health resolver 和 historical uninstall 不再消费它作为 manifest 真值。
- 修改 `packages/cli/src/commands/status.ts` / formatter：
  - 展示配置缺失和脚本声明健康状态。
  - 新增只读 health source resolver，按 `installSnapshot -> currentCatalog -> historical/none` 为每个 `platform + scope` 选择 manifest 真值；config/script 健康必须使用同一份 manifest。
  - health source resolver 只读取 ledger 快照和 discovery/status 已经聚合出的矩阵证据，不能在 status 层偷偷重算或信任 `~/.aw/plugins/<plugin>` 里的当前 bundle。
  - 该项接在当前 status orchestrator 之后：输入是已经聚合好的 `platform + scope + plugin` 矩阵 target，输出是每格的 config/script health。不能复用执行型 `CommandOptions.scope` 默认值，也不能让未传 `--scope` 时只检查单个 scope。

### Phase 4：插件脚本测试 runner

- 根 `package.json` 新增 `plugin:test` 脚本，委托到 `pnpm --filter @yiliang/aw plugin:test --`；另新增 opt-in 的 `test:smoke:plugin-scripts`，只用于真实 staging install / manifest build 回归，不进入根 `pnpm test`。
- `packages/cli/package.json` 新增 `plugin:test` 脚本：先运行 `tsc -p tsconfig.json` 编译 CLI 与 `scripts/**/*.ts`，再运行 `node dist/scripts/test-plugin-scripts.js`；这个脚本不能调用 `pnpm build` 或 `dist/scripts/bundle-plugins.js` 作为启动前置。另新增 `test:smoke:plugin-scripts`，通过 `vitest.smoke.config.ts` 运行 `tests/smoke/plugin-scripts-staging-smoke.test.ts`。
- 新增 `packages/cli/scripts/test-plugin-scripts.ts`，作为 `plugin:test` 的唯一 runner 源码入口。它通过已编译 JS 模块复用 `readPluginManifest()`、`bundleLocalPlugin()` 和 `packages/cli/scripts/**` 下的 staging helper，不直接 import TS 源文件，也不 import `tests/helpers/**`。
- 不修改 `packages/cli/src/index.ts`，不增加 `aw plugin test` 子命令。
- 在 `packages/cli/scripts/` 下新增显式命名的 staging helper，例如 `plugin-staging.ts`；`tsconfig.json` 已包含 `scripts/**/*.ts`，所以 compile-only 后 runner 能从 `dist/scripts/**` 直接加载它。`packages/cli/tests/helpers/embedded-root.ts` 保持 build-free，只在 Vitest 需要时包装这些 scripts helper，不能再承载 runner 必须 import 的实现。
- `pnpm plugin:test <plugin>` 走单插件执行路径，只调用 `readPluginManifest()` / `bundleLocalPlugin()` 处理指定插件。
- `pnpm plugin:test --all` 才走批量路径，调用 `bundlePlugins()` 生成完整临时 embedded root。
- 参数校验要求 `<plugin>` 和 `--all` 二选一；两者同时出现时报错。
- 明确实现 `--scope`、`--platform` 和 `--test-name` 语义：默认 scope 为 `user`；`both` 拆成 codex/claude 两次隔离运行，并为每个平台从同一个基准 bundle 复制独立可写 bundle；`auto` 只按 build 后 staging manifest 的 product policy 推断，不探测宿主安装；`--test-name` 原样传给 Node `--test-name-pattern`。
- 单插件和 `--all` 都复用 bundle staging 流程；声明 `scripts.node` 的插件必须先安装依赖、运行 manifest build 入口，再进入测试 bundle。临时测试 bundle 可保留 devDependencies，发布 bundle 仍只复制 production dependencies。`--platform both` 需要把这个 build 后结果当作只读基准，再为 codex/claude 分别复制运行目录，不能让第一轮测试改写第二轮会读取的 `plugin.rootDir`。
- 按最终测试基准 manifest glob 发现 Node 测试入口：无 manifest build 时以 source manifest 为准；有 manifest build 时以 build 后 staging manifest 为准。runner 再把入口从测试基准插件根复制到临时 bundle 中的相同相对路径；随后递归复制入口可静态识别的 test-only 相对依赖，遇到 bundle 中已存在的 runtime 文件时不覆盖，让 import 命中 bundle runtime。入口文件本身与 runtime 文件路径冲突时直接报错。这里的“已存在 runtime 文件”必须来自 `bundleLocalPlugin()` 生成的 runtime 入口和相对依赖闭包，不能靠测试复制步骤补齐发布 bundle 本应包含的运行时代码。
- 注入测试 context、隔离 user config store、受管临时 project root 和该 root 下的 project config store；`node --test` spawn 的 `cwd` 与 context 中的 `cwd` 必须一致。
- 在测试 context 中同时提供 `plugin.rootDir`（bundle root）和 `sourceRoot`。脚手架与文档必须引导测试通过 bundle root 或相对路径 import runtime helper；sourceRoot 只用于测试数据。
- 复用 import contract 扫描器检查复制后的测试文件和 bundle 内 Node lifecycle/helper 及其 runtime 相对依赖闭包；未声明 `scripts.node` 时拒绝 `import "yaml"` / `require("yaml")` 这类 bare package import，声明后只允许引用 packageRoot 里声明过的 dependencies/devDependencies，并清空 `NODE_PATH`，避免测试偶然借到仓库依赖。
- 复用 lifecycle env builder 生成隔离环境；POSIX 与 Windows home/temp 变量都要能通过纯函数测试，不依赖当前 CI OS。
- 在 `.agents/skills/create-agent-workflows-plugin/SKILL.md` 说明测试入口和适用场景。
- `.agents/skills/create-agent-workflows-plugin/scripts/` 可以继续维护 init / validate 等作者工具，但不能再作为 `plugin:test` runner 入口；相关文档应指向根 `pnpm plugin:test`。

### Phase 5：作者工具与文档

- 更新 `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md`：
  - 新增 `scripts` / `config` 字段规范。
- 新增或更新 references：
  - `plugin-scripts.md`
  - `plugin-config.md`
  - Claude 命令结果填充如何调用 AW config helper。
- 更新 `docs/plugin-authoring.md`、`docs/architecture.md`、`docs/testing.md`、`docs/plugin-installation.md`。
- `docs/testing.md` 必须把交互测试约定改成窄例外：除 prompt runtime 合同回归外，交互式集成测试仍必须使用 fake prompt 并断言不访问真实 stdin；真实 prompt harness 只允许验证 output sink、TTY、stderr/stdout 隔离和隐藏输入能力，并且必须显式隔离 stdin/stdout/stderr、TTY 状态、`CI` 和 home/temp 环境。
- `docs/testing.md` 必须写清 `scripts.node` staging 分层：常规 `unit/` 和 `integration/` 不执行 package manager、不跑 manifest build、不扫真实 dependency closure；这些重路径只能进 `smoke/` 或显式 opt-in 脚本，例如 `pnpm test:smoke:plugin-scripts`。
- 在用户文档中把 `aw config configure <plugin>` 作为推荐配置入口，同时保留 `aw config set` 的脚本化示例；说明 install/upgrade 的交互式配置补问只在 TTY 且允许交互时发生。
- 文档必须说明 AW config 是 project/user 分层配置，effective config 的优先级是 default < user < project；配置可先于安装写入，也可写在未安装插件的另一层 scope。
- 文档必须说明 project config root 的非仓库目录语义：有 repo / workspace root 时写 repo root；没有时写 normalized command `cwd` 下的 `.agent-workflows/plugin-config/`，helper fallback、status 健康检查和 CLI 命令都使用同一规则。
- 文档必须说明 `file` / `directory` 的相对路径锚点、absolute realpath 落盘格式和每次读取重校验规则；路径失效时 status 显示 `invalid-config`，脚本和 helper fail closed。
- 文档必须说明 config schema 字段 allowlist：`title` / `description` 只用于 prompt 和 schema 摘要，`number.min` / `number.max` 是闭区间边界，default 和写入值都必须落在范围内。
- 文档必须说明 `aw config reset` 是历史清理入口：即使插件已经从 current catalog 消失，只要对应 config store 存在，也可以删除残留配置；`get/list` 在缺少 schema 时不会 raw 打印敏感值。
- 文档必须说明 `aw config reset` 的确认规则：交互模式下必须确认，`-y/--yes` 表示显式确认；非交互、CI、`--no-interactive` 或无 prompt 时未传 `--yes` 不删除并返回业务错误。
- 文档必须说明 config store 的插件名路径安全规则：`reset` 虽然不依赖 current catalog，但仍只接受安全的单段插件名；包含路径分隔符、`.`、`..` 或绝对路径语义的输入会被拒绝。
- 文档必须说明标准 helper 无 `AW_PLUGIN_CONTEXT` 时以当前 bundle 邻近 manifest 作为 schema/default/redaction 真值，可能和 `aw config` 的 current catalog 视图短暂不同；两条路径都必须 fail closed，不能 raw 打印残留敏感配置。
- 文档必须说明 lifecycle 支持 Node 和受控 shell 脚本文件，Windows 需要 `.ps1` / `.cmd` 或 Node 脚本入口；不支持内联 shell 命令。
- 文档必须说明 Node lifecycle/helper/test 的依赖边界：未声明 `scripts.node.packageRoot` 时只能 import `node:` 内置模块和插件内相对文件；声明后可以使用 packageRoot 中 `package.json` / `pnpm-lock.yaml` 锁定的 registry 依赖，且这些依赖只在 build/test 的隔离 staging 阶段安装并随 bundle 分发，运行时不联网、不借仓库根 `node_modules`。首版拒绝 `workspace:` / `file:` / `link:` / git / URL 依赖来源，并拒绝 runtime 依赖闭包里的 dependency install scripts。
- 文档必须说明自定义 build 只能通过 manifest 显式的 `scripts.node.build` 入口触发，`package.json` scripts 和 npm lifecycle 不会自动执行；build 输出在 staging 里产生，源码树不被修改。
- 文档必须说明 lifecycle 和 `plugin:test` 的隔离环境在 POSIX 与 Windows 使用不同 home/temp 变量，Windows 下依赖 `USERPROFILE`、`TEMP`、`TMP` 而不是宿主真实目录。
- 文档必须说明 `pnpm plugin:test` 测的是临时 bundle：测试入口来自最终测试基准 manifest，匹配到的测试文件会被复制到临时 bundle 后执行，相对 import 应命中 bundle 内 runtime 文件，不能直接从 sourceRoot import 生命周期脚本或 helper。
- 文档必须说明 `pnpm plugin:test` 没有匹配到 manifest 测试入口时是显式 skipped/no-op，退出码为 0，并且不会回落到 Node 默认测试发现。
- 文档必须说明 `pnpm plugin:test` 的 Node 测试进程始终在受管临时 project root 下执行，`process.cwd()`、`AW_PLUGIN_CONTEXT.cwd` 和无 context helper fallback 的 project store 解析必须指向同一处，不能读写调用命令时所在的真实仓库。
- 文档必须说明 `pnpm plugin:test --platform both` 是双运行目录隔离：codex 和 claude 两轮都来自同一个 build 后基准 bundle，但各自拿到独立可写副本，测试不能依赖上一轮对 bundle 的修改。
- 更新 `.agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js`：
  - 可选生成 lifecycle、config schema、Node test、config helper。
- 更新 `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`：
  - 校验脚本路径、runner、OS selector、Windows 可解析 entry、config schema、helper 文件存在性和 Node 脚本 import contract；不对任意 helper 的配置 key 读取做静态承诺。
- 更新 `.agents/skills/create-agent-workflows-plugin/SKILL.md`：
  - 说明插件脚本测试通过 `pnpm plugin:test` 运行，属于开发期包脚本，不通过 `aw` 客户端入口。

## 测试计划

### Unit

- `runtime.test.ts`
  - 默认 `createReadlinePrompt()` 支持注入 prompt output sink；普通人类输出可用 stdout，`--json` 上下文用 stderr 承载 prompt 文案、确认问题和候选列表。
  - 交互可用性按 `stdin` TTY 加 prompt output sink TTY 判断；覆盖 stdout 非 TTY、stderr TTY 时仍允许真实 prompt 的 `--json` 合同回归。
  - 默认 prompt 的隐藏输入分支读取 `sensitive: true` string 时不回显真实值，stdout、stderr、debug logger 和 `--log-file` 都只能看到脱敏值或空值。
  - 真实 prompt harness 只能用于上述 runtime 合同测试，并要显式构造隔离 stdin/stdout/stderr、TTY 状态、`CI` 和 env；普通交互式 command 测试继续注入 fake prompt，并断言不会访问真实 stdin。
- `manifest.test.ts` / `manifest-coverage.test.ts`
  - 接受合法 `scripts` / `config`。
  - 接受 Node、POSIX shell、PowerShell、cmd lifecycle，并验证 OS selector 优先级：`linux/darwin/win32` 分别优先于 `unix/windows`，宽 selector 只在窄 selector 缺失时兜底。
  - 接受合法 `scripts.helpers.config`，并拒绝 helper 路径逃逸、绝对路径和非 Node 扩展名。
  - 接受合法 `scripts.node.packageRoot` 和 manifest 显式 `scripts.node.build`；拒绝 packageRoot 逃逸、缺 `package.json`、缺 `pnpm-lock.yaml`、多个 packageRoot、非 pnpm lockfile、build 入口逃逸和非 Node runner。
  - 拒绝 `scripts.node.packageRoot/package.json` 中的非 registry specifier：`workspace:`、`file:`、`link:`、`portal:`、本地路径、git/shortcut、HTTP(S) URL 和 tarball URL；拒绝 `optionalDependencies` / `bundledDependencies` 作为 runtime 依赖入口。
  - 接受合法顶层 `scripts.timeoutMs`，拒绝越界、非整数、非数字，以及 event/selector 下的 timeout 覆盖。
  - 接受合法 config schema metadata：`title` / `description` 字符串、`number.min` / `number.max` 闭区间；拒绝未知 schema 字段、非 number 类型上的 `min` / `max`、`min > max`、越界 default 和非法 config type/default。
  - 拒绝未知 runner、逃逸路径、绝对路径、内联命令字符串、缺少 Windows 可解析 entry、非法 config type/default。
  - `createBundleSourceManifest()` 保留 runtime lifecycle/helpers/node packageRoot/timeout/config，剥离开发期 test glob 和 build 入口。
- `bundle-layout.test.ts`
  - bundle root 中缺 lifecycle 脚本时报错。
  - bundle root 中缺 `scripts.helpers.config` 声明的 helper 时报错；没有声明 helper 时不扫描固定 `./scripts/aw-config.mjs`。
  - Node lifecycle/helper 相对 import sibling runtime 模块时，bundle root 中缺这个 sibling 模块必须报错；模块存在时通过。
  - 声明 `scripts.node.packageRoot` 时，bundle root 中缺 package metadata、缺 production `node_modules` 或 runtime bare import 无法从 packageRoot 解析时报错。
  - 声明 `scripts.node.packageRoot` 时，packageRoot 内 runtime 入口相对 import 同目录或子目录模块，bundle-layout 必须从 bundle 内解析并校验通过。
  - OS selector 下声明的多个 lifecycle 文件都会进入 bundle，不能只复制当前 OS 的文件。
  - AW 脚本不会进入平台 manifest。
- `local-plugin.test.ts` / `bundle-plugins.test.ts`
  - build-free 模式下只打包 file-only fixture；遇到需要 staging 的 `scripts.node` fixture 时必须返回确定性的 authoring / mode 错误，不能隐式调用 package manager 或 manifest build。
  - `scriptBuildMode: "staging"` 的参数传递和最终 manifest 消费可以用 fake staging helper 覆盖：断言 `bundlePlugins()` 生成 marketplace manifest 时消费 helper 返回的最终 manifest，不继续使用 build 前 `discoverPlugins()` metadata。
  - build 后 `.agents-plugin/plugin.json` 改动 `name` 的失败分支可以用不触发 package manager 的 fake staging result 覆盖，避免 marketplace `source`、bundle 输出目录和命令选择 identity 分叉。
  - 多文件 runtime fixture 覆盖 `./scripts/lifecycle.mjs` 相对 import `./lib/context.mjs`、`./scripts/aw-config.mjs` 相对 import `./shared/read-store.mjs`，并断言入口和 sibling 模块都进入 bundle。
  - 声明 `scripts.node.packageRoot` 的 fixture 覆盖 packageRoot 内 runtime 入口相对 import sibling 模块，断言 sibling 模块进入 bundle，dev-only 文件和测试 helper 不进入发布 runtime bundle。
  - `createBundleSourceManifest()` 使用最终 staging manifest，仍剥离 `scripts.tests` 和 `scripts.node.build`。
- 新增 `plugin-config.test.ts`
  - set/get/unset/reset。
  - 写命令默认 scope 为 user；读命令默认返回 effective config。
  - effective config 按 default < user < project 聚合，project 覆盖 user，并返回每个 key 的来源层。
  - 显式 `--scope user|project` 只读写单层 store，不参与安装状态判断。
  - 未安装插件也能写入 user/project config，只要 current catalog 有 schema。
  - current catalog 缺失但 config store 存在时，`reset` 仍能删除目标 store；`get/list` 不 raw 打印残留敏感值，并提示使用 `reset` 清理。
  - 插件存在于 current catalog 但 manifest 没有 `config.schema` 时，`set/configure/unset/get/list` 都返回确定性业务错误，且不会创建、读取、打印或修改无 schema 的配置 store。
  - current catalog 缺失时，`set/configure/unset/get/list` 都按缺少 current schema 失败；只有 `reset` 能进入 raw-store 清理分支，防止 schema-aware 命令误复用 raw-store resolver。
  - 插件名到 config store 路径必须经过统一 path segment 校验；`../../x`、`a/b`、`a\\b`、`.`、`..`、绝对路径和空字符串在 `set/get/list/configure/unset/reset` 中都返回确定性错误，且不会创建、读取或删除越界路径。
  - store 中存在当前 schema source 未声明的旧 key 时，effective config、`get/list`、status 健康和 lifecycle context 都忽略该 key，并返回只含 key 名 / scope 的 `ignoredUnknownKeys` 诊断；旧值不出现在 stdout、stderr、debug log 或 JSON 输出中。
  - schema-aware `set/configure/unset` 默认保留 raw store 里的 unknown keys；`reset` 删除整个目标 scope store 后才清理这些旧值。
  - default、required、enum、number/boolean coercion。
  - `title` / `description` 进入 schema 摘要但不进入 `config.values`；`config list/get --json` 暴露稳定 schema metadata 且不泄漏 sensitive 值。
  - number `min` / `max` 对 default、`config set` 和 `configure` 都按闭区间校验，越界值给出稳定 validation issue。
  - `config set --value-json` 才按 JSON literal 解析输入；`config set --json` 只影响输出 receipt，不改变落盘值解析。覆盖 `--value-json --json` 组合，确保输入和输出语义互不抢占。
  - `config unset --json` 输出 JSON receipt，并在删除后返回脱敏 effective config 摘要；不存在的 key 也要给出确定性 receipt，不把 warning 写入 stdout。
  - `config reset --json` 在 current catalog 存在和缺失两条路径下都输出 JSON receipt；缺 schema 时 receipt 只包含 raw-store 删除结果，不 raw 打印旧配置值。
  - `file` / `directory` 相对路径按 AW project root 解析，repo root 和 repo 子目录传同一个相对路径时落盘为同一个 absolute realpath；`~`、环境变量和 glob 不展开。
  - 非 repo / 非 workspace cwd 下 `--scope project` 明确退回 normalized command `cwd`，project store 写到该目录的 `.agent-workflows/plugin-config/`，且 direct command 与 CLI entry 解析一致。
  - `file` / `directory` 写入时校验存在和类型；写入后删除或改类型时，`resolveEffectivePluginConfig()` 返回 `invalid-config` issue，`unset` / `reset` 仍能清理。
  - manifest default 中的 `file` / `directory` 按同一锚点解析，并在每次 effective config 读取时重新校验。
  - sensitive redaction。
  - POSIX 下 user/project config store 以 `0600` 权限 best effort 写入，更新已有文件时不放宽权限。
  - project config store 使用 AW project config root，且不参与 Claude/Codex 安装 identity 判断。
- `local-marketplace.test.ts`
  - `initializeLocalMarketplace({ force: true })` 保留既有 `plugin-config/` 和安装快照目录。
  - non-force stale refresh 保留既有 `plugin-config/` 和安装快照目录。
  - 本地 `config.json` 损坏触发重建时仍保留既有 `plugin-config/` 和安装快照目录。
- `embedded-root.test.ts` 或现有 helper 覆盖
  - 普通 `createSyntheticEmbeddedRoot()` 保持 build-free：即使 repo 中存在另一个声明 `scripts.node` 的插件，也不会调用 `pnpm install` 或 manifest build 入口，更不会因为该插件的依赖安装、lockfile 或 build 失败阻断普通测试。
  - 需要真实执行 `scripts.node`、依赖安装或 manifest build 的用例必须移到 smoke/opt-in suite；unit / integration 只能用 fake staging helper 覆盖 dispatch，不执行 package manager。
  - `plugin:test` 编译后从 `dist/scripts/**` 加载 staging helper，不 import `tests/helpers/**`；用例可以通过编译产物或脚本入口 smoke 断言这条边界，避免 compile-only runner 再次滑回 TS test helper。
- 新增 `plugin-scripts.test.ts`
  - context 写入、runner spawn、timeout、exit code、stderr 摘要。
  - timeout 优先级固定为 CLI `--script-timeout` > manifest `scripts.timeoutMs` > runtime 默认 `30000`，并覆盖小于 `1000`、大于 `300000`、非整数和非法字符串时的确定性错误。
  - context temp file 在 POSIX 下使用 `0600` 权限 best effort，失败和超时后清理临时文件。
  - runner argv builder 覆盖 Node、`sh`、`bash`、`pwsh`、`powershell`、`cmd`，并对 `win32` 路径空格和参数引号做纯函数测试。
  - 当前 OS 无法解析 lifecycle entry 时，在执行前返回业务错误，不写 native state。
  - lifecycle spawn env 保留 runtime 注入的 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME`；POSIX 分支只使用隔离 `HOME` / `TMPDIR`，Windows 分支只使用隔离 `USERPROFILE` / `TEMP` / `TMP`，不会读到真实 home/temp。
  - lifecycle stdout/stderr 如果原样输出敏感配置值，reporter、debug logger、失败摘要和 log file 都必须脱敏。
  - 标准 helper 在存在 `AW_PLUGIN_CONTEXT` 时优先读 context；没有 context 时按 `AW_HOME` / project store 读取 effective 落盘配置，并使用当前 bundle 邻近 manifest 解释 schema/default/redaction。
  - 标准 helper 和 lifecycle context 都只暴露当前 schema source 声明的 key；raw store 中的 unknown keys 只进入脱敏诊断，不会因为 helper fallback 直接读落盘文件而泄漏。
  - 标准 helper 无 `AW_PLUGIN_CONTEXT` 且 bundle 邻近 `.agents-plugin/plugin.json` 缺失时，返回确定性错误，不读取 current catalog，不 raw 输出落盘配置值。
  - 标准 helper 无 `AW_PLUGIN_CONTEXT` 且 bundle 邻近 manifest 损坏或校验失败时，返回确定性错误；stdout、stderr、debug log 和 log file 都不能泄漏 sensitive 值或 unknown key 的原始值。
  - CLI current catalog 与 helper 所在 bundle manifest 漂移时，`aw config get/list` 使用 current catalog，helper 使用 bundle manifest；两边的 default、redaction 和 key 可见性差异必须符合预期且不泄漏敏感值。
  - import contract 扫描器在无 `scripts.node.packageRoot` 时允许 `node:` 和插件内相对路径，拒绝 ESM / CJS / literal dynamic import 中的第三方 bare specifier，并阻止相对 import realpath 逃出 bundle root。
  - import contract 扫描器在有 `scripts.node.packageRoot` 时允许 runtime 文件引用 `dependencies`，拒绝 runtime 文件引用只在 `devDependencies` 中声明的包、未声明包、packageRoot 外文件引用第三方包，以及相对 import 逃逸。
  - import contract 扫描器能从 Node lifecycle/helper 入口递归返回相对依赖闭包，覆盖 ESM `import`、`export ... from`、CJS `require()` 和 literal dynamic `import()`；闭包中任一文件缺失或逃逸时给出 authoring validation 错误。
  - staging helper 的 package metadata / dependency specifier 预检可以用纯 fixture 覆盖，保证在任何真实 `pnpm install` 前拒绝非 registry 依赖来源。
  - historical lifecycle 解析按安装快照 -> current catalog -> warning fallback 的顺序运行。
  - historical lifecycle target 返回脚本 entry、bundle root、manifest digest 和同源 source manifest；安装快照与 current catalog 的 config schema/default 不同时，context config 只使用安装快照 manifest。
  - lifecycle runner 写入的 `AW_PLUGIN_ROOT`、`AW_PLUGIN_CONTEXT.plugin.rootDir` 和 resolver 返回的 `bundleRoot` 始终相等；安装后刷新 `~/.aw/plugins/<plugin>` 到新版 bundle 时，uninstall lifecycle 仍读取安装快照 root，不回落到当前 marketplace root。
  - 安装后本地 marketplace refresh 到新版 bundle、但 scope ledger 仍指向旧安装快照时，uninstall lifecycle 执行旧快照脚本，且 context 中的 schema/default/value 解释也来自旧快照。
  - 安装快照 manifest digest 不匹配、脚本 realpath 逃出 snapshot root 或 snapshot 目录缺失时，resolver 不执行该快照，按 current catalog / warning fallback 降级并记录诊断。
  - snapshot GC helper 只删除当前 ledger 中没有任何 scope/platform/project 记录精确引用的 snapshot root；两个 scope 或两个 platform 安装同一 digest 时应落在不同 scope-owned snapshot root，清理其中一个只删除当前 root，另一个独立目录必须保留。
  - install / upgrade 在 required config preflight、lifecycle 或 native write 失败时，会回收本轮新建且未进入 ledger 的安装快照，不留下孤儿 bundle。
  - uninstall lifecycle 失败或平台卸载失败时不会删除 ledger 记录指向的安装快照；成功删除 ledger 记录后才允许回收已经无精确引用的快照。
  - 路径逃逸、内联 shell 字符串和 `shell: true` 都不会被执行。
- `adapter-status.test.ts` 或新增 `plugin-status-health.test.ts`
  - Codex adapter status 仍可把当前格子的 `activeLocalBundle` 暴露到 `PluginStatusReport.activeLocalBundle` 作为 runtime evidence，但 status health resolver 不把它当 manifest 真值。
  - current catalog、activeLocalBundle 与 ledger 安装快照同时存在且 manifest 不同时，已安装 target 的 config/script 健康使用安装快照，并输出 `healthSource: "installSnapshot"`。
  - current catalog 缺失但 ledger 安装快照仍可读时，status 仍用安装快照计算 `configured` / `missing-required` / `declared`。
  - 安装快照不可读或 digest 不匹配但 current catalog 可用时，status 回退 current catalog，并保留快照不可用诊断。
  - 安装快照或 currentCatalog 可读但对应 manifest 没有 `config.schema` 时，status 输出 `config: "no-schema"`，不能因为 config store 存在而显示为 `configured`，也不能把缺 schema 误报为 `missing-required`。
  - 有 historical tracking / ledger 证据但没有可信 manifest 时，status 输出 `healthSource: "historical"`、`config: "no-schema"`、`scripts: "not_declared"`。
  - 连 historical tracking / ledger 证据都没有时，status 输出 `healthSource: "none"`，且不伪造 schema 或脚本健康。
  - 只有 user/project config store 存在、但没有 ledger、tracking、native state 和 runtime evidence 时，status 仍输出未安装态，不把配置存在当作 managed evidence、安装快照或 historical evidence。
  - 可信 manifest 声明的 lifecycle 或 `scripts.helpers.config` 在 bundle root 缺失时输出 `missing-from-bundle`。
  - lifecycle selector 在当前 OS 无法解析时输出 `unsupported-on-current-os`。
  - schema required 项无法从 default/user/project effective config 满足时输出 `missing-required`；`file` / `directory` 失效时输出 `invalid-config`，并在 `status --json` 暴露稳定 issue 字段。
  - status 读取过程中不创建 config store、不刷新 marketplace、不修复 bundle 缺口。

### Integration

- `cli-entry.test.ts`
  - `aw config ...` 参数解析、stdout/stderr、错误码。
  - `aw config configure <plugin>` 在 fake prompt 下写入 schema 合法值，敏感值不出现在输出中。
  - `aw config configure <plugin> --json` 在真实 prompt harness 可用且 stdout 被 JSON 占用时仍能交互；stdout 必须是单一可 `JSON.parse` 的 receipt，prompt 文案、候选列表、确认问题、verbose 和 warning 只能进入 stderr 或 log file，敏感值不能出现在任一输出通道。该用例属于 `docs/testing.md` 明确允许的 prompt runtime 合同例外。
  - `aw config configure <plugin> --json` 经由默认 prompt 输入 `sensitive: true` 值时，真实输入不会回显到 stdout、stderr、debug log 或 log file；stdout 仍只包含 JSON receipt，receipt 中也只能出现脱敏摘要。
  - `aw config configure <plugin>` 未传 `--scope` 时 fake prompt 可从默认 `user` 改选 `project`，最终只写 project store，user store 不被创建或修改。
  - `aw config configure <plugin> --scope project` 和 `--scope user` 时，fake prompt 收到的 `allowedScopes` 必须是单值；如果 fake prompt 返回另一层 `selectedScope`，命令返回业务错误且不创建或修改任何 store。
  - `aw config configure <plugin>` 从 effective config 展示 user/project/default 既有值后，fake prompt 只修改部分 key 并切换 scope 时，命令只 patch `updatedKeys` 到目标 scope；另一层已有值和未修改 sensitive key 不会被复制或覆盖。
  - `aw config configure <plugin> --json` receipt 的 `updatedKeys` 只包含本次显式修改的 key，不把 prompt 展示过但未修改的 effective key 算作更新。
  - `aw config configure <plugin>` 在 fake prompt 返回 `cancelled: true` 时返回业务错误，不创建或修改 user/project store，并给出配置补救建议。
  - `aw config get/list` 未传 `--scope` 时展示 effective config；显式 `--scope user|project` 时展示单层 store。
  - project 配置覆盖 user 配置；删除 project store 后回落到 user store。
  - `aw config set` 写入 `file` / `directory` 时，在 repo root 和 repo 子目录执行同一个相对路径得到同一个 absolute realpath；删除目标文件/目录后，`get/list` 报告 `invalid-config` 且不泄漏敏感值。
  - 未在目标 scope 安装插件时，仍允许 `aw config set/configure <plugin> --scope <scope>` 写入配置。
  - 插件已卸载、配置仍在、current catalog 已缺失时，`aw config reset <plugin> [-s scope]` 经交互确认或 `--yes` 后仍能成功清理残留配置。
  - `aw config reset <plugin> --yes` 在非交互环境中能删除目标 store，且不会调用 prompt；未传 `--yes` 时，非 TTY、`CI=true`、`--no-interactive` 或缺 prompt 都返回业务错误，不删除任何 store。
  - `aw config reset <plugin>` 在 fake prompt 确认时才删除；fake prompt 拒绝或取消时返回业务错误，user/project store 都保持原样；目标 store 不存在时返回 no-op，不触发确认。
  - `aw config reset <plugin> --json` 在目标 store 存在、需要确认且实际走真实 prompt harness 时，stdout 仍是单一可 `JSON.parse` 的 receipt；删除确认文案进入 stderr，确认拒绝或取消时也不能把旧配置值或 prompt 文案写进 stdout。该用例属于 `docs/testing.md` 明确允许的 prompt runtime 合同例外。
  - `aw config reset ../../x`、`aw config reset a/b`、`aw config get a\\b` 等非法插件名不会触发 raw-store 路径访问，错误信息明确说明插件名不是安全的本地配置路径 segment。
  - current catalog 缺失时，`aw config get/list` 不输出 raw store 内容，错误信息引导用户使用 `aw config reset`。
  - current catalog 缺失时，`aw config set/configure/unset` 也按缺少 current schema 失败，错误信息同样引导用户只能用 `reset` 清理残留配置。
  - 插件存在于 current catalog 但没有 `config.schema` 时，`aw config set/configure/unset/get/list` 全部失败并保持 stdout/stderr 脱敏；`reset` 仍只按 raw-store 删除规则处理。
  - 非 TTY、`CI=true`、`--no-interactive` 或缺 prompt 时，`config configure` 不挂起，返回业务错误和 `aw config set` 建议。
  - `aw config set <plugin> <key> <value> --json` 输出 JSON receipt，但仍按普通字符串路径解析 `<value>`；`aw config set ... --value-json` 才解析 JSON literal。
  - `aw config set ... --value-json --json` 同时覆盖输入 JSON literal 和输出 JSON receipt，stdout 仍是单一可 `JSON.parse` 的对象。
  - `aw config unset <plugin> <key> --json` 输出单一 JSON receipt；人类 warning、verbose 和 debug log 路径都不能进入 stdout。
  - `aw config reset <plugin> --yes --json` 在 current catalog 存在和缺失时都输出单一 JSON receipt；非交互缺少 `--yes` 的错误也不能泄漏旧配置值。
  - `aw config get/list --json` 的 stdout 是纯 JSON，不混入 warning、verbose 或 debug log 路径。
  - `aw config get/list/set/configure/unset/reset --json --debug --log-file <path>` 不在 stdout、stderr 或 log file 泄漏敏感值。
  - `install` / `upgrade` / `uninstall` 的 `--script-timeout <ms>` 只接受 `1000..300000` 的整数；非法值在 CLI entry 返回业务错误，不进入 command 执行。
  - `aw --help` / 子命令 help 不出现插件脚本测试入口，也不出现 `--no-scripts`。
- `discovery.test.ts` 或 status CLI entry 对应用例
  - 只有 user/project config store、但没有 ledger、tracking、native state 和 runtime evidence 时，`buildCommandCandidates({ command: "status" })` 不产生“已安装”候选；指定插件名查询时，`status --json` 仍返回 `notInstalled`。
- `cli.test.ts`
  - install / upgrade 缺 required config 且 fake prompt 可用时，在 native state 写入前补问配置并继续执行。
  - install / upgrade preflight 中 fake prompt 可把写入层从命令目标 scope 改到另一层；写入后重新按 `default < user < project` 解析 effective config，lifecycle 看到的是重新解析后的值和来源。
  - install / upgrade preflight 中 fake prompt 只返回缺失 key 的 `updates`；切换写入层时不把另一层已有 sensitive key 或其它未修改 effective key 复制到目标 store。
  - `aw install <plugin> -p both` 缺 required config 且 fake prompt 可用时，只调用一次配置向导，只写一次 config store；codex / claude 两个平台都复用同一份重新解析后的 effective config。
  - 双平台 install / upgrade preflight 中 fake prompt 把 `selectedScope` 改到另一层时，两边 platform 都复用该层写入结果，不会第二次按命令原始 scope 覆盖。
  - 同一插件在同一条 install / upgrade 命令里不会产生重复 config receipt、重复 warning 或重复 prompt 调用；测试需要断言 fake prompt 调用次数、store write 次数和 reporter 输出次数。
  - install / upgrade preflight 中 fake prompt 返回 `cancelled: true` 时，在 native state、repo-managed artifacts、tracking 和 ledger 写入前失败，且不保留部分配置写入。
  - install / upgrade 缺 required config 且非交互时，在 native state 写入前失败，不写平台状态、tracking 或 ledger。
  - `aw install a b` 中第二个 target 缺 required config 时，第一个 target 也没有 native state、repo-managed artifacts、tracking 或 ledger 写入，证明 preflight 不在逐 target 写入循环内延后执行。
  - 双平台 install 中任一 `platform + target` 缺 required config 时，两个平台都不写 native state、tracking 或 ledger。
  - user scope 安装的插件能读取 project override；project scope 安装的插件能读取 user 默认配置。
  - install / upgrade preflight 遇到失效的 `file` / `directory` 配置时，在 native state 写入前失败；lifecycle 不会收到包含失效路径的 context。
  - install 成功后执行 lifecycle，脚本看到 effective config、config sources 和 generatedArtifacts。
  - `aw install --script-timeout <ms>` 的 install lifecycle 使用 CLI 覆盖值；测试要能区分 CLI 覆盖、manifest `scripts.timeoutMs` 和 runtime 默认值。
  - lifecycle 支持 Node、POSIX shell 和 PowerShell fixture；在非 Windows CI 上至少用 runner argv builder 覆盖 Windows 分支。
  - install lifecycle 失败触发现有回滚 / degraded ledger 语义。
  - uninstall lifecycle 在平台卸载前执行，失败不删除状态。
  - `aw uninstall --script-timeout <ms>` 的 uninstall lifecycle 使用 CLI 覆盖值；测试要能区分 CLI 覆盖、manifest `scripts.timeoutMs` 和 runtime 默认值。
  - 成功执行 `aw uninstall` 后，user/project config store 仍保留；随后 `status --json` 回到 `notInstalled`，`aw config get/list` 仍能读取 effective config，`aw config reset` 仍能显式清理残留配置。
  - 成功执行 `aw uninstall` 后，当前 target 的 ledger 记录被删除，若原安装快照的 exact snapshot root 已无其它 ledger 引用则被回收；若另一 scope、project 或 platform 安装了同 digest 插件，它应拥有独立 snapshot root，当前回收不能删除那个独立目录。
  - current catalog、activeLocalBundle 与 ledger 安装快照同时存在但 lifecycle 内容不同时，uninstall 执行安装快照的脚本。
  - current catalog 与 ledger 安装快照同时存在，且 lifecycle 和 config schema/default 都不同时，uninstall 脚本看到的是安装快照那一版 `config.values` / `config.schema`。
  - Codex 本地 marketplace refresh 导致 current catalog / activeLocalBundle 漂移时，status health 和 uninstall lifecycle 都使用 ledger 安装快照，不使用刷新后的 `~/.aw/plugins/<plugin>`。
  - historical uninstall 在 current catalog 缺失但 ledger 安装快照仍有 lifecycle 时执行 uninstall lifecycle。
  - historical uninstall 在 current catalog 和 ledger 安装快照都没有可执行 lifecycle 时 warning 后继续清理。
- `init-command.test.ts` 或 CLI entry 对应用例
  - `aw init --force` 不删除既有 `plugin-config/`。
  - `aw init --force`、stale refresh 和本地 `config.json` 损坏重建都不删除安装快照目录。
- `upgrade-command.test.ts`
  - upgrade 执行 `upgrade` lifecycle。
  - `aw upgrade --script-timeout <ms>` 的 upgrade lifecycle 使用 CLI 覆盖值；测试要能区分 CLI 覆盖、manifest `scripts.timeoutMs` 和 runtime 默认值。
  - capabilityChanged 内部清理不触发 `uninstall` lifecycle。
  - `upgrade --all` 中任一插件缺 required config 时，在进入任何 target 的 capabilityChanged 内部 uninstall、install 或 lifecycle 前失败，不先升级其它安全子集。
- `runtime-env.test.ts`
  - `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 和 project config store 覆写正确。
  - lifecycle runner 与 `plugin:test` runner 的 context、spawn env、config helper 都使用 runtime env，不回落到 `process.env` 或真实 home。
  - Windows env builder 分支设置隔离 `USERPROFILE`、`TEMP`、`TMP`，不会透传宿主 `USERPROFILE` / temp；POSIX 分支设置隔离 `HOME`、`TMPDIR`。
  - direct command 与 `runCli(..., { env })` 两条入口下，config path、catalog 解析、lifecycle context 和 status 诊断都使用 runtime env，不回落到 `process.env`。
  - 非 repo / 非 workspace cwd 下，direct command、CLI entry、status 健康检查和无 `AW_PLUGIN_CONTEXT` 的 config helper fallback 都读写同一个 project config store。
  - `status --json --debug` 不污染 JSON stdout；config/script 健康诊断和 `healthSource` 进入 JSON 稳定字段或 debug log。
  - `status --json --debug --log-file <path>` 在 config/script 健康诊断、漂移诊断和日志文件中都不泄漏敏感值。
  - status 在 current catalog / activeLocalBundle 与 ledger 安装快照漂移时展示安装快照的 config/script 健康；current catalog 缺失但安装快照可读时也保持同样行为。
  - status 在只有 historical tracking / ledger 证据时展示 `healthSource: "historical"`；完全没有可信 manifest 和历史证据时展示 `healthSource: "none"`。
  - status 覆盖 `missing-from-bundle`、`unsupported-on-current-os`、`missing-required`、`invalid-config` 四类健康态，且不会因为读取健康信息写入 `~/.aw` 或 project config store。
- `authoring-tools.test.ts`
  - 脚手架生成 lifecycle/config/test 样板；启用 config helper 时写入 `scripts.helpers.config`。
  - 脚手架可选生成 `scripts.node.packageRoot`、package metadata、lockfile 提示和 manifest build 样板。
  - validate script 在 build-free fixture 下拒绝坏脚本路径、坏 helper 路径、坏 config schema、坏 packageRoot、缺锁文件、非 registry 依赖来源和隐式 package.json lifecycle build；不要求证明任意 helper 读取的配置 key 都来自 schema。需要真实安装依赖后扫描 runtime dependency install/postinstall 类脚本的 fixture 移到 smoke/opt-in suite。
  - `plugin:test` runner 覆盖没有测试文件、测试通过、测试失败。
  - `plugin:test` 没有匹配测试入口时退出码为 0，输出 skipped/no tests matched 摘要，不调用裸 `node --test`，也不会执行临时 project root 或 bundle 中未被 manifest glob 匹配的其它测试文件。
  - `plugin:test` runner 使用已编译的 `dist/scripts/test-plugin-scripts.js` 和 `dist/scripts/**` staging helper；测试断言 runner 不依赖 `packages/cli/tests/helpers/embedded-root.ts`。
  - `plugin:test <plugin>` 只处理指定插件；fixture 中加入另一个坏 manifest 插件时，单插件测试仍应通过。
  - `plugin:test <plugin>` 不要求先跑全量 `pnpm build`，也不会在进入单插件路径前执行 `bundlePlugins()`；常规 integration 只用 file-only 或 fake staging fixture 覆盖单插件隔离，不真实执行其它插件的 staging build。
  - `plugin:test --all` 才会被其它插件的 manifest / bundle / test 失败阻断。
  - `plugin:test --platform codex|claude|both|auto` 分别覆盖单次、双次隔离运行和按 build 后 staging manifest 的 product policy 推断；`--scope user|project` 写入 context 并影响临时 config store 视图；`--test-name` 原样传给 Node `--test-name-pattern`。
  - `plugin:test` 的 Node 进程 `cwd` 稳定为受管临时 project root；测试里断言 `process.cwd()`、`AW_PLUGIN_CONTEXT.cwd`、`paths.configStores.project` 的 project root 一致，且不等于 source root、staging 插件根、临时 bundle root 或调用命令时的真实仓库。
  - `plugin:test` 中绕开或清空 `AW_PLUGIN_CONTEXT` 调用标准 config helper fallback 时，helper 通过 `process.cwd()` 命中同一个临时 project root 下的 project store，并通过隔离 `AW_HOME` 命中临时 user store，不读写真实仓库或真实用户 home。
  - `plugin:test --platform both` 中 codex 测试如果改写 bundle root 文件，claude 测试看不到该改动；反向顺序也应保持隔离，避免双平台测试出现顺序相关的误报或漏报。
  - `plugin:test` 运行的是复制到临时 bundle 的测试文件；测试入口 import sibling helper 时，runner 会递归复制 test-only helper；测试内相对 import 命中 bundle runtime 文件；如果 bundle 漏复制 lifecycle/helper 或其 runtime 相对依赖闭包，测试应失败而不是回落到 source 文件。
  - 未声明 `scripts.node` 时，`plugin:test` 拒绝测试文件、lifecycle 或 helper 中的第三方 bare package import；fixture 覆盖 `import "yaml"` 和 `require("yaml")` 都给出清晰错误。
  - `plugin:test` 的隔离 env 同时覆盖 POSIX 与 Windows home/temp 变量，测试 helper 读取 `os.homedir()` / `os.tmpdir()` 时不会命中真实目录。
  - `plugin:test` 失败摘要和 stderr 转发遵守同一套敏感值脱敏规则。
  - `plugin:test` 复制测试文件时不会覆盖 bundle runtime 文件；发生路径冲突时给出清晰错误。

### Smoke

- `pnpm test:smoke:plugin-scripts`
  - 这是唯一会在自动化测试中真实执行 `pnpm install --frozen-lockfile --ignore-scripts`、manifest build 入口和 production dependency closure 扫描的插件脚本回归入口；它不属于根 `pnpm test`，只能显式运行。
  - staging build 入口改写 `.agents-plugin/plugin.json` 中会进入 catalog 的字段时，bundle source manifest、Claude/Codex platform manifest base、marketplace entry 和 `plugin:test` platform/test glob 发现都使用 build 后 staging manifest。
  - `bundlePlugins()` 生成 marketplace manifest 时只使用各插件 staging/bundle 后返回的最终 manifest，不使用 build 前 `discoverPlugins()` metadata。
  - manifest build 后改写 `scripts.node.packageRoot`、`package.json` 或 `pnpm-lock.yaml` 时，staging helper 必须按最终 packageRoot 重新 install；发布 bundle 和 `plugin:test` 都使用最终依赖环境，不复用 build 前 `node_modules`。
  - manifest build 后新增非 registry dependency、runtime dependency install script 或 runtime bare import 未声明依赖时，打包或 `plugin:test` 在测试入口执行前以 authoring validation 错误失败。
  - manifest build 后新增已声明 runtime bare import 时，最终 packageRoot 重装后的 production dependency 会进入 bundle；如果跳过 build 后重装，该 fixture 应失败。
  - build staging 使用隔离临时目录执行 `pnpm install --frozen-lockfile --ignore-scripts` 和 manifest build 入口；不修改源码树，不执行 package.json lifecycle scripts，build 失败时不产出半成品 bundle。
  - `plugin:test <plugin>` 在 fixture 中加入另一个声明 `scripts.node` 且 staging build 会失败的插件时，目标插件仍应通过，证明单插件路径不提前跑全量 `bundlePlugins()`。
  - 声明 manifest build 入口并在 staging 中改写 `marketplace.policy.products` 的 fixture，`plugin:test --platform auto` 必须按 build 后 staging manifest 选择平台，而不是 source manifest。
  - 声明 manifest build 入口并在 staging 中改写 `scripts.tests.node` 的 fixture，`plugin:test` 必须按 build 后 staging manifest 发现测试入口；source manifest 中旧 glob 指向的测试不应被执行。
  - 声明 `scripts.node` 时，`plugin:test` 允许测试/build 文件引用 devDependencies、允许 runtime 文件引用 dependencies，并拒绝 runtime 文件引用 devDependencies 或未声明包。
  - 声明 `scripts.node` 时，`plugin:test` 对非 registry 依赖来源和 runtime dependency install scripts 给出清晰 authoring 错误，不拖到测试入口执行中途才失败。
  - 声明 manifest build 入口的插件会在 plugin:test staging 中先运行 build，测试看到 build 后 bundle；源码树不被修改，package.json lifecycle scripts 不会自动执行。
- `pnpm test:smoke:build`
  - 真实 `pnpm build` 后，manifest 声明的 lifecycle、`scripts.timeoutMs`、`scripts.helpers.config` helper，以及 Node lifecycle/helper 相对依赖闭包进入 `plugins-dist`，OS selector 下的 shell lifecycle 文件也进入 bundle，开发期测试文件不进入发布 runtime bundle。
  - 声明 `scripts.node.packageRoot` 的 fixture 在真实 `pnpm build` 中完成隔离依赖安装和 manifest build，production `node_modules` 与 packageRoot 内 runtime 相对依赖闭包进入 `plugins-dist`，devDependencies、测试文件、test-only helper 和构建缓存不进入发布 runtime bundle。
  - 声明 manifest build 入口的 fixture 在 staging 中改写 catalog 字段后，`plugins-dist` 的 marketplace entry、bundle `.agents-plugin/plugin.json` 和 platform manifest base 保持一致；改写 `name` 的 fixture 以 authoring validation 错误失败。
  - smoke fixture 的 bundle metadata 只包含 registry-backed runtime 依赖；tarball / bundle 审计确认没有 `workspace:`、`file:`、`link:`、git/URL 依赖来源，也没有 runtime dependency install scripts 漏进发布产物。
  - `validateBundleLayout()` 通过；如果临时删除 runtime 相对依赖闭包中的 sibling 模块，layout 校验必须失败。
- `pnpm test:smoke:pack`
  - npm tarball 包含 manifest 声明的 AW 脚本、配置 helper、它们的 runtime 相对依赖闭包、package metadata 和 production `node_modules`。
  - `dist/index.js --help` 不暴露 `plugin test` 或 `--no-scripts`。

## 风险与收口

- 生命周期脚本副作用无法通用回滚。首版通过“runner allowlist、禁止内联命令、禁止 `shell: true`、默认超时、失败中止、脚本自行幂等”收口，不承诺自动撤销外部系统变更。
- shell lifecycle 的跨平台风险高于 Node。计划要求每个 lifecycle 事件能解析到 Windows entry，并为 runner 选择和 Windows quoting 建单测；作者文档继续推荐优先用 Node 写跨平台脚本，只有确实需要系统 shell 时再写 `.sh` / `.ps1` / `.cmd`。
- `~/.aw` 既是 marketplace 镜像又要保存 user config，重建时必须保留 `plugin-config/`。如果实现时发现这个边界让 `~/.aw` 职责过重，可以把 user config store 改到 `~/.aw-config/` 或同级目录，但需要先同步路径决策。
- AW project config 采用 repo root 路径，是平台中立配置，不等同于当前 discovery/status 的平台 project identity。实现时不能用 config store 推断 Claude/Codex 安装候选，也不能让 status/discovery 因配置存在就把插件判断成已安装。
- `file` / `directory` 首版以 absolute realpath 落盘，牺牲一部分 project config 可迁移性来换取所有入口的唯一解释。后续如果要支持 repo-root-relative 存储，需要设计显式格式和迁移，不能悄悄改变旧配置语义。
- AW config 与安装状态解耦后，用户可能在未安装插件的 scope 里留下配置。文档需要明确：这是允许的预配置和覆盖机制，`aw uninstall` 不删除配置，敏感配置要用 `aw config reset` 显式清理。
- raw-store `aw config reset` 是必要的历史清理入口，也因此是路径安全和误删高风险点。实现必须把插件名 path segment 校验放在 resolver 最外层，并用测试证明非法插件名不会越界读取或删除；真实删除必须由交互确认或 `--yes` 触发，非交互缺少 `--yes` 时只返回错误。
- 历史卸载会遇到 current catalog、activeLocalBundle 和安装时快照漂移。实现必须把 lifecycle 脚本、schema/default 和 context values 绑定到 ledger 安装快照里的同一个 source manifest；否则旧卸载脚本可能拿到新版配置形状。
- 敏感配置首版不是强安全密钥存储，只做权限和脱敏。脱敏必须覆盖 config 命令、status、lifecycle stdout/stderr、`plugin:test` 失败摘要、debug logger 和 `--log-file`；context 临时文件和 config store 在 POSIX 下使用 `0600` best effort。需要 keychain 时另起方案。
- Claude 原生 `userConfig` 与 AW 自管配置可能同时存在。文档必须明确：AW config 供 AW 脚本和 AW helper 读取；Claude `userConfig` 仍只服务 Claude 原生 plugin manifest。
- 交互式配置必须复用当前 `CliPrompt` 和 runtime 走线。不要在 `aw config`、install preflight 或 lifecycle runner 里直接读 TTY / CI 状态，否则会破坏 fake prompt 测试和非交互确定性。
- `scripts.node` 会让 `pnpm build` 执行插件作者提供的 manifest build 文件，并安装第三方依赖。这个能力只面向仓库内受信插件源码和发布构建链路；运行时不安装依赖、不执行 package manager，也不自动跑 package.json lifecycle。实现必须保证 staging 隔离、lockfile 必需、只接受 registry 依赖、拒绝 runtime dependency install scripts、`--ignore-scripts`、devDependencies 不进 runtime bundle，并在文档中提醒维护者审查依赖来源。
- 涉及 `scripts.node` 的真实 staging install / manifest build 回归不能进入常规 `pnpm test`。这些测试依赖 package manager、lockfile 和 registry-backed fixture，必须通过 smoke/opt-in 脚本显式运行；unit/integration 只覆盖 build-free、纯函数和 fake staging wiring。
- `plugin:test` 使用 Node built-in test runner，不引入 Vitest 到插件运行时，也不把测试入口暴露给 `aw` 客户端。仓库内部仍用 Vitest 测 CLI。测试文件必须在临时 bundle 内执行，避免测试相对 import 绕过 build 产物；声明 `scripts.node` 时允许锁定的第三方依赖，未声明时继续拒绝 bare import，避免测试和真实发布 runtime 使用不同的 Node 依赖解析环境。
- `plugin:test` 的 Node 进程必须在受管临时 project root 下运行。这样无 `AW_PLUGIN_CONTEXT` 的 helper fallback、`file` / `directory` 默认路径和测试内子进程看到的是同一个隔离项目视图，不会污染源码仓库或用户当前目录。
- `plugin:test --platform both` 不能复用同一份可写 bundle root。两轮运行必须从同一个 build 后基准复制独立目录，否则某个平台测试对 runtime 文件的写入会污染另一个平台，掩盖打包缺口或制造顺序相关失败。
- lifecycle 与 `plugin:test` 的隔离 env 必须按 OS 分支处理 home/temp 变量。特别是 Windows 下不能只设置 `HOME` / `TMPDIR`，否则 PowerShell、`cmd` 或 Node API 可能回落到宿主 `USERPROFILE` / `TEMP` / `TMP`。

## 验收标准

- 插件可以在 manifest 中声明 lifecycle Node 脚本、受控 shell 脚本、Node packageRoot、manifest build 入口、开发期 Node 测试 glob 和 AW 自管配置 schema；shell lifecycle 需要有 Windows 可解析 entry。`scripts.node` 首版只接受 registry-backed 依赖，非 registry 依赖来源和 runtime dependency install scripts 会在 authoring / staging validation 阶段失败。
- `pnpm build` 后，runtime 需要的脚本、配置 schema 和 Node packageRoot 保留在 bundle source manifest，生命周期脚本、`scripts.helpers.config` 声明的 helper、这些 Node 入口的相对依赖闭包、package metadata 和 production `node_modules` 存在于 bundle root，测试文件、test-only helper、devDependencies 和 build 入口不进入发布 runtime bundle，OS selector 不会漏复制非当前 OS 的脚本。声明 manifest build 入口时，marketplace entry、bundle source manifest 和 platform manifest base 都以 build 后 staging manifest 为准；build 后改动 `name` 必须失败；build 后改动 packageRoot、package metadata、lockfile 或依赖声明时，最终依赖环境必须重新 install、重新校验并重新扫描 closure，不能复用 build 前结果。
- `aw config set/get/list/configure/unset/reset` 能按 project/user store 管理配置，并校验 schema；读路径默认返回 default < user < project 的 effective config，写路径默认 user，交互式配置通过 fake prompt 可测，非交互不会挂起；`configure` 未显式传 `--scope` 时可在 prompt 中选择写入层，显式传 `--scope user|project` 时 scope 是硬约束，prompt 不能改写到另一层；`configure` 切换写入层时只 patch 本次显式更新的 key，不复制整份 effective config。六个子命令都支持 `--json`，stdout 始终是单一可解析 JSON。非仓库目录下 project scope 回退到 normalized command `cwd`。current catalog 缺失但 store 存在时，`reset --yes` 或交互确认后仍能清理残留配置，非交互未传 `--yes` 不删除。所有 config 命令都拒绝不安全插件名，raw-store reset 也不会越界访问路径。`title` / `description`、`number.min` / `number.max` 等 schema metadata 有稳定 allowlist 和校验。`file` / `directory` 相对值按 AW project root 解析并以 absolute realpath 落盘，后续读取会重新校验失效路径。store 里不属于当前 schema source 的旧 key 只进入脱敏诊断，不进入 effective config、helper 或 lifecycle context。
- `aw install`、`aw upgrade`、`aw uninstall` 能自动执行 lifecycle，且客户端不提供 `--no-scripts` 跳过；三条命令都能用公共 `--script-timeout <ms>` 覆盖 manifest/default timeout，upgrade 重新进入 install 编排时不会丢失该覆盖。install/upgrade 在缺 required config 时能按交互可用性补问或确定性失败。同一插件在双平台或重复 target 矩阵中只补问一次、落盘一次，并让所有 platform cell 复用同一份 effective config。
- `aw config` 支持未安装插件的 scope 预配置和覆盖配置；配置存在不会让 status/discovery 把插件误判为已安装，uninstall 默认保留配置。
- 生命周期脚本能通过 `AW_PLUGIN_CONTEXT` 读取 effective config、config sources、scope、platform、plugin root 和 generated artifacts；historical uninstall 使用 ledger 安装快照脚本时，`AW_PLUGIN_ROOT`、`AW_PLUGIN_CONTEXT.plugin.rootDir`、脚本路径、`config.schema`、default 和 values 都来自同一个 resolved bundle root，不回落到当前 marketplace root。
- Claude 命令结果填充可以通过标准 Node helper 读取 AW config；helper 无 `AW_PLUGIN_CONTEXT` 时按当前 bundle manifest 解释 schema/default/redaction，和 `aw config` 的 current catalog 视图允许短暂漂移但必须有测试锁住。helper 找不到或无法校验当前 bundle manifest 时必须 fail closed，不能回退到 current catalog 或 schema-less raw store 输出，也不能在 stdout、stderr、debug log 或 log file 泄漏 sensitive 值。
- status 能以只读方式展示 config/script 健康，并按 `healthSource` 说明健康真值来自 installSnapshot、currentCatalog 还是 historical/none；`status --json` 保持纯 JSON，且不因读取健康状态创建或修复 `~/.aw`。失效的 `file` / `directory` 配置会稳定展示为 `invalid-config`。
- `pnpm plugin:test` 通过已编译的 `packages/cli/scripts/test-plugin-scripts.ts` 入口运行，启动前只做 `tsc` compile-only，不触发全量 `pnpm build` 或 `bundlePlugins()`；单插件模式不会被其它插件的 manifest、staging build 或测试失败阻断。它能在隔离临时环境中运行插件 Node 测试，不依赖真实 `~/.aw`；测试进程 cwd、context cwd 和 project config fallback 都指向受管临时 project root。测试入口从最终测试基准 manifest 的 glob 发现，有 manifest build 时跟随 build 后 staging manifest，匹配到的文件复制到临时 bundle 后执行；零匹配是显式 skipped/no-op，退出码为 0，且不触发 Node 默认测试发现。test-only helper 会被递归复制，能捕获 runtime helper 没有进入 bundle 的回归。`--platform both` 为 codex/claude 两轮复制独立可写 bundle，互不污染。测试 runner 只允许声明过的第三方依赖，并按 POSIX / Windows 分支隔离 home/temp 变量；真实 `scripts.node` staging 回归由 `pnpm test:smoke:plugin-scripts` 或 smoke suite 显式覆盖，不进入常规 `pnpm test`；这些规则要在 `.agents/skills/create-agent-workflows-plugin` 插件开发技能内说明。
