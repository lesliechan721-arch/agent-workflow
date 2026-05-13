# `aw` TUI 使用体验优化需求 Spec

日期：2026-05-12
状态：需求确认稿
执行计划：`docs/dev/plans/aw-tui-ux-optimization-plan.md`
文档规范：`docs/dev/spec-plan-writing-guide.md`

## 文档定位

这份 Spec 定义需求范围、现状探查结论、用户体验边界、公开合同边界和验收标准。它回答“为什么要做、现状约束是什么、要做到什么程度、哪些行为算正确、哪些行为明确不做”。

现状探查属于 Spec，因为它发生在计划之前，是需求边界和技术决策的依据。执行顺序、批次拆分、测试用例和迁移收口放在执行计划文档中维护。

## 背景

当前裸 `aw` 会进入交互控制台，但体验仍偏向“状态矩阵浏览器”，不是面向用户任务的插件管理器。用户打开 TUI 后会先看到平台、位置、诊断和内部状态，难以直接完成安装、升级、配置、卸载或修复。更关键的是，未安装插件不会出现在首页，用户无法在 TUI 中发现并安装 current catalog 里的新插件。

本轮目标是把 TUI 调整为以任务为中心的插件控制台：先选插件，再选功能，必要时才选择平台和安装位置。默认页面只展示简单、可行动的信息；详细诊断只在用户主动进入“状态”或“诊断”功能后出现。

## 现状探查结论

这一节记录需求形成前的代码与行为探查结论。它不是执行计划，但会约束本轮需求边界和验收标准。具体改动批次、测试文件和实施顺序见执行计划。

### 入口与渲染

- `packages/cli/src/index.ts` 中，裸 `aw` 会进入 `runConsoleController()`；非 TTY 或 CI 会输出不可交互提示。
- `packages/cli/src/commands/runtime.ts` 默认 prompt 已接入 `@inquirer/prompts`，支持方向键选择、确认、输入和密码输入。
- 当前 `CliConsoleDriver` 的默认实现只是向 stderr 追加：

  ```text
  == <title> ==
  ...
  ```

  所以状态信息、结果信息和下一次操作页会连续堆叠，形成“状态信息一直叠加”的体验。

- 当前 prompt 没有统一的 `back` / `exit` 结果语义。部分页面通过显式 `返回`、`退出` 选项实现导航，但没有全局 `b` / `q` / `Esc` 快捷键。

### 首页数据来源

- `packages/cli/src/commands/console.ts` 的首页通过 `statusCommand([], { cwd })` 加载 `consoleItems`。
- `statusCommand()` 走 `collectP7Locations()`，再走 `buildCommandCandidates({ command: 'status' })`。
- `packages/cli/src/commands/discovery.ts` 对 `status` 有过滤逻辑：当没有显式插件名时，如果某个 current catalog 插件没有安装证据、运行时证据或读取错误，就会被过滤掉。
- 结果是：TUI 首页看不到纯 current catalog 的未安装插件。用户无法通过 TUI 发现和安装这类插件。

### 页面结构

- 当前控制流是：

  ```text
  首页插件列表 -> 插件详情 -> 位置列表 -> 位置动作列表
  ```

- `browseItem()` 在插件有多个 `locations` 时，会马上让用户选择 `Codex（个人）`、`Codex（当前项目）`、`Claude Code（个人）` 等位置。
- 这和用户习惯不匹配。用户通常先想做“安装、升级、配置、卸载、查看状态”等功能，而不是先理解所有安装目的地。

### 功能覆盖

- `console-model.ts` 已经能生成不少动作：`openInstallWizard`、`openConfigWizard`、`runUpgrade`、`runUninstall`、`repairInstall`、`cleanupRecovery`、`reapplyConfigRefresh`、`diagnoseCommand`。
- 但有些看起来像动作的菜单项实际只是 `diagnoseCommand`，例如：
  - `认领现有安装` 只展示 `aw repair ... --adopt-existing`
  - `接管共享触发策略` 只展示 `aw repair ... --takeover-shared-runtime`
  - 部分 `清理残留` 只展示 `aw cleanup ...`
- `repairCommand`、`cleanupCommand`、`reinstallCommand` 已经存在，CLI 入口也支持，但 TUI 没有完整调用这些能力。
- CLI 入口已经暴露 `repair --takeover-shared-runtime`，`RawRepairCommandOptions` / `RepairCommandOptions`、normalize 逻辑和 shared runtime owner preflight 也已经能传递 `takeoverSharedRuntime`。实现 TUI 直连 `接管共享触发策略` 前，仍必须复核 repair pipeline 并补回归测试，避免未来出现 CLI/TUI 看起来支持 takeover、实际执行层忽略该语义的断层。

### 卸载与清理基线

- 当前 `uninstall` 和 `cleanup` 都有 `--force`，但含义不一致：`uninstall --force` 只处理共享 runtime 无法安全重放时是否继续；`cleanup --force` 主要用于共享配置损坏时备份后删除 AW-owned 区块，或缺少安全重放来源时只清 owner。
- 当前 `cleanup` CLI 已有 `--yes`，但只在 `cleanup --dependency-index --prune-stale` 路径消费；本轮 direct `cleanup --force` 不复用 `--yes` 做二次确认，`--force` 自身就是高风险确认合同。
- 当前 `cleanup` CLI 没有 `--plan`、`--dry-run` 或其它无写入预览入口；`diagnose` 也只会提示 `aw cleanup ... --force`，不会先产出同一套删除计划。
- 当前代码已经把 `uninstall` 和 `cleanup` 分成两条路径：`uninstall` 偏健康安装的正常卸载，`cleanup` 偏 AW 能证明归属的残留和半完成状态。`cleanup` 目前会拒绝健康安装和可认领状态。
- 当前 `cleanup` 已有部分 best-effort 能力，例如 dependency index 不可信时仍可清理已知残留，事务回滚或 finalize 失败会降级为 warning；但它不是“诊断有问题就一定能恢复”的统一入口。
- 当前诊断里存在“发现异常但没有 cleanup 评估入口”的状态，例如仍有 verified dependents、Codex cache-only residue 缺少 ownership proof、外部归属冲突或可认领状态。本轮需要把这些状态映射到统一的 `cleanup` 评估入口；如果评估后无法安全自动恢复，命令必须明确失败并给出人工处理建议，而不是让 TUI 自行解释。
- 当前删除 AW 自管配置只能通过 `aw config reset` 完成。`uninstall` / `cleanup` 没有附带配置删除选项；文档也明确普通卸载默认保留配置。

### 缺省能力被误报为注意事项

当前状态输出会把合法的能力缺省暴露成“注意”。典型例子：

