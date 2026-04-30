# `codex-install-native-interactive-ux` 实现代码复审报告

审查对象：

- 计划文档：`docs/dev/plans/codex-install-native-interactive-ux.md`
- 实现代码：`packages/cli/src/**`
- 测试：`packages/cli/tests/**`

审查时间：2026-04-29

## Findings

本轮未发现新的 blocking、major 或 medium finding。

上一轮报告里的问题，这次都已经关闭：

1. 非 TTY + `--interactive` 不再误入真实 prompt，CLI 会直接返回业务层错误：`packages/cli/tests/integration/cli-entry.test.ts:835-867`
2. `--interactive` 可以重选显式传入的安装平台，不再被 `--platform codex` 锁死：`packages/cli/tests/integration/cli-entry.test.ts:781-833`
3. Codex repo-managed-only 插件不再误打印 native marketplace / plugin 成功收据：`packages/cli/tests/integration/cli-entry.test.ts:870-920`
4. debug log 已经接上真实事件流，native 失败细节会进入日志：`packages/cli/tests/integration/cli-entry.test.ts:315-380`
5. 上一版新增的 Codex marketplace 错误本地目录误判问题也已经修掉：
   - marketplace 健康度、`marketplaceSourceType`、`marketplaceRootResolution` 已按计划归一化：`packages/cli/src/adapters/codex.ts:139-207`
   - 错误本地目录会在 adapter status 中落成 drift，而不是继续当作 ready：`packages/cli/tests/unit/codex-adapter.test.ts:395-442`
   - `aw status` 默认输出和 `--json` 都能正确给出 `needsAttention` 与修复建议：`packages/cli/src/commands/status.ts:129-166`、`225-325`，`packages/cli/tests/integration/cli-entry.test.ts:1259-1310`

## 复审结论

这轮实现的代码质量是好的，结构也比较干净。Phase 0-6 拆出来的几个核心边界现在都已经落成独立模块：

- `commands/runtime.ts` 把 `env`、native runner、prompt、reporter、debug logger 和 diagnostics 收到同一条 runtime 走线
- `commands/options.ts` 把执行型命令和 `status` 的 options 语义拆开，避免再出现 partial options 直通深层逻辑的崩溃
- `commands/interactive.ts`、`commands/discovery.ts`、`commands/status.ts` 的职责分界清楚，交互、候选发现、状态面板没有重新耦回 CLI action 或 adapter
- Codex adapter 的 native marketplace add、status 健康判定和错误包装现在也使用同一套合同，没有再出现 install/status 两套标准分叉

按“是否严格按照计划实现”来判断，我这次的结论是：可以给“是”。

依据主要有三点：

1. 计划要求的 runtime / options / native add / discovery / interactive / output / status 主链都已经落地到对应模块，`docs/dev/todos/codex-install-native-interactive-ux.md` 也没有未完成项。
2. 用户文档和内部文档已经同步到新行为：`README.md`、`docs/plugin-installation.md`、`docs/architecture.md`、`docs/testing.md` 都已更新到 `user` 默认 scope、交互式模式、Codex native marketplace add、`status --json` 边界这套新合同。
3. 之前报告里指出的实现偏差，这次已经都能在代码和测试里对上，不再只是“文档说到了”。

## 测试覆盖评估

这次我实际重跑了关键回归链，结果如下：

- `pnpm test:unit`：29 个测试文件、192 个测试，全部通过
- `pnpm test:integration`：9 个测试文件、123 个测试，全部通过
- `pnpm test:smoke:build`：3 个测试，全部通过

从计划要求的风险面来看，这轮测试覆盖已经闭环，没有再看到明显缺口。关键点包括：

- partial direct command options、`user/auto` 默认值和 status filter 语义：`packages/cli/tests/integration/options-normalization.test.ts:146-219`
- `runtime.env` 贯穿默认 adapter、平台检测和 catalog 读取：`packages/cli/tests/integration/runtime-env.test.ts:73-127`
- Codex native marketplace add 的调用、失败包装、debug 记录和 `PATH=''` 场景：`packages/cli/tests/integration/cli-entry.test.ts:315-380`
- 交互式 install / uninstall / upgrade 的非 TTY 边界、重选平台、候选约束：`packages/cli/tests/integration/cli-entry.test.ts:781-867`、`930-1107`
- `status` 默认视图、JSON 纯度、wrong-local-source drift、下一步建议：`packages/cli/tests/integration/cli-entry.test.ts:1124-1310`
- stale marketplace 只读 fallback、historical placeholder、repo 子目录 discovery：`packages/cli/tests/integration/cli.test.ts`、`packages/cli/tests/integration/discovery.test.ts`

严格来说，没有任何一次 review 能证明“未来绝不会再有漏测点”；但如果问题是“这份实现是否已经把计划要求的关键路径都测到了”，我这次的判断是：测到了，而且覆盖是足够扎实的。

## 总结

这次复审没有发现上一版报告之外的新问题。上一轮和上上一轮报告里提到的实现缺口，现在都已经修完，并且有对应回归测试锁住。

当前状态可以判断为：

- 实现代码质量良好
- 已严格按计划落地
- 测试覆盖对计划范围内的关键合同已经完整闭环
- 未再发现新的实现问题
