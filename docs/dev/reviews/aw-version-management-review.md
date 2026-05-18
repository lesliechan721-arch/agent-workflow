# `aw-version-management.md` 需求评审报告

审查日期：2026-05-15  
审查对象：[`docs/dev/specs/aw-version-management.md`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md)  
审查范围：上一轮问题修复情况、需求合理性、当前基线可落地性、关联流程完整性、验收标准覆盖度、可选更优方案

## Findings

本轮未发现新的阻断级或中高优先级需求问题。上一轮报告里真正影响需求收口的几个缺口，这一版已经在正文和验收里补齐，当前 spec 已经能作为实现输入继续推进。

## 已修复项确认

- catalog 历史记录与 cache fallback 的关系已经收紧成自洽规则。spec 现在明确：`awVersionTooLow` 是历史记录给出的终止结论，不能再被本地 cache 推翻；cache fallback 只允许发生在“已经解析出可用 catalog identity 之后”的远程失败场景，见 [`aw-version-management.md:237`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:237)、[`aw-version-management.md:370`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:370)、[`aw-version-management.md:391`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:391)-[`aw-version-management.md:396`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:396)、[`aw-version-management.md:887`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:887)、[`aw-version-management.md:915`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:915)。
- selected current catalog 如何落到 native runtime 的本地视图，现在也不再缺合同。spec 已把 `catalog cache` 和 `active local marketplace/runtime view` 显式拆开，并要求 user-scope native 安装、升级、重装和 native repair 在原生调用前先 materialize 并校验 active view，见 [`aw-version-management.md:175`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:175)-[`aw-version-management.md:186`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:186)、[`aw-version-management.md:378`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:378)、[`aw-version-management.md:405`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:405)、[`aw-version-management.md:919`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:919)。
- `reinstall` 的历史副作用撤销边界已经写死。spec 现在明确要求它继承 `uninstall` 的 fail-closed 安全边界，historical runtime 不可信时必须在新安装前失败，不能把 historical runtime 当成 current catalog 替身，也不能强行覆盖，见 [`aw-version-management.md:397`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:397)-[`aw-version-management.md:398`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:398)、[`aw-version-management.md:414`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:414)、[`aw-version-management.md:718`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:718)-[`aw-version-management.md:724`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:724)、[`aw-version-management.md:907`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:907)。
- `aw init` 的新语义也已经从“同步 embedded bundle”收紧成“预热远程 catalog/cache”，并且把 `awVersionTooLow`、`catalogHistoryUnavailable`、`catalogUnavailable` 的边界写进正文和验收，见 [`aw-version-management.md:706`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:706)-[`aw-version-management.md:712`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:712)、[`aw-version-management.md:906`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:906)。
- 验收标准已经覆盖了上一轮缺失的关键边界，不只是原则描述。current catalog 消费矩阵、active view、historical runtime、config schema source、文档/作者工具同步都进入了验收，见 [`aw-version-management.md:907`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:907)-[`aw-version-management.md:920`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:920)。

## 其余判断

### 需求合理性

这版 spec 的主方案是合理的。它把 CLI version、catalog version、catalog 最低 CLI 版本、插件 version、插件最低 CLI 版本、依赖最低版本、catalog 历史版本记录、catalog cache、active local marketplace 和 historical runtime 的职责边界都拆清楚了，而且几处最容易互相打架的规则现在也已经对齐：

- latest 不兼容时先查 sidecar 历史记录，再决定是否可回退历史兼容 catalog，而不是混用 npm metadata 或 cache 猜测，见 [`aw-version-management.md:237`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:237)。
- native runtime 消费的是本次 selector 对应的 active view，不是任意 cache entry，见 [`aw-version-management.md:182`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:182)-[`aw-version-management.md:184`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:184)。
- `uninstall` / `repair` / `reinstall` 在 current catalog unavailable 时的边界已经拆开，不再混成一条模糊规则，见 [`aw-version-management.md:714`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:714)-[`aw-version-management.md:724`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:724)。

如果只从“实现最省事”看，单独维护一个 npm sidecar 包确实比“继续把 manifest 塞进 CLI 包”更重；但在当前约束下，它换来的是两件真正必要的能力：先做轻量兼容性判断，再避免为读 manifest 下载完整 artifact tarball。我认为这个 tradeoff 是成立的。

