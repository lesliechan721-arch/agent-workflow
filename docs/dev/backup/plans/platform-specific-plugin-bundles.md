# 平台专属插件构建物执行计划

## 需求来源

本计划落实 `docs/dev/specs/platform-specific-plugin-bundles.md`。如果实现过程中发现本计划和 spec 不一致，以 spec 为准，并同步修正本计划，避免实现沿着过期理解继续推进。

本需求的核心变化是：`marketplace.policy.products` 不再只是安装侧门禁，它必须成为 build、bundle layout、platform marketplace、插件脚本测试和作者工具校验共同遵守的平台范围真值。

首版目标不是给 `codex-explore` 做特例，而是让所有插件都遵守同一套平台支持集合：

- `products` 省略或为空：生成 Claude 与 Codex 双平台 bundle。
- `products=["CODEX"]`：只生成 Codex platform manifest、Codex runtime 目录和 Codex marketplace entry。
- `products=["CLAUDE"]`：只生成 Claude platform manifest、Claude runtime 目录和 Claude marketplace entry。
- `products=["CODEX", "CLAUDE"]`：保持双平台产物。
- `.agents-plugin/plugin.json` 仍是 AW current catalog 真值，所有插件都必须保留。

## 执行边界

本轮只修复平台范围对 build 产物、marketplace、layout、测试 runner、文档和作者工具的约束，不改变安装命令已有的平台门禁语义。

需要坚持这些边界：

- 不新增 `marketplace.policy.products` 取值，仍只接受 `CODEX` 和 `CLAUDE`。
- 不把 `products` 写入 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- 不引入新的顶层 `claude` / `codex` manifest block。
- 不支持同一个插件目录内按单个 skill 做平台级拆分；顶层 `skills` 仍整体复制到插件支持的平台。
- 不新增 Claude 动态 artifact target；只放宽 Codex 动态 target 可出现在双平台插件中。
- 不让 `pnpm plugin:test --platform claude|codex|both` 成为 override；显式平台也必须落在 build 后 staging manifest 的支持平台集合内。
- 不让平台 marketplace 成为 AW current catalog 的唯一来源；AW 仍扫描 `plugins/<name>/.agents-plugin/plugin.json` 看到全部插件。

## 总体策略

先抽出平台支持集合的共享语义，再把所有消费点逐步改到这套语义上。实现顺序必须让每一步都能被单元测试锁住，避免 bundle 生成、layout 校验和 `pnpm plugin:test` 各自复制判断。

建议按以下顺序推进：

1. 抽出共享平台支持 helper，并让安装侧门禁和 `plugin:test` 复用。
2. 在 manifest/build 校验中加入 unsupported platform 冲突检查。
3. 改 `bundleLocalPlugin()`，让单插件 bundle 按支持平台裁剪，并收口返回合同。
4. 改 `resolveSlashCommands()`，只为目标支持平台渲染和校验。
5. 改根级 `bundlePlugins()`，按最终 staging manifest 生成平台过滤后的 marketplace。
6. 改 `validateBundleLayout()` 和 `readMarketplaceManifest()`，取消两份 marketplace 完全镜像的旧假设。
7. 补齐 unit、integration、smoke、pack 测试。
8. 更新公开文档、作者技能参考和 `validate_plugin.js`。

## Phase 1：共享平台支持语义

### 目标

新增一套 CLI、build、layout、测试 runner 和作者工具都能复用的平台支持集合解析逻辑。后续任何平台判断都不应再手写 `products` 分支。

### 修改范围

- `packages/cli/src/types.ts`
- `packages/cli/src/utils/manifest.ts`
- 新增或扩展 `packages/cli/src/utils/platform-support.ts`
- `packages/cli/src/commands/common.ts`
- `packages/cli/scripts/test-plugin-scripts.ts`
- 相关 unit tests

### 任务

新增纯函数，建议接口类似：

