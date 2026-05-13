# `aw-tui-ux-optimization-plan.md` 执行计划复审报告

审查对象：`docs/dev/plans/aw-tui-ux-optimization-plan.md`  
对应需求：`docs/dev/specs/aw-tui-ux-optimization.md`  
复审时间：2026-05-13

## Findings

本轮未发现新的问题。

## 已确认修复

上版报告指出的几个关键缺口，这一版计划已经补齐，而且都收进了阶段验收或测试矩阵，不再只是方向性表述。

### 1. V2 稳定 reason code 已经被钉成公开合同

Spec 要求把最低公共 reason code 集合写成精确 code id，而不是只写语义类别：`duplicateInstall`、`missingRequiredConfig`、`artifactRefreshFailed`、`recordCorrupted`、`nativeIncomplete`、`adoptableInstall`、`foreignOwnershipConflict`、`residueDetected`、`dependencyBlocked` 是 V2 合同的一部分：`docs/dev/specs/aw-tui-ux-optimization.md:160-170`。

这次计划已经把这组 code id 写进了阶段 1 待办、阶段验收、迁移说明和详细测试里：

- 阶段 1 待办与阶段验收明确列出了这 9 个稳定 code id，并要求 V2 不再混出旧 id：`docs/dev/plans/aw-tui-ux-optimization-plan.md:85-107`
- 阶段 9 迁移说明要求补上旧 reason code 到 V2 reason code 的替换关系：`docs/dev/plans/aw-tui-ux-optimization-plan.md:461-463`
- 详细测试已经要求 `consoleItemsSchemaVersion: 2` 下不再泄露旧 reason code，并验证旧输入语义到 V2 code 的映射：`docs/dev/plans/aw-tui-ux-optimization-plan.md:495-496`、`554-556`

这部分已经从“语义大致覆盖”收紧成了“code id、迁移边界和测试断言都明确”。

### 2. `所有平台` 的按动作收敛规则已经进入计划和测试

Spec 对 `所有平台` 不是泛化要求，而是按动作分别定义候选范围：安装、升级、配置、卸载/重装、修复/重新应用配置、清理各自都有不同收敛规则：`docs/dev/specs/aw-tui-ux-optimization.md:290-309`。

这次计划已经把这些规则写进阶段 5、阶段 7、阶段验收和测试明细：

- 阶段 5 待办与阶段验收已经按动作写明 `所有平台` 候选范围：`docs/dev/plans/aw-tui-ux-optimization-plan.md:273-295`
- 阶段 7 待办和阶段验收再次把按动作收敛规则落到执行编排边界：`docs/dev/plans/aw-tui-ux-optimization-plan.md:364-399`
- `console.test.ts` 明细已经分别覆盖安装、升级/配置/卸载/重装、修复/重新应用配置、清理四类候选范围，还单独约束“未安装且无诊断问题的平台不会进入 cleanup 候选集”：`docs/dev/plans/aw-tui-ux-optimization-plan.md:517-523`

这一块现在已经能防住“先把无效平台混进来，再靠逐平台跳过兜底”的实现偏差。

### 3. `cleanup` 的目标覆盖和执行层 action 边界继续保持完整

上轮报告里另一组问题，这版计划也保持了修复状态：

- `cleanup` 已明确覆盖 `marker-only` 以及 `config-only`、`manifest-only`、`cache-only` 等受控 native residue，并把它们写进阶段待办、阶段验收和测试矩阵：`docs/dev/plans/aw-tui-ux-optimization-plan.md:131-160`、`372`、`398`、`530-531`、`571-572`
- `PluginConsoleExecutableAction` 的边界已经固定下来，不再让 `command[]` 混进执行层 action，且只有 `runCleanup` 能生成 `force: true`：`docs/dev/plans/aw-tui-ux-optimization-plan.md:224-249`、`373`、`397`、`503-505`

## 一致性检查

### 计划与 Spec 一致性

本轮复核后，计划和 Spec 的主线要求已经对齐，没有再看到明显偏差或漏项。

