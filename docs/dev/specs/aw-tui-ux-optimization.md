# `aw` TUI 使用体验优化需求 Spec

日期：2026-05-11

## 背景

当前 `aw` 主命令已经会进入交互控制台，但真实使用体验仍然偏“状态矩阵浏览器”，而不是“插件管理器”。用户打开 TUI 后，很容易被平台、位置、诊断和内部状态牵着走；更严重的是，未安装插件不会出现在首页，用户无法在 TUI 里发现并安装新插件。

本轮目标是把 TUI 调整成以用户任务为中心的插件控制台：先选插件，再选功能，最后在必要时选择平台和安装位置。默认界面只展示简单、可行动的信息；诊断细节放进用户主动进入的“状态”和“诊断”功能里。

## 已确认决策

- TUI 必须支持全局快捷键：`b` 返回、`q` 退出、`Esc` 返回或在首页退出。`Ctrl+C` 也应安全退出控制台。
- 详情页功能菜单要覆盖插件操作：安装、升级、配置、卸载、状态、诊断、修复、清理、重装，以及认领现有安装、接管共享触发策略、重新应用配置等状态驱动动作。支持多个平台的普通动作必须提供 `所有平台` 选项，让用户能一次处理同一插件的多个平台；`接管共享触发策略` 是单目标风险动作，只能在明确 plugin/platform/scope/project target 后执行。
- 插件详情页采用“状态摘要 + 功能菜单”的组合。进入插件详情后不直接列所有平台和安装目的地；只有进入具体功能后，才选择平台、scope 和项目位置。
- TUI 中的功能要直接执行。不能只给出一条命令要求用户退出后复制执行。
- 同一插件在同一平台、同一当前工作上下文内只能有一个生效安装位置。`codex/user` 和当前仓库的 `codex/project` 不能同时作为正常状态存在；如果真实发现两边都已安装，应投影为“异常：重复安装”，而不是把“多个位置”当成正常管理形态。这个约束是命令层公共 invariant，不只是 TUI 展示策略。
- 未声明、未配置或不存在的可选能力不是问题。默认界面不能因为插件没有 lifecycle、没有 config schema、没有某类 artifact 或某个平台状态不存在而显示注意、警告或处理建议。
- 控制台模型必须拆成三层：`PluginConsoleSummary` 只承载跨 status/TUI 复用的语义状态；详情页第一层功能菜单使用 `PluginConsoleFeatureSummary` 描述 `安装`、`升级`、`配置` 等 capability；用户选完平台、scope 和项目位置后，才生成带完整 target 的 `PluginConsoleExecutableAction`。任何写入、删除、清理、接管和重装动作都不能挂在 summary 顶层，也不能在缺 target 的情况下进入执行层。
- `status --json.consoleItems` 的本轮调整按版本化 breaking change 处理。允许原地把 `consoleItems` 升级为新的 summary schema，但必须提供可机器检测的 schema version，同步更新公开文档和迁移说明，并明确旧状态枚举、旧 action kind 与新合同的替换关系。
- TUI 模型改造和 `status --json.consoleItems` V2 breaking change 在同一轮收口，不拆成“先 TUI 私有路径、后公开 JSON 迁移”的两阶段发布。实现落地时仍必须同步公开文档、迁移说明和测试，避免公开合同静默变化。
- `status --json.consoleItems` V2 只承诺新的 summary shape，不扩大默认 `status` 的插件发现范围；纯 current catalog、没有安装证据、没有 runtime 证据、没有读取错误的 catalog-only 插件不进入默认 `status --json.consoleItems`。TUI 首页必须改用 console 专用加载路径拿到 catalog-only 插件，并把它们投影成同一套 `PluginConsoleSummary`。
- 目标选择页的 `targetOptions` 只属于 TUI 页面模型，不进入 `status --json.consoleItems` 的公开 summary schema；公开合同不承诺目标 label、排序或页面禁用原因。
- `aw uninstall` 只负责正常状态插件的标准卸载，并移除 `--force` 选项。只要目标存在异常、残留、损坏、归属冲突、无法安全重放 lifecycle/runtime、依赖元数据不可信等问题，`uninstall` 必须失败，不得用 force 继续；错误里给出明确原因和 `cleanup` 恢复评估入口。
- `aw cleanup` 是统一恢复评估、执行和强制移除入口，目标范围覆盖健康安装、可升级安装、残留、半完成状态、可认领状态、外部归属冲突和诊断能发现的其它问题。健康目标默认走与 `uninstall` 等价的正常卸载语义；异常目标走 best-effort 恢复清理。`cleanup` 不是“所有异常都自动恢复成功”的承诺：如果无法安全证明归属、无法安全枚举删除面，最终结果必须是阻断自动恢复，并给出人工处理建议。`--force` 只用于用户明确接受高风险删除，例如删除可定位且可预览的外部归属冲突内容、越过依赖保护、或在正常卸载路径失败后切到恢复清理。direct CLI 必须提供 `aw cleanup --plan` 无写入预览入口，`--plan --json` 输出带 `cleanupPlanSchemaVersion: 1`、且与实际执行同构的删除计划；`aw cleanup --force` 本身仍是高风险执行确认，不再额外要求 `--yes` 或 plan token。TUI 仍必须在生成 `force: true` 前展示单独确认页。
- `aw uninstall` 和 `aw cleanup` 都新增 `--remove-config`，在主体删除成功后删除当前目标 scope/store 中该插件的 AW 自管配置；不删除其它 scope 的配置，也不在主体删除失败时抢先清配置。`所有平台` 是 TUI 编排概念，写命令前必须展开成明确 target；TUI 批量动作需要按 config store 去重和分组。direct `aw cleanup` 仍保持单插件、单平台、单 scope 目标。direct `aw uninstall --remove-config` 如果在一条命令里展开出同一插件、同一 config store 下的多个 execution target，命令层必须按 `(plugin, scope, projectKey?)` 分组；同一 store 只有在本次命令涉及该 store 的所有主体卸载都成功后，才删除一次配置。

## 当前实现探索结论

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
- CLI 入口已经暴露 `repair --takeover-shared-runtime`，并会把 `takeoverSharedRuntime` 传给 `repairCommand()`；但当前 `RawRepairCommandOptions` / `RepairCommandOptions` 和 normalize 逻辑还没有消费这个字段。实现 TUI 直连 `接管共享触发策略` 前，必须补齐这条命令层链路，避免出现 CLI/TUI 看起来支持 takeover、实际 repair pipeline 忽略该语义的断层。

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

## 产品目标

1. 裸 `aw` 首页展示所有可管理插件，包括未安装插件。
2. 首页用状态图标、颜色和平台短标签展示插件状态、已安装到哪里、还能安装到哪里，尽量少用解释性长句。
3. 插件详情页先展示简短状态和功能菜单，不先暴露平台和位置列表。
4. 平台、scope、项目位置只在执行具体功能时出现。
5. 同一插件同一平台的安装位置保持唯一，避免 user/project 同时存在造成运行时和状态判断歧义。
6. 同一插件的多平台安装、升级、卸载、修复、清理、重装等普通动作可以通过 `所有平台` 一次处理；需要 `--takeover-shared-runtime` 语义的目标必须拆成单目标确认和执行。
7. 所有菜单动作都能在 TUI 内完成，除非该动作本身属于脚本化全局维护入口。
8. 状态摘要和操作页面分离。默认页面不堆叠历史状态，也不混入长诊断输出。
9. 诊断细节只在用户进入“状态”或“诊断”功能后展示。
10. 默认页面只展示真实问题；未声明、未配置、不存在的可选能力不算问题。
11. TUI 中所有写入、删除、接管、清理和重装动作必须带明确目标，并在风险较高时二次确认；direct CLI 的确认合同由对应命令选项定义。
12. 删除类命令边界清晰：`uninstall` 没有 `--force`，只处理正常状态；`cleanup` 覆盖所有状态，并承担诊断异常的恢复评估与执行入口。
13. 用户能在 `uninstall` 和 `cleanup` 中显式选择同时删除当前目标 scope 的 AW 自管配置，但配置删除不能早于主体删除成功。

## 非目标

