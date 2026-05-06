# 平台专属插件构建物实现代码审查报告

审查时间：2026-05-06  
审查范围：`main(c09b05da2475f4a00867801e582ef2d470243ee9)...HEAD(f74066815f686bcfed6ab4c09e2abe3b3aa6189d)`  
对照文档：

- 计划：`docs/dev/plans/platform-specific-plugin-bundles.md`
- Spec：`docs/dev/specs/platform-specific-plugin-bundles.md`
- 测试规范：`docs/testing.md`

## Findings

本轮最终复审未发现新的实现问题、计划偏差或会阻塞交付的测试缺口。

## 已关闭问题

### 1. unsupported platform 上的 `agentOverrides.<platform> = {}` 误判已经关闭

- 代码位置：
  - `packages/cli/src/utils/manifest.ts:174`
  - `packages/cli/src/utils/manifest.ts:186`
- 回归测试：
  - `packages/cli/tests/unit/manifest.test.ts:1405`

当前实现会先剔除 override 对象里的 `undefined` 字段，再判断它是否真的“非空”。因此：

- `{}` 会被视为 no-op，不再误判成 unsupported platform 冲突
- 非空 override 仍然会按原规则 fail fast
- `null` 继续保持合法

这一项已经和计划 / spec 保持一致。

### 2. bundle layout 的跨平台路径绕过与 symlink 变体已经关闭

- 代码位置：
  - `packages/cli/src/utils/bundle-layout.ts:29`
  - `packages/cli/src/utils/bundle-layout.ts:53`
  - `packages/cli/src/utils/bundle-layout.ts:499`
- 回归测试：
  - `packages/cli/tests/unit/bundle-layout.test.ts:283`
  - `packages/cli/tests/unit/bundle-layout.test.ts:319`

当前实现现在有两层保护：

- 先校验规范化后的路径仍留在目标平台子树内，拦住 `./claude/../codex/...`、`./codex/../claude/...` 这类绕过
- 再对真实目标做 `realpath` 校验，确保 symlink 解析后仍然留在插件根目录和对应平台子树内

因此，跨平台引用和 symlink 变体都已经被拦住。

## 测试覆盖

本轮复审确认，这条需求直接相关的测试已经覆盖到位，包括：

- 平台支持集合、manifest 冲突、marketplace / layout 过滤、slash command 单平台渲染等 unit tests
- `plugin-test-runner`、`discovery`、`cli`、`authoring-tools` 等 integration tests
- `pnpm test:smoke:build`
- `tests/smoke/pack-smoke.test.ts`
- `tests/smoke/plugin-scripts-staging-smoke.test.ts`
- 本轮新增的 `bundle-layout` symlink 回归用例

复审代理在最终一轮额外验证了这些检查，结果均通过：

- `pnpm build`
- 相关 7 个 unit / integration suites，共 137 个测试
- `tests/integration/authoring-tools.test.ts`，29 个测试
- `pnpm test:smoke:build`，5 个测试
- `tests/smoke/pack-smoke.test.ts` 与 `tests/smoke/plugin-scripts-staging-smoke.test.ts`，共 4 个测试

## 结论

这轮平台专属插件 bundle 实现现在可以通过最终 review。

我没有看到新的实现缺陷，也没有看到和计划 / spec 不一致的偏航。剩余风险主要是常规维护层面的，例如未来如果需要在不支持 symlink 的环境运行这组单测，可能要再做测试适配；但这不影响当前功能交付结论。