```text
注意：Codex / codex-explore / 当前用户：Lifecycle install snapshot for codex-explore is unusable; falling back to current catalog. snapshot manifest does not declare "install" lifecycle script
```

排查结果：

- `packages/cli/src/commands/status.ts` 的 `resolveStatusHealthManifest()` 会尝试读取 install snapshot，失败后把错误加入 `healthWarnings`。
- `packages/cli/src/utils/plugin-scripts.ts` 的 `resolveLifecycleScriptTarget()` 在 snapshot 不声明指定 lifecycle event 时，会生成 `falling back to current catalog` warning。
- “snapshot manifest does not declare install lifecycle script” 只说明该插件没有声明 `install` lifecycle。对没有 lifecycle 的插件来说，这是合法状态，不代表安装不完整，也不需要用户处理。
- 类似地，`config=no-schema`、`scripts=not_declared`、某类 artifact 不存在、未选择的 scope 没有安装，都不应该在默认 TUI 或普通状态摘要中成为问题。

需要调整为：

- 只有“插件声明了某项能力，但当前安装需要它且它失败/缺失/漂移”才显示问题。
- 没声明的能力默认静默省略；如果进入诊断页，可以显示为“未声明”这种中性事实，但不能进入 `注意`、`异常`、`下一步`。
- lifecycle snapshot fallback 只有在真正影响必须执行的 lifecycle 时才进入诊断；普通 status/TUI 不展示“未声明 lifecycle”警告。

### 友好状态投影

- `console-model.ts` 已经有一层友好状态投影，包含：
  - `未安装`
  - `已安装`
  - `可升级`
  - `异常`
- 也已经有测试约束，不应在友好文案里暴露 `ledger`、`tracking`、`repo-managed`、`scope` 等内部词。
- 不再显示 `由其它来源管理`。插件不能被另一个来源正常管理；如果出现记录不完整、文件缺失、运行时归属冲突或可认领状态，应统一投影为 `异常`，并在详情或诊断里解释具体原因。
- 这层投影可以继续复用，但需要补充首页的 catalog-only 插件、平台徽标和更完整的直接动作。

## 目标

1. 裸 `aw` 首页展示所有可管理插件，包括 current catalog 中尚未安装的插件。
2. 首页用状态图标、状态文案、平台短标签和主动作表达插件状态，避免默认展示诊断矩阵。
3. 插件详情页先展示状态摘要和功能菜单，不先展示平台与安装位置列表。
4. 平台、scope、项目位置只在执行具体功能时选择。
5. 同一插件在同一平台、同一当前项目上下文内只能有一个正常生效安装位置。
6. 多平台普通动作支持 `所有平台`，但高风险 takeover 类动作必须保持单目标确认和执行。
7. TUI 中的普通功能必须能直接执行，不能只展示命令让用户退出后复制。
8. 默认页面只展示真实问题；未声明、未配置或不存在的可选能力不算问题。
9. 删除类命令边界清晰：`uninstall` 只处理正常卸载，`cleanup` 作为统一恢复评估和清理入口。
10. `status --json.consoleItems` 的结构变化按版本化 breaking change 处理。

## 范围

### 本轮范围

- 重构 TUI 首页、插件详情页、目标选择页、状态页和诊断页的信息架构。
- 建立四类用户可见状态：`未安装`、`已安装`、`可升级`、`异常`。
- 让 TUI 首页合并 current catalog 插件和已发现安装状态，显示 catalog-only 未安装插件。
- 调整 `status --json.consoleItems` 为 V2 summary 合同，并提供可机器检测的 schema version。
- 明确 `PluginConsoleSummary`、功能菜单 summary、执行层 action 和 TUI page model 的分层边界。
- 调整 `uninstall`、`cleanup`、`cleanup --plan`、`--force`、`--remove-config` 的行为合同。
- 补齐 TUI 直接执行能力，包括安装、升级、配置、卸载、修复、清理、重装、认领、接管共享触发策略、重新应用配置和重复安装处理。
- 支持菜单页和选择页的全局导航快捷键：`b` 返回、`q` 退出、`Esc` 返回或首页退出、`Ctrl+C` 安全退出。
- 把控制台渲染从追加式输出改成页面式刷新，避免历史状态持续堆叠。

### 非目标

- 不把 TUI 做成完整的全局维护后台。`aw init`、`repair --dependency-index`、`cleanup --dependency-index --prune-stale` 不进入默认插件功能菜单。
- 不在本轮改变 install record、dependency index、dynamic artifact cache 或插件 manifest 的磁盘格式。
- 不让 TUI 默认显示完整诊断矩阵。完整细节继续由 `aw diagnose`、`aw status --verbose`、`--json` 和 debug log 承担。
- 不把 `status --json.consoleItems` 扩展成插件市场或 catalog 列表 API。
- 不设计跨插件批量安装、批量卸载或批量升级。`所有平台` 只作用于当前插件。
- 不把“未声明 lifecycle / 未声明 config schema / 未声明 artifact target”视为错误。
- 不让 `cleanup --force` 成为静默忽略风险的开关。高风险删除必须有计划、范围和确认边界。

## 状态与术语

用户可见状态只保留四类：

```ts
type PluginConsoleStatus =
  | 'notInstalled'
  | 'installed'
  | 'upgradeAvailable'
  | 'abnormal';
```

展示文案分别是 `未安装`、`已安装`、`可升级`、`异常`。内部仍可保留更细状态，但进入首页、详情页和 `status --json.consoleItems` 的友好字段前必须映射到这四类。

稳定 reason code 至少需要覆盖：

- `duplicateInstall`：同一插件同一平台在 user 与当前 project 同时健康安装。
- `missingRequiredConfig`：已安装插件缺少必填配置或配置无效。
- `artifactRefreshFailed`：声明并写入过的 artifact 缺失、漂移或刷新失败。
- `recordCorrupted`：AW-owned install record 损坏或互相矛盾。
- `nativeIncomplete`：平台 native 状态不完整。
- `adoptableInstall`：存在可认领安装。
- `foreignOwnershipConflict`：存在外部归属冲突。
- `residueDetected`：存在可定位残留。
- `dependencyBlocked`：依赖关系阻止删除或清理。

## 已确认决策