```ts
export type SupportedPlatformSet = ReadonlySet<PlatformName>;

export function resolveSupportedPlatforms(manifest: PluginManifestSource | PluginMeta['manifest']): SupportedPlatformSet;
export function supportsPlatform(manifest: PluginManifestSource | PluginMeta['manifest'], platform: PlatformName): boolean;
export function formatSupportedPlatforms(platforms: SupportedPlatformSet): string;
export function formatMarketplaceProductsForError(manifest: PluginManifestSource | PluginMeta['manifest']): string;
```

解析规则：

- 沿用现有 token 归一化：`trim().toUpperCase().replace(/[\s-]+/g, "_")`。
- `products` 缺失或空数组时返回 `claude + codex`。
- 包含 `CODEX` 时返回 `codex`。
- 包含 `CLAUDE` 时返回 `claude`。
- 包含两者时返回 `claude + codex`。

接入点：

- `pluginSupportsPlatform()` 改成 thin wrapper，内部调用共享 helper。
- `resolvePlatformTargets()`、interactive、upgrade、discovery 继续通过 `pluginSupportsPlatform()` 获得现有行为。
- `packages/cli/scripts/test-plugin-scripts.ts` 删除本地 `inferPlatforms()` 的独立 products 解析逻辑，改用共享 helper。
- 错误信息统一包含插件名、`marketplace.policy.products` 和实际支持平台集合。

### 测试

补充或调整 unit tests：

- `products` 省略、空数组、`CODEX`、`CLAUDE`、双平台声明都解析正确。
- 大小写、空格、短横线等 token 归一化行为不变。
- `pluginSupportsPlatform()` 和共享 helper 结果一致。
- 错误格式中能稳定展示 `marketplace.policy.products=[CODEX]` 这类文本。

## Phase 2：manifest 与 build 冲突校验

### 目标

所有会向某个平台增加、覆盖或声明 runtime 能力的字段，都必须受插件支持平台集合约束。排除平台上出现实际产物配置时 fail fast。

### 修改范围