- 不把 TUI 做成完整的全局维护后台。`aw init`、`repair --dependency-index`、`cleanup --dependency-index --prune-stale` 不进入默认插件功能菜单。
- 不在本轮改变 install record、dependency index、dynamic artifact cache 或插件 manifest 的磁盘格式。
- 不让 TUI 默认显示完整诊断矩阵。完整细节继续由 `aw diagnose`、`aw status --verbose`、`--json` 和 debug log 承担。
- 不在本轮设计跨插件批量安装、批量卸载或批量升级。`所有平台` 只作用于当前插件的多个平台。
- 不把“未声明 lifecycle / 未声明 config schema / 未声明 artifact target”视为错误。
- 不把 `cleanup --force` 设计成静默忽略所有风险的开关。凡是会越过依赖保护、删除外部归属内容或从正常卸载降级到恢复清理的场景，都必须清楚列出影响范围；TUI 必须二次确认，direct CLI 通过 `--plan` 提供执行前预览，并把显式传入 `--force` 视为高风险执行确认。

## 信息架构

### 简化原则

- 首页优先展示可扫视信息：状态图标、插件名、平台徽标、主动作。长原因、内部诊断和完整命令只放进详情、状态或诊断页。
- 只有一个可选平台、位置或配置策略时，直接跳过该选择页；执行前的确认页仍要列出最终目标。
- 文案尽量短：按钮使用 `安装`、`升级`、`卸载`、`处理`、`诊断` 这类动词，不使用解释性长标题。
- 异常只在首页显示一个 `异常` 状态；具体是重复安装、残留、文件缺失还是配置问题，进入详情后再解释。

### 首页

首页是插件列表，不是状态矩阵。

每个插件行展示：

- 状态图标和颜色：
  - 灰色 `○`：未安装。
  - 绿色 `✓`：已安装。
  - 蓝色 `↑`：可升级。
  - 红色 `!`：异常。
- 插件显示名，优先使用 `manifest.interface.displayName`，否则使用插件名。
- 简短说明，优先使用 `manifest.interface.shortDescription`，否则使用 `manifest.description`；首页空间不足时可省略。
- 友好状态只允许：`未安装`、`已安装`、`可升级`、`异常`。
- 安装摘要用平台徽标和短标签表达，不使用 `已安装：...`、`未安装，可安装到：...` 这类句子。
- 简短下一步，例如 `安装`、`升级`、`详情`、`处理`。

首页行示例：

```text
✓ git-commit      Codex:个人                 升级
↑ codex-explore   Codex:个人 / Claude:个人   升级
○ code-review     Codex / Claude             安装
! aw-plugin       Codex:重复                 处理
```

颜色只能辅助识别，不能作为唯一信息来源；图标、平台名和短标签必须足够表达状态。

首页必须合并两类来源：

1. current catalog 中的所有插件，用来展示未安装插件。
2. 已安装、可认领、有残留、文件缺失或读取失败的插件，用来展示真实状态。

如果 current catalog 不可用，首页仍展示已发现的安装状态，并在顶部显示简短提示：

```text
插件目录不可用，仅显示已发现安装；恢复后可安装或升级。
```

首页排序建议：

1. 异常
2. 可升级
3. 已安装
4. 未安装

同一状态内按插件显示名排序。插件数量超过屏幕高度时，列表必须能滚动。

### 插件详情页

从首页进入插件后，先展示插件详情和功能菜单。

详情区只展示简短信息：

- 插件名、版本、简短说明。
- 汇总状态：`未安装`、`已安装`、`可升级`、`异常`。
- 安装摘要继续使用平台徽标和短标签，例如 `✓ Codex:个人`、`○ Codex / Claude`、`! Codex:重复`。
- 如果有问题，只展示一条主要原因和一条建议，不展开内部诊断。

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

平台和位置选择必须发生在功能内部。例如用户选择 `卸载` 后，如果有多个可卸载位置，再展示：

```text
选择卸载位置
- 所有平台
- Codex（个人）
- Claude Code（当前项目）
- 返回
```

不能在进入插件详情时就把所有位置作为第一层导航。

同平台 user/project 重复安装不是“多个可卸载位置”的正常形式，而是独立异常状态。详情页应展示“重复安装”，并提供“保留个人位置 / 保留当前项目位置”或等价的清晰动作；动作内部通过 `cleanup` 或专门的重复安装处理动作收口。不能把重复安装混进普通位置列表，让用户误以为并存是推荐形态。

### 多平台动作

安装、升级、配置、卸载、修复、清理、重新安装、重新应用配置等普通功能，只要当前插件存在两个及以上可处理平台，就必须在平台选择页提供 `所有平台`。`接管共享触发策略` 不属于普通批量动作；它只能针对单个明确 target 执行。

`所有平台` 的范围按当前动作收敛：

- 安装：当前插件声明支持、且在当前上下文可安装的所有平台。
- 升级、配置、卸载、重新安装：当前已有安装或可升级的所有平台。
- 修复、重新应用配置：当前存在对应异常、残留或可刷新项目文件的所有平台。
- 清理：当前插件在该平台有健康安装、可升级安装、可认领状态、残留、半完成状态、外部归属冲突或诊断问题的所有目标；未安装且没有任何诊断问题的候选目标不进入清理范围。

选择 `所有平台` 后：

- 如果所有平台都有相同位置选项，只询问一次 `个人` / `当前项目`。
- 如果位置选项不同，按平台列出待处理目标，让用户逐项确认或跳过。
- 破坏性动作只做一次汇总确认，但确认文案必须列出会写入、删除或清理的平台和位置。
- 配置动作还必须按最终写入的 config scope/store 收口：只有所有目标落在同一个 store 时，才允许把相同配置表单合并成一次填写和一次保存。跨 `user` / `project` store 时，必须拆成 scope 分组，每组独立确认、独立写入，并分别汇总 refresh 结果。
- 执行结果按平台压缩展示，例如 `Codex 已安装，Claude Code 安装失败`；失败平台提供 `诊断` 入口。

shared runtime takeover 的降级规则必须写死：

- `--takeover-shared-runtime` 只允许单个明确 plugin/platform/scope/project target。TUI 不能把多个平台或多个位置合并成一次 takeover 执行，也不能用一次汇总确认代替单目标确认。
- 用户选择 `所有平台` 后，如果预检发现某个目标需要 takeover，普通批量写入不得包含该目标。页面应把需要 takeover 的目标列出来，并要求用户逐个进入单目标 `接管共享触发策略` 流程；其它不需要 takeover 的目标可以继续按普通批量规则执行，前提是确认页明确说明哪些目标会被跳过。
- `所有平台` 的动作模型可以保留批量预检结果，但写命令调用前必须展开成具体 target。带 `takeoverSharedRuntime: true` 的调用必须满足 `targetCount === 1`。

### 状态功能

`状态` 是详情页内的只读子功能，用来展示比详情页更多的信息，但仍然保持友好。

它可以展示：

- 每个位置的状态。
- 每个位置的一条原因摘要。
- 每个位置可执行的下一步动作。

它不展示完整 JSON、不展示内部字段名，也不默认展开底层错误栈。需要进一步定位时，引导用户进入 `诊断`。

状态功能可以展开未生效位置，但必须区分“无安装”和“问题”：

- 未安装的候选位置只显示为中性事实，不计为 `异常`。
- 用户显式查看 `codex/project` 时，如果当前只有 `codex/user` 健康安装，`codex/project` 显示 `未安装`，并附带中性提示 `同平台个人位置已有安装`。
- 只有当前 scope 存在 AW-owned record、project identity、repo-visible artifact、native marker、损坏状态，或同平台重复健康安装时，才显示处理建议。

### 诊断功能

`诊断` 是用户主动进入的细节页面。

它可以运行现有 `diagnoseCommand()` 或 `statusCommand(..., verbose: true)` 的内部能力，但 TUI 中默认仍应压缩成可读摘要：

- 结论。
- 发现的问题。
- 可进入的功能或已明确目标的可执行动作。
- 需要复制到 shell 的命令只作为补充，不作为唯一操作路径。

如果诊断发现 TUI 尚不支持的全局维护动作，例如 dependency index prune，可以展示命令和原因，但不能混在普通插件功能菜单里。

### 状态 / 诊断输入合同

`状态` 和 `诊断` 页面必须消费结构化数据，不能解析人类输出文本，也不能把 `statusCommand(...).output.split('\n')` 或 `diagnoseCommand(...).output` 直接塞进页面。

