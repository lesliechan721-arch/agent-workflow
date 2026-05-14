# `aw` TUI 体验返工需求 Spec

日期：2026-05-13
状态：需求确认稿
前置需求：`docs/dev/specs/aw-tui-ux-optimization.md`
文档规范：`docs/dev/spec-plan-writing-guide.md`

## 文档定位

这份 Spec 只定义本轮 TUI 体验返工的需求边界、现状探查结论、用户体验合同、命令合同和验收标准，不写实现计划、阶段拆分或测试清单。

上一轮 `aw` TUI 优化已经实现了一批能力，但自测后暴露出退出、图标、状态判断、页面信息架构、确认交互和配置管理等体验问题。本文件作为后续需求文档新增，不覆盖上一轮 Spec。实现计划应另建 Plan，并以本文件为需求来源。

## 背景

当前 TUI 已经从早期“状态矩阵浏览器”推进到插件管理控制台，但实际使用时仍有明显的 CLI 痕迹：页面里会出现命令建议，状态和诊断仍分成两套入口，危险确认还是文本式 `y/N`，操作完成后用户不容易判断当前插件是否已经刷新到新状态。

本轮目标是把 TUI 收紧成真正面向插件管理任务的界面：首页能扫视插件，详情页能理解状态和继续操作，状态细节作为下一级页面承载，命令输出和内部诊断不直接污染 TUI 页面。CLI 侧也同步简化，把 `status` 和 `diagnose` 合并，减少用户理解成本。

版本管理也需要收紧。`aw` CLI、本地 catalog 和插件 manifest 必须使用同一套严格 SemVer 规则比较版本，构建发布阶段要阻断非法版本，运行时要在本地 catalog 版本不可信时阻止继续使用，避免 CLI 和本地 catalog 或插件 bundle 之间出现隐性兼容问题。

Skill 触发策略也需要从安装流程里拆出来。当前 `SkillTrigger` 需要用户在安装或升级时选择，随后又依赖 install record 里的偏好恢复；一旦安装完成，用户没有自然的配置页可以调整，只能通过重装、升级、修复或刷新等写路径间接重放。这让触发策略像安装历史的一部分，而不是插件配置的一部分。本轮要求删除这套安装期偏好机制，改为由 AW 自动注入的内建配置项管理，并复用现有插件配置分层和动态 artifact 刷新能力。

## 现状探查结论

这一节只记录会影响需求边界的事实，不描述执行步骤。

### TUI 入口与退出

- 裸 `aw` 进入 `runConsoleController()`，控制流在 `packages/cli/src/commands/console.ts`。
- Prompt 层已经定义 `select`、`back`、`exit`、`cancel` 等稳定 action，也支持菜单里的 `b`、`q`、`Esc` 和 `Ctrl+C`。
- 当前 TUI 仍依赖 prompt action 和菜单 role 退出。实际自测发现“退出”菜单无响应，需要 `Ctrl+C` 强制结束，说明控制器、prompt 拦截或正在运行的 prompt 生命周期没有完整收口。
- 退出必须成为可验收的一等行为：任何页面选择退出后都应结束当前控制台进程，不继续刷新首页，不留下仍在等待输入的 prompt。

### 首页展示模型

- `buildHomeLines()` 会把首页渲染成一组文本行，并把 `statusIcon`、插件标题、状态、平台 badge、位置摘要、主操作和摘要文字拼在一起。
- `pageStatusIcon()` 当前返回 `alert-circle`、`arrow-up-circle`、`check-circle`、`circle` 这类 icon id。在终端中这些 id 会直接显示成文字，例如 `arrow-up-circle`，不是用户可识别的状态图标。
- 首页已经能通过 `loadConsoleItems({ includeCatalogOnly: true })` 加载 catalog-only 未安装插件，但首页信息仍偏文本摘要，不像经过设计的插件列表。
- 用户期望首页删除摘要段落，按状态分组，以插件卡片形式展示插件当前安装和基础信息。

### 插件详情页

- `renderDetailLines()` 会展示状态、安装摘要、版本、说明、主要原因和 `recommendation`。
- `recommendation` 来自 `summary.nextSteps[0]`，而很多 `nextSteps` 是 CLI 命令，例如 `aw upgrade codex-explore -p codex -s user`。这些命令对 TUI 用户没有直接意义，也会让详情页像命令提示器。
- 详情页应该保留“建议”的语义，但不能显示 raw command。推荐动作应直接标在可执行 UI 操作上。

### 下一步指示

- 当前多处 `nextSteps` 仍是 `string[]`，内容既可能是面向人的说明，也可能是裸 CLI 命令。
- CLI 人类输出会出现只给命令、不解释作用的下一步，例如只提示用户运行某条 `aw ...` 命令。用户需要额外理解命令用途、适用场景和执行后会发生什么。
- TUI 会复用这些 `nextSteps` 字符串，导致页面上出现命令行建议。TUI 用户已经在交互界面里，不应该再看到“复制命令去执行”的普通建议。
- 下一步指示需要从“字符串列表”收敛为结构化动作说明：CLI 可以展示命令，但必须说明命令作用；TUI 只能展示可执行 UI 动作或状态说明，不能展示命令文本。

### 状态与诊断

- CLI 目前有 `aw status` 和 `aw diagnose` 两个命令。`diagnose` 会做更细的诊断、cleanup 评估和 deep 检查；`status` 默认更偏状态摘要。
- TUI 目前也有 `状态` 和 `诊断` 两个功能。`状态` 使用已有结构化 page model 渲染后直接返回，`诊断` 调用 `diagnoseCommand()` 后渲染结构化 page model。两者不是一个连续的下一级页面体验。
- 状态和诊断页面不能再列出纯未安装 catalog 位置。首页可以展示未安装插件，但状态详情默认只展示当前真正安装、可升级、异常、残留、可认领或有其它发现证据的目标。

### 可升级判断

- 当前 install-state projection 里 `upgradeAvailable` 会受 `sourceDrift` 或 project shared identity drift 影响。
- `status.ts` 里存在按 `resolvedVersion` 与 current catalog `manifest.version` 判断的辅助逻辑，但当前 console projection 没有稳定地使用这条路径。
- 用户可见的 `可升级` 应只由版本判断驱动。bundle fingerprint、source drift、同版本内容变化不应让首页或详情显示 `可升级`。

### 版本与本地 catalog

- CLI 版本来自发布包 `package.json` 的 version，本地 catalog 配置中已经记录 `sourceVersion`，用于描述当前 `~/.aw` 是由哪个 CLI 版本生成。
- 当前 current catalog 选择逻辑会比较本地 `sourceVersion`、bundle fingerprint 和布局健康度；不匹配时会回退到 embedded bundle，但还没有把“CLI 版本高于本地 catalog”和“CLI 版本低于或本地版本异常”分成不同用户交互。
- 插件 manifest 已有 `version` 字段，插件作者文档描述为 semver，但本轮需要把 CLI 版本、插件 manifest 版本、构建发布门禁和运行时比较统一到同一套严格 SemVer 合同。

### 卸载、清理和确认

- 当前正常安装位置可能同时生成 `卸载` 和 `清理` 功能，容易让用户误以为两者都是同等推荐操作。
- 当前危险动作仍会调用 confirm prompt，呈现为 CLI 风格的文本确认。
- TUI 中健康安装应优先显示 `卸载`；异常、残留、半完成或无法正常卸载的状态才显示 `清理`。卸载失败后再引导用户进入清理预览。

### 操作结果与刷新

- 当前结果页有 `返回首页` 和 `退出`。这会让用户完成升级、卸载或清理后离开插件详情，难以确认当前插件的新状态。
- 本轮要求操作完成后默认返回插件详情页，并刷新当前插件数据。详情页需要有“上一步操作状态”区域，只保留最近一次操作的结果摘要。

### 配置管理

- TUI 当前已有配置写入向导，能对 schema 字段进行设置、清空和刷新。
- 但它不是完整的插件配置管理页，缺少查看 effective/source、按 user/project shared/project local 管理配置、重置配置层和展示刷新结果的稳定页面结构。
- CLI 侧已有 `aw config list/get/set/unset/reset`，并区分 user、project shared、project local。本轮 TUI 要把这些能力组织成可理解的配置管理页。

### 安装目标平台与位置

