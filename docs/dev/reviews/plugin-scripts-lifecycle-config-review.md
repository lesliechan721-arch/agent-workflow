# `plugin-scripts-lifecycle-config.md` 执行计划复审报告

审查对象：`docs/dev/plans/plugin-scripts-lifecycle-config.md`

审查时间：2026-04-29

## 结论

本轮未发现新的阻塞性问题。上一轮报告里的两个核心问题，已经在计划正文、实现步骤、测试计划和验收标准里收口；以当前仓库基线来看，这份方案已经可以作为后续实现的直接依据。

这次复审重点看的四件事，当前版本都已经对齐：

- 文档内部的 contract 基本自洽，没有再看到会把实现引向两套真值的设计冲突。
- 方案已经正面吸收当前基线限制，而不是假设仓库里存在另一套尚未落地的 runtime 或测试基础设施。
- lifecycle / config / status / `plugin:test` 之间的边界比上一版清楚很多，能在现有 `CommandExecutionContext`、status matrix 和 ledger 模型上继续推进。
- 高风险路径已经进入测试矩阵，尤其是快照真值、helper fail-closed、配置分层写入、build-free 与 staging 分层、`--json` 输出纯度这些容易回滑的点。

## 复查结果

### 1. 已修复：lifecycle 的 bundle root 真值已经收口，快照与当前 marketplace 不再混用

位置：

- `docs/dev/plans/plugin-scripts-lifecycle-config.md:243-249`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:305`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:583-585`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:749-753`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:925`

说明：

计划现在已经把这条合同写死了：

- install / upgrade / historical uninstall 都有各自明确的 manifest 真值来源
- `AW_PLUGIN_ROOT`、`AW_PLUGIN_CONTEXT.plugin.rootDir` 和 resolver 返回的 `bundleRoot` 必须始终相等
- status 与 uninstall 优先信任 ledger 安装快照，不再把 `activeLocalBundle` 或 `~/.aw/plugins/<plugin>` 当成安装时真值

更重要的是，测试也把这条线锁住了，已经不再只是正文里“希望这么做”。

### 2. 已修复：无 `AW_PLUGIN_CONTEXT` 的 helper 已补成严格 fail-closed，并进入测试矩阵

位置：

- `docs/dev/plans/plugin-scripts-lifecycle-config.md:226-227`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:740-744`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:926`

说明：

上一轮最担心的是 helper 在 bundle manifest 缺失、损坏或校验失败时，偷偷回退到 raw store 或 current catalog，最后把敏感值打出来。现在这条风险已经被计划显式收口：

- schema/default/redaction 只能来自当前 bundle 邻近 manifest
- manifest 不可用时必须确定性失败
- stdout、stderr、debug log 和 log file 都不能泄漏 sensitive 值

这次不仅正文补了 fail-closed 合同，`plugin-scripts.test.ts` 里也补上了 manifest 缺失、损坏和校验失败的异常分支。

### 3. 已修复：build-free 与 staging 的测试分层已经回到可落地状态

位置：

- `docs/dev/plans/plugin-scripts-lifecycle-config.md:536-541`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:616-618`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:729-731`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:928`

说明：

当前基线里，普通测试 helper 仍直接走 `bundlePlugins()`，而 `createReadlinePrompt()` 也还没具备这次方案需要的 prompt runtime 合同。新计划没有绕开这些现实限制，而是把它们吸收到分阶段实施里：

- `bundleLocalPlugin()` / `bundlePlugins()` 明确区分 `build-free` 和 `staging`
- `plugin:test` 走已编译的 `dist/scripts/**` 入口，不反向依赖 `tests/helpers/**`
- 普通 unit / integration 继续停留在 build-free 语义，真实 `pnpm install`、manifest build 和 closure 扫描只进 smoke / opt-in

这点很关键。它说明方案不是建立在“仓库已经有 staging test infra”的假设上，而是承认当前基线还没有，并给出了可执行的迁移路径。

### 4. 已修复：配置分层写入、raw-store reset 与卸载保留配置的语义已经闭环

位置：

- `docs/dev/plans/plugin-scripts-lifecycle-config.md:220-222`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:227-228`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:573-576`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:788-800`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:826`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:922-924`

说明：

这版计划把配置相关最容易出错的几条边界都补实了：

- install / upgrade preflight 只补问一次、只写一次，并且按 `updatedKeys` patch 到目标层
- `reset` 在 current catalog 缺失时仍能作为历史清理入口工作
- `get/list` 不会在无 schema 时 raw 打印旧配置
- `aw uninstall` 默认保留 AW config，不再把“卸载插件”和“删除配置”混成一个动作

对应的 fake prompt、`--json`、非交互、非法插件名和残留 store 场景也都已经进入测试计划，没有看到明显漏掉的高风险分支。

### 5. 已修复：status 的健康真值、fallback 顺序和只读约束已经补齐

位置：

- `docs/dev/plans/plugin-scripts-lifecycle-config.md:239-249`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:604-608`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:758-770`
- `docs/dev/plans/plugin-scripts-lifecycle-config.md:927`

说明：

上一轮还有一个隐患，是 status 很容易重新滑回“看当前 marketplace 目录猜状态”。现在这条线已经被明确压回只读矩阵模型：

- `healthSource` 固定为 `installSnapshot | currentCatalog | historical | none`
- config/script health 必须使用同一份 manifest 真值
- `activeLocalBundle` 只能继续作为 runtime evidence / drift 诊断，不能参与 schema/default/lifecycle 选择
- status 读取过程中不能刷新 marketplace、不能创建 config store、不能顺手修复 bundle

从当前 `statusCommand()` 和 discovery/status 基线看，这种接法是能落地的，也符合仓库现有的只读状态面板方向。

## 剩余注意点

下面两点我不把它们算成新的 findings，但实现时最好按顺序盯住：

- `build-free` helper 拆分和 `plugin:test` 的 staging helper 最好同一批落地。现在普通测试 helper 仍直接依赖 `bundlePlugins()`，所以一旦仓库里第一个 `scripts.node` fixture 提前落地，而 helper 还没切到 `scriptBuildMode: "build-free"`，unit / integration 很容易立刻被拖进重路径。这件事计划里已经写到位了，关键是实施顺序别反（`docs/dev/plans/plugin-scripts-lifecycle-config.md:536-538,616-618,729-731`）。
- `plugin-config/` 和安装快照目录的保留逻辑，要跟第一次真实写入 user config / snapshot 一起落地，不能后补。否则 `aw init --force`、stale refresh 或 `config.json` 损坏重建，会先把新增状态删掉，再等后续 patch 去补救（`docs/dev/plans/plugin-scripts-lifecycle-config.md:567-572,834-835`）。

## 总结

这轮复审可以认为已经收口完成。

上一轮指出的设计缺口都已经关闭；本轮也没有再发现新的文档冲突、基线落地阻塞或明显缺失的测试面。只要后续实现严格按计划里的 Phase 0-5 顺序推进，尤其先守住 runtime 合同、测试分层和本地状态保留逻辑，这份执行计划就已经足够支撑进入实现阶段。