- 首页是插件列表，不是状态矩阵。
- 插件详情页第一层是功能菜单，不是位置列表。
- 写入、删除、清理、接管和重装动作必须先选定明确 target，再进入执行层。
- `所有平台` 是 TUI 编排概念，命令层只能收到展开后的明确 target。
- `接管共享触发策略` 是单目标高风险动作，不允许批量执行。
- 纯展示字段，例如图标、颜色、badge、主按钮文案、目标 label 和排序，不进入公开 JSON schema。
- `status --json.consoleItems` V2 和 TUI 模型改造在同一轮收口，不拆成先 TUI 私有、后公开 JSON 迁移。
- `aw uninstall` 移除 `--force`，异常恢复统一走 `aw cleanup`。
- `aw cleanup --force` 本身就是 direct CLI 的高风险执行确认，不再额外要求 `--yes` 或 plan token；TUI 仍必须在生成 `force: true` 前展示单独确认。

## 用户体验需求

### 简化原则

- 首页优先展示可扫视信息：状态图标、插件名、平台徽标、主动作。长原因、内部诊断和完整命令只放进详情、状态或诊断页。
- 只有一个可选平台、位置或配置策略时，直接跳过该选择页；执行前的确认页仍要列出最终目标。
- 文案尽量短：按钮使用 `安装`、`升级`、`卸载`、`处理`、`诊断` 这类动词，不使用解释性长标题。
- 异常只在首页显示一个 `异常` 状态；具体是重复安装、残留、文件缺失还是配置问题，进入详情或诊断后再解释。

### R1：首页

首页必须展示所有可管理插件：

1. current catalog 中的插件，用来展示未安装插件。
2. 已安装、可升级、可认领、有残留、文件缺失、读取失败或其它真实状态的插件。

如果 current catalog 不可用，首页仍展示已发现安装状态，并在顶部显示简短提示：

```text
插件目录不可用，仅显示已发现安装；恢复后可安装或升级。
```

首页每行展示：

- 状态图标、颜色和状态文案：
  - 灰色 `○`：未安装。
  - 绿色 `✓`：已安装。
  - 蓝色 `↑`：可升级。
  - 红色 `!`：异常。
- 插件显示名，优先使用 `manifest.interface.displayName`。
- 简短说明，优先使用 `manifest.interface.shortDescription`，否则使用 `manifest.description`；首页空间不足时可省略。
- 平台短标签，例如 `Codex:个人`、`Claude:当前项目`、`Codex / Claude`。
- 主动作，例如 `安装`、`升级`、`详情`、`处理`。

首页排序：

1. 异常
2. 可升级
3. 已安装
4. 未安装

同一状态内按插件显示名排序。插件数量超过屏幕高度时，列表必须能滚动。颜色只能辅助识别，不能作为唯一信息来源。

示例：

```text
✓ git-commit      Codex:个人                 升级
↑ codex-explore   Codex:个人 / Claude:个人   升级
○ code-review     Codex / Claude             安装
! aw-plugin       Codex:重复                 处理
```

### R2：插件详情页

从首页进入插件后，详情页展示状态摘要和功能菜单。

详情区只展示：

- 插件名、版本和简短说明。
- 汇总状态：`未安装`、`已安装`、`可升级`、`异常`。
- 安装摘要，例如 `✓ Codex:个人`、`○ Codex / Claude`、`! Codex:重复`。
- 如果有问题，只展示一条主要原因和一条建议。

功能菜单按当前状态动态展示：

- `安装`
- `升级`
- `配置`
- `卸载`
- `修复`
- `清理`
- `重新安装`
- `重新应用配置`
- `状态`
- `诊断`
- `返回`
- `退出`

平台和位置选择只能发生在功能内部。例如用户选择 `卸载` 后，才展示可卸载目标：

```text
选择卸载位置
- 所有平台
- Codex（个人）
- Claude Code（当前项目）
- 返回
```

同平台 user/project 重复安装不是正常“多个位置”。详情页必须展示重复安装，并提供“保留个人位置 / 保留当前项目位置”或等价动作。

### R3：功能、目标和执行

TUI 普通功能必须直接执行，不能只展示命令字符串。

所有写动作必须满足：

- 在执行前已经确定 plugin、platform、scope 和 project target。
- 高风险动作必须二次确认。
- 取消确认时不得写状态、写配置或留下中间文件。
- 执行完成后刷新当前插件或首页数据。
- 结果用短摘要展示；失败目标提供 `诊断` 入口。

只读的 `状态`、`诊断` 可以作为插件级页面跳转，不要求 target。普通功能菜单不能依赖可复制命令作为唯一结果。

### R4：多平台动作

安装、升级、配置、卸载、修复、清理、重新安装、重新应用配置等普通功能，只要当前插件存在两个及以上可处理平台，就必须在目标选择页提供 `所有平台`。

`所有平台` 的范围按当前动作收敛：

- 安装：当前插件声明支持、且在当前上下文可安装的所有平台。
- 升级、配置、卸载、重新安装：当前已有安装或可升级的所有平台。
- 修复、重新应用配置：当前存在对应异常、残留或可刷新项目文件的所有平台。
- 清理：当前插件在该平台有健康安装、可升级安装、可认领状态、残留、半完成状态、外部归属冲突或诊断问题的目标。
- 未安装且没有任何诊断问题的候选目标不进入清理范围。

选择 `所有平台` 后：

- 如果所有平台都有相同位置选项，可以只询问一次位置。
- 如果位置选项不同，按平台列出待处理目标，让用户逐项确认或跳过。
- 破坏性动作只做一次汇总确认，但确认文案必须列出会写入、删除或清理的平台和位置。
- 配置动作必须按最终写入的 config scope/store 收口。只有所有目标落在同一个 store，且配置表单 identity 一致时，才允许一次填写和一次保存；跨 `user` / `project` store 时必须拆成多个 config write group，分别确认、分别写入、分别汇总 refresh 结果。
- 执行结果按平台压缩展示，例如 `Codex 已安装，Claude Code 安装失败`；失败平台提供 `诊断` 入口。
- 写命令调用前必须展开成明确 target；命令层不能收到 `all platforms` 这类抽象目标。

`接管共享触发策略` 不属于普通批量动作。预检发现某个目标需要 takeover 时，普通批量写入必须跳过该目标，并引导用户进入单目标 `接管共享触发策略` 流程。

带 `takeoverSharedRuntime: true` 的调用必须满足 `targetCount === 1`。批量预检可以发现多个 takeover 候选，但不能生成一个多 target takeover action；每个候选都必须独立确认、独立调用写命令、独立展示结果。

### R5：状态与诊断

`状态` 是详情页内的只读功能，用来展示比详情页更多的信息，但仍保持友好。它可以展示每个位置的状态、原因摘要和下一步动作。

`诊断` 是用户主动进入的细节页面。它可以展示结论、发现的问题、建议功能、已明确 target 的可执行动作，以及必要的补充命令。

状态页不展示完整 JSON、内部字段名或底层错误栈。需要进一步定位时，引导用户进入 `诊断`。