- 当前 `PlatformSelection` 同时包含真实平台 `codex`、`claude` 和选择策略 `auto`、`both`；install record、project artifact identity、diagnostic cache 等持久状态只保存真实平台和真实 scope，不保存 `auto` 或 `both`。
- 当前安装、升级、卸载、修复、状态等入口会解析 `--platform auto`，安装类命令默认也是 `auto`。`auto` 会按当前环境、插件产品声明和当前 scope 的既有状态做推断；当多个平台都可执行且证据不唯一时会失败并要求用户显式选择。
- 当前 `both` 表示同时请求 Codex 和 Claude Code 两个平台，并要求两个平台都可执行；它不是“插件支持什么就安装什么”。
- 当前 TUI 目标选择会把平台和位置组合成候选项，例如 `Codex / 个人`、`Claude Code / 当前项目`，并在多平台操作中额外提供 `所有平台`。安装目标候选因此同时混合了平台、scope 和批量语义，维护成本较高，也容易让用户在第一步看到过多位置矩阵。
- 本轮要删除的是平台选择里的 `auto`。SkillTrigger 配置里的 `auto` 仍表示允许模型自动触发，两者语义不同，不能在文档和实现中混用。

### SkillTrigger 与配置渲染

- 现有 `SkillTriggerPreference` 只有 `default`、`manual`、`auto` 三个偏好值；`SkillTriggerApplicability` 有 `none`、`fixed`、`overridable` 三类状态。
- 当前公开入口是安装或升级时传 `-t, --skill-trigger default|manual|auto`，TUI 目标选择页也会在可覆盖目标上提示选择 `默认`、`手动`、`自动`。
- 当前持久化真值写在 install record 的 `record.options.skillTriggerPreference`。install record schema 只允许这个单值，不保存每个 skill 的配置来源、分层覆盖或可编辑状态。
- 当前重复安装、显式升级、修复、config refresh 和 refresh-only 会尝试从 install record 恢复并重放触发偏好；install record degraded 时，部分路径会要求用户重新显式传 `--skill-trigger`。
- 当前没有安装后的独立调整入口。用户不能像修改普通插件配置一样，在 TUI 配置页或 `aw config` 里修改某个 skill 的触发策略。
- 动态 `codex.skill` 已经通过 `config.schema`、`artifacts.targets`、`scripts.artifacts.render` 和 artifact apply 链路生成运行时内容；AW apply 阶段会按 install record 中的 `skillTriggerPreference` 再 patch `agents/openai.yaml`。
- 现有 manifest 的 `skillTriggers.<skill>.allowInstallOverride` 只表示安装时是否允许覆盖，不定义默认触发策略，也不表示安装后可动态变更。默认策略仍散落在平台原生文件中：Codex 看 `agents/openai.yaml`，Claude Code 看 `SKILL.md` frontmatter。
- 现有配置分层和刷新机制已经能表达“配置变更后刷新动态 artifact”。SkillTrigger 的长期真值应并入这套配置模型，而不是继续依赖 install record 的历史偏好。

## 目标、范围与非目标

### 目标

1. TUI 任意页面都能正常退出，不需要 `Ctrl+C` 强制结束。
2. 首页状态图标使用终端可直接显示的符号，不输出 icon id。
3. 首页按状态分组，用插件卡片展示插件基础信息、安装位置和主操作。
4. 用户可见的 `可升级` 只由语义版本比较决定。
5. 插件详情页不显示 raw command，推荐动作直接标在功能菜单上。
6. `状态` 与 `诊断` 在 TUI 和 CLI 上合并。
7. 状态详情默认只显示当前有安装或状态证据的目标，不列纯未安装位置。
8. TUI 状态详情改成插件详情下的单一下级页面。
9. TUI 危险确认统一改为选项页确认，默认聚焦取消。
10. TUI 不同时展示健康安装的 `卸载` 和 `清理`。
11. 写操作完成后默认回到插件详情页，并展示最新操作结果。
12. TUI 补齐完整插件配置管理页。
13. 下一步指示使用结构化对象表达，不能再用裸命令字符串作为公开用户提示。
14. CLI 所有人类输出里的下一步如果包含命令，必须说明命令作用和使用场景。
15. TUI 所有页面都不展示命令行建议；需要继续处理时，只展示 UI 可执行动作或状态说明。
16. 新需求先设计 UI 和 UX，再进入执行计划，避免继续按文字功能堆叠实现。
17. CLI 版本和插件版本统一遵守严格 SemVer 2.0.0，并使用同一套规范化与比较规则。
18. CLI 或插件版本号不符合规范时，构建、打包和发布必须失败。
19. `aw` 启动所有需要 current catalog 的入口前校验本地 catalog `sourceVersion`，并按版本关系选择自动刷新、确认覆盖或退出。
20. 插件版本只在 current catalog 版本高于已安装版本时显示 `可升级`；其它版本不一致或不可比较场景显示 `异常`，原因是版本不一致。
21. 删除所有公开平台选择中的 `auto`，CLI、TUI、help、错误提示、文档和测试都不再把 `platform=auto` 作为可用值。
22. 非交互 CLI 不传 `--platform` 时默认按 `both` 处理。
23. `both` 改为“安装到每个插件自己支持的所有平台”，不再固定等同于 Codex + Claude Code 双平台。
24. `both` 展开后的任一目标平台不可执行、不可安装或预检失败时，整条写命令失败且不能产生部分写入。
25. TUI 安装目标选择支持 `both`，并改为先选平台，再选 scope；首个目标页只展示平台，不展示平台和 scope 的组合矩阵。
26. 删除安装、升级和 TUI 目标选择阶段的 SkillTrigger 偏好选择，不再让触发策略作为安装选项流转。
27. SkillTrigger 改为 AW 自动注入的内建配置项，复用现有 `aw config`、TUI 配置管理页和动态 artifact refresh。
28. 每个 skill 都能声明默认触发策略，并声明是否允许用户通过配置动态变更该 skill 的触发策略。
29. 动态触发策略按 skill 粒度生效，不使用插件级统一开关，也不按平台拆成多套用户配置。
30. 已有 install record 中的 `skillTriggerPreference` 不再作为运行时真值；新机制上线后直接忽略旧偏好，回到插件声明的默认策略，除非用户重新写入内建配置项。
31. 状态、诊断和刷新判断以“插件默认策略 + 内建配置 effective 值 + 运行时产物”作为 SkillTrigger 判断依据，不再用安装历史偏好判断 drift。

### 范围

- 新增一轮 TUI 首页、插件详情页、状态页、确认页、结果反馈区和配置页的需求定义。
- 调整 CLI `status` / `diagnose` 公开命令边界。
- 明确 `可升级` 的版本判断策略。
- 明确 CLI 和插件版本的严格 SemVer 规范、构建发布门禁和运行时比较规则。
- 明确 `aw` 启动时本地 catalog `sourceVersion` 与当前 CLI 版本不一致时的交互合同。
- 明确平台安装目标中删除 `auto`、重定义 `both` 和 CLI 默认平台的公开合同。
- 明确 TUI 安装目标选择从“平台 + scope 组合列表”改为“先选平台，再选 scope”的交互合同。
- 明确 TUI 对卸载、清理、配置、状态详情和操作结果的展示合同。
- 明确状态详情默认数据范围。
- 明确 SkillTrigger 从安装选项迁移到 AW 内建配置项后的作者合同、用户配置合同和刷新合同。
- 明确 TUI 配置页和 `aw config` 对内建 SkillTrigger 配置项的展示、编辑和重置边界。
- 明确现有 install record `skillTriggerPreference` 在新机制中直接忽略，不做兼容迁移。

### 非目标

- 不在本 Spec 中写实现阶段、测试文件清单或迁移步骤。
- 除 SkillTrigger 内建配置所需的插件作者合同和 install record 真值收口外，不重新设计插件 manifest、dependency index 或 dynamic diagnostic cache 的磁盘格式。
- 不把 TUI 做成跨项目全局维护后台。
- 不在首页展示完整诊断、JSON、debug log 或命令输出。
- 不在 TUI 里做命令复制器、命令教程或 CLI 命令推荐面板。
- 不让 `cleanup` 变成健康安装的默认入口；CLI 可保留受控清理能力，但 TUI 默认不把它和卸载并列展示。
- 不为项目级 skill trigger 设计本机私有覆盖；项目级 repo-visible skill 触发策略仍以 project shared 配置为共享真值。

## 已确认决策

