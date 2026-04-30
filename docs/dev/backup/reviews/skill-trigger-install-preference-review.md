# `skill-trigger-install-preference.md` 计划审查报告

审查对象：`docs/dev/plans/skill-trigger-install-preference.md`  
审查时间：2026-04-28

本轮审查仍然基于当前仓库基线，范围限定为：

- 基于基线的执行计划 review，不是代码实现 review
- 不只检查文档是否自洽，也检查当前基线是否真能承接这套方案
- 重点核对安装、升级、卸载、`~/.aw` 重建、status 推导、warning 合同和测试矩阵

对照依据：

- 当前仓库实现：`packages/cli/src/**`、`packages/cli/tests/**`
- 当前仓库文档：`docs/testing.md`、`docs/architecture.md`、`docs/plugin-authoring.md`
- Codex 源码：`/Users/LeslieChan/Desktop/codex/codex-rs`
- Claude Code 源码：`/Users/LeslieChan/Desktop/claude-code-source-code/src`

## 本轮结论

这次重新过完计划、基线和事实标准后，我的结论是：这份计划已经达到可以直接进入实现的程度，本轮没有发现新的阻塞性问题。

上一轮报告里的两处核心问题，这版计划都已经补实了，而且补法和当前仓库基线是对得上的：

- CLI 入口测试已经明确改成 build-free 的源码入口测试，再由 smoke 兜真实 `dist/index.js`，和当前测试分层一致，不会再把 integration 拉成半个 build/smoke
- malformed pristine skill 文件对 `status`、replay、sibling conflict warning、`aw init --force`、`upgrade --all` 等只读/维护性路径的退化合同已经写清楚：这些路径返回 `unknown` / `skipped`，只有用户显式要求 `manual|auto` 改写时才 fail fast

再往下看，计划对当前基线里最容易出错的几处也都已经有明确承接：

- `skillTriggers` / `allowInstallOverride` 的事实来源固定在 embedded / pristine bundle，不再让 `~/.aw` 的运行时副本反向决定 install、replay、status 或 drift/warning 语义
- `ensureLocalMarketplace()` 的 warning 传递、`upgrade --all` 的 preparation 顺序、CLI 失败路径 warning 输出合同，都已经补到命令入口层，不再停留在 helper 或 command 内部假设
- 测试计划已经覆盖 unit、integration、CLI 入口 integration、smoke 和 authoring tools，关键链路没有再看到明显漏口

## Findings

本轮未发现新的阻塞性 findings。

## 已关闭的上一轮问题

### 1. CLI 入口测试方案已经和当前 build-free 基线对齐

当前基线里：

- `docs/testing.md` 明确要求 `unit/`、`integration/` 保持 build-free，真实 build 产物验证放到 smoke
- `packages/cli/src/index.ts` 现在还是一体化 `main()`
- `packages/cli/src/utils/paths.ts` 的 `setEmbeddedPluginsRootOverrideForTests()` 是进程内 override
- `packages/cli/tests/helpers/embedded-root.ts` 也是通过同进程 synthetic embedded root 组织测试

这版计划已经明确要求把 Commander 入口拆成可直接从源码调用的 `runCli()` / `buildProgram()`，并把 CLI 入口测试放在 build-free integration，真实 `dist/index.js` 只在 smoke 校验。这个落点和当前仓库骨架是匹配的，不再有上一轮那种“测试目标是对的，但执行方案落不到现有基线里”的问题。

对应计划位置：

- CLI 入口重构与 warning 合同：`docs/dev/plans/skill-trigger-install-preference.md:218-220`
- CLI 入口 integration 覆盖：`docs/dev/plans/skill-trigger-install-preference.md:468-474`

### 2. malformed embedded pristine skill 的退化语义已经补完整

当前基线里：

- `packages/cli/src/utils/manifest.ts` 和 `packages/cli/src/utils/bundle-layout.ts` 只做浅校验
- `packages/cli/src/utils/local-marketplace.ts` 的重建也还没有 replay / warning / skill 语义判断

也就是说，malformed skill 文件今天完全可能进入 embedded bundle。上一轮真正担心的，不是显式 `manual|auto` 写入时 fail fast，而是这些 malformed 文件会不会把 `status`、replay、`aw init --force`、`upgrade --all` 之类的维护性路径也一起打成硬失败。