- `packages/cli/src/utils/manifest.ts`
- `packages/cli/src/generators/local-plugin.ts`
- `packages/cli/src/utils/codex-project-surface.ts`
- `packages/cli/src/utils/artifact-plan.ts`
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`
- 作者工具对应测试夹具

### 任务

在 manifest source validation 或 build validation 阶段增加统一平台冲突检查。建议提供 helper：

```ts
assertPlatformFieldSupported({
  pluginName,
  manifest,
  fieldPath,
  requiredPlatform,
});
```

需要覆盖的冲突字段：

- `buildConfig.fileRules.claude` 要求支持 Claude。
- `buildConfig.fileRules.codex` 要求支持 Codex。
- `buildConfig.manifestOverrides.claude` 要求支持 Claude。
- `buildConfig.manifestOverrides.codex` 虽然当前只允许空对象，但插件不支持 Codex 时仍不应声明。
- 顶层 `apps` 要求支持 Codex。`products=["CLAUDE"] + apps` 必须失败。
- `extensions.nativeHooks.claude` 要求支持 Claude。
- `extensions.nativeHooks.codex` 要求支持 Codex。
- `extensions.*[].agentOverrides.<platform>` 中非空 override 要求支持对应平台。
- `agentOverrides.<unsupportedPlatform> = null` 合法，表示显式不生成，不能当作冲突。
- `artifacts.targets[].platform` 必须属于插件支持平台集合。

动态 artifact 的规则要从旧的“Codex 动态 artifact 插件必须 Codex-only”改成：

- `platform: "codex"` 且插件支持 Codex：允许。
- 双平台插件声明 Codex target：允许。
- Claude-only 插件声明 Codex target：失败。
- 当前没有 Claude target，因此 Claude-only 插件声明任何 `artifacts.targets` 都应失败。

错误文案要包含：

- 插件名。
- 冲突字段路径。
- 当前 `marketplace.policy.products`。
- 字段要求的平台。

示例：

```text
Invalid plugin "codex-explore": buildConfig.manifestOverrides.claude requires CLAUDE support, but marketplace.policy.products=[CODEX].
```

### 测试

补充 unit tests：

- Codex-only 插件声明 `buildConfig.fileRules.claude` 失败。
- Codex-only 插件声明 `buildConfig.manifestOverrides.claude` 失败。
- Claude-only 插件声明 `apps` 失败。
- Claude-only 插件声明 Codex `artifacts.targets` 失败。
- 双平台插件声明 Codex `artifacts.targets` 通过。
- `artifact-plan.test.ts` 覆盖双平台插件的 Codex dynamic artifact 仍能建立 Codex renderer plan，且不会被 Claude 分支消费。
- `adapter-status.test.ts` 覆盖双平台插件的 Codex dynamic artifact 只进入 Codex capability/status surface。
- `codex-project-platform-gates.test.ts` 和 `codex-project-installability.test.ts` 覆盖双平台插件携带 Codex dynamic artifact 时，project preflight、repo-managed kinds 和 installability 仍只在 Codex project 分支生效。
- unsupported platform 的 `nativeHooks` 和非空 `agentOverrides` 失败。
- `agentOverrides.<unsupportedPlatform> = null` 通过。

## Phase 3：`pnpm plugin:test` 平台选择

### 目标

`pnpm plugin:test` 必须以 build 后 staging manifest 为准解析支持平台。显式 `--platform` 只允许在支持集合内缩小测试目标，不允许强制测试未支持平台。

### 修改范围

- `packages/cli/scripts/test-plugin-scripts.ts`
- `packages/cli/scripts/plugin-staging.ts`
- `packages/cli/tests/integration/plugin-test-runner.test.ts`
- 相关 fixture

### 任务

调整 runner 时序：

1. 读取 source manifest，用于定位插件与测试配置。
2. 调用 `prepareLocalPluginBundleSource(..., { buildMode: "staging" })`。
3. 读取 staging manifest，解析支持平台集合。
4. 校验显式 `--platform`：
   - `auto`：使用完整支持平台集合。
   - `codex`：插件支持 Codex 才合法。
   - `claude`：插件支持 Claude 才合法。
   - `both`：插件同时支持 Claude 和 Codex 才合法。
5. 校验失败时清理 staging 目录，并在 `bundleLocalPlugin()` 前报 contract 错误。
6. 校验通过后调用 `bundleLocalPlugin(..., { buildMode: "prepared" })` 生成测试 runtime bundle。

错误信息需要明确：

- 插件名。
- 用户显式选择的平台。
- staging manifest 中的 `marketplace.policy.products`。
- 插件实际支持的平台集合。

### 测试

在 `plugin-test-runner.test.ts` 覆盖：

- Codex-only 插件 `--platform auto` 只跑 Codex。
- Claude-only 插件 `--platform auto` 只跑 Claude。
- 双平台插件 `--platform auto` 跑两轮。
- 双平台插件显式 `--platform both` 继续跑 Codex / Claude 两轮，且两轮使用独立可写 bundle、home 和 tmp；这条正向路径必须在新的支持平台集合校验之后仍然成立。
- Codex-only 插件 `--platform claude` 和 `--platform both` fail fast。
- Claude-only 插件 `--platform codex` 和 `--platform both` fail fast。
- source manifest 与 staging manifest 的 `products` 不一致时，以 staging manifest 为准。
- 校验失败不进入 `bundleLocalPlugin()`，也不会因为缺 runtime 文件才失败。

## Phase 4：单插件 bundle 平台裁剪

### 目标

`bundleLocalPlugin()` 按 build 后最终 manifest 的支持平台集合生成产物。被排除平台不创建 platform manifest，不复制 runtime 目录，也不渲染该平台专属产物。

### 修改范围

- `packages/cli/src/generators/local-plugin.ts`
- `packages/cli/src/generators/hooks.ts`
- `packages/cli/src/generators/instructions.ts`
- `packages/cli/src/generators/permissions.ts`
- `packages/cli/src/generators/agents.ts`
- `packages/cli/src/generators/shared.ts`
- `packages/cli/tests/unit/generators.test.ts`

### 返回合同

将 `LocalPluginBundleResult` 从固定双 manifest 改成：

```ts
interface LocalPluginBundleResult {
  outputRoot: string;
  plugin: PluginMeta;
  platformManifests: Partial<Record<PlatformName, PlatformPluginManifest>>;
}
```

规则：

- `platformManifests` 只能包含插件最终支持的平台。
- 不支持的平台不能保留空 manifest 或占位字段。
- key 集合必须等于 build 后最终 manifest 解析出的支持平台集合。
- 调用方不能继续依赖 `result.claudeManifest` 或 `result.codexManifest`。

### 生成规则

支持的平台：

- 生成对应 `.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`。
- 复制该平台的 `skills`、`mcpServers`、`apps`、slash command 产物、extensions 产物和 `buildConfig.fileRules.<platform>` 额外文件。
- platform manifest 内路径继续使用 `./claude/...` 或 `./codex/...`。

不支持的平台：

- 不创建 `.claude-plugin/` 或 `.codex-plugin/` 目录。
- 不创建 `claude/` 或 `codex/` runtime 目录。
- 不执行该平台 slash command 生成。
- 不渲染该平台 native hooks、agents、instructions、permissions 或 manifest overrides。

顶层字段规则：

- `skills` 复制到所有支持的平台。
- `mcpServers` 复制到所有支持的平台。
- `apps` 仍只复制到 Codex；如果插件不支持 Codex，Phase 2 已经 fail fast。
- `scripts`、`config`、`artifacts.targets` 只保留在 `.agents-plugin/plugin.json`，不进入 platform manifest。

输出目录清理：

- `bundleLocalPlugin()` 开始时继续清空 `outputRoot`，确保旧平台残留不会被保留。
- layout 校验仍要能抓出手工残留。

### 测试

在 `generators.test.ts` 覆盖：

- Codex-only 插件只生成 `.codex-plugin/plugin.json` 和 `codex/**`。
- Codex-only 插件不生成 `.claude-plugin/plugin.json` 和 `claude/**`。
- Claude-only 插件只生成 `.claude-plugin/plugin.json` 和 `claude/**`。
- 双平台插件保持双 manifest 与双 runtime 行为。
- `platformManifests` key 集合与支持平台一致。
- 旧的 `result.claudeManifest` / `result.codexManifest` 调用全部迁移。

## Phase 5：slashCommands 按平台渲染

### 目标

`slashCommands` 仍是跨平台源码入口，但生成和校验只发生在插件支持的平台上。

### 修改范围

- `packages/cli/src/utils/slash-commands.ts`
- `packages/cli/src/generators/local-plugin.ts`
- `packages/cli/src/utils/manifest.ts`
- `packages/cli/tests/unit/slash-commands.test.ts`
- `packages/cli/tests/unit/generators.test.ts`
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`

### 任务

调整 `resolveSlashCommands()` 接口，建议显式接收目标平台集合：

```ts
resolveSlashCommands(pluginRoot, manifest, {
  targetPlatforms: SupportedPlatformSet,
});
```

行为：

- 双平台插件同时生成 Claude `commands/*.md` 和 Codex manual-only skills。
- Codex-only 插件只生成 Codex manual-only skills。
- Claude-only 插件只生成 Claude commands。
- Codex forbidden syntax 校验只在生成 Codex 产物时执行。
- Claude-only 插件不应被 Codex-only 语法限制阻断。
- 被排除平台的 command 输出、assets 引用和 platform frontmatter 不进入对应 platform manifest。

直接调用 `resolveSlashCommands()` 的测试必须覆盖单平台场景，不能只靠 `bundleLocalPlugin()` 间接验证。

### 测试

在 `slash-commands.test.ts` 覆盖：

- Codex-only 只返回 Codex 结果。
- Claude-only 只返回 Claude 结果。
- 双平台同时返回两边结果。
- Claude-only 命令即使命中 Codex forbidden syntax，也不会因 Codex 校验失败。
- Codex-only 命令仍执行 Codex render/frontmatter/forbidden syntax 校验。

## Phase 6：平台 marketplace 过滤

### 目标

根级 `.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json` 不再要求插件列表完全一致。两者共享根级元数据，但 entries 按平台支持集合过滤。

### 修改范围

- `packages/cli/scripts/bundle-plugins.ts`
- `packages/cli/src/utils/marketplace.ts`
- `packages/cli/tests/unit/marketplace.test.ts`
- `packages/cli/tests/smoke/build-smoke.test.ts`
- `packages/cli/tests/smoke/pack-smoke.test.ts`

### 任务

`bundlePlugins()` 的平台 marketplace 生成必须基于每个插件完成 staging/bundle 后的最终 manifest：

- 支持 Claude 的插件进入 `.claude-plugin/marketplace.json`。
- 支持 Codex 的插件进入 `.agents/plugins/marketplace.json`。
- `source` 继续写 `./plugins/<pluginName>`。
- 不得用 `discoverPlugins()` 读到的 source metadata 直接过滤 marketplace。
- source manifest 被 build script 改写 `products` 时，平台 marketplace 以后者为准。

`readMarketplaceManifest()`：

- 不再比较两份 marketplace 完全一致。
- 只读取目标平台 marketplace。
- 单独校验 marketplace 基本结构。
- 保持 owner、interface 等根级元数据的基础校验。

### 测试

在 `marketplace.test.ts` 覆盖：

- Claude marketplace 不包含 Codex-only 插件。
- Codex marketplace 不包含 Claude-only 插件。
- 双平台插件同时出现在两份 marketplace。
- 两份 marketplace 的 owner/interface 等根级元数据一致。
- build script 改写 staging manifest 后，平台 marketplace 按 staging manifest 过滤。
- 旧的“两个 marketplace 完全相等”断言全部删除或替换。

## Phase 7：bundle layout 校验

### 目标

layout 校验以 `plugins/<name>/.agents-plugin/plugin.json` 扫描全部插件，再按支持平台集合校验应该存在和不应该存在的文件。

### 修改范围

- `packages/cli/src/utils/bundle-layout.ts`
- `packages/cli/src/utils/local-marketplace.ts`
- `packages/cli/src/utils/paths.ts`
- `packages/cli/tests/unit/bundle-layout.test.ts`
- `packages/cli/tests/unit/local-marketplace.test.ts`

### 任务

`validateBundleLayout()` 新规则：

- 扫描 `plugins/*/.agents-plugin/plugin.json` 作为全插件集合。
- 所有插件都必须有 `.agents-plugin/plugin.json`。
- 支持 Claude 的插件必须有 `.claude-plugin/plugin.json`。
- 不支持 Claude 的插件不得有 `.claude-plugin/plugin.json`，也不得有 `claude/` runtime 目录。
- 支持 Codex 的插件必须有 `.codex-plugin/plugin.json`。
- 不支持 Codex 的插件不得有 `.codex-plugin/plugin.json`，也不得有 `codex/` runtime 目录。
- Claude manifest 中的路径必须存在，且以 `./claude/` 开头。
- Codex manifest 中的路径必须存在，且以 `./codex/` 开头。
- Claude marketplace entries 必须等于支持 Claude 的插件集合。
- Codex marketplace entries 必须等于支持 Codex 的插件集合。
- 每个 marketplace entry 的 `source` 仍必须是 `./plugins/<pluginName>`。

错误分类：

- 支持平台缺 manifest：`missing supported Claude manifest` 或 `missing supported Codex manifest`。
- 不支持平台残留文件：`unexpected Claude bundle files for unsupported platform` 或 `unexpected Codex bundle files for unsupported platform`。

`ensureLocalMarketplace()` / `copyBundleToStaging()` 可以继续复制根级 `.claude-plugin/`、根级 `.agents/` 和 `plugins/`，但刷新后的 `~/.aw` 必须通过新的 layout 校验。

### 测试

在 `bundle-layout.test.ts` 覆盖：

- 平台过滤后的 marketplace 能通过。
- Codex-only 插件残留 `.claude-plugin/plugin.json` 失败。
- Codex-only 插件残留 `claude/` 目录失败。
- Claude-only 插件残留 `.codex-plugin/plugin.json` 失败。
- Claude-only 插件残留 `codex/` 目录失败。
- 支持平台缺少 manifest 失败。
- marketplace entries 与支持平台集合不一致失败。

## Phase 8：安装、status 与 discovery 回归

### 目标

平台 marketplace 过滤后，AW current catalog 仍能看到全部插件。错误平台安装应返回“不支持目标平台”，而不是 unknown plugin 或 manifest 缺失。

### 修改范围

- `packages/cli/src/commands/discovery.ts`
- `packages/cli/src/commands/common.ts`
- `packages/cli/src/commands/install.ts`
- `packages/cli/src/commands/upgrade.ts`
- `packages/cli/src/commands/status.ts`
- `packages/cli/tests/integration/*`

### 任务

确认 current catalog 仍通过 `resolveCatalogPlugins()` 扫描 `plugins/<name>/.agents-plugin/plugin.json`，不依赖 platform marketplace entry。

需要重点回归：

- `aw install <codex-only> -p claude` 能找到插件，并返回平台不支持错误。
- `--platform both` 遇到单平台插件时继续在写入前失败。
- `--platform auto` 仍先按 `products` 过滤候选平台，再推断目标平台。
- `aw status` / discovery current catalog 能看到单平台插件。
- 历史卸载 fallback 不依赖平台 marketplace 是否列出当前插件。

### 测试

新增或调整 integration tests：

- 单平台插件不在目标平台 marketplace 中时，显式安装到错误平台仍不是 `Unknown plugin`。
- `aw status` current catalog 包含单平台插件。
- `aw init --force` 后本地 marketplace layout 通过校验。
- upgrade / uninstall 的历史诊断不因 platform marketplace 过滤而丢插件名。

## Phase 9：测试矩阵补齐

### Unit

调整：

- `packages/cli/tests/unit/generators.test.ts`
- `packages/cli/tests/unit/slash-commands.test.ts`
- `packages/cli/tests/unit/bundle-layout.test.ts`
- `packages/cli/tests/unit/marketplace.test.ts`
- `packages/cli/tests/unit/manifest.test.ts`
- `packages/cli/tests/unit/manifest-coverage.test.ts`
- `packages/cli/tests/unit/artifact-plan.test.ts`
- `packages/cli/tests/unit/adapter-status.test.ts`
- `packages/cli/tests/unit/codex-project-platform-gates.test.ts`
- `packages/cli/tests/unit/codex-project-installability.test.ts`

必须覆盖：

- 单平台 bundle 裁剪。
- `platformManifests` 返回合同。
- 平台冲突 fail fast。
- slash command 单平台渲染。
- 平台 marketplace 过滤。
- layout 对缺失和残留文件的区分。
- 双平台 Codex dynamic artifact 允许，并且 renderer plan、status/capability snapshot、project preflight、repo-managed kinds 和 installability 都只把它作为 Codex 能力处理。

### Integration

调整：

- `packages/cli/tests/integration/plugin-test-runner.test.ts`
- `packages/cli/tests/integration/authoring-tools.test.ts`
- 安装、status、discovery 相关集成测试

必须覆盖：

- `pnpm plugin:test --platform auto|claude|codex|both` 的新约束。
- 双平台插件显式 `--platform both` 继续成功，并且 Codex / Claude 两轮隔离 bundle、home 和 tmp。
- staging manifest 改写 `products` 后，runner 与 marketplace 都跟随最终 manifest。
- 作者文档断言不再包含恒定双平台 bundle 的旧叙述。
- `validate_plugin.js` 的平台冲突、slash command 单平台校验和 artifact target 校验。

### Smoke / Pack / Plugin Scripts

调整：

- `packages/cli/tests/smoke/build-smoke.test.ts`
- `packages/cli/tests/smoke/pack-smoke.test.ts`
- `packages/cli/tests/smoke/plugin-scripts-staging-smoke.test.ts`

必须覆盖：

- `pnpm build` 后 `codex-explore` 有 `.codex-plugin/plugin.json`、`codex/skills`、`codex/instructions`、`codex/roles` 和 renderer runtime。
- `codex-explore` 没有 `.claude-plugin/plugin.json` 和 `claude/`。
- Claude marketplace 不包含 `codex-explore`。
- Codex marketplace 包含 `codex-explore`。
- npm tarball 不包含 `codex-explore` 的 Claude bundle 文件。
- build script 改写 staging manifest 的 `marketplace.policy.products` 后，runner、bundle 和平台选择都跟随最终 manifest。
- 单平台插件显式选择错误平台时，`pnpm plugin:test` 在 runtime bundle 生成前 fail fast。

## Phase 10：文档与作者工具同步

### 目标

更新所有会指导插件作者、维护者和测试编写者的文档，避免新 contract 只存在于实现里。

### 修改范围

- `docs/plugin-authoring.md`
- `docs/architecture.md`
- `docs/testing.md`
- `.agents/skills/create-agent-workflows-plugin/SKILL.md`
- `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md`
- `.agents/skills/create-agent-workflows-plugin/references/build-config-spec.md`
- `.agents/skills/create-agent-workflows-plugin/references/slash-commands.md`
- `.agents/skills/create-agent-workflows-plugin/references/mcp-and-apps.md`
- `.agents/skills/create-agent-workflows-plugin/references/extensions-spec.md`
- `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md`
- `.agents/skills/create-agent-workflows-plugin/references/aw-scripts-config-lifecycle.md`
- `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`

### 文档任务

`docs/plugin-authoring.md`：

- 说明 `products` 参与 build 裁剪，不只是安装门禁。
- 更新 Bundle Contract，不再说每个插件固定生成两份 platform manifest。
- 更新 Public Slash Commands，说明只为支持平台生成 Claude commands / Codex manual-only skills。
- 更新 apps 说明：`products=["CLAUDE"] + apps` 是矛盾配置。
- 更新 extensions 说明：unsupported platform 的 `nativeHooks` 和非空 `agentOverrides` fail fast，`agentOverrides.<unsupportedPlatform> = null` 合法。
- 更新 `pnpm plugin:test` 示例，避免把 `--platform both` 写成单平台插件通用命令。

`docs/architecture.md`：

- 更新 Three-Layer Distribution Model 的 embedded bundle layout。
- 明确所有插件都有 `.agents-plugin/plugin.json`，platform manifest/runtime 目录只在支持平台存在。
- 不再暗示 `plugins/<name>/` 恒定包含双 platform manifest。

`docs/testing.md`：

- 更新 `pnpm plugin:test` 平台选择语义。
- 明确 `auto` 使用 build 后 staging manifest 的支持平台集合。
- 明确显式 `claude|codex|both` 不允许越过最终 `products`。

作者技能参考：

- `plugin-manifest-spec.md` 更新 runtime marketplace 和三层分发模型。
- `build-config-spec.md` 说明 `fileRules` / `manifestOverrides` 只能用于支持平台。
- `slash-commands.md` 更新单平台生成和 Codex forbidden syntax 校验时机。
- `mcp-and-apps.md` 写明 Claude-only 插件声明 `apps` 必须失败。
- `extensions-spec.md` 写明 unsupported platform 的冲突和 `null` 排除语义。
- `skills-and-triggers.md` 更新 Claude-only skill 与 Codex bundle 裁剪说明。
- `aw-scripts-config-lifecycle.md` 更新 `plugin:test --platform both` 只适用于双平台插件。

### 作者工具任务

`validate_plugin.js` 同步 CLI 语义：

- 使用同一套平台范围解析规则。
- 校验 unsupported platform 的 `fileRules`、`manifestOverrides`、`apps`、`nativeHooks`、非空 `agentOverrides`。
- `artifacts.targets` 改成 target 平台必须属于插件支持平台集合。
- `slashCommands` 只按支持平台渲染和校验。
- Codex forbidden syntax 只在插件支持 Codex 时执行。

## Phase 11：验收与发布前验证

### 本地验证命令

建议按风险从小到大运行：

```bash
pnpm test:unit
pnpm test:integration
pnpm build
pnpm test:smoke:build
pnpm test:smoke:plugin-scripts
pnpm test:smoke:pack
```

如果实现范围触及作者工具校验，再单独跑对应作者工具集成测试：

```bash
pnpm --filter @lesliechan721/aw exec vitest run tests/integration/authoring-tools.test.ts
```

### 必须人工确认的产物

`pnpm build` 后检查：

```text
packages/cli/plugins-dist/plugins/codex-explore/.codex-plugin/plugin.json
packages/cli/plugins-dist/plugins/codex-explore/codex/skills
packages/cli/plugins-dist/plugins/codex-explore/codex/instructions
packages/cli/plugins-dist/plugins/codex-explore/codex/roles
packages/cli/plugins-dist/.agents/plugins/marketplace.json
```

并确认这些路径不存在：

```text
packages/cli/plugins-dist/plugins/codex-explore/.claude-plugin/plugin.json
packages/cli/plugins-dist/plugins/codex-explore/claude/
```

### 验收标准

完成后必须满足：

- `validateBundleLayout(packages/cli/plugins-dist)` 通过。
- Claude marketplace 不包含 `codex-explore`。
- Codex marketplace 包含 `codex-explore`。
- `aw install codex-explore -p claude` 返回平台不支持错误，不是 unknown plugin。
- Codex-only 插件声明 `buildConfig.fileRules.claude` 时 build fail fast。
- 双平台插件声明 Codex `artifacts.targets` 校验通过。
- Claude-only 插件声明 Codex `artifacts.targets` 校验失败。
- `pnpm plugin:test <codex-only> --platform auto` 只跑 Codex。
- `pnpm plugin:test <codex-only> --platform claude|both` 在 runtime bundle 生成前 fail fast。
- 公开文档、作者技能参考和 `validate_plugin.js` 与新 contract 一致。

## 建议拆分

为了降低 review 难度，建议按以下 PR 或提交边界拆分：

1. 共享平台支持 helper、安装侧 wrapper、基础 unit tests。
2. manifest/build 冲突校验和作者工具基础校验。
3. `plugin:test` staging manifest 平台选择。
4. `bundleLocalPlugin()` 返回合同和单插件 bundle 裁剪。
5. `slashCommands` 平台化渲染。
6. platform marketplace 和 bundle layout 校验。
7. integration、smoke、pack 测试补齐。
8. 文档和作者技能参考同步。

每一步完成后都应至少运行对应 unit tests。最后再跑完整 build、integration、smoke 和 pack 验证。

## 风险点

- build script 可以改写 staging manifest，因此 marketplace、bundle、`plugin:test` 都必须以 staging manifest 为准，不能在不同入口混用 source manifest。
- `bundleLocalPlugin()` 返回合同变化会影响大量测试和调用点，迁移时要一次性删除旧的 `claudeManifest` / `codexManifest` 依赖。
- slash command 目前可能假设双平台同时渲染，改接口时要直接覆盖工具函数测试，否则容易留下隐性双平台校验。
- layout 校验不能再从 marketplace entries 推导全部插件集合，否则单平台过滤后会漏掉被过滤平台的插件。
- 作者工具如果继续保留旧的 Codex-only artifact 规则，会和 CLI build 分叉，必须和实现同轮更新。
- 文档测试会锁住措辞方向，更新公开文档和作者参考时要同步改断言，避免测试只验证旧 contract 消失却没有验证新 contract 出现。
