# 平台专属插件构建物需求 Spec

日期：2026-05-06

## 背景

AW 插件 manifest 已经能声明平台范围：

- `marketplace.policy.products` 可以限制插件只支持 `CODEX`、只支持 `CLAUDE`，或省略表示双平台可用。
- `extensions.*.agentOverrides`、`extensions.nativeHooks.<platform>`、`artifacts.targets[].platform` 和 `buildConfig.fileRules.<platform>` 已经能表达平台差异。

但当前 build 产物仍按“双平台都有 runtime manifest”的老 contract 生成。典型问题是 `plugins/codex-explore`：

- 源码 manifest 明确写了 `marketplace.policy.products = ["CODEX"]`。
- 动态 artifact targets 全是 `platform: "codex"`。
- 额外文件规则只声明了 `buildConfig.fileRules.codex`。
- 实际 `pnpm build` 后仍生成 `packages/cli/plugins-dist/plugins/codex-explore/.claude-plugin/plugin.json`，并把同一份 `skills` 复制到 `claude/skills/codex-explore/`。

这会让“安装门禁”和“发布产物”脱节：CLI 已经会阻止把 Codex-only 插件装到 Claude Code，但 bundle 里仍有 Claude 原生 manifest 和 Claude runtime 文件。修复目标不是给 `codex-explore` 写特殊逻辑，而是补齐平台范围对 build / bundle layout / marketplace 的统一约束。

## 当前基线事实

### manifest 与平台范围

- 源码树的初始 manifest 是 `plugins/<name>/.agents-plugin/plugin.json`。如果插件声明了 `scripts.node.build`，staging build 可以改写临时目录里的 `.agents-plugin/plugin.json`；对 bundle、platform manifest、runtime 文件收集、platform marketplace 生成和 `pnpm plugin:test` 来说，build 后重新读取的 staging manifest 才是真值。install / upgrade 这类直接消费 current catalog 的命令，继续以当前 catalog manifest 为真值。
- `packages/cli/src/utils/manifest.ts` 只允许 `marketplace.policy.products` 使用 `CODEX` 和 `CLAUDE`。
- 省略 `marketplace.policy.products` 表示不限制平台；当前安装/升级侧通过 `pluginSupportsPlatform()` 把它解释为支持目标平台。
- `createPlatformManifestBase()` 只写 `name`、`version`、`description`、`interface`，不会把产品范围写进 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。

### build 生成器

- `bundleLocalPlugin()` 当前无条件创建两份 platform manifest：`claudeManifest` 和 `codexManifest`。
- 顶层路径字段无条件复制到两边：
  - `skills` 同时进入 `./claude/skills` 和 `./codex/skills`。
  - `mcpServers` 同时进入 `./claude/...` 和 `./codex/...`。
  - `apps` 只进入 Codex。
- `slashCommands` 当前无条件生成 Claude `commands` 和 Codex manual-only skill。
- `buildConfig.fileRules.<platform>` 只控制额外文件，但不会决定该平台 bundle 是否存在。
- `scripts`、`config`、`artifacts.targets` 会留在 `.agents-plugin/plugin.json`，不进入平台 manifest。

### bundle layout 与 marketplace

- `packages/cli/scripts/bundle-plugins.ts` 当前把同一份 marketplace 同时写到：
  - `.claude-plugin/marketplace.json`
  - `.agents/plugins/marketplace.json`
- `validateBundleLayout()` 当前要求两份 marketplace 内容完全一致，并且每个 marketplace entry 都必须同时存在：
  - `plugins/<name>/.agents-plugin/plugin.json`
  - `plugins/<name>/.claude-plugin/plugin.json`
  - `plugins/<name>/.codex-plugin/plugin.json`
- `readMarketplaceManifest()` 也要求两份 marketplace 镜像完全一致。
- `resolveCatalogPlugins()` 不通过 marketplace entry 发现插件，而是扫描 `plugins/<name>/.agents-plugin/plugin.json`。这意味着 AW 自己的 current catalog 可以继续包含全部插件，不必依赖平台 marketplace 是否列出该插件。

### 安装侧平台门禁

- `pluginSupportsPlatform()` 已经在 install / upgrade 的平台解析中生效。
- `--platform claude` 安装 `products=["CODEX"]` 的插件会失败。
- `--platform both` 遇到单平台插件也会在写入前失败。
- `--platform auto` 会先按 `products` 过滤候选平台，再做目标平台推断。

### 作者脚本测试 runner

- `packages/cli/scripts/test-plugin-scripts.ts` 的 `inferPlatforms()` 当前单独解析 `marketplace.policy.products`，`--platform auto` 会据此决定运行 Codex、Claude 还是双平台测试。
- `--platform claude|codex` 当前直接返回显式目标平台，`--platform both` 直接返回双平台，不会校验 `marketplace.policy.products`。单平台 bundle 落地后，这会让 runner 可能尝试测试一个插件并不支持、且不会生成 runtime 文件的平台。
- 这份逻辑需要和 install / build / layout 共用同一套平台范围解析，否则 `pnpm plugin:test` 可能保留旧语义，和实际 bundle 产物分叉。

