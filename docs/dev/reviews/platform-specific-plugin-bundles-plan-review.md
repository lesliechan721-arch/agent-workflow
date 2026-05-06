# `platform-specific-plugin-bundles.md` 执行计划审查报告

审查对象：`docs/dev/plans/platform-specific-plugin-bundles.md`  
审查时间：2026-05-06

这轮 review 重点核对四件事：

- 计划是否严格落实 `docs/dev/specs/platform-specific-plugin-bundles.md`
- 计划内部是否自洽，能否挂到当前 CLI 基线直接实施
- 计划有没有引入 spec 之外的新增内容或遗漏必要内容
- 单元 / 集成 / smoke 测试矩阵是否完整覆盖计划承诺的改动

对照依据：

- 计划文档：`docs/dev/plans/platform-specific-plugin-bundles.md`
- 需求 spec：`docs/dev/specs/platform-specific-plugin-bundles.md`
- 测试规范：`docs/testing.md`
- 当前基线实现：`packages/cli/src/generators/local-plugin.ts`、`packages/cli/scripts/bundle-plugins.ts`、`packages/cli/scripts/test-plugin-scripts.ts`、`packages/cli/src/utils/manifest.ts`、`packages/cli/src/utils/slash-commands.ts`、`packages/cli/src/utils/marketplace.ts`、`packages/cli/src/utils/bundle-layout.ts`、`packages/cli/src/utils/local-marketplace.ts`、`packages/cli/src/utils/codex-project-surface.ts`、`packages/cli/src/utils/artifact-plan.ts`、`.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`

## Findings

本轮复核未发现新的问题。上一轮报告里的 3 个问题都已经在计划中补齐，且修复方向和 spec、测试规范保持一致。

### 1. `scripts.node` / `pnpm plugin:test` 的 smoke 分层缺口已补齐

计划现在已经把 `packages/cli/tests/smoke/plugin-scripts-staging-smoke.test.ts` 纳入 Smoke / Pack / Plugin Scripts 测试矩阵，并明确覆盖：

- build script 改写 staging manifest 后，runner、bundle 和平台选择都跟随最终 manifest
- 单平台插件显式选择错误平台时，在 runtime bundle 生成前 fail fast

对应位置见 `docs/dev/plans/platform-specific-plugin-bundles.md:511-527`，也和 `docs/testing.md:74-76`、`84-86` 的分层要求一致。

### 2. 动态 artifact downstream 的 unit 覆盖已经收口

计划现在不仅在 Phase 2 里点名了 `artifact-plan.test.ts`、`adapter-status.test.ts`、`codex-project-platform-gates.test.ts` 和 `codex-project-installability.test.ts`，还在 Phase 9 的 Unit 矩阵里把这些套件正式纳入，并明确要求双平台插件上的 Codex dynamic artifact 只能被 Codex 分支消费。

对应位置见 `docs/dev/plans/platform-specific-plugin-bundles.md:159-172`、`468-494`。这和 spec 对动态 artifact 放宽后的 contract 完全一致，能覆盖 renderer plan、capability/status surface、project preflight、repo-managed kinds 和 installability 这些 downstream 语义。

### 3. `pnpm plugin:test --platform both` 的双平台正向合同已显式保留

计划现在已经把“双平台插件显式 `--platform both` 继续成功，且两轮使用独立 bundle、home 和 tmp”写进 Phase 3 和 Phase 9 Integration 要求里。

对应位置见 `docs/dev/plans/platform-specific-plugin-bundles.md:209-220`、`495-509`。这和 `docs/testing.md:76` 保持一致，也避免实现时只补非法 `both` 的 fail fast，却漏掉双平台正向路径回归。

## 结论

这份执行计划现在和 `docs/dev/specs/platform-specific-plugin-bundles.md` 是一致的，没有看到需求偏差、核心遗漏，或超出 spec 的新增范围。平台范围解析、单插件 bundle 裁剪、platform marketplace 过滤、layout 校验、`pnpm plugin:test` 平台选择、作者工具校验和文档同步，已经形成一条完整闭环。

从当前基线看，计划内容也是自洽且可落地的：`bundleLocalPlugin()`、`prepareLocalPluginBundleSource()`、`validateBundleLayout()`、`readMarketplaceManifest()`、`resolveCatalogPlugins()`、`resolveSlashCommands()` 和 `validate_plugin.js` 都是现成的实施落点，计划对这些入口的改法彼此没有冲突。

测试矩阵也已经覆盖到位：

- unit 覆盖平台裁剪、平台冲突、slash command 单平台渲染、marketplace/layout 过滤，以及动态 artifact downstream 行为
- integration 覆盖 `pnpm plugin:test` 的新平台约束、作者工具校验，以及 install/status/discovery 回归
- smoke / pack / plugin-scripts 覆盖真实 build 产物、tarball 和 staging manifest 改写场景

截至本轮复核，上一版报告中的问题均已修复，也没有发现新的未知问题。可以按当前计划进入实现。