允许的数据来源：

- `statusCommand()` 返回的 `matrix`、`friendlySummaries`、语义化 console summary。
- `diagnoseCommand()` 返回的 `payload`。
- 基于上述结构生成的 `StatusPageModel` / `DiagnosePageModel` 或等价页面模型。

最小页面模型需要包含：

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

结构化模型负责把诊断语义压缩成用户能行动的信息；人类输出只允许作为 CLI fallback 或诊断页的可复制补充，不允许成为 TUI 判断状态、动作或下一步的依据。

## 功能菜单动作要求

### 安装

适用于未安装插件，也适用于需要修复但更适合重新安装的状态。

流程：

1. 进入 `安装`。
2. 如果插件支持多个平台，选择平台；两个及以上平台可安装时，提供 `所有平台`。
3. 如果目标平台支持多个位置，选择 `个人` 或 `当前项目`；选择 `所有平台` 时，按“多平台动作”规则收敛位置选择。
4. 如果允许配置触发方式，选择 `默认`、`手动`、`自动`。
5. 执行只读预检。
6. 预检通过后，如果缺必填配置，进入配置表单。
7. 配置完成后运行 `installCommand()`。
8. 展示简短结果，然后刷新首页数据。

只读预检必须早于 required config 表单和任何写入动作。Codex project write safety、external ownership、tracking identity、同平台重复安装等阻断原因都必须在配置表单出现前完成判断；预检失败时不得调用配置表单，不得创建或改写 config store，也不得留下任何安装/升级中间状态。

安装中的 required config 必须复用 `配置` 动作的 config write group 规则。选择 `所有平台` 或其它批量安装目标时，TUI 必须先完成整批目标的只读预检，再根据明确的 plugin/platform/scope/project target 计算配置写入组；只有同一 config store 且配置表单 identity 一致的目标，才允许一次填写后复用结果。跨 `user` / `project` store 时，即使 schema 一样，也必须拆成多个 config write group，并分别确认、分别保存、分别汇总结果。不得把整批目标压成一个 `selectedScope`，也不得在部分目标尚未完成预检时先写入任何 config store。

同平台 scope 互斥预检：

- 安装到 `codex/project` 前，如果当前工作上下文已经有健康的 `codex/user` 同名插件，默认拒绝并提示先卸载或迁移个人位置。
- 安装到 `codex/user` 前，如果当前项目已经有健康的 `codex/project` 同名插件，默认拒绝并提示先卸载或迁移项目位置。
- Claude 同理：同一插件在 `claude/user` 和当前项目 `claude/project` 之间也不能作为正常并存状态。
- Codex 和 Claude 属于不同平台，可以分别安装，不构成重复安装。
- 未来如果提供迁移能力，应是明确的 `move scope` / `replace scope` 动作，不要通过普通 install 隐式覆盖另一侧。

这条互斥规则必须落在命令层公共 preflight，而不是只落在 TUI：

- `aw install`、`aw upgrade`、`aw reinstall`、`aw repair`、`aw repair --adopt-existing` 等会让目标变成健康安装的入口，在第一笔写入前都必须检查当前工作上下文中的同平台另一侧 scope。
- 如果目标是 `project`，而同一插件同一平台已有健康 `user` 安装，命令默认失败；如果目标是 `user`，而当前项目已有健康 `project` 安装，也默认失败。
- 失败结果需要带稳定原因码，例如 `duplicateInstall`，并给出明确下一步：先卸载、清理或选择“保留个人位置 / 保留当前项目位置”这类重复安装处理动作。
- `aw cleanup` 和重复安装处理动作可以移除冲突，但不能把两侧都修成健康安装。普通 `aw uninstall` 看到重复安装这类异常状态时应失败并引导用户走清理或重复安装处理流程。
- TUI 调用的只读预检和脚本化子命令必须共用同一套判断，避免出现控制台阻断、direct command 仍可制造重复安装的双重行为。

安装过程中出现不可安装组合时，只展示面向用户的原因，例如：

```text
这个插件不能安装到当前项目，请改为安装到个人位置。
```

### 升级

适用于 `可升级` 或 `catalogCapabilityChanged` 等需要重装/升级的状态。

流程与安装类似，但执行 `upgradeCommand()`，并沿用“先只读预检、再 required config、最后写命令”的顺序。如果同一插件有多个平台可升级，平台选择页提供 `所有平台`，并在执行前汇总展示将升级的平台和位置。升级中的 required config 与安装使用同一套 config write group 规则：整批只读预检完成后，再按 config store 和表单 identity 分组；跨 store 必须拆组确认、拆组写入、拆组汇总。如果某个目标需要共享触发策略接管，TUI 应展示风险说明，并把该目标移入单目标 `接管共享触发策略` 流程；不得对 `所有平台` 或多个 target 调用 `upgradeCommand(..., { takeoverSharedRuntime: true })`。

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

### 重新应用配置

适用于 `artifactRefreshFailed` 或有 tracked dynamic artifact 可刷新时。

要求：

- 直接调用 `reapplyConfigRefresh()`。
- 不修改 config store。
- 多个平台都有可刷新项目文件时，平台选择页提供 `所有平台`。
- 成功后展示 `相关项目文件已更新。`
- skipped 时展示 `没有需要重新应用的项目文件。`
- 失败时展示友好摘要，并提供 `诊断` 入口。

### 卸载

适用于正常已安装、可升级且仍能按标准路径卸载的插件，或可安全移除的自动依赖。`uninstall` 不再承担异常恢复职责。

要求：

- 若跨平台有多个目标，先选择平台，并提供 `所有平台`；同平台重复安装应走“重复安装处理”动作，不当成普通并存位置。
- 必须二次确认。
- 直接调用 `uninstallCommand()`。
- CLI 层移除 `--force`。入口、normalized options、帮助文案、公开文档和测试都不能再保留 `uninstall --force` 语义。
- `uninstallCommand()` 在第一笔删除前必须确认目标和所在插件聚合状态都是正常状态。只要发现 record 损坏、lifecycle/runtime 无法安全重放、native 状态不完整、repo artifact 漂移、可认领状态、残留、重复安装、外部归属冲突、dependency metadata 缺失或其它诊断异常，就直接失败并提示使用 `cleanup`。
- 如果仍被其它插件依赖，菜单项可以显示但必须禁用，并给出简短原因。
- 如果用户选择同时删除配置，调用 `uninstallCommand(..., { removeConfig: true })` 或等价选项；配置删除只发生在主体卸载成功之后，并且只删除当前目标 scope/store 的 AW 自管配置。

重复安装处理：

- 如果同一插件同一平台同时存在 user/project 健康安装，默认状态为 `异常：重复安装`。
- TUI 提供两个明确动作：
  - `保留个人位置`：清理当前项目位置，保留 user 安装。
  - `保留当前项目位置`：清理 user 位置，保留 project 安装。
- 两个动作都必须二次确认，并在执行前说明会删除哪一侧。
- 两个动作都通过 `cleanupCommand()` 或专门的 `resolveDuplicateInstall` 执行层动作收口；不能对异常聚合状态调用普通 `uninstallCommand()` 来绕过卸载前置检查。被删除的一侧如果本身是健康安装，按 `cleanup` 的健康目标规则走正常卸载语义。
- 如果其中一侧不是健康安装，而是残留/损坏，动作文案应变成“清理个人残留”或“清理项目残留”，不能继续称为正常卸载。

### 修复

适用于 `needsRepair`、`nativeIncomplete`、`missingRecord`、`dependencyMissing`、`artifactDrift`、`catalogCapabilityChanged` 等可由 AW 修复的状态。

要求：

- 直接调用 `repairCommand()`，不只展示 `aw repair ...`。
- 多个平台都有可修复目标时，平台选择页提供 `所有平台`。
- 如果状态是可认领的 project artifacts，动作名使用 `认领现有安装`，并调用 `repairCommand(..., { adoptExisting: true })`。
- 如果需要接管共享触发策略，动作名使用 `接管共享触发策略`，并标记为 `singleTargetOnly` 或等价语义。TUI 先展示风险说明，用户确认单个明确 target 后，才能调用 `repairCommand(..., { takeoverSharedRuntime: true })`。
- `repairCommand()` 的 raw options、normalized options 和执行逻辑必须显式支持 `takeoverSharedRuntime`。CLI 的 `aw repair --takeover-shared-runtime`、TUI 的 `runTakeoverSharedRuntime` action 和底层 shared runtime owner preflight 必须走同一条语义链路，不能只在入口层接收 flag。
- 修复完成后刷新控制台数据。