- 新建本后续 Spec，不覆盖上一轮 `aw-tui-ux-optimization.md`。
- CLI 合并为 `aw status`，`aw status` 默认简洁，`aw status --verbose` 输出详细诊断并执行更深的只读检查。
- 不保留 `aw diagnose` 兼容命令。文档、帮助和 TUI 都不再引用 `diagnose`。
- TUI 首页使用插件卡片，并按状态分组。
- 状态图标使用终端可见符号，例如 `!`、`↑`、`✓`、`○`，不使用 icon id。
- `可升级` 使用语义版本比较。只有 current catalog 版本高于已安装版本时，才显示 `可升级`。
- 状态详情默认只显示已发现安装或状态证据，不显示纯未安装 catalog 位置。
- 详情页建议通过功能菜单标记推荐操作，不显示命令。
- TUI 里状态和诊断合并为单一 `状态` 下级页面，页面内可选择显示详细信息。
- TUI 全部页面禁止展示命令行建议，包括首页、详情页、状态页、状态详细信息、结果页、配置页和确认页。
- `nextSteps` 公开合同升级为结构化对象；每条下一步必须有用户可读的动作名和作用说明，命令只能作为 CLI/JSON 的附属字段，不能成为唯一内容。
- CLI 所有人类输出中的下一步都不能只有裸命令。包含命令时，必须同时说明它用来解决什么问题、会进入什么流程或会查看什么信息。
- 危险确认统一使用选项页，不使用 `y/N` 文本确认。
- 健康安装只显示 `卸载`；异常、残留或卸载失败后再显示或引导 `清理`。
- 操作完成后回插件详情页，并只保留最近一次操作结果。
- 配置管理页覆盖 user、project shared 和 project local。
- CLI package version 和插件 `manifest.version` 都必须是严格 SemVer 2.0.0，不接受 `v1.2.3`、`1.2`、version range 或其它宽松写法。
- 构建、打包和发布都必须校验版本号；任一 CLI 或插件版本不符合规范时失败，不能产出可发布结果。
- 本地 catalog 版本号指 `~/.aw/config.json` 中的 `sourceVersion`，启动时与当前 CLI package version 做严格 SemVer 比较。
- 所有需要 current catalog 的 CLI/TUI 入口都必须先执行本地 catalog 版本校验；非交互环境遇到需要确认的覆盖场景时直接失败。
- 当前 CLI 版本高于本地 catalog `sourceVersion` 时自动刷新本地 catalog，相当于自动执行 `init`。
- 当前 CLI 版本低于本地 catalog `sourceVersion`，或本地 `sourceVersion` 缺失、非法、无法比较时，CLI 输出警告并要求用户输入 `y/n` 确认是否覆盖；TUI 使用选项确认页。
- 用户不选择覆盖本地 catalog 时，命令或 TUI 直接退出，不继续进入可用状态。
- 插件版本判断采用“非升级即异常”：current catalog 插件版本高于已安装版本时显示 `可升级`；其它版本不一致或不可比较时显示 `异常`，异常原因是版本不一致。
- 平台选择值删除 `auto`。公开 CLI、TUI、help、错误提示和文档都不再展示或接受 `platform=auto`。
- 非交互 CLI 不传 `--platform` 时默认使用 `both`。
- `both` 表示按每个插件自身的支持平台集合展开安装目标。单平台插件只生成该单平台目标，双平台插件生成两个平台目标；批量安装时每个插件按自己的支持集展开。
- `both` 展开后，如果任一目标平台当前不可执行、插件在该平台不可安装、scope 组合不合法或写入前预检失败，本次写命令整体失败，不允许已经写入部分目标后再跳过失败目标。
- TUI 安装目标选择支持 `both`，并拆成两个连续步骤：先选择平台，再选择 scope。平台页只能列 `Codex`、`Claude Code` 和 `全部支持平台` 这类平台选项；scope 页再列 `个人`、`当前项目`。
- TUI 安装目标页不再展示 `Codex / 个人`、`Claude Code / 当前项目` 这类平台和 scope 的笛卡尔积候选。
- 删除安装期 SkillTrigger 配置入口。`aw install`、`aw upgrade`、`aw repair` 和 TUI 目标选择页都不再接受或展示 `--skill-trigger` / `-t`。
- 不保留 `--skill-trigger` 兼容别名；触发策略只能通过 AW 内建配置项查看和修改。
- AW 为 skill 自动注入内建触发策略配置项，插件作者不需要也不能在普通 `config.schema` 中手写这些保留字段。
- SkillTrigger 配置按 skill 粒度生效。每个 skill 各自声明默认触发策略，以及是否允许用户动态变更。
- 已有 install record 中的 `options.skillTriggerPreference` 直接忽略，不迁移到新配置项，也不继续参与 runtime patch、status 或 drift 判断。

## 术语与状态模型

### 版本规范

本 Spec 中的 CLI 版本、插件 manifest 版本和所有用于比较的已安装插件版本都遵守严格 SemVer 2.0.0。

允许的版本示例：

- `1.2.3`
- `1.2.3-beta.1`
- `1.2.3+build.5`
- `1.2.3-beta.1+build.5`

不允许的版本示例：

- `v1.2.3`
- `1.2`
- `1.2.3.4`
- `latest`
- `^1.2.3`

这里的“规范化”只表示把已经符合严格 SemVer 的版本解析成统一比较形式，不表示宽松修复输入。带 `v` 前缀、缺少 patch、version range 或其它非 SemVer 写法不能被自动清洗成合法版本。

比较规则遵守 SemVer 2.0.0：

- prerelease 低于对应 stable 版本，例如 `1.2.3-beta.1` 低于 `1.2.3`。
- build metadata 不影响版本优先级，例如 `1.2.3+build.1` 和 `1.2.3+build.2` 语义版本相等。
- 用于展示的版本号应保持用户能理解的原始 SemVer 形式；用于判断的版本号必须先通过严格 SemVer 解析。

版本来源：

- CLI 版本来自发布包的 package version，当前发布包为 `packages/cli/package.json`；发布流程如同步根目录 package version，也必须一起校验。
- 插件版本来自插件 manifest 的 `version`。
- 已安装版本优先来自当前目标已接受的 install record `resolvedVersion` 或等价的已安装 source version。
- 本地 catalog 版本来自 `~/.aw/config.json` 的 `sourceVersion`。

任一参与构建、打包、发布或运行时比较的版本字段不符合严格 SemVer 时，不能静默降级为字符串比较。

### 用户可见状态

继续沿用四类用户可见状态：

```ts
type PluginConsoleStatus =
  | 'notInstalled'
  | 'installed'
  | 'upgradeAvailable'
  | 'abnormal';
```

展示文案为：

- `notInstalled`：`未安装`
- `installed`：`已安装`
- `upgradeAvailable`：`可升级`
- `abnormal`：`异常`

首页状态符号为：

- `○`：未安装
- `✓`：已安装
- `↑`：可升级
- `!`：异常

颜色只能作为辅助信息，不能作为唯一识别方式。终端不支持对应符号时，可以降级成纯 ASCII 等价符号，但不能输出 `arrow-up-circle` 这类 icon id。

### 可升级

用户可见 `可升级` 只表示 current catalog 中存在更高语义版本。比较前必须先按“版本规范”完成严格 SemVer 解析。

版本来源：

- 已安装版本优先来自当前目标已接受的 install record `resolvedVersion` 或等价的已安装 source version。
- 当前版本来自 current catalog `manifest.version`。

判断规则：

- current catalog 版本语义上高于已安装版本：显示 `可升级`。
- 两边语义版本相同：不显示 `可升级`。
- 已安装版本高于 current catalog：显示 `异常`，异常原因是版本不一致。
- 任一侧版本无法按严格 SemVer 规范化或比较：显示 `异常`，异常原因是版本不一致或版本号不符合规范，不能显示 `可升级`。
- bundle fingerprint、source drift、project identity drift 或同版本内容变化不能触发 `可升级`。版本相同但内容或来源发生漂移时，不能使用“版本不一致”作为原因，应归入修复、重装、刷新或状态详情说明。

### 安装平台选择

本节只定义插件安装目标里的平台选择，不定义 SkillTrigger 的触发策略。SkillTrigger 的 `auto` 仍保留在“Skill 触发策略配置”语义中。

公开平台选择值收敛为：

```ts
type PlatformSelection = 'codex' | 'claude' | 'both';
```

字段语义：

- `codex`：只请求 Codex 平台。
- `claude`：只请求 Claude Code 平台。
- `both`：请求每个插件自己支持的全部平台。

默认行为：

- 所有带平台选项的非交互 CLI 入口，未传 `--platform` 时默认值为 `both`；确实只能处理单平台的命令必须把平台设为必填，而不是退回 `auto` 推断。
- TUI 安装流程必须让用户显式选择平台；默认焦点可以落在 `全部支持平台`，但页面上不能出现 `auto`。
- 查询型或状态型入口不再接受 `--platform auto` 作为兼容别名。需要全部平台时使用 `both`，需要单平台时使用 `codex` 或 `claude`。

`both` 展开规则：

