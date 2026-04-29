# `plugin-scripts-lifecycle-config.md` 实现复审报告

审查对象：`docs/dev/plans/plugin-scripts-lifecycle-config.md` 对应实现  
复审时间：2026-04-29

这次复审重新覆盖了 manifest contract、bundle/staging、lifecycle runner、安装快照、`aw config`、status 健康、标准 `aw-config.mjs` helper，以及 `pnpm plugin:test` 主链路。

上轮实现报告中的问题已经确认修复，包括：

- historical uninstall 的快照 lifecycle fallback
- `runner: "auto"` 的 authoring 校验
- lifecycle context 的 `paths.configStores`
- PowerShell argv 构造
- `status --json` 的稳定 `configIssues` 字段

不过，这轮重新审下来，仍然还有 2 个高置信问题没有完全对齐文档。

## 主要问题

### 1. 中风险：lifecycle context 仍然把 raw config store 整体塞进了 `AW_PLUGIN_CONTEXT`

- 文档要求很明确：schema 之外的旧 key 只能进入脱敏诊断，不能进入 helper 输出或 lifecycle context；生命周期脚本读取的也应该是 effective config，而不是 raw store 内容（`docs/dev/plans/plugin-scripts-lifecycle-config.md:292-293, 322-345, 922, 925`）。
- 现在 `writeLifecycleScriptContext()` 在把 `paths.configStores` 写进 context 的同时，又把 `effective.stores` 整体挂到了 `config.stores` 上（`packages/cli/src/utils/plugin-scripts.ts:740-749`）。
- `effective.stores` 保留的是磁盘上的 raw store。也就是说：
  - schema 外的 legacy key 及其原始值会进入 context JSON；
  - user/project 两层的原始值都会直接暴露给 lifecycle 脚本；
  - 这和文档里“旧 key 不进入 lifecycle context，只保留 `paths.configStores` 供显式 scoped 读取”的 contract 不一致。
- 这条问题的实际风险主要在“默认暴露范围过大”而不是权限逃逸，因为 `paths.configStores` 本来就允许脚本按需读取 store 文件；但按文档，本轮 context 本身不应该直接带 raw store payload。

### 2. 中低风险：敏感配置的 stdout/stderr 脱敏只覆盖字符串，`number` / `boolean` 仍会漏

- 文档把 `sensitive: true` 定义成统一脱敏合同，而不是“只对字符串生效”；范围明确覆盖 CLI/lifecycle 日志和测试日志（`docs/dev/plans/plugin-scripts-lifecycle-config.md:155-160, 308, 928`）。
- 现在 `collectSensitivePluginConfigValues()` 只收集 `typeof value === "string"` 的值（`packages/cli/src/utils/plugin-scripts.ts:684-693`），后面的 `redactPluginScriptOutput()`、lifecycle `stdout/stderr` 摘要，以及 `plugin:test` 的测试输出都依赖这份字符串列表做替换（`packages/cli/src/utils/plugin-scripts.ts:695-705, 796`; `packages/cli/scripts/test-plugin-scripts.ts:508-510, 628-629`）。
- 结果是：如果插件把某个 `number` 或 `boolean` 配置标成 `sensitive: true`，脚本或测试把它打印出来时，当前实现不会脱敏。
- 这不是纯理论问题，因为 schema 首版本来就允许所有基础类型都带 `sensitive`。

## 总体评价

主链路整体已经比较成熟，之前最关键的几处偏差也都补上了：

- 安装快照、historical uninstall 真值和 current catalog fallback 的边界现在基本清楚。
- `aw config` 的分层存储、interactive configure、raw-store reset、`file`/`directory` 重新校验、catalog 缺失时的清理引导，都已经和文档更接近了。
- bundle/runtime 这层关于 AW 脚本、helper、Node runtime closure、`plugin-install-snapshots/` 和 `plugin-config/` 保留逻辑，也都落到了实现和测试里。

如果只看主体实现质量，这批代码是好的，结构也比上一轮稳很多。现在剩下的问题，主要集中在安全边界和 contract 收口上，而不是命令编排主流程本身。

## 测试覆盖评估

这次实际复跑了 14 个相关测试文件，全部通过，共 175 个测试：

- `tests/unit/plugin-config.test.ts`
- `tests/unit/plugin-scripts.test.ts`
- `tests/unit/manifest.test.ts`
- `tests/unit/manifest-coverage.test.ts`
- `tests/unit/generators.test.ts`
- `tests/unit/bundle-layout.test.ts`
- `tests/unit/local-marketplace.test.ts`
- `tests/unit/runtime.test.ts`
- `tests/unit/adapter-status.test.ts`
- `tests/integration/cli-entry.test.ts`
- `tests/integration/authoring-tools.test.ts`
- `tests/integration/plugin-test-runner.test.ts`
- `tests/integration/cli.test.ts`
- `tests/integration/runtime-env.test.ts`

覆盖面已经不错，但还不能算“完全覆盖”。目前缺的回归点至少有这些：

- `writeLifecycleScriptContext()` 生成的 `AW_PLUGIN_CONTEXT` 不应包含 `config.stores` raw payload，尤其不能把 schema 外旧 key 带进去。
- lifecycle runner 对 `sensitive: true` 的 `number` / `boolean` 配置做 stdout/stderr 脱敏。
- `plugin:test` 对 `sensitive: true` 的 `number` / `boolean` 配置做测试输出脱敏。

现有测试里，脱敏相关断言只覆盖了字符串 secret（`packages/cli/tests/unit/plugin-scripts.test.ts:235-259`; `packages/cli/tests/integration/plugin-test-runner.test.ts:228-237`），而 lifecycle context 的断言目前只验证了 `paths.configStores` 存在，没有锁住“不应额外挂 raw stores”这条边界（`packages/cli/tests/unit/plugin-scripts.test.ts:122-159`）。

## 结论

- 是否严格按照文档实现：还没有，当前还有 2 处明确的 contract 偏差。
- 实现代码质量：整体质量不错，主链路稳定，旧问题已修复；剩余问题集中在 context 边界和敏感信息脱敏。
- 测试是否完全覆盖：还没有。14 个相关测试文件、175 个用例都通过，但上面 2 个问题都缺少回归测试。
- 除了上一版报告的问题，是否还有其他未知 bug：有，这次新增确认了以上 2 个高置信问题。除此之外，我没有再发现第 3 个同等级、可稳定复现的实现缺陷。
