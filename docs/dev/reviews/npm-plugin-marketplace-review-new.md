# `npm-plugin-marketplace-new.md` 评审报告

审查对象：`docs/dev/plans/npm-plugin-marketplace-new.md`

审查范围：基于当前仓库基线，对执行计划本身做评审，不审代码实现

审查基线：

- 当前 `packages/cli` 实现与现有测试
- `Codex` 源码：`/Users/LeslieChan/Desktop/codex/codex-rs`
- `Claude Code` 源码：`/Users/LeslieChan/Desktop/claude-code-source-code/src`

审查时间：2026-04-25

补充前提：

- review 的是执行计划，不是代码实现
- Claude 的全局 plugins 目录按本次约束固定为 `~/.claude/plugins`

## 结论

基于当前基线与上游源码重新复核后，这份计划目前没有发现需要在实施前继续收口的阻塞问题。

上一轮 report 里的两个遗留问题，这次都可以正式关闭：

- smoke / pack 的 monorepo 命令入口已经补齐，不再存在“正文和当前仓库执行入口脱节”的问题
- 同主题旧计划文档已经被显式纳入历史文档清理范围，不再留有“多份活动方案并列”的尾项

整体上，这份计划现在已经满足这次 review 重点：

- 文档边界清楚，讨论的是“基于当前基线如何落地”，不是把实现细节和目标态混成一团
- Claude / Codex 的平台真值、CLI 账本、repo-managed artifacts 和 current catalog 之间的职责边界是自洽的
- 方案拆分能顺着当前 `packages/cli` 结构演进，不需要先推翻现有目录组织
- 测试矩阵已经覆盖 build contract、本地市场、平台状态、失败降级、作者工具和历史文档同步

## 发现

本轮未发现新的高、中、低严重度问题。

## 已关闭项

### 1. smoke / pack 命令入口与当前 monorepo 基线不一致

位置：

- `docs/dev/plans/npm-plugin-marketplace-new.md:163-241`
- `docs/dev/plans/npm-plugin-marketplace-new.md:1974-1978`
- `docs/dev/plans/npm-plugin-marketplace-new.md:2107-2125`

结论：

这个问题已经关闭。计划现在明确把仓库根 `package.json` 纳入修改范围，补上了 `test:smoke`、`test:smoke:build`、`test:smoke:pack` 和 `pack:cli` 代理入口，也明确规定 tarball 验证统一走 `pnpm pack:cli`，不再混用会命中 workspace root 的裸 `pnpm pack`。

这意味着正文里的验证命令已经和当前 monorepo 的执行 contract 对齐，实施和验收都能从 repo root 稳定执行。

### 2. 同主题旧版计划文档没有被显式纳入历史文档清单

位置：

- `docs/dev/plans/npm-plugin-marketplace-new.md:1679-1692`
- `docs/dev/plans/npm-plugin-marketplace-new.md:1758-1762`
- `docs/dev/plans/npm-plugin-marketplace-new.md:2100-2105`

结论：

这个问题也已经关闭。计划现在不仅在文档同步章节里显式点名了：

- `docs/dev/plans/npm-plugin-marketplace.md`
- `docs/dev/plans/npm-plugin-marketplace-copy.md`

还把它们写进了关键文件清单和验收标准，要求“删除或标记为历史文档”，并且明确不能再以活动计划身份与当前方案并列保留。

这次文档收口已经从“建议补一下”变成了实施与验收 contract 的正式组成部分。

## 测试覆盖评估

这版计划的测试设计已经比较完整，当前没有看到明显的覆盖空洞。尤其下面几类高风险点，都已经被写进了验证范围：

- build-free 常规测试与 build / pack smoke 的职责边界
- `plugins-dist`、`resolveEmbeddedPluginsRoot()`、synthetic embedded root 的运行时输入 contract
- `~/.aw` 的 freshness、bundle refresh、合法账本保留和 degraded ledger 行为
- Claude 的 declared source drift、materialized drift、`platformRuntimeEvidence`、`platformNativeFallbackEvidence`
- Codex 的 `requiresNativePlugin`、`sharedNativeRefs`、`developer_instructions`、project trust、role file 契约
- `catalogCompatibility = current | missing | capabilityChanged`
- `--platform auto|both` 的正向和拒绝矩阵
- native write / artifact write 之后账本提交失败的降级路径
- 作者工具、参考文档和历史文档同步
- tarball 内容与解包后的 embedded bundle 最小 smoke

如果一定要说剩余风险，最高的还是 `codex-config.ts` 的 round-trip 编辑能力。但计划已经把它单独抬成 feasibility gate，并要求在接入命令链路之前先通过独立 golden fixture 和 build-free smoke，所以这更像实施时必须守住的 gate，不再是当前文档缺口。

## 基线与源码核对摘要

这次复核里，下面这些关键前提再次和当前基线 / 上游源码对齐：

- Claude 的 project 身份来自启动阶段已经 realpath 过的 `getOriginalCwd()`，不是 repo root，也不是运行中漂移后的 cwd
  - `claude-code-source-code/src/bootstrap/state.ts:260-279`
  - `claude-code-source-code/src/utils/settings/settings.ts:239-247`
  - `claude-code-source-code/src/services/plugins/pluginOperations.ts:111-115`
  - `claude-code-source-code/src/utils/plugins/installedPluginsManager.ts:800-807`
- Claude 的本地目录 marketplace loader，确实按 `known_marketplaces.installLocation + entry.source` 解析当前 bundle；`installed_plugins.json.installPath` 不是本地目录 marketplace 的当前载荷真值
  - `claude-code-source-code/src/utils/plugins/pluginLoader.ts:2048-2127`
- Claude 的 marketplace 声明层 / 物化层差异，确实由 `diffMarketplaces()` 的 source 归一化比较与 `known_marketplaces.json` 分别表达
  - `claude-code-source-code/src/utils/plugins/reconciler.ts:50-76`
- Codex 的 user marketplace 写回结构，确实要求写 `source_type` 与 `source`
  - `codex-rs/config/src/marketplace_edit.rs:14-38`
- Codex 对本地 marketplace root 的解析，只有 `source_type = "local"` 时才把 `source` 当目录 root；否则回落到默认安装目录
  - `codex-rs/core-plugins/src/installed_marketplaces.rs:63-75`
- Codex 的 project trust 查找顺序，确实是“当前目录 -> project root -> repo root”的 lookup key 回退
  - `codex-rs/core/src/config_loader/mod.rs:665-725`
- Codex 的 `developer_instructions` 会进入真实 developer message
  - `codex-rs/core/src/session/mod.rs:2571-2575`
- Codex agent role 文件的 `name`、`description`、`developer_instructions` 约束，也和计划里的生成契约一致
  - `codex-rs/core/src/config/agent_roles.rs:229-262`
  - `codex-rs/core/src/config/agent_roles.rs:354-372`