- 支持平台来自插件 manifest 的 `marketplace.policy.products` 解析结果；未声明产品时按当前既有默认支持平台集合解释。
- 单平台插件选择 `both` 时，只生成该插件唯一支持平台的目标。
- 双平台插件选择 `both` 时，生成 Codex 和 Claude Code 两个平台目标。
- 批量安装多个插件时，每个插件按自己的支持平台集合独立展开，不要求所有插件支持集合完全相同，也不取共同交集。
- 展开结果中不能包含插件不支持的平台。
- 展开后的每个真实目标都必须继续通过环境可执行性、scope 合法性、Codex project installability、重复安装、required config 和写入安全预检。
- 任一展开目标不可执行或预检失败时，整条写命令失败；失败前不能产生写入，已经进入写入阶段的批量动作也不能把失败目标静默跳过后继续伪装成功。

持久状态规则：

- install record、tracking manifest、project artifact identity、dependency index、diagnostic cache 和 receipt target 中只保存真实平台 `codex` 或 `claude`。
- `both` 只存在于用户请求、TUI 选择和命令解析阶段；写入、状态、诊断和回滚都必须面对展开后的真实目标。
- 删除 `auto` 不改变 scope 的取值，scope 仍为 `user` 或 `project`。

### Skill 触发策略配置

Skill 触发策略不再是安装选项，而是 AW 管理的内建配置。内建配置项与插件作者自定义 `config.schema` 共用配置查看、写入、重置和刷新体验，但字段由 AW 注入，插件作者不能把同名保留字段写进普通 schema。

触发策略使用平台中立语义：

```ts
type SkillTriggerMode = 'manual' | 'auto';

interface SkillTriggerConfigContract {
  skillName: string;
  defaultTrigger: SkillTriggerMode;
  allowDynamicTrigger: boolean;
}
```

字段语义：

- `defaultTrigger` 是插件作者为该 skill 声明的默认触发策略。
- `allowDynamicTrigger` 表示用户是否可以通过 AW 配置动态变更该 skill 的触发策略。
- `manual` 表示禁止模型自动触发，但保留用户显式触发入口。
- `auto` 表示允许模型自动触发。

生效规则：

- 每个 skill 独立计算触发策略，不使用插件级统一配置。
- 未写入内建配置时，effective 值等于该 skill 的 `defaultTrigger`。
- 写入内建配置时，effective 值等于当前配置分层解析出的 `manual` 或 `auto`。
- 恢复默认通过清空或重置内建配置完成，不再保存 `default` 这种安装偏好值。
- `allowDynamicTrigger: false` 的 skill 在配置页只读展示默认策略；`aw config set` 也必须拒绝写入对应内建字段。
- 已有 install record 的 `options.skillTriggerPreference` 直接忽略，不参与默认值、effective 值、runtime patch、status 或 drift 判断。

配置分层沿用现有 AW config 语义：

- user scope runtime 使用默认值和 user 配置计算。
- project scope repo-visible runtime 使用默认值和 project shared 配置计算。
- project local 配置不能改变项目级 repo-visible skill 的触发策略。
- 配置写入后按现有动态 artifact refresh 机制刷新对应已安装产物；CLI 不扫描所有历史项目。

平台映射由 AW 负责：

- Codex `manual` 映射为 `agents/openai.yaml` 中 `policy.allow_implicit_invocation: false`。
- Codex `auto` 映射为 `agents/openai.yaml` 中 `policy.allow_implicit_invocation: true`。
- Claude Code 的平台原生字段映射继续遵守 `SKILL.md` frontmatter 合同。
- 动态 renderer 可以读取当前 effective 触发策略，但不能把触发策略作为私有状态写入 AW 受管路径；最终 runtime 写盘仍由 AW apply 链路完成。

### 下一步指示

公开 `nextSteps` 不再使用裸字符串数组表达，统一使用结构化对象。最终字段命名可在实现计划中细化，但语义合同必须至少覆盖：

```ts
interface NextStepInstruction {
  kind: 'uiAction' | 'cliCommand' | 'manual';
  label: string;
  description: string;
  uiAction?: string;
  command?: string;
}
```

字段语义：

- `label` 是短动作名，例如 `查看详细状态`、`升级插件`、`清理残留`。
- `description` 说明这一步的作用、适用原因或执行后会看到什么，不能只是命令本身的改写。
- `kind: 'uiAction'` 表示 TUI 可以直接承载的操作，必须能映射到功能菜单、确认页或下级页面。
- `kind: 'cliCommand'` 表示只能在 CLI 人类输出或 JSON 中暴露的命令建议，必须带 `command`，也必须带 `description`。
- `kind: 'manual'` 表示需要用户理解或人工处理的说明，不带命令。
- `command` 只是机器可读或 CLI 可展示的附属信息，不能作为 TUI 文案，也不能成为一条下一步的唯一信息。

禁止的公开输出：

```text
下一步：aw status codex-explore --verbose
```

允许的 CLI 人类输出：

```text
下一步：查看详细状态。运行 aw status codex-explore --verbose 可以查看安装证据、残留和可恢复动作。
```

涉及既有 JSON 字段从 `string[]` 迁移到结构化对象数组时，必须提供 schema version 或等价版本边界，不能静默改变机器消费者看到的字段形状。

## 用户体验需求

### TUI 页面示意图总览

本节用于 UI/UX 核对，示意图表达页面信息架构、主要区域和导航关系，不代表最终终端宽度、配色或具体组件实现。所有页面都遵守两个共同约束：

- 页面内不展示 `aw ...` 命令建议，不展示 raw command。
- 每个页面都提供返回或退出路径；`q` 退出，子页面 `Esc` 返回，首页 `Esc` 退出。

本轮涉及的 TUI 页面如下：

```text
启动 catalog 校验页
  └─ 覆盖后进入首页 / 取消后退出

首页
  └─ 插件详情页
       ├─ 目标选择页
       ├─ 状态摘要页
       │    └─ 状态详细信息页
       ├─ 配置管理页
       │    ├─ 配置字段编辑页
       │    └─ 配置删除或重置确认页
       ├─ 危险动作确认页
       ├─ 清理预览页
       │    └─ 高风险清理确认页
       └─ 写操作执行中页
            └─ 返回插件详情页，并显示最近一次操作结果
```

#### P0：启动 catalog 校验页

仅在本地 catalog 版本高于当前 CLI 版本，或本地 `sourceVersion` 缺失、非法、无法比较时出现。当前 CLI 版本高于本地 catalog 时自动刷新，不进入此页。

```text
本地 catalog 需要确认

当前 CLI       0.3.0
本地 catalog   0.4.0

本地 catalog 看起来来自更新版本的 aw。
继续使用当前 CLI 会覆盖本地 catalog。

将要发生
  - 用当前 CLI 内置插件包重建本地 catalog
  - 不升级或卸载任何已安装插件
  - 不修改插件配置

操作
> 取消并退出
  覆盖本地 catalog 并继续
```

默认选中 `取消并退出`。选择取消后直接退出，不进入首页。

#### P1：首页

首页负责扫视和进入插件，不解释复杂问题。列表按状态分组，空分组不显示。

```text
aw 插件控制台

异常 1
! codex-explore              v0.1.4              处理
  平台  Codex
  位置  个人
  状态  异常

可升级 1
↑ git-commit                 v0.1.0 -> v0.2.0    升级
  平台  Codex / Claude Code
  位置  个人

已安装 1
✓ code-review                v1.0.0              详情
  平台  Codex
  位置  当前项目

未安装 1
○ dev-workflow               v0.1.0              安装
  平台  Codex

操作
> 打开所选插件
  刷新
  退出
```

首页不显示长摘要、诊断矩阵、内部字段或命令建议。插件很多时，分组列表可滚动，底部操作区保持稳定。

#### P2：插件详情页

详情页是插件操作中心。首页主操作进入详情后，由详情页功能菜单承接推荐动作。

```text
codex-explore

状态    异常
版本    v0.1.4
平台    Codex

原因
平台侧写入没有完整收口。

安装信息
Codex / 个人        异常

功能
> 查看状态（推荐）
  修复
  清理预览
  配置
  返回首页
  退出
```

没有最近操作时不显示结果区域。存在最近操作时，结果区域固定放在状态摘要之后。

```text
git-commit

状态    已安装
版本    v0.2.0

上一步：升级成功
Codex / 个人 已更新到 v0.2.0

安装信息
Codex / 个人        已安装

功能
> 配置
  卸载
  查看状态
  返回首页
  退出
```

失败结果只保留简短原因和可继续 UI 动作。

```text
上一步：卸载失败
Codex / 个人 无法完成标准卸载

可继续
> 查看状态
  清理预览
```

