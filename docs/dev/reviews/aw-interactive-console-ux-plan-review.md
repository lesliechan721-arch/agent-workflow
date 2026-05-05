# `aw` 交互控制台与安装输出重设计执行计划评审报告

审查对象：`docs/dev/plans/aw-interactive-console-ux-plan.md`
对照规格：`docs/dev/specs/aw-interactive-console-ux.md`
审查时间：2026-05-05
复审结论：本次复审未发现新的阻断性或重要问题。上一版报告里提出的两处缺口已经补进计划；当前计划和 spec 已经对齐，没有再看到明显的偏差、遗漏或额外扩 scope 的情况。阶段顺序、当前基线承接方式和测试分层也都说得通，可以继续进入实现。

## Findings

本次复审未发现需要阻断执行的新增问题。

## 已修复项复核

上一版报告里的两处问题已经补齐，而且补得比较完整，不只是加了一句描述：

- `removedKeys` / 显式清空已有配置值 / `artifactRefresh.triggerKeys` 对齐，已经写进交付目标、共享 helper 设计、阶段任务、单测矩阵、集成测试和最终验收，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:55-63`、`203-205`、`388-390`、`444`、`525-531`、`562-563`、`597`、`649`、`666`
- `PluginConsoleItem.actions` 的安全边界，已经从“多位置不要隐式批量写”补成“所有立即写状态动作都只能来自 `locations[].actions[]`”，并且有对应单测和最终验收约束，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:344-347`、`511-515`、`669`

## Spec 对齐情况

这版计划和 spec 的主线已经一致，之前最容易走偏的几块现在都对上了：

- `aw` 主命令作为唯一交互入口，子命令去 prompt，非 TTY 直接失败并提示 `--json`，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:13-18`、`24-29`、`280-297`、`436-452`
- 六类首屏状态、友好原因码、session visibility / project trust 映射、保守升级判定和 current catalog 缺失分支，都进入统一投影层和测试矩阵，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:31-36`、`89-134`、`324-349`、`498-517`
- 配置向导、共享 config helper、refresh-only 动作、manifest-optional `config reset --yes` 清理分支，以及“只 patch 一次、refresh 一次”的提交语义都已落进计划，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:55-63`、`193-218`、`378-397`、`522-540`
- JSON receipt、默认输出降噪、`status --json` 兼容字段和失败通道边界已经成体系，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:47-53`、`220-278`、`351-376`、`590-609`
- 文档和插件作者工具同步仍然在覆盖范围内，没有漏掉 `.agents/skills/create-agent-workflows-plugin/`，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:67-76`、`454-473`

我这轮没有再看到 spec 明确要求、但计划里没接住的功能点；也没看到计划擅自新增一块和 spec 无关的实现范围。

## 可落地性判断

计划仍然能在当前基线上落地，原因比较直接：

- 现有 runtime 已经有可注入 prompt / reporter / diagnostics 的执行上下文，TUI 控制器和 fake prompt 测试都能沿这条扩，见 `packages/cli/src/commands/runtime.ts:148-163`
- 当前 config store patch 已经支持 `removeKeys`，并返回 `updatedKeys` / `removedKeys`，共享 helper 的演进路径是顺的，见 `packages/cli/src/utils/plugin-config.ts:189-219`
- 旧交互入口、`config configure` 和 receipt 输出边界都集中在 CLI 入口层，拆除和改造范围比较清晰，见 `packages/cli/src/index.ts:733-1098`
- 推荐顺序保持了“先投影和输出合同，再 config helper，再去掉子命令交互，最后接 TUI”的依赖关系，能避免最危险的半成品阶段，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:631-639`

剩下需要重点盯住的，更多是实施阶段的检查项，不是计划缺陷本身：

- 阶段 0 的 `@inquirer/prompts` registry 可安装性验证
- JSON receipt 字段名冻结
- 阶段 9 的 build / smoke / 真实 TTY 验证

这些风险点计划里都已经有承接，没有再看到“计划写得通，但现有代码接不住”的地方。

## 单元测试覆盖判断

如果按“纯逻辑层面的变更有没有被单测锁住”来判断，这版计划已经补齐了关键缺口：

- 友好投影层：六类状态、全部原因码、跨位置汇总、优先级、保守升级判定、session visibility 映射、action contract、禁词文案，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:498-517`
- 安装/升级预检模型：失败前不写状态、mixed target 只弹一次 required config，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:518-521`
- 配置向导和共享 helper：默认写入位置、sensitive 占位、显式清空已有值、`updatedKeys` / `removedKeys` / `artifactRefresh.triggerKeys` 对齐、只 patch 一次 / refresh 一次、raw-store reset 安全校验，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:522-535`
- refresh-only helper：失败 artifact `refreshKeys`、tracked refresh keys 回退、成功/失败写回 tracking 诊断、skipped 分支，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:536-540`
- 输出层：默认 renderer 禁词和 warning 分类，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:541-542`

剩下那些天然依赖 CLI 编排、stdout/stderr 边界、TTY/非 TTY 环境和 commander 解析的合同，计划放在 Integration / JSON / Smoke 层去测更合适，也已经有对应条目，见 `docs/dev/plans/aw-interactive-console-ux-plan.md:544-609`、`623-630`。所以从测试设计上看，现在不是“单测不够”，而是“单测锁纯逻辑，集成和 smoke 锁终端行为”，这层分工是合理的。

## 结论

这次复审可以收敛为一个明确结论：上一版报告提到的问题已经修复，本次没有发现新的计划问题。计划内容和 spec 一致，内部顺序自洽，能够承接当前基线；单元测试矩阵对核心逻辑也已经补齐，剩余终端和命令编排合同由集成测试、JSON 通道测试和 smoke 测试兜底，安排合理。