### 清理

适用于所有可定位目标：健康安装、可升级安装、残留、marker-only、半完成状态、可认领状态、受控 native residue、外部归属冲突，以及 `diagnose` 能发现的其它插件级问题。`cleanup` 是用户遇到异常时进入恢复评估、恢复执行或强制移除的统一入口；它必须尽力把目标恢复到可继续使用状态，但不能越过安全边界承诺所有异常都能自动恢复。

要求：

- 直接调用 `cleanupCommand()`，不只展示 `aw cleanup ...`。
- 多个平台都有可清理目标时，平台选择页提供 `所有平台`。
- 必须二次确认。
- 健康安装或可升级安装走与 `uninstall` 等价的正常卸载语义，包括历史 `uninstall` lifecycle、平台 native uninstall、repo-visible artifacts、project artifact identity、dynamic diagnostic cache、install record 和 dependency index 更新。
- 如果健康目标的正常卸载路径因为 lifecycle/runtime 缺失、native 状态异常或共享 runtime 无法安全重放而失败，普通 `cleanup` 失败并提示 `cleanup --force`；用户显式加 `--force` 后，允许降级为恢复清理，不再依赖无法验证的正常卸载步骤。
- 异常、残留、半完成和可认领状态走 best-effort 恢复清理：优先删除 AW-owned install record、project artifact identity、dynamic diagnostic cache、historical lifecycle runtime、native transaction marker、repo-visible artifacts、平台 native residue 和其它能定位到的插件状态。
- `cleanup` 必须覆盖 `diagnose` 报出的恢复问题。诊断页不能长期给出“发现异常但没有统一恢复入口”的结论；如果问题能由 `repair` 或 `uninstall` 更温和地解决，仍可优先推荐它们，但必须提供 `cleanup` 作为最终恢复评估入口。若 `cleanup` 无法安全自动恢复，结果必须说明阻断原因、已知冲突面和人工处理建议。
- 默认 `cleanup` 不能越过依赖保护。目标仍被其它已安装插件依赖时，普通清理失败并列出 dependents；`cleanup --force` 可以移除目标，但不级联删除依赖它的插件，结果页必须提示这些 dependents 可能需要后续 `repair`、`reinstall` 或 `cleanup`。
- 默认 `cleanup` 不能删除外部归属或非 AW-owned 的冲突内容。`cleanup --force` 可以删除可定位的外部冲突内容，但执行层必须先产出删除计划，并且每一项都要满足这些条件：
  - 能归类到 AW 已知 surface，例如 shared runtime owner 记录、平台 native plugin 条目、repo-visible artifact、project artifact identity、dynamic diagnostic cache、install/native transaction marker，或 manifest/record 能精确定位的插件级文件。
  - 能在执行前枚举具体删除项，包括路径、native identifier、owner key、config block key 或等价稳定标识；不能只描述成“删除某目录下的冲突内容”。
  - 能证明删除项属于当前 plugin/platform/scope 的冲突面，或是阻断当前目标恢复的同名 plugin surface；不能删除其它插件、其它 scope/project 的配置、dependency 插件、未知第三方文件、父目录或无法归属的任意内容。
- 外部冲突删除计划里无法归类、无法枚举或无法证明目标归属的项目必须阻断 `cleanup --force`，并在结果里列出跳过原因和人工处理建议；不能把它们降级成 warning 后继续宣称目标已恢复。
- 如果需要 `--force`，TUI 必须单独说明风险来源。确认页必须列出外部冲突删除计划、受影响的 dependents、降级清理原因、备份策略以及不可删除项。可备份的共享配置或 repo-visible 文件应尽量先备份；不能备份时必须在确认页说明。
- direct CLI 必须支持 `aw cleanup <plugin> ... --plan`，只做读取、诊断和计划生成，不执行 lifecycle/native 卸载、文件删除、配置写入、备份写入或 state 修改。`--plan --json` 输出机器可读计划；普通输出也要列出 force reason、planned removals、would-backup items、skipped foreign items、affected dependents、blocking reasons 和最终需要用户确认的高风险范围。
- `aw cleanup --plan` 和 `aw cleanup --force` 必须复用同一套目标解析、归属校验、依赖检查和删除计划生成逻辑。状态在两次命令之间变化时，`--force` 以执行时重新生成的计划为准；receipt 必须输出实际执行的计划，不能只引用之前的预览结果。执行 receipt 中的实际计划必须和 `--plan --json` 使用同一个 `cleanupPlanSchemaVersion` 边界。
- direct CLI 中，`aw cleanup --force ...` 不再额外要求 `--yes` 或 plan token；`--force` 本身就是高风险执行确认。命令仍必须执行同一套删除计划校验，并在普通输出和 JSON receipt 中暴露 force reason、planned removals、backups、skipped foreign items、affected dependents 和最终未清项。`diagnose` 在提示 force cleanup 时，应优先给出 `aw cleanup ... --plan` 作为执行前预览入口，再提示 `aw cleanup ... --force`。
- direct CLI 的 `cleanup --plan` 选项矩阵必须固定：
  - `--plan` 只适用于普通插件 target cleanup，仍要求单插件、单平台、明确 scope/project target；不适用于 `cleanup --dependency-index --prune-stale`。
  - `aw cleanup --dependency-index --prune-stale <token> --plan` 非法；dependency-index prune 仍走既有 `--yes` 确认合同。
  - 普通插件 target cleanup 不接受 `--yes`。`--yes` 不能替代 `--force`，也不能影响 `--plan`；传入时必须报错并说明它只用于 `cleanup --dependency-index --prune-stale`。
  - `--plan --force` 合法，但仍然只读。这里的 `--force` 表示“按 force 执行语义生成高风险删除计划”，不是执行确认；输出必须列出 force reason、planned removals、would-backup items、skipped foreign items、affected dependents 和 blocking reasons。真正执行时仍需要用户单独运行 `aw cleanup ... --force`，并以执行时重新生成的计划为准。
  - 不带 `--force` 的 `--plan` 只预览普通 cleanup 会执行或阻断的内容；如果目标需要高风险清理，输出 blocking reasons，并提示可运行 `aw cleanup ... --plan --force` 查看 force 计划。
  - `--plan --remove-config` 合法且只读。普通输出和 JSON 都必须表达“主体清理成功后将删除当前 target scope/store 的 AW 自管配置”；如果主体清理被阻断，配置删除计划必须标记为 blocked/skipped，不能显示成会单独执行。
  - `--plan --json` 输出稳定计划 schema，并从首版开始带 `cleanupPlanSchemaVersion: 1`。schema 至少包含 `dryRun: true`、`force`、`removeConfig`、`plannedRemovals`、`wouldBackups`、`wouldRemoveConfig`、`skippedForeignItems`、`affectedDependents`、`blockingReasons` 和最终建议的执行命令。
  - `cleanupPlanSchemaVersion` 是 `cleanup` 删除计划机器合同的版本边界。后续如果调整 `plannedRemovals`、`wouldBackups`、`wouldRemoveConfig`、`blockingReasons` 或执行 receipt 中同构计划的结构，必须提升该版本或提供明确兼容策略，不能让消费者只靠字段猜测计划版本。
- `cleanup --force` 可以继续尝试后续删除，即使某些单项删除失败；但清理后如果该目标仍有诊断异常或可定位残留，最终结果必须失败并列出未清项，不能用 warning 把未恢复状态包装成成功。
- 如果用户选择同时删除配置，调用 `cleanupCommand(..., { removeConfig: true })` 或等价选项；配置删除只发生在主体清理成功之后，并且只删除当前目标 scope/store 的 AW 自管配置。
- `cleanup` 删除配置失败时不回滚已经完成的主体清理，但整体结果必须明确标记配置仍未删除，JSON receipt 也要暴露该失败。

### 删除自管配置

`aw uninstall` 和 `aw cleanup` 都提供 `--remove-config`，TUI 中展示为破坏性确认项，例如 `同时删除配置`。

