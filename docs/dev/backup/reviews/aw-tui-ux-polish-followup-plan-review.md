# `aw-tui-ux-polish-followup-plan.md` 执行计划复审报告

审查对象：`docs/dev/plans/aw-tui-ux-polish-followup-plan.md`  
对应需求：`docs/dev/specs/aw-tui-ux-polish-followup.md`  
审查时间：2026-05-15  
当前基线：工作区当前状态，静态审查，未运行测试

## 结论

本轮复审未发现新的阻塞问题。上一轮报告里的 4 个问题，这次都已经在计划中补齐或收窄。

## 已确认修复

1. 阶段 4 / 7A / 5 的边界已经拆开。

阶段 4 现在只收口 `status --verbose` 和 `diagnose` 迁移，不再提前承担 `consoleItemsSchemaVersion: 3` 或 SkillTrigger 公共投影；`consoleItemsSchemaVersion: 3` 明确下沉到阶段 7A，SkillTrigger 公共投影放到阶段 5 / 7B 之后接入。见 `docs/dev/plans/aw-tui-ux-polish-followup-plan.md:289-345`、`480-503`。

2. 显式单平台恢复规则已经补上。

阶段 3 现在单独写了 `cleanup` / `uninstall` / `repair` 的显式单平台恢复合同和测试，历史不支持但有现场证据时允许进入恢复流程，没有现场证据时才失败；`reinstall --platform both` 的 fail-fast 规则也保留了。见 `docs/dev/plans/aw-tui-ux-polish-followup-plan.md:234-286`。

3. TUI 平台页候选口径已经写成并集规则。

计划现在明确要求：先确认整组插件有共同可用 scope，再按“任一可选 scope 下仍可能安装”的并集生成平台候选，scope 失效后回到平台页说明原因，不再提前隐藏合法候选。见 `docs/dev/plans/aw-tui-ux-polish-followup-plan.md:242-245`、`782-792`。

4. 双 scope 健康安装的展示回归也补进去了。

阶段 7A 现在明确要求同一平台的 user / project 健康安装都要展示，且不能因为 dual-scope 直接归到 `异常`；对应测试和最终回归里也已经补了同样的断言。见 `docs/dev/plans/aw-tui-ux-polish-followup-plan.md:517-540`、`553`、`866`。

## 其它复核

计划与需求文档整体一致，没有看到明显的需求偏差或遗漏。严格 SemVer、本地 catalog gate、`status` / `diagnose` 合并、SkillTrigger 真值迁移、配置管理页、作者工具同步和最终回归矩阵，方向都对齐 spec。

从当前基线看，这份计划也能落地。命令入口、平台解析、TUI 控制器、配置写入、dependency index 分支和作者工具都有现成挂点，关键测试文件也都已经存在。

测试覆盖面已经足够完整，剩余风险主要是后续实现时别把阶段 4 / 7A / 5 的边界重新打穿。
