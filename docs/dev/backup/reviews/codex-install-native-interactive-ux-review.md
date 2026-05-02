# `codex-install-native-interactive-ux.md` 执行计划复审报告

审查对象：`docs/dev/plans/codex-install-native-interactive-ux.md`  
审查时间：2026-04-29

本轮复审仍然基于当前仓库基线，范围限定为：

- 基于基线的执行计划 review，不是实现代码 review
- 同时检查文档自洽、当前基线是否真能承接这套方案，以及测试用例是否闭环
- 除了核对上一版报告里的问题是否已修复，也继续筛查新的落地风险

对照依据：

- 当前仓库实现：`packages/cli/src/**`
- 当前仓库测试：`packages/cli/tests/**`
- 当前仓库文档：`docs/testing.md`、`docs/architecture.md`

## Findings

本轮未发现新的 blocking finding。

上一版报告里挂着的几条关键风险，这一版计划都已经明确补回正文、测试约定和验收标准，可以关闭：

1. prepare / replay warning 的顺序与去重合同，已经写回 Phase 0、Phase 5、`docs/testing.md` 更新项和验收标准：`docs/dev/plans/codex-install-native-interactive-ux.md:149-170`、`151-152`、`493-495`、`611`、`641`
2. `--skill-trigger` 在 CLI entry 的正向透传，以及 `upgrade --all` 入口拒绝合同，已经写回 Phase 1、`docs/testing.md` 更新项和验收标准：`docs/dev/plans/codex-install-native-interactive-ux.md:185-186`、`203-227`、`612`、`618`
3. stale `~/.aw` 场景下，`status` 必须保持只读并回退 embedded catalog，已经写回 Phase 3、Phase 6、`docs/testing.md` 更新项和验收标准：`docs/dev/plans/codex-install-native-interactive-ux.md:293`、`509-512`、`580-583`、`610`、`652`
4. `runtime.env` 必须贯穿 CLI runtime、discovery、status 和默认 adapter 创建，也已经写回 Phase 0、`docs/testing.md` 更新项和验收标准：`docs/dev/plans/codex-install-native-interactive-ux.md:149`、`169-170`、`609`、`622`

这些补丁和当前基线测试也能对上：

- stale `~/.aw` 的只读 fallback，当前基线已经有回归测试：`packages/cli/tests/integration/cli.test.ts:551-585`
- `runtime.env` 贯穿平台检测、默认 adapter 和 current catalog 读取，当前基线已经有回归测试：`packages/cli/tests/integration/runtime-env.test.ts:74-127`
- warning 先于 terminal error 输出、且 prepare warning 不能重复渲染，当前基线已经有 CLI entry 回归测试：`packages/cli/tests/integration/cli-entry.test.ts:238-321`

## 复审结论

这份计划现在已经达到“可按当前基线直接实施”的状态。

我这轮重点复核了几类最容易在重构里失真的合同，计划都已经补齐：

- 新 runtime 注入链不再只停留在设计描述，而是把 `env`、fake runner、fake prompt、reporter、debug logger 和 `status --json` 的 `stdout/stderr` 边界都写进了测试要求：`docs/dev/plans/codex-install-native-interactive-ux.md:135-171`
- Codex native add 的注入缝、`PATH=''` 下不触发真实二进制、native 失败矩阵和 debug 记录边界都已经覆盖：`docs/dev/plans/codex-install-native-interactive-ux.md:235-270`
- discovery / status 对 repo 子目录、Codex/Claude project identity、historical placeholder 保守恢复、stale marketplace fallback 和只读边界都已经和当前基线合同对齐：`docs/dev/plans/codex-install-native-interactive-ux.md:276-322`、`501-583`
- 输出层不只写“说人话”，也把最关键的行为边界钉住了：warning 顺序、warning 去重、`status -j` 纯 JSON、`status --debug` 不写 `~/.aw`：`docs/dev/plans/codex-install-native-interactive-ux.md:151-160`、`459-495`、`548-583`

从“当前基线能不能承接”这个角度看，我没有再看到结构性阻塞点。

## 测试评估

如果问题是“测试用例是否已经完全覆盖”，按执行计划层面看，这一版已经基本闭环。

原因不是它把测试写得更长，而是它把最容易漏掉的几条高风险路径都单独钉住了：

- CLI runtime 合同：`env` 贯穿、fake runner / fake prompt 注入、`--debug` 与 `AW_DEBUG=1` 共线、`status -j` 纯 JSON：`docs/dev/plans/codex-install-native-interactive-ux.md:162-171`
- Codex native marketplace add：正确调用、跳过条件、错误包装、`PATH=''` 场景和 debug 细节：`docs/dev/plans/codex-install-native-interactive-ux.md:238-270`
- discovery / historical placeholder：按 `platform + scope` 分格、repo 子目录语义、ledger-only 保守恢复、tracking 明确信号正向恢复：`docs/dev/plans/codex-install-native-interactive-ux.md:294-322`
- 交互式 install / uninstall / upgrade：候选来源、candidate identity、平台兼容性、`Codex + project` 可安装性、degraded ledger 下 skill-trigger 补问：`docs/dev/plans/codex-install-native-interactive-ux.md:326-408`
- status 重写：默认摘要、verbose/json/debug 三视图、skill-trigger 状态矩阵、stale marketplace fallback、完全只读边界：`docs/dev/plans/codex-install-native-interactive-ux.md:501-583`

我这轮没有再看到新的测试盲区。

## 实施期注意点

下面两点我不算作 finding，但实现时最好主动盯住：

- `codex plugin marketplace add` 的精确 flags 仍要在实现时用本机 `codex --help` 或上游源码确认；计划本身已经把这件事写进风险项，方向没问题：`docs/dev/plans/codex-install-native-interactive-ux.md:661`
- `aw status <unknown-plugin>` 的默认行为会从当前基线的 `Unknown plugin` 错误，调整为“未安装 / 未发现受管状态”并给安装建议；这是计划里明确声明的产品行为变更，不是遗漏，但实现时要同步更新现有测试预期，例如 `packages/cli/tests/integration/cli.test.ts:702-726`，避免把有意行为变化误判成回归

## 结论

上一版报告里的问题，这一版计划已经补齐；本轮也没有发现新的阻塞级问题。

我现在会把这份计划判断为：在当前基线下可落地实施，且测试覆盖要求已经足够支撑后续改动。