状态和诊断页面必须消费结构化数据，不能解析人类输出文本，也不能把命令输出按行拆分后作为状态判断依据。允许的数据来源包括结构化 status matrix、friendly summaries、console summary、diagnose payload，以及基于它们生成的页面模型。

未安装候选位置只显示为中性事实，不计为 `异常`。只有当前 scope 存在 AW-owned record、project identity、repo-visible artifact、native marker、损坏状态，或同平台重复健康安装时，才显示处理建议。

用户显式查看 `codex/project` 时，如果当前只有 `codex/user` 健康安装，`codex/project` 显示 `未安装`，并附带中性提示 `同平台个人位置已有安装`。这不是残留，也不建议清理 project。

如果诊断发现 TUI 尚不支持的全局维护动作，例如 dependency index prune，可以展示命令和原因，但不能混在普通插件功能菜单里。

状态和诊断页面的最小页面模型需要能表达问题、位置、建议功能和补充命令：

```ts
interface ConsoleIssueSummary {
  code: string;
  label: string;
  severity: 'info' | 'warning' | 'error';
  summary: string;
  suggestedFeatures: PluginConsoleFeatureSummary[];
}

interface ConsoleLocationSummary {
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  label: string;
  status: PluginConsoleStatus;
  statusLabel: string;
  issue?: ConsoleIssueSummary;
  suggestedFeatures: PluginConsoleFeatureSummary[];
}

interface StatusPageModel {
  pluginName: string;
  summary: PluginConsoleSummary;
  locations: ConsoleLocationSummary[];
}

interface DiagnosePageModel {
  pluginName: string;
  conclusion: string;
  issues: ConsoleIssueSummary[];
  locations: ConsoleLocationSummary[];
  supplementalCommands: string[];
}
```

补充命令只作为诊断页里的辅助信息，不得成为普通插件功能的唯一操作路径。

### R6：快捷键与导航

菜单页和选择页支持：

- `b`：返回上一页。
- `q`：退出控制台。
- `Esc`：返回上一页；如果已经在首页，则退出控制台。
- `Ctrl+C`：安全退出控制台。

输入框和密码框中，`b` 与 `q` 作为普通字符处理；`Esc` 取消当前输入并返回上一页。

控制器应消费稳定导航结果，例如 `select`、`back`、`exit`、`cancel`，不能只依赖 `__back`、`__exit` 这类特殊菜单值。

### R7：渲染

TUI 需要从追加式输出改成页面式输出。

要求：

- 每次进入新页面时清理上一页区域或整屏重绘。
- 操作结果作为短 banner 或结果页展示。
- 长输出只在状态或诊断页出现。
- 默认页面不展示完整错误栈、JSON、debug log 路径或内部诊断矩阵。
- debug log 路径只在 `--debug` 或显式诊断中出现。

## 状态语义需求

### R8：缺省能力静默

以下情况不是问题，不计为 `异常`，不生成默认下一步：

- 插件没有声明 lifecycle 脚本。
- 插件没有声明 config schema。
- 插件没有声明某类 artifact target。
- 某个平台或 scope 没有安装记录。
- current catalog 中的插件尚未安装。
- snapshot fallback 的唯一原因是 snapshot 没有声明当前 lifecycle event，且当前命令只是只读状态展示。

只有“插件声明过、写入过、或当前健康状态确实依赖的能力失败/缺失/漂移”才显示问题。

以下情况才是问题：

- 声明过并写入过的 artifact 缺失、漂移或刷新失败。
- 已安装插件声明 required config，但当前安装位置缺少必需值或配置无效。
- install record、project identity、native transaction marker、dependency edge 等 AW-owned 状态损坏或互相矛盾。
- Codex user native 安装缺少 enabled config、active cache 或 AW record 中任一必需组成。
- 同一插件同一平台在 user 和当前 project 同时健康安装。
- 文件缺失、记录缺失或可认领安装等导致 AW 无法确认插件处于健康状态。

### R9：同平台 scope 唯一安装

投影时按 `(plugin, platform, currentProjectContext)` 聚合 user/project：

- 只有 user 健康安装：汇总为 `已安装`，位置是个人。
- 只有当前 project 健康安装：汇总为 `已安装`，位置是当前项目。
- user 和当前 project 都健康：汇总为 `异常`，原因是 `duplicateInstall`。
- 一侧健康、一侧未安装：汇总为健康安装，不展示“多个位置”。
- 一侧健康、另一侧有真实 AW-owned 残留：汇总为 `异常`，下一步只针对残留侧。
- 两侧都未安装：汇总为 `未安装`。

`多个位置` 只能用于跨平台摘要，不能表示同一平台 user/project 并存。

### R10：shared runtime owner

shared runtime owner 是共享运行时归属记录，不等同于每个 scope 的安装证据。

- project scope 没有自己的 install record、project identity、repo artifact、diagnostic cache 或 native marker 时，不能只因为 user scope 拥有 shared runtime owner 就把 project 判为残留。
- owner 指向另一个 scope，但当前 scope 的期望 runtime 语义一致时，不显示问题。
- 只有当前 scope 要改写 shared runtime 且语义会变化时，才显示 `接管共享触发策略`。
- Codex project scope 的状态页可以把 foreign owner 作为诊断事实，但默认详情页不应把它当成项目残留。

## 公开合同需求

### R11：Console Summary V2

`status --json.consoleItems` 的状态枚举、action kind 和元素 shape 会变化，必须提供版本边界：

```ts
interface StatusJsonPayload {
  ok: true;
  command: 'status';
  consoleItemsSchemaVersion: 2;
  consoleItems: PluginConsoleSummary[];
}
```

V2 要求：

- `consoleItemsSchemaVersion: 2` 是机器消费者识别新合同的边界；不能在没有版本字段时输出 V2 shape。
- 使用新的 `PluginConsoleSummary[]`。
- 旧状态枚举必须映射到四类新状态。
- 旧 action kind 不能原样混入 V2 summary。
- 默认 `status --json.consoleItems` 不包含纯 catalog-only 插件。
- 顶层其它字段如果本轮不改语义，应保持兼容。
- 公开文档必须说明 `consoleItemsSchemaVersion: 2`、旧字段/枚举到新字段/枚举的迁移关系，以及 catalog-only 边界。

### R12：Summary、功能菜单和执行层分层

`PluginConsoleSummary` 是公开 JSON 和跨命令复用的语义层，只承载状态、位置摘要、可用功能、原因码和下一步语义。

`PluginConsoleFeatureSummary` 是详情页第一层功能菜单的数据来源，只表达可以进入哪些功能和目标选择策略。它不能携带最终 target、确认文案、命令字符串或页面展示字段。