要求：

- 删除范围是本次命令目标对应的 AW 自管 config store：`--scope user` 只删 user store，`--scope project` 只删当前 project store。不会顺手删除其它 scope，也不会删除其它项目的配置。
- `所有平台` 只存在于 TUI 页面模型，不能作为 direct command target 传入命令层。TUI 在写命令前必须把它展开成明确的 plugin/platform/scope/project target。
- 选择 `所有平台` 或其它 TUI 批量动作时，如果多个 target 落在同一个 config store，TUI 编排层只删除一次；如果跨多个 scope/store，TUI 按 store 分组展示、确认、执行和汇总。
- direct `aw cleanup --remove-config` 保持单插件、单平台、单 scope 目标，不负责解释 `所有平台` 或跨 target 去重。direct `aw uninstall --remove-config` 只处理命令自身实际展开出的 execution target，不能接收 TUI 的 `所有平台` 抽象。
- direct `aw uninstall --remove-config` 的配置删除执行单元是 `(plugin, scope, projectKey?)` 对应的 config store，不是单个 platform target。同一条命令如果展开出同一 store 下的多个 execution target，必须等该 store 下本次涉及的所有主体卸载都成功后，才删除一次配置。
- 配置删除发生在主体卸载或清理成功之后。主体失败时保留配置，避免插件仍在但配置被先删掉。对 direct `aw uninstall --remove-config`，只要某个 store 分组里还有任一 execution target 主体卸载失败，就保留该 store 的配置，并在结果页和 JSON receipt 中单独标记“主体失败，因此跳过 remove-config”。
- 配置删除失败不回滚主体删除；结果页和 JSON receipt 必须把主体删除结果和配置删除结果分开展示。
- `aw config reset` 仍保留为独立配置管理入口。`--remove-config` 只是把同一 target 的配置清理串到删除流程后面，不替代完整配置管理命令。

### 重新安装

适用于用户想用 current catalog 重新落一遍插件的明确操作。

要求：

- 直接调用 `reinstallCommand()`。
- 多个平台都有可重装目标时，平台选择页提供 `所有平台`。
- 必须二次确认，因为它可能先卸载或清理再安装。
- 如果当前是 `可认领` 状态，不展示 `重新安装`，优先展示 `认领现有安装`。
- 如果需要 `cleanup --force` 或依赖保护阻止隐式清理，展示阻断说明，不自动降级成其它动作。

### 状态与诊断

`状态` 和 `诊断` 都在 TUI 内展示，不要求用户退出执行命令。

`诊断` 页面可以附带可复制命令作为补充，但不能把“复制命令”当成该功能的主结果。

## 快捷键与导航

全局快捷键适用于菜单页和选择页：

- `b`：返回上一页。
- `q`：退出控制台。
- `Esc`：返回上一页；如果已经在首页，则退出控制台。
- `Ctrl+C`：安全退出控制台。

输入框和密码框中，`b` 与 `q` 作为普通字符处理；`Esc` 取消当前输入并返回上一页。

为支持这些快捷键，需要把 prompt 层的结果语义从“只返回 value 或 cancelled”扩展为：

```ts
type CliPromptNavigation = 'select' | 'back' | 'exit' | 'cancel';
```

或等价结构。控制器不能靠特殊字符串 `__back`、`__exit` 作为唯一导航协议。

## 渲染与状态信息

TUI 需要从追加式输出改成页面式输出。

要求：

- 每次进入新页面时，清理上一页的控制台区域或整屏重绘。
- 操作结果作为短 banner 显示在当前页顶部，例如：

  ```text
  已安装 git-commit 到 Codex（个人）。
  ```

- 长输出不直接插入操作菜单。需要查看时进入 `状态` 或 `诊断`。
- 错误只展示简短摘要和下一步，不在默认页展示完整内部错误。
- debug log 路径只在 `--debug` 或显式诊断中出现。

当前 `createDefaultConsoleDriver()` 需要替换或增强。测试 fake driver 继续保留，方便断言页面模型。

## 数据模型调整

### 语义状态投影规则

TUI、`status --json.consoleItems` 和友好摘要应共用一套更收敛的语义投影规则。这里的“共用”指状态、原因码、可用功能和下一步语义一致；图标、颜色、badge、主按钮文案等页面呈现细节不进入公开 JSON 合同。

用户可见状态只保留四类：

```ts
type PluginConsoleStatus =
  | 'notInstalled'
  | 'installed'
  | 'upgradeAvailable'
  | 'abnormal';
```

展示文案分别是 `未安装`、`已安装`、`可升级`、`异常`。如果内部实现仍保留 `needsAction`、`partial`、`repoManaged` 等旧状态，进入首页、详情页和 `status --json.consoleItems` 的友好字段前必须映射成上述四类，不能把旧状态名直接展示给用户。

#### 缺省能力静默

以下情况不是问题，不计为 `abnormal`，不生成默认下一步：

- 插件没有声明 lifecycle 脚本。
- 插件没有声明 config schema。
- 插件没有声明某类 artifact target。
- 某个平台或 scope 没有安装记录。
- current catalog 中的插件尚未安装。
- snapshot fallback 的唯一原因是“snapshot 没有声明当前 lifecycle event”，且当前命令只是只读状态展示。

只有以下情况才是问题：

- 声明过并写入过的 artifact 缺失、漂移或刷新失败。
- 已安装插件声明 required config，但当前安装位置缺少必需值或配置无效。
- install record、project identity、native transaction marker、dependency edge 等 AW-owned 状态损坏或互相矛盾。
- Codex user native 安装缺少 enabled config、active cache 或 AW record 中任一必需组成。
- 同一插件同一平台在 user 和当前 project 同时健康安装。
- 文件缺失、记录缺失或可认领安装等导致 AW 无法确认插件处于健康状态的情况。

#### 同平台 scope 唯一安装

投影时先按 `(plugin, platform, currentProjectContext)` 聚合 user/project：

- 只有 user 健康安装：汇总为 `installed`，位置是 `Codex（个人）` 或 `Claude Code（个人）`。
- 只有当前 project 健康安装：汇总为 `installed`，位置是 `Codex（当前项目）` 或 `Claude Code（当前项目）`。
- user 和当前 project 都健康：汇总为 `abnormal`，原因是 `重复安装`。
- 一侧健康、一侧只是未安装：汇总为健康安装，不展示“多个位置”。
- 一侧健康、另一侧有真实 AW-owned 残留：汇总为 `abnormal`，原因是“健康安装旁边仍有残留”，下一步只针对残留侧。
- 两侧都未安装：汇总为 `notInstalled`，位置显示为“尚未安装”，可安装目标按平台能力展示。

`多个位置` 只能用于跨平台摘要，例如同时安装了 Codex 和 Claude Code。它不能表示同一平台 user/project 并存。

重复安装必须使用稳定原因码 `duplicateInstall` 或等价 schema 字段。TUI、人类摘要和 direct command 错误都应从这个原因码派生文案和下一步动作，不能靠解析中文 `重复安装` 标签判断行为。

#### foreign shared runtime owner

shared skill trigger owner 是共享运行时的归属记录，不等同于每个 scope 的安装证据。

- 如果 project scope 没有自己的 install record、project identity、repo artifact、diagnostic cache 或 native marker，仅仅因为同平台 user scope 拥有 shared runtime owner，project 不能被判为残留。
- 如果 owner 指向另一个 scope，但当前 scope 的期望 runtime 语义一致，不应显示问题。
- 如果当前 scope 要改写 shared runtime 且语义会变化，才显示 `接管共享触发策略`。
- Codex project scope 的状态页可以把 foreign owner 作为诊断事实，但默认详情页不应把它当成项目残留。

### 首页需要 catalog-only item

TUI 首页必须能拿到 current catalog 中没有安装证据的插件。

必须新增 console 专用加载路径，而不是让默认 `aw status` 立刻展示所有未安装插件：

```ts
loadConsoleItems({
  includeCatalogOnly: true,
})
```

这条路径可以复用 `discoverManagedPluginNames()`、current catalog 和 V2 summary projector，但需要在 `status` 默认过滤逻辑之外保留 catalog-only 插件，并投影为 `notInstalled`。它是 TUI/console 页面数据源，不是公开 `status --json` 合同。