## 已确认决策

- 平台范围必须参与 build 产物生成。`products=["CODEX"]` 的插件不应生成插件级 `.claude-plugin/plugin.json`、`claude/` runtime 目录，也不应出现在 Claude marketplace manifest 中。
- `products=["CLAUDE"]` 同理不应生成插件级 `.codex-plugin/plugin.json`、`codex/` runtime 目录，也不应出现在 Codex marketplace manifest 中。
- 省略 `products` 或同时声明 `["CODEX", "CLAUDE"]` 时，继续生成双平台产物。
- 如果插件排除了某个平台，但 manifest 仍声明了该平台专属构建配置，build 必须失败，而不是静默忽略或只发 warning。
- `.agents-plugin/plugin.json` 仍是 AW runtime / catalog 真值。即使插件只支持单平台，插件目录下也必须保留 `.agents-plugin/plugin.json` 和 AW 运行时脚本闭包。
- 本需求有意放宽动态 artifact 的作者 contract：声明 Codex 动态 target 不再强制要求 `marketplace.policy.products=["CODEX"]`。只要 target 平台属于插件支持的平台集合，就允许声明；双平台插件可以携带 Codex 动态 artifacts。
- `pnpm plugin:test` 的显式 `--platform claude|codex|both` 不是 override。它必须受插件支持平台集合约束：`claude` / `codex` 只允许测试插件支持的平台，`both` 只对双平台插件合法；不匹配时要在生成 runtime bundle 和执行测试前 fail fast。支持平台集合必须来自 build 后 staging manifest，不能只看 source manifest。

## 目标

1. 让 `marketplace.policy.products` 成为 build 阶段的平台裁剪输入。
2. Codex-only 插件的产物中不出现插件级 Claude bundle 文件；Claude-only 插件的产物中不出现插件级 Codex bundle 文件。
3. 平台 marketplace 只列出该平台可安装的插件，避免原生平台看到无法加载的插件 entry。
4. 保持 AW current catalog 能看到全部插件，以便 status、discovery、历史卸载、跨平台诊断和显式错误仍能工作。
5. 对平台范围与平台专属配置的矛盾做 fail fast 校验。
6. 更新 bundle layout 校验、测试、作者文档和插件作者工具参考，避免新 contract 只存在于实现里。
7. 同步放宽 `artifacts.targets` 的作者工具校验，让它跟平台支持集合一致，而不是继续要求 Codex-only。
8. 让 `pnpm plugin:test` 的自动和显式平台选择都复用同一套平台支持语义。

## 非目标