`PluginConsoleExecutableAction` 只在用户选完平台、scope 和项目位置后生成。所有写动作都必须带明确 target。`openStatus`、`openDiagnose` 等只读页面跳转可以没有 target。

TUI 页面层可以派生图标、颜色、badge、主按钮文案和目标选项，但这些字段不进入 `status --json.consoleItems` 的稳定 schema。

`PluginConsoleTargetOption` 和详情页 `targetOptions` 只属于 TUI 页面模型，用来驱动目标选择页，不进入 `status --json.consoleItems` 的稳定 schema。公开 `PluginConsoleSummary` 不承诺目标选择页所需的展示 label、排序或禁用原因。

`PluginConsoleSummary.installedLocations` 可以继续保留给状态和诊断用，但详情页不能直接把 location 列表作为第一层菜单。详情页第一层菜单只从 `summary.features` 派生；目标选择页再结合页面模型、installed locations、duplicate group 和只读预检结果生成执行层 action。

语义 summary 的建议形态如下。字段名可随代码落地微调，但职责边界不能改变：

```ts
type PluginConsoleFeatureKind =
  | 'install'
  | 'upgrade'
  | 'configure'
  | 'uninstall'
  | 'repair'
  | 'cleanup'
  | 'reinstall'
  | 'adoptExisting'
  | 'takeoverSharedRuntime'
  | 'resolveDuplicateInstall'
  | 'reapplyConfigRefresh'
  | 'status'
  | 'diagnose';

interface PluginConsoleFeatureSummary {
  kind: PluginConsoleFeatureKind;
  label: string;
  targetSelection:
    | 'none'
    | 'singleTarget'
    | 'multiTargetAllowed'
    | 'singleTargetOnly';
  disabledReason?: string;
  reasonCodes?: PluginConsoleReasonCode[];
  destructive?: boolean;
}

interface PluginConsoleLocationSummary {
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  label: string;
  status: PluginConsoleStatus;
  statusLabel: string;
  reasonCodes: PluginConsoleReasonCode[];
  issueSummary?: string;
  nextSteps: string[];
}

interface PluginConsoleSummary {
  pluginName: string;
  title: string;
  description?: string;
  version?: string;
  status: PluginConsoleStatus;
  statusLabel: string;
  locationSummary?: string;
  supportedPlatforms?: PlatformName[];
  installedLocations: PluginConsoleLocationSummary[];
  duplicateInstallGroups?: Array<{
    pluginName: string;
    platform: PlatformName;
    locations: PluginConsoleLocationSummary[];
  }>;
  features: PluginConsoleFeatureSummary[];
  reasonCodes: PluginConsoleReasonCode[];
  issueSummary?: string;
  detailHints?: string[];
  nextSteps: string[];
}
```

TUI 页面层可以在 summary 之外生成这些展示字段和目标选项：

```ts
type PluginConsoleTone = 'neutral' | 'success' | 'info' | 'danger';

interface PluginConsoleBadge {
  label: string;
  icon: string;
  tone: PluginConsoleTone;
  title?: string;
}

interface PluginConsoleTargetOption {
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  label: string;
  status?: PluginConsoleStatus;
  reasonCodes?: PluginConsoleReasonCode[];
  disabledReason?: string;
}

interface ConsolePageItem {
  summary: PluginConsoleSummary;
  statusIcon: string;
  statusTone: PluginConsoleTone;
  platformBadges: PluginConsoleBadge[];
  summaryText?: string;
  primaryActionLabel?: string;
}

interface ConsolePluginDetailPageModel {
  summary: PluginConsoleSummary;
  targetOptions: PluginConsoleTargetOption[];
}
```

执行层 action 只在目标选择后生成。`command?: string[]` 只允许作为诊断页补充信息，不进入 `PluginConsoleFeatureSummary` 或 `PluginConsoleExecutableAction`。

```ts
type PluginConsoleActionKind =
  | 'runInstall'
  | 'runUpgrade'
  | 'runConfig'
  | 'runUninstall'
  | 'runRepair'
  | 'runCleanup'
  | 'runReinstall'
  | 'runAdoptExisting'
  | 'runTakeoverSharedRuntime'
  | 'resolveDuplicateInstall'
  | 'runReapplyConfigRefresh'
  | 'openStatus'
  | 'openDiagnose';

interface PluginConsoleExecutableAction {
  kind: PluginConsoleActionKind;
  label: string;
  target?: PluginConsoleActionTarget;
  targetPolicy?: 'singleTargetOnly' | 'multiTargetAllowed';
  destructive?: boolean;
  force?: boolean;
  removeConfig?: boolean;
  confirmText?: string;
  disabledReason?: string;
}
```

`force` 只能出现在 `runCleanup` 上，表示用户已经看过并确认高风险清理范围。`runUninstall` 不能生成 `force: true`。`removeConfig` 只能在 `runUninstall` 和 `runCleanup` 上使用。`runConfig` 必须带明确写入 scope/store；跨 `user` / `project` store 时页面模型应生成多个 config write group。

## 命令边界需求

### R13：安装、升级和修复前预检

会让目标变成健康安装的入口必须在第一笔写入前执行只读预检，包括 TUI 和 direct command：

- `aw install`
- `aw upgrade`
- `aw reinstall`
- `aw repair`
- `aw repair --adopt-existing`

如果同一插件同一平台另一侧 scope 已有健康安装，命令默认失败，返回稳定 reason code，例如 `duplicateInstall`，并提示先卸载、清理或选择保留某一侧。预检失败时不得进入 required config 表单，不得创建或改写 config store，也不得留下安装或升级中间状态。

scope 互斥规则：

- 安装到 `codex/project` 前，如果当前工作上下文已有健康的 `codex/user` 同名插件，默认拒绝并提示先卸载或迁移个人位置。
- 安装到 `codex/user` 前，如果当前项目已有健康的 `codex/project` 同名插件，默认拒绝并提示先卸载或迁移项目位置。
- Claude 同理：同一插件在 `claude/user` 和当前项目 `claude/project` 之间也不能作为正常并存状态。
- Codex 和 Claude 属于不同平台，可以分别安装，不构成重复安装。
- 未来如果提供迁移能力，应是明确的 `move scope` / `replace scope` 动作，不通过普通 install 隐式覆盖另一侧。

`aw cleanup` 和重复安装处理动作可以移除冲突，但不能把两侧都修成健康安装。TUI 调用的只读预检和 direct command 必须共用同一套判断，避免出现控制台阻断、脚本命令仍可制造重复安装的双重行为。

### R14：uninstall

