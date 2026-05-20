# `test-fixture-isolation-plan.md` 实现代码 Review

审查日期：2026-05-20  
审查对象：`ed931b0 test(cli): 实现测试夹具隔离` 及其后续未提交修复  
对照文档：`docs/dev/plans/test-fixture-isolation-plan.md`、`docs/dev/specs/test-fixture-isolation.md`

## Findings

本轮复审未发现新的实现问题。

上一版报告指出的两条合同缺口已经补齐，并且补上了对应测试：

1. `AW_HOME` 同级临时目录越界写入问题已修复。current catalog rebuild、local marketplace staging 和 backup 现在统一落到 `resolveCliTempRoot(env)` 之下，并在创建前经过 `assertTestWritablePath()` 校验，见 [packages/cli/src/commands/install.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/src/commands/install.ts:334)、[packages/cli/src/utils/local-marketplace.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/src/utils/local-marketplace.ts:1157) 和 [packages/cli/src/utils/paths.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/src/utils/paths.ts:168)。对应回归测试已经锁住 staging / backup / pinned root 都位于 `TMPDIR/aw-cli/**`，见 [packages/cli/tests/unit/local-marketplace.test.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/tests/unit/local-marketplace.test.ts:199)、[packages/cli/tests/unit/upgrade-command.test.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/tests/unit/upgrade-command.test.ts:404) 和 [packages/cli/tests/unit/paths.test.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/tests/unit/paths.test.ts:35)。

2. smoke dist 隔离 bridge 默认未安装的问题已修复。smoke setup 现在在每个用例的 `beforeEach` 中自动执行 `installCurrentSmokeDistIsolationBridge()`，见 [packages/cli/tests/setup/test-isolation-smoke.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/tests/setup/test-isolation-smoke.ts:28)。对应 smoke 用例也改成“不手动安装 bridge”直接验证 dist 模块图默认 guard、生效中的 fetch stub，以及 dist 侧路径 fence，见 [packages/cli/tests/smoke/catalog-fetch-smoke.test.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/tests/smoke/catalog-fetch-smoke.test.ts:189)。

## 复审结论

这轮实现现在已经和计划、Spec 的主合同对齐：

- 需求合同：unit / integration / smoke 都走统一隔离 setup；source 与 dist 模块图都覆盖 env、cwd、fetch、catalog override、native guard、app-server guard 和路径 fence，见 [packages/cli/tests/setup/test-isolation.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/tests/setup/test-isolation.ts:144)、[packages/cli/tests/setup/test-isolation-smoke.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/tests/setup/test-isolation-smoke.ts:32) 和 [packages/cli/tests/setup/reset-dist-state.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/tests/setup/reset-dist-state.ts:122)。
- 实现质量：测试态路径校验通过 test-only hook 接入生产模块，非测试运行时默认旁路，没有改变生产默认语义；职责拆分也比较清晰，`test-path-fence` 只定义 hook，registry / 错误模型放在测试 helper 侧，见 [packages/cli/src/utils/test-path-fence.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/src/utils/test-path-fence.ts:1)。
- 性能：新增校验主要是路径规范化、root 匹配和测试 setup/reset，范围只在测试态；生产代码通过空 hook 旁路，不引入常规运行时开销。dist bridge 只在 smoke setup 执行一次模块加载缓存，后续按缓存模块 reset，复杂度可接受，见 [packages/cli/tests/setup/reset-dist-state.ts](/Users/LeslieChan/Desktop/yiliang/llm-agent/agent-workflows/.worktrees/test-fixture-isolation/packages/cli/tests/setup/reset-dist-state.ts:49)。
- 测试覆盖：原语、setup、safe CLI、tmp root、local marketplace、upgrade pinned catalog root，以及 smoke dist 默认 guard 都有直接断言；我没有看到这轮需求变更里明显缺测的核心边界。

## 验证

本地复跑通过：

- `pnpm --filter @yiliang/aw exec vitest run tests/unit/test-isolation.test.ts tests/unit/path-fence.test.ts tests/unit/test-isolation-setup.test.ts tests/unit/local-marketplace.test.ts tests/unit/paths.test.ts tests/unit/upgrade-command.test.ts`
- `pnpm --filter @yiliang/aw exec vitest -c vitest.smoke.config.ts run tests/smoke/catalog-fetch-smoke.test.ts`

结论上，这份实现可以从“有两条未收口合同缺口”更新为“本轮复审未发现新的问题，上一版问题已修复完成”。