这版计划已经把边界写清楚了：

- 显式 `manual|auto` 写入：严格解析，fail fast
- `default` 恢复：直接回 pristine，不扩成全量 skill 校验
- 签名计算、status、replay、sibling conflict warning：遇到 embedded pristine 文件缺失或不可解析时，只返回 `unknown` / `skipped` / diagnostics，不让命令整体失败

这和当前基线非常契合，因为它没有试图把 bundle/layout 校验变成另一套隐式的 runtime skill parser，而是把严格解析集中在真正需要改写文件的路径里。

对应计划位置：

- 可 patch 合同：`docs/dev/plans/skill-trigger-install-preference.md:105-119`
- 物化 helper 与签名 helper：`docs/dev/plans/skill-trigger-install-preference.md:227-255`
- `initializeLocalMarketplace()` 的 best-effort replay：`docs/dev/plans/skill-trigger-install-preference.md:327-337`
- status 的 `unknown` 合同：`docs/dev/plans/skill-trigger-install-preference.md:343-350`
- 对应测试矩阵：`docs/dev/plans/skill-trigger-install-preference.md:375-390`、`405-406`、`456-466`

## 事实标准核对

对照 Codex 和 Claude Code 源码后，计划里的平台映射没有发现新的事实性偏差：

- Codex 的 `allow_implicit_invocation` 缺省为允许自动触发  
  参考：`/Users/LeslieChan/Desktop/codex/codex-rs/core-skills/src/model.rs:25-30`
- Claude 的 `user-invocable` 缺省为 `true`  
  参考：`/Users/LeslieChan/Desktop/claude-code-source-code/src/skills/loadSkillsDir.ts:216-220`
- Claude 的 `disable-model-invocation` 缺省为 `false`  
  参考：`/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/frontmatterParser.ts:328-334`、`/Users/LeslieChan/Desktop/claude-code-source-code/src/skills/loadSkillsDir.ts:254-258`
- Claude 的模型自动调用和用户显式调用，确实是两套独立开关  
  参考：
  - 模型调用受 `disable-model-invocation` 阻断：`/Users/LeslieChan/Desktop/claude-code-source-code/src/tools/SkillTool/SkillTool.ts:398-418`
  - 用户 `/skill-name` 显式调用受 `userInvocable === false` 阻断：`/Users/LeslieChan/Desktop/claude-code-source-code/src/utils/processUserInput/processSlashCommand.tsx:525-548`

所以计划里的三种映射仍然成立：

- `manual`：禁止模型自动触发，但保留用户显式入口
- `auto`：允许模型自动触发；Claude 的 `user-invocable` 继续继承 pristine 默认
- `default`：完全回到平台原生默认文件

## 测试覆盖判断

从“当前基线能不能把这套设计测住”的角度看，测试计划现在已经比较完整，关键覆盖面都在：

- manifest / bundle / ledger schema
- install / explicit upgrade / `upgrade --all`
- uninstall 后的共享 marketplace 重选
- `~/.aw` rebuild replay 与 degraded ledger 跳过 replay
- sibling conflict warning 的触发、去重和 `unknown` 退化
- status 的 `matched` / `matches(...)` / `mixed` / `unknown`
- local manifest 被手工篡改时，embedded policy 仍然是唯一事实来源
- CLI 入口层的参数解析、warning 顺序和失败退出码
- smoke 层对真实 build 产物的兜底验证

按当前方案，我没有再看到必须补上的关键漏测口。

## 实施注意点

这些不是 findings，但实现时最好严格按计划里的边界收口，否则很容易又退回到上一轮的问题里：

- `embeddedRoot` 和 `marketplaceRoot` 一定要在 helper 签名里分开，避免调用方误把 local manifest 当成 policy 真值
- `selectEffectiveSkillTriggerRecord()`、`skillTriggerWriteOrder` 和 sibling conflict warning 必须全链路复用同一套排序与比较规则，不能在 replay、uninstall、status、install 各写一套
- `status` 必须守住只读边界：当前 catalog 不是可信 local 时，只能输出 `unknown`，不能为了“算得更准”去触发修复或物化

## 结论

这版计划已经把上一轮最关键的缺口补齐了，和当前仓库基线也对得上。我的判断是：可以按这份计划直接开工，不需要再补新的设计级修订。