`aw uninstall` 只负责正常状态插件的标准卸载，并移除 `--force`。

遇到损坏、残留、可认领、重复安装、外部归属冲突、依赖元数据异常、无法安全重放 lifecycle/runtime 等异常时，`uninstall` 必须在删除前失败，并提示使用 `cleanup` 或重复安装处理入口。

### R15：cleanup

`aw cleanup` 是统一恢复评估、执行和强制移除入口。目标范围覆盖健康安装、可升级安装、残留、半完成状态、可认领状态、外部归属冲突和诊断可定位问题。

`cleanup` 不是“所有异常都自动恢复成功”的承诺。无法安全证明归属或无法安全枚举删除面的项目必须阻断自动恢复，并给出人工处理建议。

健康安装或可升级安装走与 `uninstall` 等价的正常卸载语义，包括历史 `uninstall` lifecycle、平台 native uninstall、repo-visible artifacts、project artifact identity、dynamic diagnostic cache、install record 和 dependency index 更新。

如果健康目标的正常卸载路径因为 lifecycle/runtime 缺失、native 状态异常或共享 runtime 无法安全重放而失败，普通 `cleanup` 失败并提示 `cleanup --force`；用户显式加 `--force` 后，允许降级为恢复清理。

异常、残留、半完成和可认领状态走 best-effort 恢复清理：优先删除 AW-owned install record、project artifact identity、dynamic diagnostic cache、historical lifecycle runtime、native transaction marker、repo-visible artifacts、平台 native residue 和其它能定位到的插件状态。

`cleanup` 必须覆盖 `diagnose` 报出的恢复问题。如果问题能由 `repair` 或 `uninstall` 更温和地解决，仍可优先推荐它们，但必须提供 `cleanup` 作为最终恢复评估入口。若 `cleanup` 无法安全自动恢复，结果必须说明阻断原因、已知冲突面和人工处理建议。

direct CLI 必须提供：

- `aw cleanup --plan`：只读预览，不写状态、不删文件、不创建备份。
- `aw cleanup --plan --json`：输出 `cleanupPlanSchemaVersion: 1`。
- `aw cleanup --plan --force`：只读生成 force 语义下的高风险计划。
- `aw cleanup --force`：高风险执行确认，不额外要求 `--yes` 或 plan token。

direct CLI 的普通文本输出也是公开行为合同，不能只把关键信息放在 `--json`、debug log 或 TUI 确认页里。`aw cleanup --plan`、`aw cleanup --plan --force` 和 `aw cleanup --force` 的文本输出必须向用户暴露同构计划信息，至少包括：

- force reason
- planned removals
- would-backup items 或实际 backup items
- skipped foreign items
- affected dependents
- blocking reasons

如果对应集合为空，输出可以用简短空状态表达，但不能让用户无法判断该类风险是否被评估过。`--plan` 文本只描述预期动作，不得暗示已经删除或已经备份；`--force` 文本必须基于执行时重新生成的计划，并清楚区分实际已删除项、实际备份项、跳过项、未清项和阻断原因。

`cleanup --plan` 与 `cleanup --force` 必须复用同一套目标解析、归属校验、依赖检查和删除计划生成逻辑。执行 receipt 必须暴露实际执行计划。

`diagnose` 在提示 force cleanup 时，应优先给出 `cleanup --plan` 作为执行前预览入口，再提示 `cleanup --force`。

TUI 生成 `force: true` 前必须单独说明风险来源。确认页必须列出外部冲突删除计划、受影响 dependents、降级清理原因、备份策略以及不可删除项。可备份的共享配置或 repo-visible 文件应尽量先备份；不能备份时必须在确认页说明。

`cleanup --plan --json` 的 schema 从首版开始带 `cleanupPlanSchemaVersion: 1`，至少包含：

- `dryRun: true`
- `force`
- `removeConfig`
- `plannedRemovals`
- `wouldBackups`
- `wouldRemoveConfig`
- `skippedForeignItems`
- `affectedDependents`
- `blockingReasons`
- 最终建议的执行命令

`cleanupPlanSchemaVersion` 是 cleanup 删除计划机器合同的版本边界。后续如果调整 plan 或执行 receipt 中同构计划的结构，必须提升该版本或提供明确兼容策略。

`cleanup --plan` 的选项矩阵固定如下：

- `--plan` 只适用于普通插件 target cleanup，仍要求单插件、单平台、明确 scope/project target。
- `cleanup --dependency-index --prune-stale <token> --plan` 非法；dependency-index prune 继续走既有 `--yes` 确认合同。
- 普通插件 target cleanup 不接受 `--yes`；传入时必须报错并说明它只用于 dependency-index prune。
- `--plan --force` 合法，但仍然只读。这里的 `--force` 表示按 force 执行语义生成高风险删除计划，不是执行确认。
- 不带 `--force` 的 `--plan` 遇到高风险清理时只输出 blocking reasons，并提示可运行 `cleanup --plan --force` 查看 force 计划。
- `--plan --remove-config` 合法且只读；主体清理被阻断时，配置删除计划必须标记为 blocked/skipped。
- 真正执行时仍需要用户单独运行 `cleanup --force`，并以执行时重新生成的计划为准。

外部归属冲突删除计划必须满足安全边界：

- 只能删除可归类到 AW 已知 surface 的项目，例如 shared runtime owner 记录、平台 native plugin 条目、repo-visible artifact、project artifact identity、dynamic diagnostic cache、install/native transaction marker，或 manifest/record 能精确定位的插件级文件。
- 每一项都必须在执行前枚举具体删除项，包括路径、native identifier、owner key、config block key 或等价稳定标识。
- 每一项都必须能证明属于当前 plugin/platform/scope 的冲突面，或是阻断当前目标恢复的同名 plugin surface。
- 不能删除其它插件、其它 scope/project 的配置、dependency 插件、未知第三方文件、父目录或无法归属的任意内容。
- 无法归类、无法枚举或无法证明目标归属的项目必须阻断 `cleanup --force`，并列出人工处理建议。

如果目标仍被其它已安装插件依赖，普通 `cleanup` 必须失败并列出 dependents。`cleanup --force` 可以移除目标，但不级联删除依赖它的插件，结果页必须提示这些 dependents 可能需要后续 `repair`、`reinstall` 或 `cleanup`。

`cleanup --force` 可以继续尝试后续删除，即使某些单项删除失败；但清理后如果目标仍有诊断异常或可定位残留，最终结果必须失败并列出未清项，不能用 warning 把未恢复状态包装成成功。

### R16：remove-config

`aw uninstall` 和 `aw cleanup` 都支持 `--remove-config`，TUI 展示为破坏性确认项，例如 `同时删除配置`。