#### P3：目标选择页

当一个功能能作用于多个平台或位置时出现。只有一个明确目标时跳过此页。

未安装插件进入安装时，目标选择分成两个连续页面。第一页只收口平台，不展示平台和 scope 的组合；第二页再选择安装位置。触发策略不在安装流程中选择，需要安装后进入配置页管理。

```text
选择安装平台

插件  dev-workflow

平台
> 全部支持平台
  Codex
  Claude Code

操作
> 继续
  返回插件详情
  退出
```

当用户选择 `全部支持平台` 时，含义是按该插件的支持平台集合展开。单平台插件只安装到唯一支持平台，双平台插件安装到 Codex 和 Claude Code。页面文案不使用 `both` 作为裸英文标签，可在开发者帮助或 JSON 中保留机器值。

```text
选择安装位置

插件  dev-workflow
平台  全部支持平台

位置
> 个人
  当前项目

操作
> 继续
  返回插件详情
  退出
```

已经安装或可升级的插件进入写操作时，目标选择页展示可处理的明确目标：

```text
选择升级目标

插件  git-commit

目标
> 所有可升级目标
  Codex / 个人           v0.1.0 -> v0.2.0
  Claude Code / 个人     v0.1.0 -> v0.2.0

说明
升级会分别刷新所选平台的安装状态。

操作
> 继续
  返回插件详情
  退出
```

高风险 takeover 类动作不能出现 `所有可升级目标` 这类批量选项，必须单目标确认。

#### P4：状态摘要页

状态页是详情页下级页面，合并原 `状态` 和 `诊断` 的入口。默认只展示友好摘要，不列纯未安装位置。

```text
状态  codex-explore

整体状态
! 异常

位置
Codex / 个人
  状态  异常
  原因  平台侧写入没有完整收口
  建议  修复，或先查看详细信息

可执行操作
> 修复
  清理预览
  显示详细信息
  返回插件详情
  退出
```

如果没有可在 TUI 内直接执行的动作，只显示状态说明，不把 CLI 命令降级成建议。

#### P5：状态详细信息页

用户主动选择 `显示详细信息` 后进入。此页可以展示更细的只读诊断事实，但仍然不展示命令建议、stdout 原文或内部错误栈。

```text
详细状态  codex-explore

诊断结论
平台写入不完整，需要恢复处理。

发现的问题
! Codex / 个人
  平台注册存在，但安装记录缺失。

清理评估
可生成清理预览，但执行前需要确认范围。

受影响依赖
无

可执行操作
> 清理预览
  修复
  返回状态摘要
  退出
```

详细信息页消费结构化诊断数据，不解析人类输出文本。

#### P6：配置管理页

配置页用于长期管理插件配置，不是一次性写入向导。

```text
配置  codex-explore

作用层
> Effective
  个人
  当前项目
  当前项目本机

字段
token                    已配置             来源：个人
explorerModel             gpt-5.4-mini       来源：默认值
modelReasoningEffort      medium             来源：当前项目
codex-explore 触发方式     自动               来源：默认值
commit 触发方式            手动               来源：当前项目

最近结果
配置已保存，相关项目文件已刷新。

操作
> 更新字段
  清空字段
  重置当前层配置
  重新应用配置
  返回插件详情
  退出
```

敏感字段只显示脱敏状态。SkillTrigger 内建字段和插件自定义字段放在同一字段列表中，但需要用用户能理解的标题展示，不暴露保留 key。`当前项目本机` 只表示本机覆盖，不描述成会改变 repo-visible artifact 的共享真值；项目级 skill 触发策略不能在 `当前项目本机` 层改写。

#### P7：配置字段编辑页

从配置管理页选择 `更新字段` 或 `清空字段` 后进入。字段很多时先选字段，再进入对应输入控件。

```text
更新配置字段

作用层  当前项目

字段
> explorerModel             gpt-5.4-mini
  modelReasoningEffort      medium
  codex-explore 触发方式     自动
  token                     已配置

操作
> 编辑所选字段
  返回配置
  退出
```

普通文本字段：

```text
explorerModel

当前值  gpt-5.4-mini
来源    默认值

新值
gpt-5.5

操作
> 保存
  取消
```

密码或 token 字段：

```text
token

当前状态  已配置

新值
********

操作
> 保存
  取消
```

SkillTrigger 内建字段使用枚举选择，不用自由文本输入：

```text
codex-explore 触发方式

当前值  自动
来源    默认值

新值
> 自动
  手动
  恢复默认

操作
> 保存
  取消
```

不允许动态变更的 skill 只读展示默认触发策略，不进入编辑页。

输入框内的 `q`、`b` 是普通字符，`Esc` 取消输入并返回上一页。

#### P8：危险动作确认页

卸载、重装、认领、接管共享运行时、重复安装处理、删除配置、重置配置等危险动作统一进入确认页，不使用文本式 `y/N`。

```text
确认卸载

插件  git-commit
目标  Codex / 个人

将要删除
  - Codex 个人位置的插件安装状态
  - AW 管理的安装记录
  - 相关动态诊断缓存

配置
  保留配置

操作
> 取消
  确认卸载
```

默认选中 `取消`。选择取消后不得写状态、写配置或删除文件。

删除或重置配置使用同一类确认页：

```text
确认重置配置

插件  codex-explore
作用层  当前项目

将要删除
  - 当前项目共享配置中的本插件配置

不会删除
  - 个人配置
  - 当前项目本机配置
  - 已安装插件文件

操作
> 取消
  确认重置
```

#### P9：清理预览页

清理先进入预览。能安全执行普通清理时，用户从预览进入确认；需要 `force` 语义时，再进入高风险确认页。

```text
清理预览  codex-explore

目标
Codex / 个人

计划删除
  - 损坏的安装记录
  - 未完成的 native marker
  - AW 管理的运行时残留

备份
  - 修改共享配置前创建备份

阻断原因
  无

受影响依赖
  无

操作
> 继续清理
  同时删除配置  [否]
  返回插件详情
  退出
```

如果存在阻断或不可删除项，页面必须明示，不能让用户误以为清理一定会成功。

#### P10：高风险清理确认页

只有清理预览判断需要高风险语义时出现。它比普通危险确认页更详细，必须列出风险来源、备份策略、不可删除项和受影响依赖。

```text
确认高风险清理

插件  codex-explore
目标  Codex / 个人

风险来源
  - 标准卸载无法安全重放
  - 需要移除 AW 能证明归属的残留状态

将要删除
  - AW 管理的运行时残留
  - 损坏的安装记录

将要备份
  - 共享配置片段

不会删除
  - 未能证明归属的第三方文件
  - 其它插件配置

受影响依赖
  无

操作
> 取消
  确认高风险清理
```

默认选中 `取消`。

#### P11：写操作执行中页

安装、升级、卸载、清理、修复、重装、认领、接管和配置保存等写操作执行时显示。完成后不停留在独立结果页，默认刷新并回到插件详情页。

```text
正在升级 git-commit

目标
Codex / 个人

进度
✓ 读取当前状态
✓ 执行升级
… 刷新插件状态
```

成功后返回详情页：

```text
git-commit

状态    已安装
版本    v0.2.0

上一步：升级成功
Codex / 个人 已更新到 v0.2.0

功能
> 配置
  卸载
  查看状态
  返回首页
  退出
```

失败后也返回详情页，并展示最近一次操作结果和可继续动作。页面不能继续展示操作前的旧状态。

### R1：首页

首页必须是插件卡片列表，按状态分组：

1. `异常`
2. `可升级`
3. `已安装`
4. `未安装`

每个分组标题显示状态和数量。没有插件的分组不显示。

每个插件卡片展示：

- 状态符号和状态文案。
- 插件显示名，优先使用 `manifest.interface.displayName`，否则使用插件名。
- 当前版本或 current catalog 版本。
- 支持平台，例如 `Codex`、`Claude Code`。
- 当前安装位置，例如 `Codex / 个人`、`Claude Code / 当前项目`。
- 主操作，例如 `处理`、`升级`、`卸载`、`安装`、`详情`。

首页不得展示：

- 长摘要段落。
- raw command。
- 命令行建议。
- 完整诊断。
- 内部字段名。
- `ledger`、`tracking`、`snapshot` 等内部词。
- 未选择位置的完整矩阵。

示意：

```text
异常 1
! codex-explore        v0.1.4        处理
  平台  Codex
  位置  个人
  状态  异常

可升级 1
↑ git-commit           v0.1.0 -> v0.2.0        升级
  平台  Codex / Claude Code
  位置  个人

已安装 1
✓ code-review          v1.0.0        详情
  平台  Codex
  位置  当前项目

未安装 1
○ dev-workflow         v0.1.0        安装
  平台  Codex
```