- 不改变 `marketplace.policy.products` 的取值集合；仍只支持 `CODEX` 和 `CLAUDE`。
- 不引入新的顶层 `claude` / `codex` manifest block。
- 不改变 install / upgrade 的平台门禁语义；本需求只让 build 产物与既有门禁一致。
- 不把 `products` 写入 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`，平台 manifest 仍只承载平台原生能力。
- 不新增 Claude 动态 artifact target；首版动态 artifact target 仍只有 Codex，只是允许它出现在双平台插件中。
- 不支持“同一个插件目录内某个 skill 只给 Claude、另一个 skill 只给 Codex”的源码级混合发布；顶层 `skills` 仍按插件支持的平台整体复制。更细粒度差异继续使用模板、`agentOverrides`、`nativeHooks.<platform>`、`artifacts.targets[].platform` 或拆分插件表达。

## 平台范围解析

新增一个 build/layout 共用的解析语义，建议封装为纯函数，避免生成器、marketplace、layout 校验各自复制判断：

```ts
type SupportedPlatformSet = ReadonlySet<PlatformName>;
```

解析规则：

- `products` 省略或为空：支持 `claude` 和 `codex`。
- 包含 `CODEX`：支持 `codex`。
- 包含 `CLAUDE`：支持 `claude`。
- 同时包含两者：支持 `claude` 和 `codex`。
- token 归一化沿用现有 `trim().toUpperCase().replace(/[\s-]+/g, "_")` 语义。

该函数应放在 CLI、build 和作者脚本测试 runner 都能复用的位置。现有 `pluginSupportsPlatform()` 和 `packages/cli/scripts/test-plugin-scripts.ts` 的 `inferPlatforms()` 都应改为调用它，避免安装侧、构建侧和 `pnpm plugin:test` 长期分叉。runner 解析显式 `--platform` 时也必须先取得支持平台集合，再验证用户选择是否可用。

平台支持集合的输入 manifest 取决于消费场景：

- build / bundle / `pnpm plugin:test`：以最终 staging manifest 为准。即使 source manifest 和 staging manifest 的 `marketplace.policy.products` 不一致，也必须以后者为真值。
- layout：以 bundle 中的 `.agents-plugin/plugin.json` 为准；这份 bundle source manifest 应来自最终 staging manifest。
- install / upgrade / status / discovery：以当前 catalog 中的 bundle source manifest 为准；这些命令不重新运行源码 build。

## 目标行为

### 单插件 bundle

`bundleLocalPlugin()` 必须在完成对应 build mode 的 manifest 解析后，先从当前待打包 manifest 计算插件支持的平台，再按平台生成产物。`buildMode: "staging"` 下应使用 build 后 manifest；`buildMode: "prepared"` 下调用方必须已经传入 staging 后的 plugin。

对支持的平台：

- 生成对应 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- 复制该平台需要的顶层声明路径、生成产物、平台专属 hooks/agents 和 `fileRules` 额外文件。
- 路径仍写成 `./claude/...` 或 `./codex/...`，保持平台 manifest 内部路径不变。

对不支持的平台：

- 不创建该平台 manifest 目录。
- 不复制该平台 runtime 目录。
- 不执行该平台的 slash command 生成。
- 不渲染该平台的 hooks、agents 或其它平台专属静态产物。

`bundleLocalPlugin()` 的内部返回合同也必须按同一套平台语义收口，不能继续暴露恒定双平台 manifest。`LocalPluginBundleResult` 应改为：

```ts
interface LocalPluginBundleResult {
  outputRoot: string;
  plugin: PluginMeta;
  platformManifests: Partial<Record<PlatformName, PlatformPluginManifest>>;
}
```

返回规则：

- `platformManifests` 只能包含插件最终支持平台对应的 manifest。
- 不支持的平台不得在返回对象里保留占位 manifest；不能为了调用方便继续返回空的 `claudeManifest` 或 `codexManifest`。
- `platformManifests` 的 key 集合必须和 build 后最终 manifest 解析出的支持平台集合一致。
- 调用方生成平台 marketplace、测试断言或后续 bundle 校验时，必须以 `.agents-plugin/plugin.json` 的最终 manifest 和 `platformManifests` 为输入，不能再依赖固定的 `claudeManifest` / `codexManifest` 字段。

Codex-only 插件示例产物：

```text
plugins/codex-explore/
├── .agents-plugin/plugin.json
├── .codex-plugin/plugin.json
├── codex/
│   ├── instructions/lightweight.md
│   ├── roles/codex-explorer.md
│   └── skills/codex-explore/
│       ├── SKILL.md
│       └── agents/openai.yaml
└── scripts/render-artifacts.mjs
```

其中不得出现：

```text
plugins/codex-explore/.claude-plugin/plugin.json
plugins/codex-explore/claude/**
```

### `pnpm plugin:test` 平台选择

`pnpm plugin:test` 虽然是开发期测试入口，也必须按插件支持平台集合准备临时 bundle。显式平台参数只是在支持集合内缩小测试目标，不允许强制测试未支持平台。由于 manifest build 可以改写 `marketplace.policy.products`，runner 必须先完成 `prepareLocalPluginBundleSource(..., { buildMode: "staging" })`，再用 build 后 staging manifest 解析支持平台集合。

- `--platform auto`：直接使用插件支持平台集合。Codex-only 插件只跑 Codex 一轮，Claude-only 插件只跑 Claude 一轮，双平台插件跑两轮。
- `--platform codex`：只有插件支持 Codex 时合法；Codex-only 和双平台插件可以运行，Claude-only 插件必须 fail fast。
- `--platform claude`：只有插件支持 Claude 时合法；Claude-only 和双平台插件可以运行，Codex-only 插件必须 fail fast。
- `--platform both`：只有插件同时支持 Codex 和 Claude 时合法；Codex-only 或 Claude-only 插件必须 fail fast。

runner 时序必须是：

1. 读取源码插件 manifest，定位插件和测试配置。
2. 执行 `prepareLocalPluginBundleSource(..., { buildMode: "staging" })`，拿到 build 后 staging manifest。
3. 基于 staging manifest 解析插件支持平台集合，并校验显式 `--platform` 是否在支持集合内。
4. 如果校验失败，清理 staging 目录，并在调用 `bundleLocalPlugin()` 和执行测试前报 contract 错误。
5. 如果校验通过，再把 staging 后的 plugin 传给 `bundleLocalPlugin(..., { buildMode: "prepared" })`，生成测试用 runtime bundle。

这样既保留“显式平台不匹配要 fail fast”的 contract，又不会把 source manifest 误当成 build 后 manifest 的真值。错误文案需要包含插件名、显式平台选择、当前 staging manifest 中的 `marketplace.policy.products` 和插件实际支持的平台集合。

### `slashCommands`

`slashCommands` 是跨平台源码入口，但生成结果必须受平台范围约束：

- 双平台插件：继续同时生成 Claude `commands/*.md` 和 Codex manual-only skills。
- Codex-only 插件：只生成 Codex manual-only skills，不生成 Claude commands。
- Claude-only 插件：只生成 Claude commands，不生成 Codex manual-only skills。

如果命令 Markdown 中的平台 frontmatter 只服务被排除的平台，仍应按目标平台范围解析对应可用部分。已有 Codex 渲染语法泄漏校验只需要在生成 Codex 产物时执行；Claude-only 插件不应因为 Codex-only 语法限制阻断 build。

实现上，`resolveSlashCommands()` 不应再无条件同时渲染和校验 Claude / Codex。它可以显式接收目标平台集合，或返回按平台拆开的解析结果；无论选择哪种接口，直接调用 `resolveSlashCommands()` 的单测都要覆盖单平台插件，不能只靠 `generators.test.ts` 间接验证。

### 顶层路径字段

顶层 `skills`、`mcpServers`、`apps` 的复制规则：

- `skills`：复制到所有支持的平台。
- `mcpServers`：复制到所有支持的平台。
- `apps`：仍只复制到 Codex；若插件不支持 Codex，则不得生成 Codex app 产物。

如果插件声明了 `apps` 但 `products=["CLAUDE"]`，这是矛盾配置，build 必须失败。原因是 `apps` 当前没有 Claude runtime 承载面，静默忽略会让作者误以为 app 已发布。

### 静态 extensions

`extensions.*` 仍按现有平台解析规则工作，但只对支持的平台生效：

- `extensions.hooks` 公共 hooks 只渲染到支持的平台。
- `extensions.nativeHooks.<platform>` 只允许声明在支持的平台上。
- `extensions.agents`、`instructions`、`permissions` 中的 `agentOverrides.<platform>` 只在支持的平台解析。

如果插件排除了某个平台，却声明了该平台专属 native hook 或其它明确的平台专属构建配置，build 必须失败。

公共 extension 加上 `agentOverrides.<unsupportedPlatform> = null` 这种“显式排除”不应视为冲突；它表达的是不在该平台生成，和产品范围一致。真正需要失败的是会向被排除平台增加或覆盖产物的配置。

### 动态 artifacts

`artifacts.targets[].platform` 必须和插件支持的平台一致：

- target 指向支持的平台：允许。
- target 指向被 `products` 排除的平台：build / manifest 校验应失败。
- 双平台插件声明 `platform: "codex"` 的动态 target：允许。该 target 只参与 Codex 安装、升级、status、project preflight、ledger capability snapshot 和 config refresh；Claude 分支不得把它当作 Claude 能力。
- Codex-only 插件声明 `platform: "codex"` 的动态 target：继续允许。

当前 artifact target 只支持 Codex。因此如果插件声明 `products=["CLAUDE"]` 又声明 `artifacts.targets`，必须失败；如果未来新增 Claude artifact target，再按同一条“target 平台必须属于插件支持集合”的规则扩展。

这是对既有作者工具 contract 的有意放宽。实现时需要把 `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js` 和作者参考中“Codex 动态 artifact 插件必须 Codex-only”的规则改成“动态 artifact target 必须属于插件支持平台集合”。

### buildConfig

`buildConfig` 的平台专属字段必须受平台范围约束：

- `buildConfig.fileRules.claude` 只能出现在支持 Claude 的插件中。
- `buildConfig.fileRules.codex` 只能出现在支持 Codex 的插件中。
- `buildConfig.manifestOverrides.claude` 只能出现在支持 Claude 的插件中。
- `buildConfig.manifestOverrides.codex` 当前只允许空对象；如果插件不支持 Codex，不应声明它。

冲突示例：

```json
{
  "marketplace": {
    "policy": {
      "products": ["CODEX"]
    }
  },
  "buildConfig": {
    "manifestOverrides": {
      "claude": {
        "outputStyles": "./output-styles"
      }
    }
  }
}
```

期望失败信息应指出：

- 插件支持的平台来自 `marketplace.policy.products=[CODEX]`。
- 冲突字段是 `buildConfig.manifestOverrides.claude`。
- 该字段需要 `CLAUDE` 支持。

## Marketplace contract

根级 marketplace 不再要求 Claude 与 Codex 内容完全一致。

`bundlePlugins()` 生成平台 marketplace 时，必须使用每个插件完成 staging / bundle 后返回的最终 manifest 作为 entry 和平台过滤依据，不能用 `discoverPlugins()` 读到的 source metadata 直接过滤。若 source manifest 与 build 后 staging manifest 的 `marketplace.policy.products` 不一致，平台 marketplace 以 staging manifest 为准。

### Claude marketplace

`.claude-plugin/marketplace.json` 只包含支持 Claude 的插件：

- 省略 `products` 的插件。
- `products` 包含 `CLAUDE` 的插件。

它不得包含 Codex-only 插件 entry。否则 Claude Code 会看到一个指向 `./plugins/<name>` 的 entry，但该插件下没有 `.claude-plugin/plugin.json`。

### Codex marketplace

`.agents/plugins/marketplace.json` 只包含支持 Codex 的插件：

- 省略 `products` 的插件。
- `products` 包含 `CODEX` 的插件。

它不得包含 Claude-only 插件 entry。

### AW current catalog

AW 自己扫描 `plugins/<name>/.agents-plugin/plugin.json` 得到的 current catalog 继续包含全部插件。这样：

- 显式安装到错误平台时仍能找到插件，并返回“插件不支持目标平台”的稳定错误。
- `status` / `discovery` 可以继续展示历史安装、current catalog 和 embedded catalog 的关系。
- 历史卸载 fallback 不依赖平台 marketplace 是否列出当前插件。

`readMarketplaceManifest()` 不应再比较两份 marketplace 完全一致。它只需要读取目标平台 marketplace，并可单独校验 marketplace 基本结构。

## Bundle layout 校验

`validateBundleLayout()` 需要从每个 `plugins/<name>/.agents-plugin/plugin.json` 解析支持的平台，再校验对应文件：

- 所有插件都必须有 `.agents-plugin/plugin.json`。
- 支持 Claude 的插件必须有 `.claude-plugin/plugin.json`，且所有 Claude manifest 路径都存在并以 `./claude/` 开头。
- 不支持 Claude 的插件不得有 `.claude-plugin/plugin.json`，也不得有 `claude/` runtime 目录。
- 支持 Codex 的插件必须有 `.codex-plugin/plugin.json`，且所有 Codex manifest 路径都存在并以 `./codex/` 开头。
- 不支持 Codex 的插件不得有 `.codex-plugin/plugin.json`，也不得有 `codex/` runtime 目录。
- Claude marketplace 的插件列表必须等于“支持 Claude 的插件集合”。
- Codex marketplace 的插件列表必须等于“支持 Codex 的插件集合”。
- 每个 marketplace entry 的 `source` 仍必须是 `./plugins/<pluginName>`。

不再用 marketplace entry 作为遍历全部插件的唯一来源；应扫描 `plugins/` 下的 bundle source manifest。

## 本地 marketplace 同步

`ensureLocalMarketplace()` / `copyBundleToStaging()` 可以继续复制：

- 根级 `.claude-plugin/`
- 根级 `.agents/`
- `plugins/`

但刷新后的 `~/.aw` 必须通过新的 `validateBundleLayout()`。由于平台 marketplace 已过滤，Claude 原生 runtime 只会从 `.claude-plugin/marketplace.json` 看到 Claude 可用插件；Codex 同理。

`calculateBundleFingerprint()` 会自然反映被裁剪文件的删除，不需要新增格式版本。但如果测试或输出依赖 marketplace mirror identical，需要同步修改。

## 错误处理

### 平台配置冲突

build 或 layout 校验遇到平台范围冲突时必须失败。错误文案要包含：

- 插件名。
- 冲突字段路径。
- 当前 `marketplace.policy.products`。
- 该字段要求的平台。

示例：

```text
Invalid plugin "codex-explore": buildConfig.manifestOverrides.claude requires CLAUDE support, but marketplace.policy.products=[CODEX].
```

### 缺失或多余平台文件

layout 校验应区分两类错误：

- 支持平台缺少 manifest：`missing supported Claude manifest` 或 `missing supported Codex manifest`。
- 不支持平台残留 manifest/runtime 目录：`unexpected Claude bundle files for unsupported platform` 或 `unexpected Codex bundle files for unsupported platform`。

这样能在 CI 中直接定位是构建器漏生成，还是旧产物没有清理干净。

### 插件脚本测试平台不匹配

`pnpm plugin:test` 遇到显式平台选择不在支持集合内时必须报 contract 错误。为了取得 build 后 manifest，它可以先完成 `prepareLocalPluginBundleSource()`；但校验失败后不得继续调用 `bundleLocalPlugin()` 或执行测试。错误文案建议使用和安装门禁一致的表达方式，明确这是插件不支持目标平台，而不是测试文件、runtime manifest 或临时目录缺失。

## 测试要求

### 单元测试

新增或调整 `packages/cli/tests/unit/generators.test.ts`：

- Codex-only 插件只生成 `.codex-plugin/plugin.json` 和 `codex/**`。
- Claude-only 插件只生成 `.claude-plugin/plugin.json` 和 `claude/**`。
- 双平台插件保持现有双 manifest、双 runtime 行为。
- `bundleLocalPlugin()` 返回的 `platformManifests` 只包含插件支持的平台：Codex-only 只有 `codex`，Claude-only 只有 `claude`，双平台同时包含两者。
- 测试不得再依赖 `result.claudeManifest` / `result.codexManifest` 必填字段；需要检查平台 manifest 时应从 `result.platformManifests.<platform>` 读取。
- `slashCommands` 在 Codex-only、Claude-only、双平台三种情况下分别生成正确产物。
- 双平台插件声明 Codex `artifacts.targets` 时 build / manifest 校验通过，且 artifact 声明保留在 `.agents-plugin/plugin.json`。
- 被排除平台的 `buildConfig.fileRules`、`manifestOverrides`、`apps`、`artifacts.targets` 会 fail fast。

新增或调整 `packages/cli/tests/unit/slash-commands.test.ts`：

- 直接覆盖 `resolveSlashCommands()` 在 Codex-only、Claude-only、双平台三种平台集合下的解析结果。
- Codex-only 时只执行 Codex 渲染语法泄漏校验；Claude-only 时不应被 Codex-only 语法限制阻断。
- 被排除平台的 command 输出、assets 引用和平台 frontmatter 不应进入对应 platform manifest。

新增或调整 `packages/cli/tests/unit/bundle-layout.test.ts`：

- 接受平台过滤后的 marketplace。
- 拒绝 unsupported platform 残留 manifest/runtime 目录。
- 拒绝支持平台缺少 manifest。
- 校验 Claude marketplace 不包含 Codex-only 插件，Codex marketplace 不包含 Claude-only 插件。

新增或调整 `packages/cli/tests/unit/marketplace.test.ts`：

- 不再断言两份 marketplace 完全相等。
- 断言两份 marketplace 的 owner/interface 基础元数据一致。
- 断言插件列表按平台支持集合过滤。
- 覆盖带 `scripts.node.build` 的插件：build 在 staging 目录改写 `marketplace.policy.products` 后，平台 marketplace 必须按最终 staging manifest 过滤，而不是按 source manifest 过滤。

### 集成测试

保留现有 install / upgrade 的 `marketplace.policy.products` 门禁测试，并补充：

- 即使平台 marketplace 过滤了某插件，显式 `aw install <plugin> -p <unsupported>` 仍能通过 AW catalog 找到插件，并返回“不支持目标平台”的错误，而不是 `Unknown plugin`。
- `aw status` / discovery 在 current catalog 中仍能看到单平台插件。
- `aw init --force` 后本地 marketplace layout 仍通过校验。
- `packages/cli/tests/integration/plugin-test-runner.test.ts` 覆盖 `pnpm plugin:test <plugin> --platform auto` 对 Codex-only、Claude-only、双平台插件的自动平台推断，确保它复用共享 helper。
- `packages/cli/tests/integration/plugin-test-runner.test.ts` 覆盖显式 `--platform codex|claude|both` 的平台约束：目标平台属于支持集合时运行；Codex-only / Claude-only 插件测试另一平台时 fail fast；单平台插件使用 `--platform both` 时 fail fast。
- `packages/cli/tests/integration/plugin-test-runner.test.ts` 覆盖 manifest build 改写 `marketplace.policy.products` 的插件：`--platform auto` 和显式平台校验都必须跟随 staging manifest，不能看 source manifest。
- `packages/cli/tests/integration/authoring-tools.test.ts` 更新作者参考文档断言：
  - 断言 `plugin-manifest-spec.md` 不再出现“两份 runtime marketplace manifest 内容完全镜像”或“每个插件恒定包含 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`claude/`、`codex/`”的旧叙述。
  - 断言该文档明确写出所有插件都保留 `.agents-plugin/plugin.json`，但 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`claude/`、`codex/` 只在插件支持的平台存在。
  - 断言该文档明确写出 `.claude-plugin/marketplace.json` 与 `.agents/plugins/marketplace.json` 共享根级元数据，但插件列表按平台支持集合过滤。
  - 断言 `slash-commands.md` 和 `docs/plugin-authoring.md` 的 Public Slash Commands 说明不再把 `slashCommands` 描述成恒定双平台输出，而是明确只为插件支持的平台生成 Claude commands / Codex manual-only skills。
  - 断言 `mcp-and-apps.md` 和 `docs/plugin-authoring.md` 明确写出 `products=["CLAUDE"]` + `apps` 是矛盾配置，build / 作者工具校验必须 fail fast，不能只描述为 Claude 当前不读取 `.app.json`。
  - 断言 `extensions-spec.md` 和 `docs/plugin-authoring.md` 明确写出 unsupported platform 的 `extensions.nativeHooks.<platform>` 与会实际增加或覆盖产物的非空 `agentOverrides.<platform>` 必须 fail fast。
  - 断言 `extensions-spec.md` 保留 `agentOverrides.<unsupportedPlatform> = null` 的合法排除语义，避免把显式“不生成”误判为平台冲突。
- `packages/cli/tests/integration/authoring-tools.test.ts` 增加 `validate_plugin.js` 的 `slashCommands` 回归：Claude-only 插件只跑 Claude render/frontmatter 校验，不受 Codex forbidden syntax 限制；Codex-only 插件只跑 Codex render/frontmatter/forbidden syntax 校验。两个方向都要覆盖，避免作者工具和 CLI build 语义分叉。
- `packages/cli/tests/integration/authoring-tools.test.ts` 增加作者工具平台冲突回归：`products=["CLAUDE"]` + `apps` 必须失败；unsupported platform 的 `nativeHooks` 和非空 `agentOverrides` 必须失败；`agentOverrides.<unsupportedPlatform> = null` 必须继续通过。

### Smoke / pack 测试

更新 `packages/cli/tests/smoke/build-smoke.test.ts` 和 `pack-smoke.test.ts`：

- `codex-explore` 产物中存在 `.codex-plugin/plugin.json`、`codex/skills`、`codex/instructions`、`codex/roles` 和 renderer runtime。
- `codex-explore` 产物中不存在 `.claude-plugin/plugin.json` 和 `claude/`。
- 根级 `.claude-plugin/marketplace.json` 不包含 `codex-explore`。
- 根级 `.agents/plugins/marketplace.json` 包含 `codex-explore`。
- npm tarball 中同样不包含 `codex-explore` 的 Claude bundle 文件。

## 文档与作者工具

需要同步更新：

- `.agents/skills/create-agent-workflows-plugin/SKILL.md`
  - 更新“最小检查”和 bundle 相关说明，明确单平台插件只生成支持平台的 runtime manifest / runtime 目录。
  - 保持 `pnpm plugin:test` 的平台选择说明和新平台范围解析一致：显式平台只允许在 build 后 staging manifest 的插件支持集合内选择，`both` 只适用于双平台插件。
  - 删除“Codex 动态 artifact 插件必须 Codex-only”的绝对表述，改为 target 平台必须属于插件支持平台集合。
- `docs/testing.md`
  - 更新 `pnpm plugin:test` 说明，删除 `--platform both` 总是可用的暗示。
  - 明确 `--platform auto` 使用 build 后 staging manifest 的插件支持集合，显式 `claude|codex|both` 不允许越过最终 `marketplace.policy.products`。
- `docs/plugin-authoring.md`
  - 说明 `products` 会参与 build 裁剪，不只是安装门禁。
  - 更新 Bundle Contract：不再说每个插件都会生成两份 platform manifest。
  - 更新 Public Slash Commands：说明 `slashCommands` 源码是跨平台入口，但 Claude commands / Codex manual-only skills 只为插件支持的平台生成。
  - 更新 apps 说明：`apps` 当前只有 Codex runtime 承载；Claude-only 插件声明 `apps` 属于矛盾配置，build 必须 fail fast。
  - 更新 extensions 说明：unsupported platform 的 `nativeHooks` 和非空 `agentOverrides` 会 fail fast，只有 `agentOverrides.<unsupportedPlatform> = null` 这种显式排除合法。
  - 更新插件脚本测试示例，避免把 `--platform both` 写成单平台插件也能通用的命令。
- `docs/architecture.md`
  - 更新 Three-Layer Distribution Model 的 embedded bundle layout 示例：所有插件都必须有 `.agents-plugin/plugin.json`，但 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`claude/` 和 `codex/` runtime 目录只对插件支持的平台存在。
  - 避免继续暗示 `plugins/<name>/` 恒定包含双 platform manifest，后续工具、测试和维护说明应按平台支持集合判断 bundle 文件。
- `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md`
  - 更新 `marketplace.policy.products` 说明。
  - 增加平台范围与构建产物的关系。
  - 更新 `plugins/marketplace-source.json` 和 runtime marketplace 章节：说明 `pnpm build` 会生成 `.claude-plugin/marketplace.json` 与 `.agents/plugins/marketplace.json`，两者共享 `owner` / `interface` 等根级元数据，但插件 entries 分别过滤为支持 Claude / Codex 的集合，不再要求两份 marketplace 插件列表完全一致。
  - 更新“三层分发模型”的 embedded bundle layout 示例：所有插件目录必须包含 `.agents-plugin/plugin.json`；`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`claude/`、`codex/` 只在插件支持对应平台时存在。示例应覆盖或注释单平台插件，避免继续展示“每个插件恒定双 platform manifest + 双 runtime 目录”的树形结构。
  - 放宽 `artifacts.targets` 示例和字段规则：Codex target 可用于 Codex-only 或双平台插件，但不能用于 Claude-only 插件。
- `.agents/skills/create-agent-workflows-plugin/references/build-config-spec.md`
  - 说明 `fileRules` 和 `manifestOverrides` 只能用于插件支持的平台。
  - 说明 unsupported platform 配置会 fail fast。
  - 更新完整示例中的 `slash-commands/*.md` 说明，避免继续写成恒定生成 Claude `commands/*.md` 和 Codex manual-only skills；示例需要说明实际生成结果受插件支持平台集合约束。
- `.agents/skills/create-agent-workflows-plugin/references/slash-commands.md`
  - 更新平台生成行为：双平台插件同时生成 Claude commands 和 Codex manual-only skills；Codex-only 只生成 Codex 产物；Claude-only 只生成 Claude 产物。
  - 说明 Codex forbidden syntax 校验只在生成 Codex 产物时执行，Claude-only 插件不能因为 Codex-only 语法限制失败。
- `.agents/skills/create-agent-workflows-plugin/references/mcp-and-apps.md`
  - 更新 apps 平台 contract：`apps` 当前只发布到 Codex；插件不支持 Codex 时声明 `apps` 必须 fail fast，不能静默忽略或仅说明 Claude 不读取 `.app.json`。
- `.agents/skills/create-agent-workflows-plugin/references/extensions-spec.md`
  - 增加平台范围说明：公共 extensions 只渲染到支持的平台。
  - 明确 unsupported platform 的 `nativeHooks.<platform>` 和非空 `agentOverrides.<platform>` 会新增或覆盖被排除平台产物，必须 fail fast。
  - 明确 `agentOverrides.<unsupportedPlatform> = null` 是合法的显式排除，不应被当作冲突配置。
- `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md`
  - 更新 “Claude-only skill 可以省略 `agents/openai.yaml`” 相关说明，明确 build 也会裁剪 Codex bundle。
- `.agents/skills/create-agent-workflows-plugin/references/aw-scripts-config-lifecycle.md`
  - 更新 Plugin Script Tests 章节，说明 `--platform both` 只适用于双平台插件。
  - 明确单平台插件显式选择另一平台会在 staging manifest 准备后、runtime bundle 生成前 fail fast，而不是进入缺 runtime 文件的测试失败。
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`
  - 如果该脚本独立实现 manifest 校验，需要同步加入平台冲突检查。
  - `slashCommands` 必须按插件支持的平台渲染和校验：只校验目标平台 frontmatter；Codex forbidden syntax 只在插件支持 Codex 时执行；Claude-only 插件不能再被 Codex 渲染语法限制阻断。
  - 将当前 Codex-only artifact 校验改为“target 平台必须属于插件支持平台集合”，并补对应作者工具测试。

## 迁移与兼容

- 对省略 `products` 的现有插件没有行为变化，仍生成双平台产物。
- 对已经声明单平台的插件，这是一次行为修复：旧产物中的另一平台 manifest/runtime 将消失。
- 对 `artifacts.targets`，这是一次显式 authoring contract 放宽：旧规则要求 Codex 动态 target 必须把 `products` 收窄为 `["CODEX"]`；新规则允许省略 `products` 或声明双平台时携带 Codex target。现有 Codex-only 插件无需迁移。
- 因为 `bundleLocalPlugin()` 开始先清空 `outputRoot`，旧产物残留不会在正常 build 中保留；layout 校验仍要能抓到手工或异常残留。
- 平台 marketplace 从“完全一致镜像”变为“共享元数据、插件列表按平台过滤”。这是 intentional contract change，需要同步测试和文档。

## 验收标准

完成后，以下断言必须成立：

1. `pnpm build` 后，`packages/cli/plugins-dist/plugins/codex-explore/.claude-plugin/plugin.json` 不存在。
2. `pnpm build` 后，`packages/cli/plugins-dist/plugins/codex-explore/claude/` 不存在。
3. `packages/cli/plugins-dist/plugins/codex-explore/.codex-plugin/plugin.json` 存在，且 `skills` 指向 `./codex/skills`。
4. `packages/cli/plugins-dist/.claude-plugin/marketplace.json` 不包含 `codex-explore`。
5. `packages/cli/plugins-dist/.agents/plugins/marketplace.json` 包含 `codex-explore`。
6. `validateBundleLayout(packages/cli/plugins-dist)` 通过。
7. `aw install codex-explore -p claude` 仍返回平台不支持错误，而不是 unknown plugin 或平台 manifest 缺失错误。
8. 如果某个 Codex-only 插件声明 `buildConfig.fileRules.claude`，build 失败且错误指向冲突字段。
9. 双平台插件声明 Codex `artifacts.targets` 时校验通过；Claude-only 插件声明 Codex `artifacts.targets` 时校验失败。
10. `pnpm plugin:test <codex-only-plugin> --platform claude` 和 `--platform both` 在 staging manifest 准备后、runtime bundle 生成前失败，错误说明插件不支持目标平台；`--platform auto` 只跑 Codex。
11. 作者文档、核心架构文档和插件作者工具参考与新 contract 一致。

## 实施建议

建议按以下顺序实现，降低一次改动的回归面：

1. 抽出平台支持解析函数，并让 `pluginSupportsPlatform()` 和 `packages/cli/scripts/test-plugin-scripts.ts` 的 `inferPlatforms()` 复用；runner 应先调用 `prepareLocalPluginBundleSource()` 拿到 staging manifest，再让 `inferPlatforms()` 校验显式 `--platform` 是否属于支持集合。
2. 在 manifest/build 校验里加入 unsupported platform 配置冲突检查，并把 Codex-only artifact 旧约束改为支持平台集合校验。
3. 改 `bundleLocalPlugin()`，让单插件产物按支持平台生成，并把返回值收口为 `platformManifests: Partial<Record<PlatformName, PlatformPluginManifest>>`。
4. 改 `resolveSlashCommands()`，让 slash command 渲染和校验只发生在插件支持的平台上。
5. 改 `bundlePlugins()`，基于 `bundleLocalPlugin()` 返回的最终 manifest 生成平台过滤后的 marketplace。
6. 改 `validateBundleLayout()` 和 `readMarketplaceManifest()`，取消 marketplace identical 假设。
7. 补齐 unit / integration / smoke / pack 测试。
8. 更新公开文档和插件作者工具参考。
