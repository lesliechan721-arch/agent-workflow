# `project-init.md` 复查报告

审查对象：`docs/dev/plans/project-init.md`

审查时间：2026-04-22

## 结论

本轮复查未发现新的高严重度、中严重度或低严重度问题。上一轮指出的 5 个问题都已经在计划正文里收口，当前版本可以直接支撑 Phase 1-5 进入实现。

当前文档里的架构边界、状态模型、CLI 目标解析和测试口径已经基本对齐，没有再看到会阻塞实现的设计冲突。

## 复查结果

### 1. 已修复：共享入口已经从 `/commit` 收敛为“手动触发 skill”

位置：

- `docs/dev/plans/project-init.md:115`
- `docs/dev/plans/project-init.md:127`
- `docs/dev/plans/project-init.md:134`
- `docs/dev/plans/project-init.md:255`
- `docs/dev/plans/project-init.md:287`

说明：

Phase 2 已经把 `git-commit` 插件重新定义成“手动触发的提交工作流 skill”，不再把 `/commit` 当成双端统一协议；设计决策也明确写了，跨端共享层只承载 skill 语义，命令别名或 UI 入口只能留在平台适配层。Phase 5.4 的验收口径也改成了“功能等价，不要求命令名一致”。

这和现有调研结论一致，之前那条最关键的入口契约问题已经关闭。

### 2. 已修复：Claude marketplace 的物化流程和状态来源已经补齐

位置：

- `docs/dev/plans/project-init.md:185`
- `docs/dev/plans/project-init.md:187`
- `docs/dev/plans/project-init.md:189`
- `docs/dev/plans/project-init.md:221`
- `docs/dev/plans/project-init.md:313`
- `docs/dev/plans/project-init.md:323`
- `docs/dev/plans/project-init.md:346`

说明：

Claude 适配器现在明确要求：

- 注册 marketplace source 时同时完成 `extraKnownMarketplaces`、`known_marketplaces.json` 和 marketplace cache 的物化
- `install` / `upgrade` / `status` 以 Claude 原生 marketplace / plugin 状态为准
- CLI 不再额外维护第二套 Claude marketplace mirror

同时，状态模型和升级策略也补上了事实来源、刷新顺序和 drift 告警。之前“只写 settings、不定义 materialization”的问题已经不存在。

### 3. 已修复：Codex 的指令规则和审批规则已经拆开，`execpolicy` 落点说明一致

位置：

- `docs/dev/plans/project-init.md:199`
- `docs/dev/plans/project-init.md:204`
- `docs/dev/plans/project-init.md:207`
- `docs/dev/plans/project-init.md:295`
- `docs/dev/plans/project-init.md:303`
- `docs/dev/plans/project-init.md:358`

说明：

计划现在已经把规则系统拆成两块：

- 指令规则：`generators/instructions.ts`，输出到 Codex `AGENTS.md` / Claude `.claude/rules/*.md`
- 审批规则：`generators/permissions.ts`，Codex 侧明确映射为 `execpolicy`，落盘为 config layer 下的 `.rules` 文件

文档前面的架构图、Phase 3、路径映射和测试策略现在说的是同一件事，不再互相打架。上一轮这里的高严重度问题可以关闭。

### 4. 已修复：`install` / `upgrade` / `status` 的状态归属已经定义清楚

位置：

- `docs/dev/plans/project-init.md:183`
- `docs/dev/plans/project-init.md:218`
- `docs/dev/plans/project-init.md:225`
- `docs/dev/plans/project-init.md:323`
- `docs/dev/plans/project-init.md:336`
- `docs/dev/plans/project-init.md:350`

说明：

这版计划已经补出单独的“状态模型与所有权”一节，明确了：

- marketplace source 注册看平台原生状态
- 插件安装状态优先读平台原生已安装/可用状态
- `.agent-workflows-manifest.json` 只记录 CLI 生成的扩展产物
- `status` 的展示顺序和 drift 告警逻辑
- `upgrade` 的刷新基准来自平台原生 revision / version，而不是 CLI 自己维护第二份副本

这已经足够支撑 adapter、命令层和测试层按同一套状态模型往下实现。

### 5. 已修复：`--platform auto` 在 `both` 环境下的默认策略已经写死

位置：

- `docs/dev/plans/project-init.md:219`
- `docs/dev/plans/project-init.md:222`
- `docs/dev/plans/project-init.md:223`
- `docs/dev/plans/project-init.md:224`
- `docs/dev/plans/project-init.md:225`
- `docs/dev/plans/project-init.md:226`
- `docs/dev/plans/project-init.md:227`
- `docs/dev/plans/project-init.md:228`
- `docs/dev/plans/project-init.md:229`
- `docs/dev/plans/project-init.md:230`
- `docs/dev/plans/project-init.md:321`
- `docs/dev/plans/project-init.md:323`
- `docs/dev/plans/project-init.md:326`
- `docs/dev/plans/project-init.md:330`
- `docs/dev/plans/project-init.md:333`

说明：

计划现在已经明确：

- 四个命令统一支持 `--platform codex|claude|both|auto`
- `both` 代表用户显式要求双端同时执行；单平台环境下直接报错，不静默降级
- `status --platform auto` 在 `both` 环境下同时读取两端状态
- `install` / `uninstall` / `upgrade` 在 `both` 环境下会先看初始化状态：只有一个平台已初始化时自动选中该平台；两端都已初始化或两端都未初始化时直接失败，并要求用户显式传 `--platform`
- “已初始化”的判定标准也补出来了，覆盖平台原生 marketplace / plugin 状态和 CLI 生成产物状态

上一轮留下的默认行为歧义已经关闭。

## 总结

上一轮 review 提出的 5 个问题都已经修复，当前计划已经从“需要先收口设计”进入“可以开始实现”的状态。

如果后续实现阶段严格按 Phase 4-5 的测试与手工验证口径推进，这份计划已经足够作为落地依据。