插件数量超过屏幕高度时，列表必须可滚动。卡片不能因为状态、版本或主操作文案长度变化导致布局跳动或文字重叠。

### R2：插件详情页

插件详情页是所有操作的中心页。进入插件后展示：

- 插件名、版本、状态。
- 最近一次操作结果区域。没有操作时不显示。
- 安装信息区域，列出当前已安装或有状态证据的位置。
- 功能菜单。

最近一次操作结果区域只保留最新一条：

```text
上一步：升级成功
Codex / 个人 已更新到 v0.2.0
```

失败时展示简短原因和可进入的 UI 动作：

```text
上一步：卸载失败
Codex / 个人 无法完成标准卸载
可继续：查看状态 / 清理预览
```

详情页不得显示 raw command。推荐动作通过功能菜单标记：

```text
功能
> 升级（推荐）
  配置
  卸载
  状态
```

如果某个状态需要解释原因，详情页只展示面向用户的短说明，例如：

```text
状态：异常
原因：平台侧写入没有完整收口。
```

不得展示：

```text
建议：aw upgrade codex-explore -p codex -s user
```

如果结构化下一步只有 `kind: 'cliCommand'` 而没有对应 UI 动作，详情页不能把它降级显示成命令建议。此类事项只能通过状态说明表达，或在后续设计中补齐可执行 UI 入口。

### R3：状态下级页面

详情页只保留一个 `状态` 入口，不再同时显示 `状态` 和 `诊断`。

进入 `状态` 后打开下一级页面。默认展示友好摘要：

- 当前插件整体状态。
- 当前已安装、可升级、异常、残留、可认领或有其它发现证据的位置。
- 每个位置的状态、原因和推荐 UI 动作。
- 返回插件详情。
- 退出控制台。
- 显示详细信息。

状态页默认不显示纯未安装位置。首页的未安装插件卡片不等于状态详情里的位置矩阵。

用户选择 `显示详细信息` 后，TUI 可以执行与 `aw status --verbose` 等价的只读诊断，并展示更细的事实：

- 诊断结论。
- 发现的问题。
- cleanup 评估结果。
- 受影响依赖。
- 可执行 UI 操作。

状态页和状态详细信息都不得展示命令行建议。即使结构化数据中存在 `kind: 'cliCommand'` 的下一步，TUI 也不能显示其中的 `command` 字段；需要继续处理时，必须展示对应 UI 动作，或把它作为不可在 TUI 内完成的状态说明，不得用命令替代 UI 入口。

状态页必须消费结构化数据，不得解析人类输出文本，也不得把 `aw status --verbose` 的 stdout 直接塞进 TUI。

### R4：退出与导航

TUI 任意页面都必须支持：

- 菜单项 `退出`。
- `q` 退出。
- 首页 `Esc` 退出。
- 子页面 `Esc` 返回上一页。
- `Ctrl+C` 安全退出。

输入框和密码框中，`q`、`b` 作为普通字符处理；`Esc` 取消当前输入并返回上一页。

退出验收要求：

- 选择 `退出` 后进程返回 exit code `0`。
- 不再触发新的首页刷新。
- 不再等待后续输入。
- 不输出未处理的 prompt cancellation 错误。
- 正在显示结果页、状态页、配置页或确认页时退出行为一致。

### R5：危险确认

所有危险动作使用选项页确认，不使用文本式 `y/N`。

危险动作包括：

- 卸载。
- 清理。
- 重装。
- 认领现有安装。
- 接管共享运行时。
- 处理重复安装。
- 重置配置。
- 删除配置。

确认页必须展示：

- 操作名称。
- 插件。
- 目标平台和位置。
- 将删除或改写的范围。
- 是否同时删除配置。
- 清理类动作的计划、备份、阻断原因和受影响依赖。

确认选项示例：

```text
确认卸载
取消
```

默认选中 `取消`。选择取消后不能写状态、写配置、删除文件或留下中间状态。

### R6：卸载与清理

TUI 功能菜单不能让健康安装同时显示 `卸载` 和 `清理`。

规则：

- 健康安装：显示 `卸载`，不显示 `清理`。
- 可升级安装：显示 `升级` 和 `卸载`，不显示 `清理`。
- 异常、残留、半完成、外部归属冲突、重复安装待处理：根据状态显示 `清理`、`修复`、`认领`、`处理重复安装` 等恢复动作。
- 卸载失败：结果区域说明失败原因，并提供 `查看状态` 和 `清理预览`。
- 清理必须先展示计划或风险确认，不能直接执行高风险删除。

直接 CLI 的 `aw cleanup` 可以继续作为受控恢复评估入口，但 TUI 默认不把它作为健康安装的并列主操作。

### R7：写操作后的返回与刷新

安装、升级、配置、卸载、清理、修复、重装、认领、接管、重复安装处理等操作完成后，TUI 默认返回当前插件详情页。

返回前必须刷新当前插件状态。刷新后的详情页需要：

- 展示最新状态。
- 展示最新安装位置。
- 展示最近一次操作结果。
- 如果操作失败，保留失败摘要和可继续动作。
- 如果操作成功，不能继续展示操作前的旧状态。

升级成功后，如果 current catalog 版本已经不高于已安装版本，插件不能继续显示 `可升级`。如果仍显示 `可升级`，必须是刷新后的版本判断结果，而不是旧页面缓存。

### R8：配置管理页

详情页提供 `配置` 入口。进入后打开插件配置管理页，而不是只进入一次性写入向导。

配置页覆盖：

- effective 配置视图。
- user 配置层。
- project shared 配置层。
- project local 配置层。
- AW 内建 SkillTrigger 配置项。
- 字段设置和更新。
- 字段清空。
- 当前层 reset。
- 保存后的 artifact refresh 结果。

配置页必须遵守：

- 敏感字段只显示“已配置”或等价脱敏状态。
- 字段来源要用用户能理解的文案展示，例如 `默认值`、`个人`、`当前项目`、`当前项目本机`。
- project shared 和 project local 的差异必须清楚。
- project local 不能被描述成会改变 repo-visible artifact 的共享真值。
- SkillTrigger 内建字段与插件自定义字段合并展示，但需要有清晰标题，例如 `<skill> 触发方式`。
- 未声明普通 `config.schema`、但存在可配置 SkillTrigger 的插件，也应能进入配置页管理这些内建字段。
- 不允许动态变更触发策略的 skill 只读展示默认策略，不能被保存、清空或 reset 成其它值。
- project scope 的 SkillTrigger 不能在 project local 层编辑；页面应说明该字段由默认值或当前项目共享配置决定。
- reset 或删除配置必须走危险确认选项页。
- 保存配置后默认回到配置页或插件详情页时，需要展示最近一次配置操作结果。
- 配置刷新失败不能把内部 stack trace 放进默认页面，只提供状态页详细信息入口。

配置页示意：

```text
配置  codex-explore

作用层
> Effective
  个人
  当前项目
  当前项目本机

字段
token                 已配置        来源：个人
explorerModel          gpt-5.4-mini  来源：默认值
modelReasoningEffort   medium        来源：当前项目
codex-explore 触发方式 自动          来源：默认值

操作
更新字段
清空字段
重置当前层配置
返回
```

### R9：首页与详情的信息边界

首页只负责扫视和进入，不解释复杂问题。

详情页负责说明当前插件最重要的状态和推荐动作。

状态页负责承载细节和诊断事实。

配置页负责管理配置。

命令行建议只出现在 CLI 输出或 JSON 的结构化 `cliCommand` 字段中。TUI 的首页、详情页、状态页、状态详细信息、结果页、配置页和确认页都不显示命令文本。

### R10：版本规范与构建发布门禁

CLI package version、插件 `manifest.version`、构建产物中的插件版本、测试夹具中参与构建验证的插件版本，都必须遵守同一套严格 SemVer 2.0.0 规则。

构建、打包和发布必须在写出发布结果前校验版本号：

- CLI package version 不符合严格 SemVer 时失败。
- 任一插件 `manifest.version` 不符合严格 SemVer 时失败。
- release 流程需要同步多个 package version 时，任一参与发布的 package version 不符合严格 SemVer 时失败。
- 失败时必须明确指出哪个版本字段不合法，不能继续生成可发布 tarball，也不能继续发布到 registry。

版本规范化不能把非法输入修好后继续发布。`v1.2.3`、`1.2`、`latest`、`^1.2.3` 等写法都必须失败。

### R11：启动时 catalog 版本校验