默认 `aw status --json.consoleItems` 不包含纯 catalog-only 插件。`consoleItemsSchemaVersion: 2` 只表示 `consoleItems` 的元素 shape、状态枚举和 action 分层升级，不表示默认 `status` 会把所有 current catalog 未安装插件纳入输出。公开文档和迁移说明必须明确这个边界，避免消费者误以为 `status --json` 可以作为插件市场/catalog 列表 API 使用。

### `status --json.consoleItems` 版本化迁移

本轮 `consoleItems` 的状态枚举、action kind 和元素 shape 都会变化，不能在同一个稳定合同名下静默替换。按版本化 breaking change 收口：

```ts
interface StatusJsonPayload {
  ok: true;
  command: 'status';
  consoleItemsSchemaVersion: 2;
  consoleItems: PluginConsoleSummary[];
}
```

迁移要求：

- `consoleItemsSchemaVersion: 2` 是机器消费者识别新合同的边界；实现不能在没有版本字段时输出 V2 shape。
- V2 `consoleItems` 使用本 spec 的 `PluginConsoleSummary[]`。旧的 `needsAction`、`partial`、`external` 等状态必须映射到四类新状态；旧的 `openInstallWizard`、`repairInstall`、`cleanupRecovery`、`diagnoseCommand` 等 action kind 不能原样混入 V2 summary。
- V2 `consoleItems` 沿用 `status` 的结果集边界。没有安装证据、runtime 证据或读取错误的纯 catalog-only 插件，只出现在 console 专用加载路径返回的首页模型里，不出现在默认 `aw status --json.consoleItems`。
- `detection`、`summaries`、`cells`、`reports`、`friendlySummaries` 等既有顶层字段如果本轮不改语义，应保持兼容；本轮 breaking change 只针对 `consoleItems` 合同和依赖它的公开说明。
- 公开文档必须同步说明 `consoleItemsSchemaVersion: 2`、旧字段/枚举到新字段/枚举的迁移关系，以及旧消费者需要在迁移窗口内完成适配。实现和测试落地时，必须一起更新 `docs/architecture.md`、`docs/plugin-installation.md` 等公开文档。
- TUI 可以在内部直接消费 V2 summary，但测试必须覆盖：同一运行结果不会在 `consoleItemsSchemaVersion: 2` 下输出旧 action kind，也不会在缺少版本字段时输出新 shape。

### 语义 summary、功能菜单与执行 action 三层模型

本轮不要把纯 TUI 展示字段塞进 `status --json.consoleItems`。公开 JSON 和跨命令复用的合同只承载语义状态和可用功能，暂命名为 `PluginConsoleSummary`；V2 `consoleItems` 的元素必须遵守这层 summary schema。

建议语义层字段：

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
  targetSelection: 'none' | 'singleTarget' | 'multiTargetAllowed' | 'singleTargetOnly';
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

`PluginConsoleSummary.features` 是详情页第一层功能菜单的数据来源，只表达“当前插件可以进入哪些功能”和目标选择策略。它不是可执行 action 列表，不能携带最终写入 target、confirmText 或可复制命令。

TUI 页面层再把 summary 映射成呈现字段：

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

首页优先渲染 `ConsolePageItem.statusIcon`、`statusTone` 和 `platformBadges`。`summaryText` 只用于详情页、状态页或无颜色环境的降级展示，避免首页回到长句摘要。

`PluginConsoleTargetOption` 和 `ConsolePluginDetailPageModel.targetOptions` 只属于 TUI 页面模型，用来驱动目标选择页，不进入 `status --json.consoleItems` 的稳定 schema。目标选项可以由 console 专用加载路径结合 current catalog、`installedLocations`、duplicate group 和只读预检结果派生；公开 `PluginConsoleSummary` 不承诺目标选择页所需的展示 label、排序或禁用原因。

`PluginConsoleSummary.installedLocations` 可以继续保留给状态和诊断用，但详情页不再直接把 location 列表作为第一层菜单。详情页第一层菜单只从 `summary.features` 派生；目标选择页再结合页面模型的 `targetOptions`、`installedLocations`、duplicate group 和预检结果生成执行层 action。`statusIcon`、`statusTone`、`platformBadges`、`primaryActionLabel`、`targetOptions` 等字段只属于 `ConsolePageModel` / `ConsolePageItem` / 详情页页面模型，不得出现在 `status --json.consoleItems` 的稳定 schema 中。

### 执行层 action 补充直接动作

建议把“展示命令”的动作拆成真正可执行动作。写动作的执行层 action 只在用户已经选完平台、scope 和项目位置后生成；只读的 `状态`、`诊断` 可以生成插件级页面跳转。`PluginConsoleActionKind` 不用于 `PluginConsoleSummary.features`，避免把第一层功能菜单误当成最终写动作。

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

所有写动作必须带明确 target；只有 `openStatus`、`openDiagnose` 这类只读页面跳转可以没有 target，并表示插件级视图。`所有平台` 也必须展开成一组 `PluginConsoleExecutableAction` 后再执行，不能只保存一个含糊的 `all` target。破坏性动作必须带 `destructive: true` 和 `confirmText`。

`force` 只能出现在 `runCleanup` 上，表示用户已经看过并确认高风险清理范围；`runUninstall` 不能生成 `force: true`。`removeConfig` 只能在 `runUninstall` 和 `runCleanup` 上使用，表示主体删除成功后继续删除当前 target scope/store 的 AW 自管配置。TUI 批量动作要在编排层按 config store 去重；direct `uninstall --remove-config` 则由命令层按 `(plugin, scope, projectKey?)` 分组，并在同一 store 下所有主体卸载成功后再删一次。

`runConfig` 的执行模型还必须带明确的写入 scope/store。选择 `所有平台` 后，如果配置目标跨 `user` / `project` store，页面 model 应生成多个 config write group，而不是把整批目标压成一个 `selectedScope`。

`command?: string[]` 只作为诊断页里的补充信息，不进入 `PluginConsoleFeatureSummary` 或 `PluginConsoleExecutableAction`。普通功能菜单不能靠命令字符串完成执行。

`runTakeoverSharedRuntime` 必须带 `targetPolicy: 'singleTargetOnly'` 或等价字段。批量预检可以发现多个 takeover 候选，但不能生成一个多 target takeover action；每个候选都必须独立确认、独立调用写命令、独立展示结果。

## 验收标准

### 首页

- 在没有任何安装证据时，裸 `aw` 首页仍显示 current catalog 插件，并能选择未安装插件进入详情页。
- 未安装插件详情页显示 `安装`、`配置`（如果有 schema）、`状态`、`诊断`、`返回`、`退出`。
- 首页用状态图标、颜色和平台徽标展示安装状态和可安装平台，不要求用户先进入平台列表。
- 只有 `codex/user` 健康安装时，首页显示绿色已安装状态和 `Codex:个人` 徽标，不显示 `多个位置`，也不把 `codex/project` 的未安装状态当成问题。
- 同一插件同时存在 `codex/user` 和当前 `codex/project` 健康安装时，首页显示 `异常` 和 `Codex:重复`，而不是普通 `已安装：多个位置`。
- 首页不出现 `由其它来源管理`、`部分可用`、`需要处理` 这类友好状态。
- 插件没有 lifecycle、没有 config schema 或没有某类 artifact 时，首页不显示注意或处理建议。

### 详情页

- 跨平台有多个安装位置的插件，进入详情页后先看到功能菜单，而不是位置列表。
- 同平台 user/project 重复安装的插件，进入详情页后显示重复安装处理动作，而不是普通位置列表。
- 选择 `卸载`、`配置`、`修复` 等功能后，才进入目标选择；多个平台可处理时提供 `所有平台`。
- 详情页第一层功能菜单来自 `PluginConsoleSummary.features`，不能直接消费 summary 顶层的可执行写动作。
- `状态` 和 `诊断` 是独立功能，不和操作菜单混在同一页长输出里。
- 用户显式查看未安装的候选 scope 时，详情显示 `未安装`，不显示 `残留` 或 `异常`，除非该 scope 真的有 AW-owned 状态。

### 直接执行