### 当前基线可落地性

这份需求在当前仓库基线上可以落地，但仍然是一次中到大规模改造，不是小修小补。

现状里，CLI 仍然把 `plugins-dist/` 作为正式发布内容，`resolveCurrentCatalog()` 也还是围绕 embedded bundle 与 `~/.aw` 本地镜像做选择，见 [`packages/cli/package.json:8`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/packages/cli/package.json:8)-[`packages/cli/package.json:10`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/packages/cli/package.json:10)、[`plugin-catalog.ts:25`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/packages/cli/src/utils/plugin-catalog.ts:25)-[`plugin-catalog.ts:60`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/packages/cli/src/utils/plugin-catalog.ts:60)。架构文档当前也仍是“三层分发 + embedded runtime bundle”模型，见 [`docs/architecture.md:43`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/architecture.md:43)-[`docs/architecture.md:59`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/architecture.md:59)。

但基线并不是完全没有承接点。仓库已经有：

- `~/.aw` 作为 canonical user-scope marketplace/runtime 边界，Claude/Codex user scope 都围绕它工作，见 [`docs/architecture.md:59`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/architecture.md:59)、[`docs/architecture.md:87`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/architecture.md:87)-[`docs/architecture.md:88`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/architecture.md:88)。
- historical runtime / snapshot 这套证据链已经存在，并且配置刷新、卸载、repair/reinstall 已经在使用它，见 [`docs/architecture.md:62`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/architecture.md:62)、[`docs/plugin-installation.md:189`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/plugin-installation.md:189)、[`docs/plugin-installation.md:349`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/plugin-installation.md:349)。

所以我的判断是：需求可以落地，但实现时必须把 catalog 解析/cache、active view materialize、发布脚本、作者工具和公开文档一起改，不能只改某一个点。

### 完备性与验收匹配

和上一轮相比，这版 spec 已经足够完整，主要流程没有明显缺页：

- current catalog 的解析、缓存、显式 selector、历史兼容回退、cache fallback、active view、historical runtime、legacy 合同都已经写进正文。
- `install`、`upgrade`、`status`、`config`、`diagnose`、`cleanup`、`uninstall`、`repair`、`reinstall`、发现页和 TUI 的 current catalog 边界已经有统一矩阵，而不是分散在几段说明里，见 [`aw-version-management.md:385`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:385)-[`aw-version-management.md:414`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:414)。
- 验收标准已经和正文同向，没有再出现“正文这么说，验收却要求另一条路径”的明显冲突，尤其是 `awVersionTooLow`、`catalogHistoryUnavailable`、cache fallback、active view 和 `reinstall` 安全边界，见 [`aw-version-management.md:887`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:887)-[`aw-version-management.md:920`](/Users/LeslieChan/.codex/worktrees/f091/agent-workflows/docs/dev/specs/aw-version-management.md:920)。

### 更优方案判断

在当前“官方分发仍以 npm registry 为唯一来源”的约束下，我没有看到明显更优、同时又更简单的需求方案。现在这个“sidecar manifest package + full artifact package”的设计，复杂度比单包方案高，但它正好解决了当前最关键的两个矛盾：

- 先判断 catalog/CLI 兼容性，再决定是否下载完整 artifact。
- 不再让插件更新强绑定 CLI 发版。

如果未来愿意引入新的分发基础设施，一个独立的只读 manifest 服务或静态 JSON 源，理论上还能把 sidecar package 这层再简化一些；但那已经超出本期“仍以 npm registry 为官方来源”的边界了。就本期范围来说，我更建议把“更优方案”放在实现拆分上，而不是再改需求方向：

1. 先落 catalog 解析、历史回退和 cache selector 隔离。
2. 再落 active local marketplace/runtime view 与 native adapter 对接。
3. 最后改发布脚本、tarball smoke、作者工具和公开文档。

## 总评

上一轮 report 里最关键的缺口，这一版已经基本都补齐了。当前 spec 在合理性、可落地性、关联流程完整性和验收闭环上都已经达到可以开工实现的水平。

需要提醒的只剩实现风险，而不是需求缺口：这会是一轮横跨 catalog 解析、缓存模型、native runtime materialize、release pipeline、作者工具和文档的联动改造。只要实现按主链路分阶段推进，这份 spec 本身已经足够稳。