所有需要 current catalog 的 CLI 和 TUI 入口，在读取 current catalog 并进入可用状态前，必须校验当前 CLI package version 与本地 catalog `sourceVersion` 的关系。

比较对象：

- 当前 CLI 版本：发布包 package version。
- 本地 catalog 版本：`~/.aw/config.json` 的 `sourceVersion`。

处理规则：

- 当前 CLI 版本等于本地 catalog `sourceVersion`：继续启动；bundle fingerprint 和布局健康仍按既有 freshness/健康检查处理。
- 当前 CLI 版本高于本地 catalog `sourceVersion`：直接刷新本地 catalog，相当于自动执行 `init`，刷新完成后继续启动。
- 当前 CLI 版本低于本地 catalog `sourceVersion`：输出警告，要求用户确认是否覆盖本地 catalog。
- 本地 catalog 存在但 `config.json` 缺失、无法解析、`sourceVersion` 缺失、不是字符串或不是严格 SemVer：输出警告，要求用户确认是否覆盖本地 catalog。

确认交互：

- CLI 使用 `y/n` 输入确认是否覆盖本地 catalog。
- TUI 使用选项确认页，不使用文本式 `y/N`。
- 用户选择覆盖后，刷新本地 catalog，再继续原入口。
- 用户不选择覆盖时，直接退出；命令不继续执行，TUI 不进入首页。
- 非交互环境遇到需要确认的覆盖场景时直接失败，不能默认覆盖，也不能默认继续使用不一致的本地 catalog。

覆盖本地 catalog 只表示用当前 CLI embedded bundle 重建本地 catalog；它不是插件升级，也不能把已有插件版本状态伪装成已处理。

## CLI 公开合同需求

### R12：平台选项与安装目标

所有公开 CLI 入口的 `--platform` 选项只接受 `codex`、`claude`、`both`。

通用要求：

- help、错误提示、JSON schema、测试夹具和文档都不能继续把 `auto` 列为 platform 值。
- 用户显式传入 `--platform auto` 时，命令必须失败，并提示改用 `codex`、`claude` 或 `both`。
- 如果旧代码路径仍保留内部自动推断 helper，这些 helper 不能暴露为用户可选平台，也不能影响默认行为。
- `auto` 这个词在 SkillTrigger 配置中仍可出现，但必须明确属于触发策略，不属于平台选择。

写命令默认行为：

- `aw install <plugin>` 未传 `--platform` 时按 `--platform both` 处理。
- `aw upgrade <plugin>`、`aw repair <plugin>`、`aw reinstall <plugin>`、`aw uninstall <plugin>`、`aw cleanup <plugin>` 等需要解析目标平台的写命令，如果保留可省略 `--platform` 的入口，也必须按 `both` 处理；如果某命令只能处理单目标，必须在命令合同中明确要求显式传 `codex` 或 `claude`，不能退回 `auto` 推断。
- `both` 展开后生成多个真实目标时，预检必须覆盖完整目标集。任一目标失败时，命令整体失败，不能先写成功目标再把失败目标当作跳过项。
- receipt、状态事件和 JSON 输出中的 target 必须列展开后的真实平台，不能把 `both` 写成已安装位置。

查询命令行为：

- `aw status --platform both` 表示查看所有真实平台的相关状态。
- `aw status` 未传 `--platform` 时，可以等价于 `--platform both` 展示有证据的所有平台状态。
- `aw status --platform auto` 不再是兼容入口。

### R13：`aw status`

`aw status` 是唯一公开状态命令。

默认行为：

- 输出简洁状态。
- 默认只列当前已发现安装、可升级、异常、残留、可认领或其它有状态证据的插件和位置。
- 不列纯未安装 catalog 插件和位置。
- 不执行额外的深度只读诊断。
- 不输出完整 JSON、debug log 或内部矩阵。

详细行为：

- `aw status --verbose` 输出诊断级细节。
- `--verbose` 可以执行更深的只读检查，包括原 `diagnose --deep` 对应的只读诊断能力。
- `--verbose` 不写状态、不刷新缓存、不创建备份、不修改配置。
- `--verbose` 应包含 cleanup 评估、阻断原因、受影响依赖、可恢复动作和必要的结构化下一步。

JSON 行为：

- `aw status --json` 输出简洁结构化状态。
- `aw status --verbose --json` 输出详细结构化状态。
- JSON payload 的 `command` 必须是 `status`。
- 如果详细结构和简洁结构存在机器合同差异，必须提供 schema version 或等价版本边界。
- JSON 中的 `nextSteps` 必须使用结构化下一步对象。若仍需保留旧 `string[]` 兼容字段，必须明确标记为 legacy，并为新字段提供版本边界。

显式查询未安装插件时，命令可以返回该插件的简洁 `未安装` 结论，但不能展开所有未安装 platform/scope 位置矩阵。

### R14：移除 `aw diagnose`

`aw diagnose` 不再作为公开命令存在。

要求：

- CLI help 不再列出 `diagnose`。
- TUI 不再调用 `diagnoseCommand()` 作为用户可见路径。
- 文档不再提示用户运行 `aw diagnose`。
- 原本只有 `diagnose` 才能看到的信息，迁移到 `aw status --verbose`。
- 原本 `diagnose --deep` 的只读深度检查，迁移到 `aw status --verbose`，不再设计额外 `--deep` 用户选项。

### R15：状态数据范围

默认状态输出和 TUI 状态页只显示当前有证据的目标。

“有证据”包括：

- 健康安装。
- 可升级安装。
- 安装异常。
- 残留。
- 半完成状态。
- 可认领状态。
- 外部归属冲突。
- 依赖阻断。
- 读取错误。
- 其它能证明该插件在当前环境有状态面的发现。

纯 current catalog 未安装插件只在 TUI 首页出现。它们不应污染状态详情、诊断细节或默认 CLI 状态输出。

### R16：下一步指示与命令说明

所有公开给用户的下一步指示都必须说明“为什么做这一步”和“这一步会做什么”。命令只能作为可执行方式之一，不能替代说明。

CLI 人类输出要求：

- `status`、`install`、`upgrade`、`uninstall`、`cleanup`、`repair`、`reinstall`、`config`、错误提示和 receipt 输出中的下一步都适用。
- 每条下一步至少展示动作名和作用说明。
- 如果展示命令，命令前后必须有自然语言说明，说明它用于查看信息、进入某个流程、修复某类状态或清理某类残留。
- 不得输出只有命令的 `下一步：aw ...`。
- 多条下一步不能只用分号拼接命令列表；每条都要能独立说明作用。

JSON 和结构化数据要求：

- 公开 JSON payload、console item、friendly summary 和 receipt 中暴露给消费者的下一步使用结构化对象。
- `kind: 'cliCommand'` 的下一步必须同时包含 `label`、`description` 和 `command`。
- `kind: 'uiAction'` 的下一步必须能映射到明确 UI 操作，不能只把 CLI 命令藏在 action 里。
- TUI 消费结构化对象时必须忽略 `command` 字段，不得把它渲染出来。
- 结构迁移必须有 schema version 或等价兼容边界。

### R17：SkillTrigger 内建配置与 CLI 边界

SkillTrigger 不再属于 install、upgrade 或 repair 的命令选项。

CLI 入口要求：

- `aw install`、`aw upgrade`、`aw repair` 的 help 不再展示 `-t` 或 `--skill-trigger`。
- 用户传入 `-t` 或 `--skill-trigger` 时，命令必须失败并说明触发策略已迁移到配置管理。
- `upgrade --all` 不再需要单独禁止 `--skill-trigger`；该参数在所有相关命令上都不存在。
- CLI 人类输出和下一步指示不得再提示用户通过重装、升级或修复来改触发策略。

配置入口要求：

- `aw config list/get/set/unset/reset` 必须能处理 AW 注入的 SkillTrigger 内建字段。
- 内建字段和普通插件配置字段共享 user、project shared、project local 的展示模型，但字段适用层必须遵守“Skill 触发策略配置”中的分层规则。
- 未声明普通 `config.schema` 的插件，只要存在可展示的 SkillTrigger 内建字段，也能使用配置查询和 TUI 配置页。
- 用户清空 SkillTrigger 内建字段后，effective 值回到插件声明的 `defaultTrigger`。
- 用户不能写入 `default` 作为配置值；恢复默认只能通过 unset 或 reset 完成。

作者合同要求：

- 每个 skill 的作者合同必须能声明 `defaultTrigger` 和 `allowDynamicTrigger`。
- `defaultTrigger` 是必需的默认策略来源，不再从 install record 推断。
- `allowDynamicTrigger: false` 时，AW 只能展示默认策略，不能提供配置写入口。
- 旧 manifest 中只表达安装期覆盖许可的 `skillTriggers.<skill>.allowInstallOverride` 不能继续作为新合同的长期语义。

