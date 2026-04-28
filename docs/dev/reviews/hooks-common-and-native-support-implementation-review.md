# `hooks-common-and-native-support.md` 实现复审报告

审查对象：`docs/dev/plans/hooks-common-and-native-support.md`
审查时间：2026-04-28

本轮复审基于“上一版实现复审报告里的问题已经修复”的前提，重点复核：

- 代码实现质量
- 是否严格按计划实现
- 测试用例是否完全覆盖
- 上一版报告中的问题是否修复
- 是否还有新的遗漏 bug

## Findings

本轮未发现需要继续修改的阻断问题。

## 代码实现质量

这轮实现的代码质量是好的，核心原因不是“功能能跑”，而是边界收得比较干净。

- 公共 hooks、原生 hooks、事件 allowlist、matcher 能力和 Codex shared read/write canonicalization 都集中在同一层维护，没有再把规则散在 manifest、generator、adapter 各处。关键入口在 `packages/cli/src/utils/hooks-contract.ts:13-129` 和 `packages/cli/src/utils/hooks-contract.ts:1240-1361`。
- source manifest 的入口校验也已经按这套 contract 收口，公共 `session_stop`、`nativeHooks` 平台 key、matcherless 事件、native hook 非法字段、平台级重复 hook 都在 manifest 层被挡住了，职责比较清楚。对应实现见 `packages/cli/src/utils/manifest.ts:506-739`。
- 渲染链路没有再把“公共语义”和“目标平台最终产物”混写。公共 + native 合并渲染走 `packages/cli/src/generators/hooks.ts:67-130`，Claude bundle 也直接消费目标平台最终生效视图，见 `packages/cli/src/generators/local-plugin.ts:248-255`。
- Codex shared hooks 主链路现在也是“contract 负责解析和分流，adapter 负责拼写回计划”的分层。raw group 读取、managed identity 认领、historical/foreign 保留和回写，分别落在 `packages/cli/src/utils/hooks-contract.ts:1240-1361` 与 `packages/cli/src/adapters/codex.ts:306-530`。这一层比上一版更稳，不再是“读出来就按 AW 独占文件重建”。
- Claude capability snapshot 已把 `hooks` 纳入 `managedExtensions`，和 instructions / permissions 走同一条状态链路，见 `packages/cli/src/adapters/claude.ts:75-86`。

## 计划对齐情况

对照计划文档，本轮实现已经把关键条目都真正落下来了。

- 计划要求把公共 hooks 收窄为 `before_tool`、`after_tool`、`session_start`，并移除公共 `session_stop`。这一点已经落地到 hooks contract 和 manifest 校验，见 `docs/dev/plans/hooks-common-and-native-support.md:74-156`、`packages/cli/src/utils/hooks-contract.ts:13-129`、`packages/cli/src/utils/manifest.ts:506-565`。
- 计划要求新增 `extensions.nativeHooks`，并用事件级 matcher 能力表统一控制 source、generated artifact 和 shared read-mode。当前实现与测试已经对齐，见 `docs/dev/plans/hooks-common-and-native-support.md:148-231`、`packages/cli/src/utils/hooks-contract.ts:42-129`。
- 计划要求 Codex shared `.codex/hooks.json` 按“本次重渲染 AW groups / historical AW raw groups / foreign raw groups”三类处理。当前 contract 层的 `planCodexSharedHooksUpdate(...)` 和 adapter 侧 `syncCodexHooks()` 已经按这个模型写回，见 `docs/dev/plans/hooks-common-and-native-support.md:227-231`、`packages/cli/src/utils/hooks-contract.ts:1328-1361`、`packages/cli/src/adapters/codex.ts:507-530`。
- 计划要求 `nativeHooks` 走通 source manifest、bundle source manifest、embedded catalog、bundle hooks 文件、install / uninstall / status / historical fallback / 作者工具 / 文档。现有实现和自动化测试都能找到对应锚点，覆盖了这条全链路。

如果用“是否严格按计划实现”来判断，我这次会给“是”。我没有再看到上一版那种“主设计对了，但某条历史分支实际上没按计划工作”的缺口。

## 测试评估

我实际跑了这三组验证，结果全部通过：

- `pnpm test:unit`
  24 个 test files，127 个测试全部通过。
- `pnpm test:integration`
  5 个 test files，46 个测试全部通过。
- `pnpm test:smoke:build`
  1 个 test file，2 个测试全部通过。

从覆盖面看，这轮测试已经不只是“有几条 happy path”：