要求：

- 只删除本次目标对应 scope/store 中该插件的 AW 自管配置。
- 不删除其它 scope、其它项目或其它插件的配置。
- 主体删除或清理成功后才删除配置。
- 主体失败时保留配置，并在结果和 JSON receipt 中明确标记。
- TUI 批量动作要按 config store 去重和分组；命令层不接收 `所有平台` 抽象目标。
- direct `aw cleanup --remove-config` 保持单插件、单平台、单 scope 目标。
- direct `aw uninstall --remove-config` 如果一条命令展开出同一 `(plugin, scope, projectKey?)` config store 下的多个 execution target，必须等该 store 下本次涉及的所有主体卸载都成功后，才删除一次配置。
- 任一主体失败时保留对应 store 的配置，并在结果和 JSON receipt 中标记“主体失败，因此跳过 remove-config”。
- 配置删除失败不回滚已经完成的主体删除或清理，但整体结果必须明确标记配置仍未删除。
- `aw config reset` 仍保留为独立配置管理入口。`--remove-config` 只是把同一 target 的配置清理串到删除流程后面，不替代完整配置管理命令。

## 功能要求

### 安装

适用于未安装插件，也适用于需要修复但更适合重新安装的状态。

流程：

1. 进入 `安装`。
2. 如果插件支持多个平台，选择平台；两个及以上平台可安装时，提供 `所有平台`。
3. 如果目标平台支持多个位置，选择 `个人` 或 `当前项目`；选择 `所有平台` 时，按多平台规则收敛位置选择。
4. 如果允许配置触发方式，选择 `默认`、`手动`、`自动`。
5. 执行只读预检。
6. 预检通过后，如果缺必填配置，进入配置表单。
7. 配置完成后运行安装命令。
8. 展示简短结果，然后刷新首页数据。

只读预检必须早于 required config 表单和任何写入动作。Codex project write safety、external ownership、tracking identity、同平台重复安装等阻断原因都必须在配置表单出现前完成判断；预检失败时不得调用配置表单，不得创建或改写 config store，也不得留下任何安装或升级中间状态。

安装中的 required config 必须复用配置动作的 config write group 规则。选择 `所有平台` 或其它批量安装目标时，TUI 必须先完成整批目标的只读预检，再根据明确的 plugin/platform/scope/project target 计算配置写入组。只有同一 config store 且配置表单 identity 一致的目标，才允许一次填写后复用结果。跨 `user` / `project` store 时，即使 schema 一样，也必须拆成多个 config write group，并分别确认、分别保存、分别汇总结果。不得把整批目标压成一个 `selectedScope`，也不得在部分目标尚未完成预检时先写入任何 config store。

安装过程中出现不可安装组合时，只展示面向用户的原因，例如：

```text
这个插件不能安装到当前项目，请改为安装到个人位置。
```

### 升级

适用于 `可升级` 或 `catalogCapabilityChanged` 等需要重装/升级的状态。

流程与安装类似，但调用升级命令，并沿用“先只读预检、再 required config、最后写命令”的顺序。如果同一插件有多个平台可升级，平台选择页提供 `所有平台`，并在执行前汇总展示将升级的平台和位置。升级中的 required config 与安装使用同一套 config write group 规则：整批只读预检完成后，再按 config store 和表单 identity 分组；跨 store 必须拆组确认、拆组写入、拆组汇总。

如果某个目标需要共享触发策略接管，TUI 应展示风险说明，并把该目标移入单目标 `接管共享触发策略` 流程；不得对 `所有平台` 或多个 target 调用带 takeover 语义的升级动作。

### 配置

配置入口适用于：

- 已安装插件。
- 可升级插件。
- 缺少必填配置或配置无效的插件。
- 未安装但声明了 config schema 的插件，用于预先配置。

要求：

- 默认写入位置跟当前安装位置一致。
- 未安装插件默认写入 `个人`，但允许选择 `当前项目`。
- 同一插件有多个平台可配置时，平台选择页提供 `所有平台`，并先展开成明确的平台、scope 和项目位置目标。
- 默认或用户选择的位置决定最终写入的 config scope/store；TUI 不能只保留一个含糊的 `selectedScope` 来代表跨 scope 目标。
- 如果目标都落在同一个 config store，且配置表单一致，只填写一次并写入该组所有目标；如果配置表单不一致，按平台或 target 依次填写。
- 如果目标横跨 `user` / `project` config store，即使配置表单一致，也必须按写入 store 分组处理。每组有独立确认页、独立保存事务和独立结果汇总；不得静默把同一份更新同时写进 user 与 project 两层。
- `string`、`file`、`directory` 使用输入框。
- `number` 使用输入框并校验范围。
- `boolean` 使用确认控件。
- `enum` 使用选择控件。
- `sensitive` 值隐藏输入，已配置时只显示 `已配置`。
- 保存后只展示简短结果。

如果配置保存成功但相关项目文件刷新失败，详情页只展示：

```text
配置已保存，但相关项目文件刷新失败。你可以重新应用配置，或进入诊断查看原因。
```

不在默认页面展示 `artifactRefresh`、`refreshKeys`、digest 或 tracking 细节。

### 卸载

适用于正常已安装、可升级且仍能按标准路径卸载的插件，或可安全移除的自动依赖。`uninstall` 不再承担异常恢复职责。

要求：

- 若跨平台有多个目标，先选择平台，并提供 `所有平台`；同平台重复安装应走“重复安装处理”动作，不当成普通并存位置。
- 必须二次确认。
- 直接调用卸载命令。
- CLI 层移除 `--force`。入口、normalized options、帮助文案、公开文档和测试都不能再保留 `uninstall --force` 语义。
- 卸载命令在第一笔删除前必须确认目标和所在插件聚合状态都是正常状态。只要发现 record 损坏、lifecycle/runtime 无法安全重放、native 状态不完整、repo artifact 漂移、可认领状态、残留、重复安装、外部归属冲突、dependency metadata 缺失或其它诊断异常，就直接失败并提示使用 `cleanup`。
- 如果仍被其它插件依赖，菜单项可以显示但必须禁用，并给出简短原因。
- 如果用户选择同时删除配置，配置删除只发生在主体卸载成功之后，并且只删除当前目标 scope/store 的 AW 自管配置。

重复安装处理：

- 如果同一插件同一平台同时存在 user/project 健康安装，默认状态为 `异常：重复安装`。
- TUI 提供两个明确动作：
  - `保留个人位置`：清理当前项目位置，保留 user 安装。
  - `保留当前项目位置`：清理 user 位置，保留 project 安装。