状态与刷新要求：

- status 详细结构化状态、TUI 状态页和 dynamic diagnostic cache 都以 `defaultTrigger`、内建配置 effective 值和实际 runtime 产物判断 SkillTrigger 状态。
- install record 中旧的 `options.skillTriggerPreference` 直接忽略；即使旧值是 `manual` 或 `auto`，也不能影响新运行时结果。
- 动态 artifact refresh 按 effective SkillTrigger 配置重新应用 runtime patch；刷新失败按普通配置刷新失败展示。
- runtime 与 effective SkillTrigger 不一致时，状态应说明“触发策略与配置不一致”，并把可继续动作指向配置页或重新应用配置，不提示 `--skill-trigger`。

## 验收标准

### 版本规范与构建发布

- CLI package version 符合严格 SemVer 时，构建和发布流程可继续；不符合时构建、打包和发布失败。
- 插件 `manifest.version` 符合严格 SemVer 时，插件可进入 catalog 构建；不符合时构建失败。
- `v1.2.3`、`1.2`、`latest`、`^1.2.3` 等写法不能被自动清洗后通过。
- prerelease 和 build metadata 按 SemVer 2.0.0 处理；build metadata 不影响版本优先级。

### 启动 catalog 校验

- 当前 CLI 版本高于本地 catalog `sourceVersion` 时，`aw` 自动刷新本地 catalog 后继续原入口。
- 当前 CLI 版本低于本地 catalog `sourceVersion` 时，CLI 输出警告并要求输入 `y/n`；TUI 展示选项确认页。
- 本地 catalog `sourceVersion` 缺失、非法或无法比较时，CLI 输出警告并要求输入 `y/n`；TUI 展示选项确认页。
- 用户不选择覆盖本地 catalog 时，命令退出，TUI 不进入首页。
- 非交互环境遇到需要确认覆盖的本地 catalog 时直接失败。
- 需要 current catalog 的入口都不能绕过这个启动校验。

### 安装目标

- CLI help 和公开文档不再把 `auto` 列为 `--platform` 可选值。
- 用户传入 `--platform auto` 时命令失败，并提示改用 `codex`、`claude` 或 `both`。
- `aw install <plugin>` 不传 `--platform` 时按 `both` 展开。
- 其它带平台选项的非交互 CLI 入口不传 `--platform` 时，也不能退回旧的 `auto` 推断；要么按 `both` 展开，要么在命令合同中要求显式单平台。
- 单平台插件使用 `--platform both` 时，只生成该插件支持的单平台目标。
- 双平台插件使用 `--platform both` 时，生成 Codex 和 Claude Code 两个平台目标。
- 批量安装多个插件时，`both` 按每个插件自己的支持平台集合展开，不要求所有插件支持同一组平台。
- `both` 展开后的任一目标平台不可执行、scope 不合法或预检失败时，命令整体失败，且不产生部分写入。
- install record、project artifact identity、dependency index 和 receipt target 只出现真实平台，不保存 `both` 或 `auto`。
- `aw status --platform both` 能查看所有真实平台的状态，`aw status --platform auto` 不再可用。
- TUI 安装流程的平台页只列平台选项，不列 `Codex / 个人`、`Claude Code / 当前项目` 这类组合。
- TUI 安装流程选择 `全部支持平台` 后，再进入 scope 选择页。
- TUI 安装流程选择 `全部支持平台` 后的预检覆盖展开后的完整目标集。

### 首页

- 打开 `aw` 后首页按状态分组展示插件卡片。
- 首页不显示 `arrow-up-circle`、`check-circle`、`alert-circle` 等 icon id。
- 首页不显示长摘要段落、命令建议或诊断矩阵。
- 首页不显示 `aw ...` 命令或任何复制到 CLI 执行的建议。
- `异常`、`可升级`、`已安装`、`未安装` 的排序稳定。
- 未安装 catalog 插件仍能在首页出现并可进入安装流程。

### 详情页

- 详情页不显示 `aw upgrade ...`、`aw cleanup ...` 等命令式建议。
- 推荐操作以菜单标记呈现，例如 `升级（推荐）`。
- 详情页的下一步只展示 UI 动作或状态说明，不展示结构化 `command` 字段。
- 操作完成后默认回到插件详情页。
- 详情页展示最近一次操作结果，且只保留最新一条。
- 成功升级后刷新状态，不继续显示旧的 `可升级` 状态。

### 状态页与 CLI

- TUI 详情页只显示一个 `状态` 入口，不再显示单独 `诊断` 入口。
- 状态页是下一级页面，支持返回和退出。
- 状态页默认不列纯未安装位置。
- 状态页详细信息消费结构化数据，不解析 human stdout。
- 状态页和状态详细信息不显示命令行建议。
- `aw status` 默认输出简洁状态。
- `aw status --verbose` 输出原诊断级细节和更深只读检查。
- `aw diagnose` 不出现在 CLI help 中。
- 文档和 TUI 不再引用 `aw diagnose`。

### 下一步指示

- 公开 `nextSteps` 使用结构化对象，不再把裸命令字符串作为用户提示。
- 每条下一步都有动作名和作用说明。
- CLI 人类输出中出现命令时，同时解释命令用于什么场景、会查看或处理什么内容。
- CLI 人类输出不出现只有命令的 `下一步：aw ...`。
- TUI 所有页面都不显示 `aw ...` 命令建议。
- `cliCommand` 类型下一步不会被 TUI 渲染成命令文本。
- JSON 字段形状变化有 schema version 或等价兼容边界。

### 版本判断与可升级

- 已安装版本低于 current catalog 版本时，显示 `可升级`。
- 已安装版本等于 current catalog 版本时，不显示 `可升级`。
- 同版本但 fingerprint 或 source drift 不同时，不显示 `可升级`。
- current catalog 版本低于已安装版本时，显示 `异常`，原因是版本不一致。
- 任一侧版本无法按严格 SemVer 规范化或比较时，显示 `异常`，原因是版本不一致或版本号不符合规范。
- 不可比较版本不能因为字符串不同而显示 `可升级`。

### 退出与确认

- 首页选择 `退出` 能正常结束进程。
- 任意子页面选择 `退出` 能正常结束进程。
- 退出后不再等待输入。
- 危险动作确认页使用选项菜单，不出现 `y/N` 文本确认。
- 确认页默认选中取消。
- 取消危险动作不产生写入。

### 卸载与清理

- 健康安装详情页不同时显示 `卸载` 和 `清理`。
- 健康安装显示 `卸载`。
- 异常、残留或半完成状态显示对应恢复动作，其中清理必须先进入预览或风险确认。
- 卸载失败后，详情页最近操作结果提供 `查看状态` 和 `清理预览`。

### SkillTrigger 内建配置

- `aw install`、`aw upgrade`、`aw repair` 的 help 不展示 `-t` 或 `--skill-trigger`。
- 用户传入 `-t` 或 `--skill-trigger` 时，命令失败，并引导到配置管理。
- TUI 目标选择页不展示 `默认`、`手动`、`自动` 的触发策略选择。
- 配置页展示 AW 注入的每个 skill 触发方式字段，且字段来源能显示为默认值、个人或当前项目。
- 未声明普通 `config.schema` 的插件，只要有 SkillTrigger 内建字段，也能进入配置页查看或管理。
- `allowDynamicTrigger: true` 的 skill 可以通过配置页和 `aw config set` 修改触发方式。
- `allowDynamicTrigger: false` 的 skill 只读展示默认触发策略，写入对应内建字段会失败。
- 清空或 reset SkillTrigger 内建字段后，effective 值回到该 skill 的 `defaultTrigger`。
- 配置值只接受 `manual` 或 `auto`；不能把 `default` 写成持久配置值。
- project scope 的 SkillTrigger 不允许通过 project local 层改变 repo-visible runtime。
- 已有 install record 中的 `options.skillTriggerPreference` 不再影响 runtime、status 或 refresh，也不会自动迁移为配置项。
- runtime 与 effective SkillTrigger 配置不一致时，状态页和 CLI 下一步不提示 `--skill-trigger`，只提示配置页或重新应用配置。

### 配置管理

- 详情页有清晰的 `配置` 入口。
- 配置页可查看 effective、user、project shared、project local。
- 配置页支持字段设置、清空和当前层 reset。
- reset 和删除配置走选项确认页。
- 敏感字段脱敏展示。
- project local 不被描述成共享配置真值。
- 配置保存后的 refresh 结果能在 UI 中看到。
