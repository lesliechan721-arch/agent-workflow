# 平台专属插件构建物需求 Spec Review

日期：2026-05-06

## Findings

本轮未发现新的需求缺口、逻辑漏洞，或当前基线下无法落地的实现阻塞。

## 已修复项确认

- 上一轮遗留的 `bundleLocalPlugin()` 返回合同问题已经补齐。spec 现在不仅要求磁盘产物按平台裁剪，也明确把返回值改成 `platformManifests`，并同步约束调用方、测试和实施顺序，见 `platform-specific-plugin-bundles.md:122-154`、`platform-specific-plugin-bundles.md:373-379`、`platform-specific-plugin-bundles.md:513-516`。
- `pnpm plugin:test` 的平台判定时机已经修正。spec 现在明确要求先执行 `prepareLocalPluginBundleSource(..., { buildMode: "staging" })`，再基于 build 后 staging manifest 校验 `--platform`，并在 `bundleLocalPlugin()` 之前 fail fast，见 `platform-specific-plugin-bundles.md:178-195`、`platform-specific-plugin-bundles.md:411-413`、`platform-specific-plugin-bundles.md:513-514`。
- 平台 marketplace 的过滤真值已经收口到最终 staging manifest。spec 明确要求 `bundlePlugins()` 不能再按 source manifest 直接过滤，并补了 build 改写 `marketplace.policy.products` 的测试要求，见 `platform-specific-plugin-bundles.md:278-310`、`platform-specific-plugin-bundles.md:397-402`、`platform-specific-plugin-bundles.md:517`。
- `slashCommands` 的单平台生成与校验规则已经补齐。Claude-only、Codex-only、双平台三种行为、Codex forbidden syntax 只在生成 Codex 产物时校验、以及作者工具回归范围，现在都写清楚了，见 `platform-specific-plugin-bundles.md:197-207`、`platform-specific-plugin-bundles.md:384-389`、`platform-specific-plugin-bundles.md:422`、`platform-specific-plugin-bundles.md:466-468`。
- “两份 marketplace 必须完全镜像”和“每个插件恒定双 platform manifest”的旧 contract 已经从 spec 主线移除，bundle layout 也改成按 `.agents-plugin/plugin.json` 解析平台支持集合再校验，见 `platform-specific-plugin-bundles.md:280-310`、`platform-specific-plugin-bundles.md:312-325`、`platform-specific-plugin-bundles.md:390-402`、`platform-specific-plugin-bundles.md:518`。
- 动态 artifacts 的作者 contract 已按“target 平台必须属于插件支持平台集合”重写，不再继续保留“Codex target 必须 Codex-only 插件”这个旧限制，并且同步纳入作者工具与参考文档更新范围，见 `platform-specific-plugin-bundles.md:231-242`、`platform-specific-plugin-bundles.md:461`、`platform-specific-plugin-bundles.md:480-483`、`platform-specific-plugin-bundles.md:514`。
- 文档和作者工具的同步范围这次也已经补全，覆盖公开文档、架构文档、作者技能参考和 `validate_plugin.js`，没有再留下“实现改了、参考资料没改”的明显缺口，见 `platform-specific-plugin-bundles.md:414-423`、`platform-specific-plugin-bundles.md:435-483`。

## 结论

这版 spec 已经是合理、正确且可落地的。它把当前真正分叉的几条主路径都收拢到了同一套平台支持语义上：`bundleLocalPlugin()`、`bundlePlugins()`、`validateBundleLayout()`、`readMarketplaceManifest()`、`pnpm plugin:test`、作者工具校验和文档合同都被纳入范围，而且和当前代码基线的改动入口能够一一对应上。

从实现角度看，改动面也比较清晰，主要集中在 `packages/cli/src/generators/local-plugin.ts`、`packages/cli/scripts/bundle-plugins.ts`、`packages/cli/src/utils/bundle-layout.ts`、`packages/cli/src/utils/marketplace.ts`、`packages/cli/scripts/test-plugin-scripts.ts`、`packages/cli/src/utils/manifest.ts`，以及 `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js`。spec 给出的实施顺序也是合适的，我这轮没有看到明显更优、且风险更低的替代方案。

剩余风险主要不在 spec 本身，而在实现时是否把测试和文档同步做完整。只要按文档里列出的 unit / integration / smoke / pack 覆盖面一起推进，这轮需求可以在当前基线上稳定落地。
