# `plugin-scripts-lifecycle-config.md` 实现复审报告

审查对象：`docs/dev/plans/plugin-scripts-lifecycle-config.md` 对应实现  
复审时间：2026-04-29

这轮复审重新对照方案文档检查了 manifest contract、bundle/staging、lifecycle runner、安装快照、`aw config`、status 健康、标准 `aw-config.mjs` helper，以及 `pnpm plugin:test` 主链路，并实际复跑了构建、unit / integration 和 smoke 回归。

## 主要结论

本轮没有再发现新的实现缺陷。上一轮报告里的 2 个明确问题已经确认修复：

### 1. `plugin:test` 已经补齐 test bundle 的 devDependency 依赖闭包

- `copyTestPackageNodeModules()` 现在直接把 baseline package root 的整个 `node_modules` 复制进临时测试 bundle，不再只复制 dev-only 顶层包目录，因此传递依赖也会一并进入测试环境，见 `packages/cli/scripts/test-plugin-scripts.ts:364-383`。
- 对应回归已经覆盖单插件、双平台隔离、裸包 import 合同和敏感值脱敏，见 `packages/cli/tests/integration/plugin-test-runner.test.ts:148-355`；package 入口 smoke 也通过，见 `packages/cli/tests/smoke/plugin-scripts-staging-smoke.test.ts:41-83`。

### 2. 运行时 bundle 现在只保留 production dependencies，`.pnpm` store 里的 devDependency 包体也会被剔除

- `copyProductionDependencyClosure()` 现在按 production 闭包逐个复制 `.pnpm` 实例目录和顶层 package link，而不是整目录放行，见 `packages/cli/src/generators/local-plugin.ts:498-554`。
- 单测和 build smoke 都已经锁住“保留 production 依赖、移除 devDependency 及其 `.pnpm` 实例”的断言，见 `packages/cli/tests/unit/generators.test.ts:605-620`、`packages/cli/tests/smoke/build-smoke.test.ts:253-267`。

另外，上轮更早的一些边界问题这次也保持正常：lifecycle context 只暴露 `config.values` 和 `paths.configStores`，不再把 raw store 直接写进 `AW_PLUGIN_CONTEXT`；非字符串的 sensitive 值也已经进入统一脱敏链路，见 `packages/cli/src/utils/plugin-scripts.ts:682-769`、`packages/cli/tests/unit/plugin-scripts.test.ts:153-185,470-535`。

## 文档对齐与代码质量

- 是否严格按照文档实现：在这轮复审范围内，我没有再发现和 `docs/dev/plans/plugin-scripts-lifecycle-config.md` 明确冲突的实现。manifest contract、bundle/staging、安装快照真值、`aw config` 分层存储、lifecycle context、status 健康来源以及标准 helper 的读取路径，目前都和方案保持一致。
- 实现代码质量：整体质量较好。几条复杂主链路复用了同一份 runtime / config / snapshot 合同，没有再出现测试入口、status 视图、lifecycle 视图各走一套真值的分叉；context 生成、脱敏和 snapshot fallback 的边界也已经比较清楚。

## 测试与覆盖

这次实际复跑结果：

- `pnpm build` 通过。
- 14 个关键 unit / integration 文件通过，共 186 个测试：
- `tests/unit/plugin-config.test.ts`
- `tests/unit/plugin-scripts.test.ts`
- `tests/unit/manifest.test.ts`
- `tests/unit/generators.test.ts`
- `tests/unit/bundle-layout.test.ts`
- `tests/unit/local-marketplace.test.ts`
- `tests/unit/runtime.test.ts`
- `tests/integration/cli-entry.test.ts`
- `tests/integration/cli.test.ts`
- `tests/integration/plugin-lifecycle-command.test.ts`
- `tests/integration/plugin-test-runner.test.ts`
- `tests/integration/authoring-tools.test.ts`
- `tests/integration/runtime-env.test.ts`
- `tests/integration/upgrade-command.test.ts`
- `pnpm --filter @yiliang/aw test:smoke:plugin-scripts` 通过，共 1 个 smoke 测试。
- `pnpm --filter @yiliang/aw test:smoke:build` 通过，共 4 个 smoke 测试。

本次修复后，报告里提到的两类覆盖空白已经补齐：

- `install` 缺 required config 时，现在有集成回归覆盖命令编排进入 preflight prompt、用户把 `selectedScope` 从默认 `user` 改为 `project`、配置写入 project store 后继续安装的链路，见 `packages/cli/tests/integration/cli.test.ts:825-894`。
- `upgrade` 缺 required config 时，现在有集成回归覆盖同一条 preflight wiring，并验证用户把 `selectedScope` 从默认 `project` 改为 `user` 后仍能继续升级，见 `packages/cli/tests/integration/upgrade-command.test.ts:357-466`。
- `statusCommand()` 现在补了入口级回归：安装快照摘要被破坏时，`status --json` 会回落到 `currentCatalog`，同时输出 `healthWarnings`，见 `packages/cli/tests/integration/plugin-lifecycle-command.test.ts:360-395`。

本次修复后额外复跑：

- `pnpm build` 通过。
- `pnpm --filter @yiliang/aw exec vitest run tests/integration/cli.test.ts tests/integration/upgrade-command.test.ts tests/integration/plugin-lifecycle-command.test.ts` 通过，共 42 个测试。
- `pnpm test:integration` 通过，共 151 个集成测试。

## 结论

- 是否严格按照文档实现：本轮复审范围内，是的；上一轮报告中的 2 个明确偏差已经修复，当前没有再发现新的高置信文档偏差。
- 实现代码质量：整体较好，复杂链路的真值与边界现在比较一致。
- 测试是否完全覆盖：仍不建议写成“完全覆盖”，但本报告点名的两类覆盖空白已经补齐，主路径和高风险分支覆盖得更稳。
- 除了 review 报告里的问题，是否还有其他未知 bug：这轮没有再发现新的高置信 bug。结合代码检查、构建和回归结果，我目前更倾向于“没有新的已确认缺陷”。
