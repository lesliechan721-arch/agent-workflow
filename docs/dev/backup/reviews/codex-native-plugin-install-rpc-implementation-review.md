# Codex 原生插件安装/卸载 RPC 实现复审报告

日期：2026-05-05
审查对象：`docs/dev/plans/codex-native-plugin-install-rpc-plan.md` 对应实现与当前 `git diff`
复审重点：验证上一轮阻断修复、检查计划一致性、确认测试覆盖

## 复审结论

已验证上一轮阻断问题已经修复：Codex user uninstall 的 post-check 不再把 `ambiguous` / `invalid` cache 残留误判为成功。

本轮未发现新的阻断或计划偏差问题。
明确结论：**未发现新的阻断或计划偏差问题。**

## 已验证的修复

### 1. uninstall post-check 已按计划收紧为“无 config entry 且无任何 cache 残留”

- 计划要求：
  - `docs/dev/plans/codex-native-plugin-install-rpc-plan.md:223`
  - `docs/dev/plans/codex-native-plugin-install-rpc-plan.md:351-352`
- 当前实现：
  - `packages/cli/src/utils/codex-native-state.ts:64-69`
  - `packages/cli/src/utils/codex-native-state.ts:250-258`

`checkCodexNativeUninstallPostCheck()` 现在通过 `hasCodexNativeCacheEvidence()` 判断 cache 残留，只要 `cacheStatus !== 'missing'` 就会失败，因此：

- `active` 残留会失败；
- `ambiguous` 残留会失败；
- `invalid` 残留会失败；
- `enabled = false` 的 config entry 残留仍会失败。

这和计划里“目标 config entry 不存在且 cache 不存在才算卸载完成”的约束一致。

### 2. adapter 失败分支已经覆盖 `active / ambiguous / invalid` 三类残留

- 代码：
  - `packages/cli/src/adapters/codex.ts:405-438`
  - `packages/cli/src/adapters/codex.ts:2353-2381`

`describeCodexNativeUninstallPostCheckFailure()` 现在会区分：

- active cache 仍在；
- ambiguous，多版本有效 cache 并存；
- invalid，无效目录或非目录条目残留。

post-check 失败时，命令会继续保留并刷新 recovery breadcrumb，而不是把 native 卸载误报为成功后再清 tracking / ledger。

### 3. tracking-only 且 ledger scope record 缺失时，native uninstall 仍会执行

- 计划要求：
  - `docs/dev/plans/codex-native-plugin-install-rpc-plan.md:248-252`
- 代码：
  - `packages/cli/src/adapters/codex.ts:2218-2247`

`CodexAdapter.uninstallPlugin()` 不再只依赖成功的 scope ledger record。现在会综合判断：

- installed scope snapshot；
- tracking record；
- shared native refs；
- recovery breadcrumb；
- 当前 native state。

这修复了“账本记录丢了，但 AW 仍有足够归属证据时却跳过 native uninstall”的偏差。

## 新发现的问题

未发现新的阻断问题。
未发现新的计划偏差问题。

## 测试覆盖结论

结合当前 diff、已有测试以及本轮定向复跑结果，我认为这次修复已经把相关计划变更覆盖到位。

### 已覆盖的关键点

- helper 层：
  - `packages/cli/tests/unit/codex-native-state.test.ts:124-169` 覆盖 `ambiguous` / `invalid` cache evidence 暴露；
  - `packages/cli/tests/unit/codex-native-state.test.ts:204-251` 覆盖 uninstall post-check 对 `disabled` / `active` / `invalid` / `ambiguous` 残留的判定。
- command 层：
  - `packages/cli/tests/unit/uninstall-command.test.ts:1325-1408` 覆盖 tracking-only 且 ledger scope record 缺失时仍执行 `plugin/uninstall`；
  - `packages/cli/tests/unit/uninstall-command.test.ts:1570-1708` 覆盖 RPC 成功但留下 invalid cache 残留时，命令失败且保留 recovery / tracking / ledger bookkeeping。
- integration / status / discovery：
  - `packages/cli/tests/integration/discovery.test.ts:464-548` 覆盖 `ambiguous` / `invalid` cache residue 会进入 discovery/status 诊断面；
  - `packages/cli/tests/integration/discovery.test.ts:706-783` 覆盖 `native.recovery.evidenceMatches` 回到计划定义。
- app-server client：
  - `packages/cli/tests/unit/codex-app-server-client.test.ts:20-110` 覆盖快响应竞态修复。

### 本轮实际运行的命令

我本轮额外复跑了这条定向命令：

```bash
pnpm --filter @lesliechan721/aw exec vitest run \
  tests/unit/codex-native-state.test.ts \
  tests/unit/uninstall-command.test.ts \
  tests/unit/codex-app-server-client.test.ts \
  tests/integration/discovery.test.ts
```

结果：

- 4 个测试文件全部通过；
- 52 个测试全部通过。

另据主代理提供的结果，以下全量套件也已通过：

```bash
pnpm test:smoke:build
pnpm test:unit
pnpm test:integration
```

综合来看，这轮修复对应的实现、回归路径和计划要求之间没有再看到未锁住的关键缺口。