- source contract、nativeHooks、公共 `session_start` 收口、Codex matcher 校验、完整 Claude allowlist 和 matcher 能力表，都有直接单测锚点，见 `packages/cli/tests/unit/manifest.test.ts:261-620`、`packages/cli/tests/unit/hooks-contract.test.ts:15-411`。
- bundle source manifest 深拷贝、embedded catalog round-trip 和 nativeHooks 保留都有单测，见 `packages/cli/tests/unit/manifest-coverage.test.ts:465-603`。
- Codex shared hooks 的历史 AW raw group、foreign raw group、multi-handler / mixed group、matcherless inert matcher、status / uninstall / rebuild 行为，都有直接回归，见 `packages/cli/tests/unit/codex-adapter.test.ts:70-220`。
- CLI 命令级链路已经覆盖 Codex nativeHooks-only、公共 + native mixed hooks、catalog 缺失后的 tracking fallback、opaque mixed group drift，以及 Claude nativeHooks-only 的 ledger fallback，见 `packages/cli/tests/integration/cli.test.ts:1388-1825`。
- 作者工具和文档也补上了新 contract 校验，见 `packages/cli/tests/integration/authoring-tools.test.ts:436-594`。
- 构建产物层面，`nativeHooks` 穿过 compiled bundle script 和 bundle layout 校验也有 smoke，见 `packages/cli/tests/smoke/build-smoke.test.ts:67-135`。

如果把问题表述成“测试是否绝对完全覆盖”，我的答案仍然会谨慎一些：工程上很少有人能对“完全覆盖”下绝对判断。但按这份计划列出来的风险面看，这轮该补的测试矩阵已经补齐了，我这次没有再看到明显空白。

## 上一版问题修复情况

上一版实现复审报告里的那条核心 finding，我确认已经修掉了。

- 上一版问题是：Codex install / upgrade 遇到 legacy hook tracking 只有 `kind: "hook"`、没有 `hookGroups` 时，会把旧 AW group 留下，再把新渲染结果追加回去，造成 shared `hooks.json` 重复。
- 现在的实现里，legacy tracking 在 install rewrite 阶段会回退到“当前可解析插件的 resolved hook identities”，用于本次 rerender 扣减，见 `packages/cli/src/adapters/codex.ts:448-467`。
- 随后的 shared hooks 写回只保留 historical / foreign raw groups，再追加新的 managed groups，见 `packages/cli/src/adapters/codex.ts:507-530`。
- 对应回归也已经补进单测：`packages/cli/tests/unit/codex-adapter.test.ts:139-183` 直接覆盖了“legacy tracking lacks hook groups”场景。

更早一轮 review 提到的 Codex matcher 校验、shared read-mode canonicalization、Claude capability snapshot hooks 缺口，这次我也重新核了一遍，相关实现和测试都还在，没有回退。

## Open Questions / Assumptions

- Claude / Codex 上游 hooks 事实我重新核对过，当前仓库里的 allowlist、matcherless 事件集合和 Codex shared handler shape 与上游源码一致。核对依据仍是：
  - Claude：`/Users/LeslieChan/Desktop/claude-code-source-code/src/entrypoints/sdk/coreSchemas.ts`
  - Claude：`/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/hooks/hooksConfigManager.ts`
  - Claude：`/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/hooks.ts`
  - Codex：`/Users/LeslieChan/Desktop/codex/codex-rs/config/src/hook_config.rs`
  - Codex：`/Users/LeslieChan/Desktop/codex/codex-rs/hooks/src/events/common.rs`
  - Codex：`/Users/LeslieChan/Desktop/codex/codex-rs/hooks/src/engine/discovery.rs`
- 这次复审是“源码核对 + AW 自动化测试”的结论，不是对真实 Claude / Codex 二进制运行时做端到端黑盒复验。就当前仓库范围来说，这已经足够判断本轮实现是否达标。
- 仍然值得长期关注的点只有一个：Codex matcher 语法校验是 AW 自己维护的一套 Rust-regex 兼容解析逻辑。当前它已经比上一版稳得多，且 invalid / JS-only / Rust-only matcher 都有测试锁住；但如果 Codex 上游未来扩展 matcher 语法，这里仍需要同步跟进。这个是后续演进风险，不是本轮已发现 bug。

## 结论

这轮实现可以通过复审。

- 代码实现质量：良好，职责边界清楚，核心 contract、adapter 和状态链路已经收口。
- 是否严格按计划实现：是，计划里的关键实现项和测试项都已经落地。
- 测试用例是否完全覆盖：按本计划的验收矩阵看，已经补齐；我没有再看到明显测试缺口。
- 上一版报告发现的问题是否修复：是，已修复，并且已经有直接回归测试。
- 是否还有其他未发现 bug：本轮未发现新的高优先级问题。