- `认领现有安装` 直接调用 `repairCommand(..., { adoptExisting: true })`。
- `接管共享触发策略` 只在单个明确 target 上确认并调用对应写命令的 takeover 语义；`所有平台` 不能一次接管 shared runtime。
- `repair --takeover-shared-runtime` 不会在 normalize 阶段丢失；TUI 触发的 `runTakeoverSharedRuntime` 与 direct command 使用同一个 `RepairCommandOptions.takeoverSharedRuntime` 或等价字段。
- `runUninstall` 不会生成或传递 `force`；异常目标选择卸载时会失败或转入 `cleanup`，不会用卸载命令硬删。
- `清理` 直接调用 `cleanupCommand()`。健康目标走等同 `uninstall` 的正常卸载语义；异常目标走恢复清理语义。
- TUI 的 `cleanup --force` 只在用户确认高风险范围后生成，用于越过依赖保护、删除已计划且可定位的外部归属冲突内容，或从失败的正常卸载路径降级到恢复清理。direct CLI 必须提供 `aw cleanup --plan` 预览同构删除计划；`--plan --json` 和执行 receipt 中的同构计划都必须带 `cleanupPlanSchemaVersion: 1`；`--force` 本身即为执行确认，不额外要求 `--yes` 或 plan token。
- 外部归属冲突只有在删除计划能枚举具体 surface 且能证明属于当前目标冲突面时，才能被 `cleanup --force` 删除；无法归类或无法证明归属的外部内容必须阻断，并在 receipt 中列出。
- `cleanup --force` 可以继续尝试后续删除，但如果清理后目标仍有诊断异常或残留，结果必须失败并列出未清项。
- `runUninstall` 和 `runCleanup` 支持 `removeConfig`。主体删除成功后才删除当前 target scope/store 的 AW 自管配置，结果页分别展示主体删除和配置删除结果。direct `uninstall --remove-config` 如果展开出同一 store 下多个 target，只有整组主体卸载成功后才删配置；任一 target 主体失败时保留该 store 配置并展示跳过原因。
- `重新安装` 直接调用 `reinstallCommand()`。
- `保留个人位置` / `保留当前项目位置` 这类重复安装处理动作直接调用 `cleanupCommand()` 或专门的 `resolveDuplicateInstall` 动作；不能用普通 `runUninstall` 处理异常聚合状态。
- `配置` 选择 `所有平台` 后，只有目标落在同一个 config store 且表单一致时才合并填写和保存；跨 `user` / `project` store 时按 scope/store 分组确认、写入和展示结果。
- `安装` 和 `升级` 必须先执行只读预检；预检失败时直接展示阻断原因，不进入 required config 表单，不创建或改写 config store。预检通过后，如果批量目标需要补 required config，必须复用 `配置` 动作的 config write group 规则：同一 config store 且表单 identity 一致才合并填写和保存，跨 store 必须拆组处理。
- 安装、升级、卸载、修复、清理、重装等普通动作选择 `所有平台` 后，一次确认并按平台执行，结果页按平台显示成功或失败。需要 takeover 的平台必须跳出批量写入，转入单目标确认。
- `所有平台` 的 `removeConfig` 去重和分组发生在 TUI 编排层；执行前已经展开成明确 target，命令层不会收到含糊的 `all platforms` 目标。direct `uninstall` 自身展开出的多 target 仍由命令层按 config store 分组。
- 所有执行层写动作都是 `PluginConsoleExecutableAction`，并且在调用 command 前已经带完整 target。
- 不再出现只能复制命令、不能执行的普通功能菜单项。

### 快捷键

- 菜单页按 `b` 返回上一页。
- 菜单页按 `q` 退出控制台。
- 菜单页按 `Esc` 返回，首页按 `Esc` 退出。
- 输入页按 `Esc` 取消输入并返回上一页。
- controller 消费 prompt 层的稳定导航结果，例如 `back` / `exit` / `cancel`；不能把所有页面都绑定在特殊字符串 `__back` / `__exit` 上。

### 渲染

- 连续执行安装、返回、进入详情、查看状态时，旧页面不会一直向下堆叠。
- 操作结果以短 banner 或结果页展示，用户确认后回到刷新后的详情页或首页。
- 默认页面不展示内部术语、长错误栈或 JSON。
- 默认页面不展示 `Lifecycle install snapshot ... does not declare "install" lifecycle script` 这类可选能力缺省信息。

### 测试建议

- `console-model.test.ts`
  - console 专用加载路径包含 catalog-only 插件，并投影为 `notInstalled`。
  - 默认 `aw status --json.consoleItems` 不包含纯 catalog-only 插件；`consoleItemsSchemaVersion: 2` 只改变 summary shape，不扩大默认 status 结果集。
  - `PluginConsoleSummary` 只包含语义字段和 `features`，不包含执行层写动作；`status --json.consoleItems` 不泄露 `statusIcon`、`statusTone`、`platformBadges`、`primaryActionLabel`、`targetOptions`、`availableTargets` 这类页面字段。
  - `status --json` 输出 `consoleItemsSchemaVersion: 2` 后，`consoleItems` 使用 V2 summary shape，不再混入旧 action kind 或旧状态枚举。
  - `ConsolePageModel` / `ConsolePageItem` 从 summary 派生 `statusIcon`、`statusTone`、`platformBadges` 和 `primaryActionLabel`；详情页页面模型在公开 summary 之外生成 `targetOptions`。
  - adopt、takeover、cleanup、reinstall 在目标选择后生成执行层直接动作，不再伪装成 `diagnoseCommand`。
  - takeover 执行动作标记为单目标，不能生成多 target action。
  - 同平台 user/project 同时健康安装投影为 `abnormal` + `重复安装`。
  - 一侧健康、一侧未安装不投影为 `多个位置`。
  - 旧的 `needsAction`、`partial`、`repoManaged` 等内部状态不会变成首页友好状态，只会映射为 `异常`。
  - optional lifecycle/config/artifact 缺省不会生成 `issueSummary` 或 `nextSteps`。

- `console.test.ts`
  - 首页能选择未安装插件并执行安装。
  - 多位置插件进入详情页时先显示功能菜单。
  - 选择功能后才选择平台和位置；跨平台可处理时出现 `所有平台`。
  - 选择 `所有平台` 后会展开成具体平台和位置，确认后按平台调用对应 command。
  - `所有平台` 预检遇到 takeover target 时，普通批量写入跳过该 target，并引导用户进入单目标 `接管共享触发策略`。
  - 修复、清理、重装动作调用对应 command。
  - 选择 `卸载` 时不会出现或传递 `--force`；异常目标的卸载入口给出阻断原因并引导到 `清理`。
  - 选择 `清理` 健康目标时确认页说明它会按正常卸载语义执行；选择异常目标时确认页说明它会做恢复清理。
  - 需要 `cleanup --force` 的目标必须先展示依赖、外部归属或降级清理风险；用户取消确认时不写状态。
  - `同时删除配置` 只在 `卸载` 和 `清理` 的确认流程里出现，且传递 `removeConfig`。
  - `所有平台` 搭配 `同时删除配置` 时，TUI 会先展开具体 target；多个 target 命中同一 config store 时只删除一次，跨 scope/store 时分组确认并分别汇总。
  - 写动作取消确认时不写状态。
  - 安装/升级只读预检失败时不调用 required config 表单，也不创建或改写 config store。
  - 安装/升级选择 `所有平台` 且多个 target 缺 required config 时，TUI 会在整批预检完成后按 config store 和表单 identity 分组；同 store 同表单只填写一次，跨 `user` / `project` store 时拆组确认、拆组写入，并分别汇总结果。
  - 安装到 user 时，如果当前 project 已有同平台健康安装，TUI 阻断并提示先处理重复安装；反向同理。
  - 重复安装处理动作二次确认后只删除用户选择删除的那一侧。

- direct command 互斥预检测试
  - `aw install` / `aw upgrade` / `aw reinstall` / `aw repair --adopt-existing` 在同平台另一侧 scope 已健康安装时，在任何写入前失败，返回 `duplicateInstall` 或等价稳定原因。
  - `aw repair --takeover-shared-runtime` 的 CLI flag 会进入 `repairCommand()` 的 normalized options，并在 shared runtime owner preflight / repair pipeline 中生效；测试应防止入口接收 flag、命令层实际忽略的回归。
  - `aw uninstall` 看到重复安装异常时失败并提示 `cleanup` 或重复安装处理动作；`aw cleanup` 和重复安装处理动作仍可移除冲突，不被互斥预检误拦截。

