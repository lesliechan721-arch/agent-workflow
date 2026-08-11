# `test-fixture-isolation-plan.md` 执行计划评审报告

审查日期：2026-05-20  
审查对象：[docs/dev/plans/test-fixture-isolation-plan.md](../../../../docs/dev/plans/test-fixture-isolation-plan.md:1)
对照规范：[docs/dev/specs/test-fixture-isolation.md](../../../../docs/dev/specs/test-fixture-isolation.md:1)
审查范围：需求一致性、当前基线可落地性、测试覆盖、阶段划分与依赖关系

## 结论

上轮报告里提到的 project-scope config / repair 写路径遗漏，这一版已经补齐。重新对照 Spec、计划文档和当前代码基线后，本轮未发现新的问题；计划内容与需求一致，当前基线也有明确接入点，按现有版本可以推进实施。

## Findings

本轮未发现新的问题。

## 需求一致性

这版计划和 Spec 现在是对齐的，之前缺的 project-scope 路径也已经明确落进计划：

- 计划开头的实施约定继续守住了 Spec 的总边界：不改变生产默认语义，只在测试 setup、helper 和 test-only hook 内收紧默认值，并要求 source / smoke 共用同一套隔离合同。[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:14) 对应 [spec](../../../../docs/dev/specs/test-fixture-isolation.md:189)
- 阶段 1 到阶段 6 已完整覆盖 Spec 里的隔离模型、全局 setup、safe CLI/context、native/app-server guard、写路径 fence、dist 模块图 bridge 和文档合同。[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:68) 对应 [spec](../../../../docs/dev/specs/test-fixture-isolation.md:117)
- 上轮缺口已经补进阶段 5：`plugin-config.ts`、`plugin-config-write.ts`、`repair.ts` 和对应测试都在主文件清单里，待办和测试验收也把 `.agent-workflows/plugin-config*`、`.agents/skills`、project records / project artifacts 的 fence 合同写清楚了。[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:222) 对应 [spec](../../../../docs/dev/specs/test-fixture-isolation.md:231)
- 阶段 7、测试明细和最终回归也已经把 `config-write.test.ts`、`plugin-config.test.ts`、`repair-command.test.ts` 拉进迁移与收口范围，不再只是阶段 5 口头提到。[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:326)、[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:386)、[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:422)
- Spec 的 20 条验收标准在计划里都有对应的阶段验收、测试明细或最终回归抓手；我这轮没有再看到需求偏移或明显遗漏。[spec](../../../../docs/dev/specs/test-fixture-isolation.md:258)、[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:383)

## 当前基线可落地性

当前代码基线可以承接这份计划，没有看到阻断实施的结构性问题：

- unit / integration 现有 setup 已经挂在 [packages/cli/vitest.config.ts](../../../../packages/cli/vitest.config.ts:1)，而 smoke 侧还没有 `setupFiles`，这和 Spec 对现状的判断一致，也给阶段 2、阶段 6 提供了直接接入点。[packages/cli/vitest.smoke.config.ts](../../../../packages/cli/vitest.smoke.config.ts:1)
- 现有 `tests/setup/no-network-catalog.ts` 只处理 catalog override、memo 和 `fetch` stub，正适合按计划被收敛进统一隔离 setup，而不是推翻重做。[packages/cli/tests/setup/no-network-catalog.ts](../../../../packages/cli/tests/setup/no-network-catalog.ts:1)
- CLI 与 runtime 的注入边界已经存在：`runCliEntry()` 目前只做 IO capture，[packages/cli/tests/helpers/cli-entry.ts](../../../../packages/cli/tests/helpers/cli-entry.ts:1)；`createCommandExecutionContext()` 和 `createCliExecutionContext()` 也确实默认回退到真实 `process.env` / `process.cwd()` 和真实 native runner，正好对应阶段 3、4 要收紧的入口。[packages/cli/src/commands/runtime.ts](../../../../packages/cli/src/commands/runtime.ts:1368)
- native CLI 和 Codex app-server 也都有清晰的 runner 注入点，适合挂默认 guard 和 fake harness，不需要重写命令编排。[packages/cli/src/utils/native-cli.ts](../../../../packages/cli/src/utils/native-cli.ts:1)、[packages/cli/src/utils/codex-app-server-client.ts](../../../../packages/cli/src/utils/codex-app-server-client.ts:1)
- smoke 侧已经有手工 reset dist 模块图状态的现成先例，说明阶段 6 提到的 dynamic import bridge 在当前结构上可做，不是纸面设想。[packages/cli/tests/smoke/catalog-fetch-smoke.test.ts](../../../../packages/cli/tests/smoke/catalog-fetch-smoke.test.ts:143)
- 仓库当前没有 `test.concurrent` / `it.concurrent` / `describe.concurrent` 用例，所以“每个用例统一接管 `process.env` / `process.cwd()`”这个前提成立。
- 审查时额外做了本地验证，`os.tmpdir()` 会响应运行时 `TMPDIR` / `TEMP` / `TMP` 覆写，因此阶段 2 和阶段 5 依赖的 temp 语义在现有 Node 运行时下可以落地。

## 测试覆盖

计划里的测试闭环现在是完整的：

- 各阶段都有自己的测试验收，覆盖 env/cwd、safe helper、guard、fence、dist bridge 和文档收口，不是只靠最后跑一遍全量测试兜底。[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:91)、[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:128)、[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:165)、[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:205)、[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:271)、[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:311)、[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:371)
- 测试明细表已经把 Spec 最关键的合同逐条映射出来，尤其是 project-scope config/repair、只读/可写根、temp 派生路径、source/dist 双模块图恢复合同和 zero-write snapshot 边界。[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:386)
- 最终回归同时包含目标单测、目标集成测试、全量 `pnpm test:unit`、`pnpm test:integration`、`pnpm build` 和 smoke build/fetch/pack/plugin-scripts，足以覆盖阶段 7 没逐个点名的剩余测试文件。[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:422)

## 阶段划分与依赖关系

阶段划分和依赖关系也是合理的：

- 阶段 1 先固化隔离模型与 fence 原语，后续全部消费这一层，是对当前代码耦合度最稳妥的拆法。[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:25)
- 阶段 2、3、4 先把 setup、safe 入口和 guard 合同站稳，再让阶段 5 大面积接写路径 fence，能避免边做边返工。
- 阶段 6 等 guard / fence 合同稳定后再合并 smoke bridge 的要求是保守但正确的；当前 smoke 确实有独立 dist 模块图状态，不适合过早并进主线。[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:286)
- 阶段 7 把热点测试迁移、公开文档和最终回归放在一起收口也合理；这部分本来就依赖前面 helper/guard/fence 的最终形状，单独提前意义不大。[plan](../../../../docs/dev/plans/test-fixture-isolation-plan.md:326)