- 首页、详情页、状态/诊断页、导航和渲染的改造路径，对应了 R1-R7：`docs/dev/plans/aw-tui-ux-optimization-plan.md:207-438`
- 四类状态、reason code、shared runtime owner、Console Summary V2 和分层边界，对应了 R8-R12：`docs/dev/plans/aw-tui-ux-optimization-plan.md:68-249`
- 写入前预检、`uninstall`/`cleanup`/`remove-config` 命令合同，以及安装、升级、配置、修复、重装、重新应用配置的 TUI 编排，对应了 R13-R16 和功能要求：`docs/dev/plans/aw-tui-ux-optimization-plan.md:109-206`、`335-402`

没有发现计划里新增了 Spec 之外的行为合同，也没有发现 Spec 明确要求而计划没有承接的非人工验收项。

### 测试覆盖完整性

按用户这轮要求重点复核后，计划里的测试矩阵已经覆盖了主要变更内容，也覆盖了 Spec 验收标准里可自动化的部分。

- 首页和详情页验收，对应到 `console-model.test.ts`、`console.test.ts`、`console-entry.test.ts`：`docs/dev/plans/aw-tui-ux-optimization-plan.md:488-547`、`590-593`
- `status --json.consoleItems` V2、reason code 迁移、顶层 envelope 兼容边界，对应到 `console-model.test.ts`、`cli-entry-json-harness.test.ts`、`public-docs.test.ts`：`docs/dev/plans/aw-tui-ux-optimization-plan.md:488-556`、`469-480`
- `cleanup --plan` / `--force` / `--remove-config`、外部归属冲突、依赖阻断、receipt 同构计划，对应到 `cleanup-command.test.ts`、`command-receipt.test.ts`、`options-normalization` / CLI 入口测试：`docs/dev/plans/aw-tui-ux-optimization-plan.md:141-160`、`567-588`
- TUI 直接执行、`所有平台` 展开、skill trigger、config write group、重复安装处理、失败后诊断入口，对应到 `console.test.ts`、`console-wizard.test.ts`、`plugin-dependency-planner.test.ts`：`docs/dev/plans/aw-tui-ux-optimization-plan.md:512-560`
- 快捷键、输入页例外、页面重绘和默认页不泄露长诊断信息，对应到 `runtime.test.ts`、`console.test.ts`、`console-entry.test.ts`：`docs/dev/plans/aw-tui-ux-optimization-plan.md:605-613`

剩下更偏视觉和交互感受的内容，例如颜色辅助、列表滚动体验、页面观感压缩度，确实更适合手工验收；计划也已经在最终回归里把这类联调留出来了：`docs/dev/plans/aw-tui-ux-optimization-plan.md:475-482`。

### 当前基线可实施性

这份计划在当前仓库基线上可以落地，没有发现“计划要求的能力在现有代码结构上无处安放”的阻塞。

- 当前 console controller 仍是“首页插件 -> 位置 -> 动作”的旧流程，正好对应计划要重构的切入点：`packages/cli/src/commands/console.ts:910-1013`
- 当前 prompt / console driver 已经抽出了 `CliConsoleDriver` 和统一 render 入口，只是默认实现仍是追加输出，适合按计划替换为页面式刷新：`packages/cli/src/commands/runtime.ts:217-238`
- 当前 `cleanup` 已经有独立命令入口和单目标约束，适合作为 `--plan` / `--force` / `--remove-config` 合同扩展的承载点：`packages/cli/src/commands/cleanup.ts:61-66`、`97-139`
- 当前 `uninstall` 仍显式保留 `force` 选项，说明计划里“移除 `uninstall --force` 并收口到 cleanup”的改造范围是明确且可定位的：`packages/cli/src/commands/uninstall.ts:98-104`
- 对应的测试基础设施和主要测试文件都已存在，包括 `fake-console`、`runtime.test.ts`、`console.test.ts`、`console-model.test.ts`、`cleanup-command.test.ts`、`cli-entry-json-harness.test.ts`，新增用例主要是在现有骨架上扩展，而不是从零搭建：`packages/cli/tests/helpers/fake-console.ts:1-83`

## 结论

这版执行计划已经可以继续推进。

上轮 review 提出的关键问题都已经修复到位，而且不是只补了文案，阶段待办、阶段验收、迁移说明和测试明细都同步收口了。按本轮复核结果看，计划内容和 Spec 基本一致，测试矩阵覆盖了主要变更和可自动化验收项，文档本身也保持自洽，能够在当前代码基线上实施。
