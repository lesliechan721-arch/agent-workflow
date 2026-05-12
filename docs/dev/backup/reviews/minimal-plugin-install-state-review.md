# `minimal-plugin-install-state.md` 需求复审报告

审查对象：`docs/dev/specs/minimal-plugin-install-state.md`  
复审时间：2026-05-07

这轮复审后的结论是：

- 上一轮报告提出的问题已经修复，本轮没有再发现新的阻塞级问题。
- 需求方向是合理的，状态边界比上一版清楚很多，尤其是 catalog drift、可认领状态、project shared/local config，以及 shared runtime owner 这几块，现在已经能彼此闭合。
- 方案可以在当前基线上实施，但它本质上仍是一轮 install-state 架构切换，不适合继续围绕 `installed.json`、tracking 和 install snapshot 做增量补丁。
- 这份 spec 现在已经比较适合进入详细设计和任务拆分阶段，重点应放在状态 facade、命令迁移和文档/作者工具同步。

## Findings

本轮未发现新的阻塞问题。

## 已修复项回看

上一轮报告里需要补清的边界，这次都已经写进 spec 了：

1. “可认领”状态下 `aw config --scope project` 的写入合同已经补齐。spec 现在明确区分了两条路径：会触发共享 artifact 刷新的写入必须先失败并要求 `aw repair --adopt-existing`；不会影响共享 artifact 的写入才允许作为预写配置落盘，并在 receipt 里标出 `configRefreshSkippedReason: "adoptExistingRequired"`：`docs/dev/specs/minimal-plugin-install-state.md:760-765`、`917-918`
2. project shared config 的路径型配置边界已经补齐。`file` / `directory` 明确被排除出 project shared config，也不能进入 project-scope repo-visible artifact truth；project shared config 写命令也被要求在写入前直接拒绝这类 key：`docs/dev/specs/minimal-plugin-install-state.md:154-156`、`753`
3. “current catalog 漂移不应把旧静态 artifact 直接判坏”这条核心语义已经写死。现在只有在 current catalog 与 record source 能证明是同一 bundle 时，静态 artifact 差异才会进入 content drift；否则只能投影为 catalog drift / upgrade available：`docs/dev/specs/minimal-plugin-install-state.md:410-412`、`925-927`
4. 普通 `aw repair` 的边界也已经补齐。spec 现在明确禁止在 current catalog 不可用、或 record source 已漂移时，偷偷拿 historical runtime、旧 source 或 shared identity metadata 充当 current catalog：`docs/dev/specs/minimal-plugin-install-state.md:630-634`、`930-931`

这意味着上一轮报告里的核心 finding 已经关闭，不应该再继续沿用旧结论。

## 合理性评估

这版 spec 的整体设计已经比较顺了，主要体现在三点：

1. 安装真值被收敛成 scope 本地 per-plugin install record，而 dynamic diagnostic cache、project artifact shared identity、global dependency index、historical lifecycle runtime 和 shared runtime owner 都被压回了各自单一职责，不再混成一份“大账本”。这和文档前半段定义的九层状态来源是自洽的：`docs/dev/specs/minimal-plugin-install-state.md:99-129`、`239-414`
2. project shared/local config 的语义现在能和“可认领”状态并存。repo-visible artifact truth 只来自 project shared config；user/project local 只进入本机 effective config；config write 也不能绕过认领入口。这比上一版稳定得多：`docs/dev/specs/minimal-plugin-install-state.md:147-168`、`750-783`
3. dependency index 的 fail-closed 策略、shared runtime 的单 owner 合同，以及 marker-only repair / cleanup 的边界，现在都偏保守，但逻辑上是一致的，符合这份 spec 一直强调的“宁可显式提示，也不要静默删错或修错”的方向：`docs/dev/specs/minimal-plugin-install-state.md:421-453`、`66-97`、`475-487`

就目前文本来看，我没有再看到明显互相打架的命令合同，也没有发现需要靠“实现时自行脑补”才能成立的核心状态转换。

## 可落地性评估

我的判断仍然是：这份 spec 能落地，但只能按“架构切换”来做，不能把它当成现有状态层的小修小补。

当前基线里已经有几块可以复用的基础：

- 依赖 planner、图级 preflight、动态 artifact renderer 和 config-triggered refresh 已经存在，说明依赖图和 artifact 写路径并不是从零开始：`docs/architecture.md:96-106`
- Codex native recovery 也已经是独立状态层，和 spec 想保留的 native transaction marker 方向一致：`docs/architecture.md:57-59`、`84-86`

但真正需要替换的基线也很明确：

- 运行时状态现在仍围绕 `installed.json`、tracking 和 install snapshot 组织，和新 spec 的 per-plugin record + 多个极小辅助状态模型不是同一套结构：`docs/architecture.md:78-84`、`108-110`、`packages/cli/src/utils/local-marketplace.ts:407-416`
- CLI 命令面目前还是 `install`、`uninstall`、`upgrade`、`config`、`status` 这一组，新的 `diagnose` / `repair` / `cleanup` / `reinstall` 还没有成为一等入口：`packages/cli/src/index.ts:582-907`
- 配置层现在仍是 `user` / `project` 两层 store，路径解析、写入和读模型都还没有拆成 project shared / project local：`docs/architecture.md:78-80`、`packages/cli/src/utils/plugin-config.ts:135-220`
- `~/.aw` 的 runtime-state preserve allowlist 目前也只覆盖 `plugin-config`、`plugin-install-snapshots` 和 `native-recovery`，还没有吸收 spec 新增的 `dependency-index`、`lifecycle-runtimes`、`shared-runtime-owners`：`packages/cli/src/utils/local-marketplace.ts:407-411`

所以，实现上最合理的路径，仍然是 spec 自己给出的三步走：先落新的 install-state facade 和只读投影，再迁移写命令，最后同步公开文档、测试 fixture 和 `.agents/skills/create-agent-workflows-plugin/` 下的作者参考：`docs/dev/specs/minimal-plugin-install-state.md:977-993`

## 优化建议

本轮没有新的阻塞项，但有几条实现层面的建议值得保留：

1. 在开工前先补一份更窄的 install-state 设计稿，专门把 `InstallRecord`、diagnostic cache、dependency index、shared identity、shared runtime owner、historical lifecycle runtime 这几类 state 的 envelope、路径、读写入口和回滚责任再收一遍。现在 spec 已经足够清楚，但实现会跨很多模块，先定边界能显著减少返工。
2. 测试优先级建议前置到“状态与输出合同”，尤其是可认领状态、project shared/local config 分层、catalog drift、marker-only repair、dependency index fail-closed 和 shared runtime owner 冲突。这些都是行为正确但很容易在重构时回退的地方。
3. 文档和作者工具同步不要放到最后临时补。仓库约定已经明确要求，凡是影响插件作者的 state、config、artifact、scope 或安装语义，都要在同一轮同步 `.agents/skills/create-agent-workflows-plugin/`，否则运行时和作者参考很快会脱节：`docs/dev/specs/minimal-plugin-install-state.md:985-993`

## 结论

这轮复审可以把结论更新为：**上一轮报告的问题已经修复，本轮未发现新的阻塞问题；spec 逻辑上已经成立，也能在当前基线上落地，但必须按 install-state 架构切换推进。**

如果要继续往下走，我会把它视为“可以进入详细设计和任务拆解”的状态，而不是“还需要先补核心需求边界”的状态。