- 两个动作都必须二次确认，并在执行前说明会删除哪一侧。
- 两个动作都通过 `cleanup` 或专门的 `resolveDuplicateInstall` 执行层动作收口；不能对异常聚合状态调用普通 `uninstall` 来绕过卸载前置检查。被删除的一侧如果本身是健康安装，按 `cleanup` 的健康目标规则走正常卸载语义。
- 如果其中一侧不是健康安装，而是残留或损坏，动作文案应变成“清理个人残留”或“清理项目残留”，不能继续称为正常卸载。

### 清理

适用于所有可定位目标：健康安装、可升级安装、残留、marker-only、半完成状态、可认领状态、受控 native residue、外部归属冲突，以及 `diagnose` 能发现的其它插件级问题。`cleanup` 是用户遇到异常时进入恢复评估、恢复执行或强制移除的统一入口；它必须尽力把目标恢复到可继续使用状态，但不能越过安全边界承诺所有异常都能自动恢复。

要求：

- 直接调用清理命令，不只展示 `aw cleanup ...`。
- 多个平台都有可清理目标时，平台选择页提供 `所有平台`。
- 必须二次确认。
- 健康目标走与 `uninstall` 等价的正常卸载语义；异常目标走 best-effort 恢复清理。
- 需要 `force` 时，TUI 必须先展示风险来源、删除计划、受影响依赖、备份策略和不可删除项。
- 如果用户选择同时删除配置，配置删除只发生在主体清理成功之后，并且只删除当前目标 scope/store 的 AW 自管配置。
- `cleanup` 删除配置失败时不回滚已经完成的主体清理，但整体结果必须明确标记配置仍未删除，JSON receipt 也要暴露该失败。

### 修复

适用于 `needsRepair`、`nativeIncomplete`、`missingRecord`、`dependencyMissing`、`artifactDrift`、`catalogCapabilityChanged` 等可由 AW 修复的状态。

要求：

- 直接调用修复命令，不只展示 `aw repair ...`。
- 多个平台都有可修复目标时，平台选择页提供 `所有平台`。
- 如果状态是可认领的 project artifacts，动作名使用 `认领现有安装`，并调用 adopt 语义。
- 如果需要接管共享触发策略，动作名使用 `接管共享触发策略`，并标记为 `singleTargetOnly` 或等价语义。TUI 先展示风险说明，用户确认单个明确 target 后，才能调用 takeover 语义。
- 修复命令的 raw options、normalized options 和执行逻辑必须持续显式支持 `takeoverSharedRuntime`。CLI 的 `aw repair --takeover-shared-runtime`、TUI 的 `runTakeoverSharedRuntime` action 和底层 shared runtime owner preflight 必须走同一条语义链路，不能只在入口层接收 flag。
- 修复完成后刷新控制台数据。

### 重新安装

适用于用户想用 current catalog 重新落一遍插件的明确操作。

要求：

- 直接调用重装命令。
- 多个平台都有可重装目标时，平台选择页提供 `所有平台`。
- 必须二次确认，因为它可能先卸载或清理再安装。
- 如果当前是 `可认领` 状态，不展示 `重新安装`，优先展示 `认领现有安装`。
- 如果需要 `cleanup --force` 或依赖保护阻止隐式清理，展示阻断说明，不自动降级成其它动作。

### 重新应用配置

适用于 `artifactRefreshFailed` 或有 tracked dynamic artifact 可刷新时。

要求：

- 直接调用配置刷新能力。
- 不修改 config store。
- 多个平台都有可刷新项目文件时，平台选择页提供 `所有平台`。
- 成功后展示 `相关项目文件已更新。`
- skipped 时展示 `没有需要重新应用的项目文件。`
- 失败时展示友好摘要，并提供 `诊断` 入口。

## 验收标准

### 首页和详情页

- 没有任何安装证据时，裸 `aw` 首页仍显示 current catalog 插件。
- 未安装插件详情页显示 `安装`、可选 `配置`、`状态`、`诊断`、`返回`、`退出`。
- 跨平台插件进入详情页后先看到功能菜单，不先看到位置列表。
- 只有 `codex/user` 健康安装时，不把 `codex/project` 的未安装状态当成问题。
- 同一插件同时存在 `codex/user` 和当前 `codex/project` 健康安装时，首页显示 `异常` 和 `Codex:重复`。
- 首页和详情页不出现 `由其它来源管理`、`部分可用`、`需要处理` 这类旧友好状态。
- 插件没有 lifecycle、config schema 或 artifact target 时，默认页面不显示注意或处理建议。

### 直接执行

- 普通功能菜单项可以在 TUI 内执行，不只是展示命令。
- `所有平台` 在调用命令前已经展开为明确 target。
- `接管共享触发策略` 永远是单目标确认和单目标调用。
- `runUninstall` 不生成或传递 `force`。
- 只有 `runCleanup` 可以在用户确认高风险范围后携带 `force`。
- `removeConfig` 只出现在卸载和清理确认流程，并遵守主体成功后删除配置的规则。
- 安装和升级的只读预检早于 required config 表单和任何写入。

### 命令合同

- `aw uninstall --force` 不再被接受，help 和公开文档也不再出现该选项。
- 异常目标调用 `aw uninstall` 会在删除前失败，并明确指向 `cleanup` 或重复安装处理入口。
- `aw cleanup --plan --json` 不写状态、不删文件、不创建备份，并输出 `cleanupPlanSchemaVersion: 1`。
- `aw cleanup --force` 不要求 `--yes` 或 plan token，但 receipt 暴露实际执行计划、备份、跳过项、受影响依赖和未清项。
- 外部归属冲突只有在删除计划能枚举具体 surface 且能证明属于当前目标冲突面时，才能被 `cleanup --force` 删除。

### 状态、诊断和公开 JSON

- TUI 状态和诊断页面只消费结构化数据，不解析人类输出文本。
- 诊断问题能映射到更温和动作或最终 `cleanup` 评估路径。
- `status --json` 输出 `consoleItemsSchemaVersion: 2` 后，`consoleItems` 使用 V2 summary shape。
- V2 `consoleItems` 不包含旧 action kind、旧友好状态或 TUI 页面字段。
- 默认 `status --json.consoleItems` 不包含纯 catalog-only 插件。

### 导航和渲染

- 菜单页按 `b` 返回、按 `q` 退出、按 `Esc` 返回或在首页退出。
- 输入页中的普通 `b` / `q` 不触发导航；`Esc` 取消当前输入。
- 连续执行安装、返回、进入详情、查看状态时，旧页面不会向下堆叠。
- 默认页面不展示长错误栈、JSON、debug log 路径或内部诊断矩阵。