- `uninstall` / `cleanup` command 测试
  - `aw uninstall --force` 不再被 CLI 接受；help、options normalize 和公开文档都不再出现该选项。
  - `aw uninstall` 只处理正常状态。record 损坏、lifecycle/runtime 无法安全重放、native 状态不完整、artifact 漂移、可认领状态、残留、外部归属冲突或 dependency metadata 异常时，在删除前失败并提示 `cleanup`。
  - `aw cleanup` 可以处理健康安装，并在正常路径可用时执行与 `uninstall` 等价的 lifecycle、native uninstall、artifact 删除和 state 清理。
  - 健康目标的正常卸载路径失败时，普通 `cleanup` 失败；`cleanup --force` 可以降级为恢复清理。
  - 目标仍有 verified dependents 时，普通 `cleanup` 失败；`cleanup --force` 可以移除目标，但不级联删除 dependents，并在 receipt 中列出受影响插件。
  - direct CLI `aw cleanup --plan` 不写状态、不删除文件、不创建备份，但会输出与 `--force` 执行同构的 force reason、planned removals、would-backup items、skipped foreign items、affected dependents 和 blocking reasons；`--plan --json` 有稳定 JSON schema，并输出 `cleanupPlanSchemaVersion: 1`。
  - `aw cleanup --plan` 与 `aw cleanup --force` 复用同一套目标解析、归属校验、依赖检查和删除计划生成逻辑；测试要覆盖预览与执行 receipt 的计划字段同构，并确认两者使用同一个 `cleanupPlanSchemaVersion`。
  - `aw cleanup --plan --force` 合法且只读，会生成 force 语义下的高风险计划；不带 `--force` 的 plan 遇到高风险清理时只输出阻断原因和 `--plan --force` 预览建议。
  - `aw cleanup --plan --remove-config` 合法且只读，JSON 中包含 `wouldRemoveConfig`；主体清理被阻断时，该字段标记为 skipped/blocked。
  - `aw cleanup --dependency-index --prune-stale <token> --plan` 非法；普通插件 target cleanup 传入 `--yes` 也非法，错误需要说明 `--yes` 只用于 dependency-index prune。
  - direct CLI `aw cleanup --force` 不额外要求 `--yes` 或 plan token；`--yes` 仍只用于 `cleanup --dependency-index --prune-stale` 这类已有确认路径。
  - 外部归属或非 AW-owned 冲突默认阻断 `cleanup`；`cleanup --force` 可以删除可定位、可枚举、可证明属于当前目标冲突面的外部内容，并在确认信息和 receipt 中列出删除范围。
  - 外部冲突删除计划包含未知 surface、无法枚举路径/native id/owner key/config block，或可能命中其它插件、其它 scope/project、dependency 插件、父目录、未知第三方文件时，`cleanup --force` 必须失败并列出人工处理建议。
  - `cleanup --force` 遇到单项删除错误会继续尝试其它删除；如果最终仍有残留或诊断异常，命令返回失败并列出未清项。
  - `aw uninstall --remove-config` 和 `aw cleanup --remove-config` 只在主体删除成功后删除当前目标 scope/store 的 AW 自管配置；主体失败时配置保留。
  - direct `aw uninstall --remove-config` 展开出同一 `(plugin, scope, projectKey?)` config store 下多个 execution target 时，主体卸载全部成功后只删除一次配置；任一 target 失败时保留该 store 配置，并在 receipt 中标记跳过原因。
  - direct `aw cleanup --remove-config` 仍要求单插件、单平台、单 scope；传入 `auto` / `both` / 多插件时仍按 cleanup 单 target 合同失败。

- `console-entry.test.ts`
  - 裸 `aw` 在 fake prompt 下能从 catalog-only 插件完成安装。
  - 非 TTY / CI 行为保持不挂起。

- `status` / `diagnose` 相关测试
  - `aw status git-commit -p codex` 在只有 user 安装时不生成 project 残留。
  - `aw status git-commit -p codex -s project` 在只有 user 安装时显示 project 未安装，并给出中性提示，不建议 cleanup project。
  - install snapshot 没声明 install lifecycle 时，普通 status/TUI 不输出 warning；诊断页最多作为中性事实展示。
  - foreign shared runtime owner 不单独把 project scope 判成 residual。
  - `diagnose` 报出的插件异常都能映射到统一恢复评估入口。优先动作可以是 `repair`、`uninstall` 或其它更温和流程，但诊断模型必须能生成最终 `cleanup` 评估路径；需要高风险删除时先标记 `cleanup --plan` 预览入口，再给出 `cleanup --force` 执行入口；如果无法安全自动恢复，receipt 必须列出阻断原因、已知冲突面和人工处理建议。
  - TUI `状态` / `诊断` 页面只消费结构化 `matrix`、`friendlySummaries`、console summary 或 diagnose `payload`；测试中让 `output` 包含误导性文本也不会影响页面状态和动作。

- `runtime` 或 prompt adapter 测试
  - `b`、`q`、`Esc` 映射为稳定导航结果。
  - 输入框中的普通 `b`、`q` 不被当作快捷键。
  - controller 根据稳定导航结果返回、退出或取消输入，不依赖 `__back`、`__exit` 这类菜单 value 作为唯一协议。

## 实施顺序建议

1. 先修正友好状态投影：缺省能力静默、foreign shared runtime owner 不算 project 残留、同平台 user/project 重复安装投影为异常。
2. 调整删除类命令合同：移除 `uninstall --force`；让 `uninstall` 只处理正常状态；扩展 `cleanup` 覆盖所有状态和诊断恢复评估路径；增加 direct `cleanup --plan` 预览入口，并明确 `--plan` / `--force` / `--yes` / `--remove-config` / `--dependency-index` 的选项矩阵、`cleanupPlanSchemaVersion: 1`、外部冲突删除计划、receipt、安全阻断结果和 direct CLI 确认语义；给 `uninstall` / `cleanup` 增加 `--remove-config`，把 TUI 的 `所有平台` config 去重放在编排层，同时让 direct `uninstall --remove-config` 在命令层按 config store 分组。
3. 拆出语义 summary、功能菜单 `features`、执行层 action 和 console page model，落地 `consoleItemsSchemaVersion: 2` 的 breaking change，同时避免把 TUI 图标、颜色和 badge 写进公开 JSON schema，并保持默认 `status --json.consoleItems` 不包含纯 catalog-only 插件。
4. 改造首页行模型，用状态图标、颜色和平台徽标替代长句安装摘要。
5. 调整详情页控制流，从 `插件 -> 位置 -> 动作` 改成 `插件 -> 功能 -> 目标`。
6. 给多平台动作补上 `所有平台` 目标展开、汇总确认和分平台结果展示，并把 takeover target 降级到单目标流程。
7. 补齐 direct action kinds，接入 `repairCommand`、`cleanupCommand`、`reinstallCommand` 和重复安装处理动作；同时补齐 `repairCommand()` 的 `takeoverSharedRuntime` options 链路，让 `runCleanup` / `runUninstall` 能携带 `removeConfig` 且只有 `runCleanup` 能携带 `force`。
8. 抽出命令层公共的同平台 scope 互斥预检，供 direct command 和 TUI 写入入口复用。
9. 把 `状态` / `诊断` 页改为消费结构化 page model，不再解析人类输出文本，并保证诊断问题都能映射到恢复评估入口；无法安全自动恢复时，页面展示阻断原因和人工处理建议。
10. 改造 prompt navigation 和 controller 导航协议，支持 `b`、`q`、`Esc`，并逐步移除对 `__back` / `__exit` 特殊 value 的依赖。
11. 改造 consoleDriver，避免追加式页面堆叠。
12. 更新公开文档中的 `status --json.consoleItems` 迁移说明、TUI 描述、`uninstall` / `cleanup` / `config reset` 边界和新 `--remove-config` 选项，并补齐单元和集成测试。

这个顺序先修掉状态语义，避免 TUI 继续消费错误数据；随后解决“未安装插件不可见”和“详情页结构不符合习惯”两个最影响用户的点，再处理快捷键和渲染体验。
