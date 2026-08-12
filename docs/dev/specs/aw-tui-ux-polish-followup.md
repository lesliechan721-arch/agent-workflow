# `aw` TUI 体验返工需求 Spec

> 历史说明：本文中涉及 Skill 调用行为的手动覆盖、配置、接管或运行时重写设计已废弃，不是当前合同。Skill 是否被平台调用只由 Skill 自身的原生元数据决定。当前合同见 `docs/plugin-authoring.md` 和 `docs/plugin-installation.md`。

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

版本管理也需要收紧。`aw` CLI、本地 catalog 和插件 manifest 必须使用同一套严格 SemVer 规则比较版本，构建发布阶段要阻断非法版本，运行时要在本地 catalog 版本不可信时避免继续使用该本地 catalog，避免 CLI 和本地 catalog 或插件 bundle 之间出现隐性兼容问题。

Skill 触发策略也需要从安装流程里拆出来。当前 `SkillTrigger` 需要用户在安装或升级时选择，随后又依赖 install record 里的偏好恢复；一旦安装完成，用户没有自然的配置页可以调整，只能通过重装、升级、修复或刷新等写路径间接重放。这让触发策略像安装历史的一部分，而不是插件配置的一部分。本轮要求删除这套安装期偏好机制，改为由 AW 自动注入的内建配置项管理，并复用现有插件配置分层、配置页展示和操作结果体验；运行时写盘使用 AW 内建 apply 链路，不依赖插件作者普通 `config.schema` 或动态 artifact tracking。

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
- TUI 中健康安装应优先显示 `卸载`；异常、残留、半完成或无法正常卸载的状态才显示 `清理`。卸载失败后再引导用户进入清理流程。

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
- 当前 TUI 目标选择会把平台和位置拼成组合候选，并在多平台操作中额外提供 `所有平台`。安装目标候选因此同时混合了平台、scope 和批量语义，维护成本较高，也容易让用户在第一步看到过多位置矩阵。
- 本轮要删除的是平台选择里的 `auto`。SkillTrigger 配置里的 `auto` 仍表示允许模型自动触发，两者语义不同，不能在文档和实现中混用。

### SkillTrigger 与配置渲染

- 现有 `SkillTriggerPreference` 只有 `default`、`manual`、`auto` 三个偏好值；`SkillTriggerApplicability` 有 `none`、`fixed`、`overridable` 三类状态。
- 当前公开入口是安装或升级时传 `-t, --skill-trigger default|manual|auto`，TUI 目标选择页也会在可覆盖目标上提示选择 `默认`、`手动`、`自动`。
- 当前持久化真值写在 install record 的 `record.options.skillTriggerPreference`。install record schema 只允许这个单值，不保存每个 skill 的配置来源、分层覆盖或可编辑状态。
- 当前重复安装、显式升级、修复、config refresh 和 refresh-only 会尝试从 install record 恢复并重放触发偏好；install record degraded 时，部分路径会要求用户重新显式传 `--skill-trigger`。
- 当前没有安装后的独立调整入口。用户不能像修改普通插件配置一样，在 TUI 配置页或 `aw config` 里修改某个 skill 的触发策略。
- 动态 `codex.skill` 已经通过 `config.schema`、`artifacts.targets`、`scripts.artifacts.render` 和 artifact apply 链路生成运行时内容；AW apply 阶段会按 install record 中的 `skillTriggerPreference` 再 patch `agents/openai.yaml`。
- 现有 manifest 的 `skillTriggers.<skill>.allowInstallOverride` 只表示安装时是否允许覆盖，不定义默认触发策略，也不表示安装后可动态变更。默认策略仍散落在平台原生文件中：Codex 看 `agents/openai.yaml`，Claude Code 看 `SKILL.md` frontmatter。
- 现有配置分层已经能表达“用户配置覆盖默认值”。SkillTrigger 的长期真值应并入这套配置模型，而不是继续依赖 install record 的历史偏好；写入运行时产物时走 AW 内建 apply 链路，不能强行塞进普通 `config.schema` 或动态 artifact refresh 通道。

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
19. `aw` 只在入口确实需要 shared runtime、native marketplace 或本地 catalog 产物时，才强制校验并同步本地 catalog；纯只读或纯 Codex project repo-managed 流程优先使用 embedded catalog，不为了查询或项目级写入初始化、刷新或修复 `~/.aw`。
20. 插件版本只在 current catalog 版本高于已安装版本时显示 `可升级`；其它版本不一致或不可比较场景显示 `异常`，原因是版本不一致。
21. 删除所有公开平台选择中的 `auto`，CLI、TUI、help、错误提示、文档和测试都不再把 `platform=auto` 作为可用值。
22. 删除平台选择里的隐式推断。`status` 可以在省略 `--platform` 时按 `both` 处理；绑定真实插件 target 的 `install`、`upgrade`、卸载、清理、修复、重装、认领和接管等写操作必须显式选择平台。全局 dependency index 维护入口不绑定插件 target，是平台选择要求的明确例外。
23. `both` 改为“安装到每个插件自己支持的所有平台”，不再固定等同于 Codex + Claude Code 双平台。
24. `both` 展开后的任一目标平台不可执行、不可安装或预检失败时，整条写命令失败且不能产生部分写入。
25. TUI 安装目标选择支持 `both`，并改为先选平台，再选 scope；首个目标页只展示平台，不展示平台和 scope 的组合矩阵。
26. 删除安装、升级、修复、重装和 TUI 目标选择阶段的 SkillTrigger 偏好选择，不再让触发策略作为安装选项流转。
27. SkillTrigger 改为 AW 自动注入的内建配置项，复用现有 `aw config`、TUI 配置管理页和操作结果展示；执行层使用专门的内建 apply 链路。
28. 静态 `skills/<skill>` 和动态 `codex.skill` 产物必须声明默认触发策略，并声明是否允许用户通过配置动态变更该 skill 的触发策略；公共 `slashCommands` 生成的 Codex manual-only skill 使用隐式 fixed/manual 合同，不要求作者重复声明。
29. 动态触发策略按 skill 粒度生效，不使用插件级统一开关，也不按平台拆成多套用户配置。
30. 已有 install record 中的 `skillTriggerPreference` 不再作为运行时真值；新机制上线后直接忽略旧偏好，回到插件声明或 AW 隐式注入的默认策略，除非用户重新写入可动态变更的内建配置项。
31. 状态、诊断和刷新判断以“插件默认策略 + 内建配置 effective 值 + 运行时产物”作为 SkillTrigger 判断依据，不再用安装历史偏好判断 drift。
32. `allowDynamicTrigger: false` 的 skill 忽略历史 `$aw.skillTriggers` 存量覆盖；读路径必须暴露该值已被忽略，不能让 fixed skill 因旧配置重新变成可配。
33. shared runtime owner 只保存 owner 身份和完整性证据，不再保存或回放 SkillTrigger 真值；共享 runtime 的重放、接管和刷新都必须从 owner location 的当前内建配置 effective 值重新计算。

### 范围

- 新增一轮 TUI 首页、插件详情页、状态页、确认页、结果反馈区和配置页的需求定义。
- 调整 CLI `status` / `diagnose` 公开命令边界。
- 明确 `可升级` 的版本判断策略。
- 明确 CLI 和插件版本的严格 SemVer 规范、构建发布门禁和运行时比较规则。
- 明确本地 catalog 缺失、`sourceVersion` 与当前 CLI 版本不一致或本地版本异常时，哪些入口需要同步 `~/.aw`，哪些入口只能只读回退 embedded catalog。
- 明确平台安装目标中删除 `auto`、重定义 `both`、CLI 默认平台、显式平台要求和 dependency index 维护入口例外的公开合同。
- 明确 TUI 安装目标选择从“平台 + scope 组合列表”改为“先选平台，再选 scope”的交互合同。
- 明确 TUI 对卸载、清理、配置、状态详情和操作结果的展示合同。
- 明确状态详情默认数据范围。
- 明确 SkillTrigger 从安装选项迁移到 AW 内建配置项后的作者合同、用户配置合同、存量配置处理和刷新合同。
- 明确 shared runtime owner 从“owner + preference”迁移到“owner 身份 + owner effective 配置解析”的合同。
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
- 不保留 `aw diagnose` 兼容命令。旧入口不做 alias、不执行诊断，只允许保留隐藏迁移 stub 输出确定性错误；帮助、文档、TUI 和所有用户可见 CLI 输出都不再引用 `diagnose`。
- TUI 首页使用插件卡片，并按状态分组。
- 状态图标使用终端可见符号，例如 `!`、`↑`、`✓`、`○`，不使用 icon id。
- `可升级` 使用语义版本比较。只有 current catalog 版本高于已安装版本时，才显示 `可升级`。
- 状态详情默认只显示已发现安装或状态证据，不显示纯未安装 catalog 位置。
- 详情页建议通过功能菜单标记推荐操作，不显示命令。
- TUI 里状态和诊断合并为单一 `状态` 下级页面，页面内可选择 `详情` 查看详细信息。
- TUI 全部页面禁止展示命令行建议，包括首页、详情页、状态页、状态详细信息、结果页、配置页和确认页。
- `nextSteps` 公开合同升级为结构化对象；每条下一步必须有用户可读的动作名和作用说明，命令只能作为 CLI/JSON 的附属字段，不能成为唯一内容。
- CLI 所有人类输出中的下一步都不能只有裸命令。包含命令时，必须同时说明它用来解决什么问题、会进入什么流程或会查看什么信息。
- 危险确认统一使用选项页，不使用 `y/N` 文本确认。
- 健康安装只显示 `卸载`；异常、残留或卸载失败后再显示或引导 `清理`。
- 操作完成后回插件详情页，并只保留最近一次操作结果。
- 配置管理页覆盖 `生效`、`个人`、`项目` 和 `本地` 视图，并映射到现有 user、project shared 和 project local 配置层。
- CLI package version 和插件 `manifest.version` 都必须是严格 SemVer 2.0.0，不接受 `v1.2.3`、`1.2`、version range 或其它宽松写法。
- 构建、打包和发布都必须校验版本号；任一 CLI 或插件版本不符合规范时失败，不能产出可发布结果。
- 本地 catalog 版本号指 `~/.aw/config.json` 中的 `sourceVersion`，启动时与当前 CLI package version 做严格 SemVer 比较。
- 需要 shared runtime、Codex user native runtime、Claude native runtime、本地 marketplace 注册或其它 `~/.aw` 产物的入口，必须先执行本地 catalog gate；非交互环境遇到需要确认的覆盖场景时直接失败。
- 这类入口发现本地 catalog 完全不存在时自动初始化本地 catalog；当前 CLI 版本高于本地 catalog `sourceVersion` 时自动刷新本地 catalog；当前 CLI 版本等于本地 catalog `sourceVersion`、但 bundle fingerprint 不一致或布局健康检查失败时，也自动用当前 CLI embedded bundle 刷新。这些动作相当于自动执行 `init`，会写入本地 catalog，但不进入覆盖确认。
- 这类入口发现当前 CLI 版本低于本地 catalog `sourceVersion`，或本地 `sourceVersion` 缺失、非法、无法比较时，CLI 输出警告并要求用户输入 `y/n` 确认是否覆盖；TUI 使用选项确认页。
- 用户不选择覆盖本地 catalog 时，需要该本地 catalog 的命令或动作直接退出，不继续写入；TUI 保留在原页面或退出当前动作，不把失败动作伪装成普通取消。
- 带 `--json` 的 CLI 入口经过本地 catalog gate 时，所有 gate 警告、确认问题和取消/失败错误都只能写 stderr，stdout 仍由原命令独占；成功继续后 stdout 只能输出原命令的单一 JSON payload。
- 带 `--json` 的 CLI 入口在非交互环境遇到需要确认的覆盖场景，或用户拒绝覆盖时，返回非零退出码，stdout 为空，stderr 输出稳定错误说明；不为本地 catalog gate 额外发明 `ok: false` JSON envelope。
- 纯只读入口和纯 Codex project repo-managed 写入入口不触发本地 catalog 初始化、刷新或修复。本地 catalog 缺失、落后、bundle fingerprint 不一致、布局损坏或版本领先时，这些入口使用当前 CLI embedded catalog 继续；需要提示时只在 verbose、JSON 诊断或 TUI 状态详情中说明本地插件列表未被使用。
- 插件版本判断采用“非升级即异常”：current catalog 插件版本高于已安装版本时显示 `可升级`；其它版本不一致或不可比较时显示 `异常`，异常原因是版本不一致。
- 平台选择值删除 `auto`。公开 CLI、TUI、help、错误提示和文档都不再展示或接受 `platform=auto`。
- `aw status` 未传 `--platform` 时默认使用 `both`。绑定真实插件 target 的 `aw install`、`aw upgrade`、`aw uninstall`、`aw cleanup`、`aw repair`、`aw reinstall`、认领和接管类写入口必须显式传 `--platform codex|claude|both`，不能省略后隐式展开。`aw repair --dependency-index` 和 `aw cleanup --dependency-index --prune-stale <token> --yes` 是全局维护动作，不接受也不要求 `--platform`。
- 安装和升级里的 `both` 表示按每个插件自身的 current manifest 支持平台集合展开目标。单平台插件只生成该单平台目标，双平台插件生成两个平台目标；批量安装时每个插件按自己的支持集展开。
- 恢复动作里的 `both` 表示所有可处理目标，可以包含有现场受管证据的历史不支持平台。历史不支持平台只能用于收口旧安装或残留，不能用于新安装、升级或重新创建 current runtime。
- 首页和详情页的平台摘要必须同时承认 current manifest 支持平台和有现场证据的历史恢复目标；历史不支持平台不得被隐藏到状态页里，也不能展示成普通未安装平台。
- 安装、升级和其它新写入分支显式选择 `codex` 或 `claude` 时，是整组选中插件的 all-or-nothing 请求。只要有任一插件当前不支持所选平台，CLI 必须在写入前失败；TUI 平台页不能让用户把该平台作为可选目标继续提交。
- `both` 展开后，如果任一目标平台当前不可执行、插件在该平台不可安装、scope 组合不合法或写入前预检失败，本次写命令整体失败，不允许已经写入部分目标后再跳过失败目标。
- TUI 安装目标选择支持 `both`，并拆成两个连续步骤：先选择平台，再选择 scope。平台页只能列 `Codex`、`Claude Code` 和 `全部支持平台` 这类平台选项；scope 页再列 `个人`、`项目`。
- TUI 批量安装继续采用“单批次单一 scope”模型，不在本轮支持同一批插件按插件分别选择 scope。进入平台页前必须先确认整组选中插件存在至少一个共同可用 scope；不存在共同 scope 时直接失败，并提示用户拆成多次安装。
- TUI 安装平台页的候选按“所选插件在任一可选 scope 下仍可能安装”的并集生成，不能为了避免后续校验而取所有 scope 的交集并提前隐藏只在 user 或 project scope 可安装的平台。
- 用户在 scope 页确认后，TUI 必须用已选平台和 scope 重新展开真实目标并执行完整预检。若已选平台因该 scope 失效，流程不能直接硬失败；必须回到平台页，说明失效原因，并确保失效候选在当前上下文下不能继续提交。用户已选插件和可保留的上下文不得丢失。
- TUI 安装目标页不再展示平台和 scope 的笛卡尔积候选。
- 删除安装期 SkillTrigger 配置入口。`aw install`、`aw upgrade`、`aw repair`、`aw reinstall` 和 TUI 目标选择页都不再接受或展示 `--skill-trigger` / `-t`。
- 不保留 `--skill-trigger` 兼容别名；触发策略只能通过 AW 内建配置项查看和修改。
- AW 为 skill 自动注入内建触发策略配置项，插件作者不需要也不能在普通 `config.schema` 中手写这些保留字段。
- SkillTrigger 配置按 skill 粒度生效。静态 `skills/<skill>` 和动态 `codex.skill` 产物必须由作者声明默认触发策略，以及是否允许用户动态变更；公共 `slashCommands` 生成的 Codex manual-only skill 由 AW 注入固定 `manual` 默认值，不能动态变更。
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

首页状态符号和默认颜色为：

- `○`：未安装，弱化色。
- `✓`：已安装，绿色。
- `↑`：可升级，黄色。
- `!`：异常，红色。

依赖详情页使用独立状态符号：

- `✓`：依赖正常，绿色。
- `!`：依赖异常，红色。
- `×`：依赖缺失，红色。

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
- `both`：安装、升级时请求每个插件当前支持的全部平台；恢复动作时请求所有可处理目标。

默认行为：

- `aw status` 未传 `--platform` 时默认值为 `both`，表示查看当前有状态证据的所有真实平台。
- 绑定真实插件 target 的 `aw install <plugin>`、`aw upgrade <plugin>`、`aw uninstall <plugin>`、`aw cleanup <plugin>`、`aw repair <plugin>`、`aw reinstall <plugin>`、认领现有安装和接管共享运行时等写入口必须显式传 `--platform codex|claude|both`。省略平台时命令失败，并提示用户显式选择目标平台。dependency index 维护入口按 R14 的全局维护动作处理，不套用这条默认行为。
- 写入口只有在用户显式传入 `--platform both`，或在 TUI 里显式选择“全部支持平台 / 所有可处理目标”时，才能展开为多目标操作。
- TUI 安装流程必须让用户显式选择平台；默认焦点可以落在 `全部支持平台`，但页面上不能出现 `auto`。
- 查询型或状态型入口不再接受 `--platform auto` 作为兼容别名。需要全部平台时使用 `both`，需要单平台时使用 `codex` 或 `claude`。

平台目标解析必须拆成两层门禁：

- 新写入门禁：`install`、`upgrade`、依赖安装/升级，以及 `reinstall` 的重新安装阶段，只能按 current manifest 的支持平台展开。目标插件当前不支持的平台必须在写入前失败，不能凭历史证据重新安装或升级。
- 历史恢复门禁：`uninstall`、`cleanup`、`repair`、认领现有安装、接管共享运行时，以及 `reinstall` 的移除和恢复评估阶段，可以命中“current manifest 已不再支持、但现场仍有 AW 受管安装或残留证据”的真实平台。
- 历史恢复目标必须来自可定位证据，例如 install record、tracking manifest、project artifact identity、native transaction marker、dynamic diagnostic cache、shared runtime owner、AW 可证明归属的 native residue 或其它 install-state facade 暴露的受管状态。不能只因为用户传入了某个平台就凭空生成目标。
- 命中历史不支持平台时，只开放能收口旧现场的恢复动作，例如卸载、清理、补齐可证明的 marker/record、刷新诊断或解除受管归属。任何需要按 current catalog 在该平台创建新 runtime、升级 runtime 或重新安装 current bundle 的分支都必须在写入前失败，并提示改用支持平台或先清理旧平台残留。
- `aw reinstall --platform both` 如果同时展开到当前支持平台和历史不再支持、但仍有受管安装或残留证据的平台，整条命令必须在写入前失败。CLI 和 TUI 都不能在同一次重装里一边清理历史不支持平台、一边重建当前支持平台；提示用户先用 `aw cleanup` 或可用的恢复动作收口历史平台，再对当前支持平台重新运行 `reinstall`。

`both` 展开规则：

- 安装、升级和其它新写入分支的支持平台来自插件 manifest 的 `marketplace.policy.products` 解析结果；未声明产品时按当前既有默认支持平台集合解释。
- 单平台插件在新写入分支选择 `both` 时，只生成该插件唯一支持平台的目标。
- 双平台插件在新写入分支选择 `both` 时，生成 Codex 和 Claude Code 两个平台目标。
- 批量安装多个插件时，每个插件按自己的支持平台集合独立展开，不要求所有插件支持集合完全相同，也不取共同交集。
- 新写入分支的展开结果中不能包含插件当前不支持的平台。
- 恢复动作选择 `both` 时，展开范围是“所有可处理目标”：当前支持平台上的真实目标，加上有现场证据的历史不支持平台目标。没有 current support 且没有现场证据的平台不能进入目标集。
- 展开后的每个真实目标都必须继续通过环境可执行性、scope 合法性、Codex project installability、重复安装、required config 和写入安全预检。
- 任一展开目标不可执行或预检失败时，整条写命令失败；失败前不能产生写入，已经进入写入阶段的批量动作也不能把失败目标静默跳过后继续伪装成功。
- 多目标写操作必须把每个展开后的真实目标纳入确认、进度、结果、receipt 和回滚模型。任一目标失败时，结果必须清楚标明已完成、已回滚、未执行和失败目标，不能只给一个模糊的整体成功或失败。

显式单平台规则：

- 用户显式选择 `codex` 或 `claude` 时，请求语义是“把整组选中插件都安装或操作到该平台”，不是“只处理兼容子集”。
- 安装、升级和其它新写入分支中，只要有任一插件不支持所选单平台，整条命令必须在写入前失败，并说明不兼容的插件和目标平台。
- 恢复动作显式选择单平台时，如果该平台已不在 current manifest 支持范围内，但存在可证明的历史受管安装或残留，可以继续进入对应恢复流程；如果没有现场证据，则必须失败并说明该平台既不受当前插件支持，也没有可恢复目标。
- TUI 平台页只把整组选中插件共同支持的单平台作为可选项；不满足整组兼容的平台不能继续提交。
- 当整组选中插件没有共同单平台，但每个插件至少有自己的支持平台、因此 `both` 可以展开时，TUI 平台页只保留 `全部支持平台`。
- `both` 是唯一允许按插件各自支持平台拆开的批量平台选择。

TUI 平台与 scope 交互规则：

- TUI 批量安装不支持 per-plugin scope。进入平台页前必须计算整组选中插件的共同可用 scope；如果插件 A 只能安装到 `user`、插件 B 只能安装到 `project`，整组选中插件没有共同 scope，流程必须 fail fast，提示“这批插件没有共同安装位置，请分开安装”，不展示平台页或 scope 页。
- 跨 scope 并集候选只适用于已经存在至少一个共同 scope 的安装请求。它不能绕过单批次单一 scope 模型，也不能把同一批插件自动拆成多个 scope 写入。
- 安装平台页的候选口径是跨 scope 并集：只要某个平台对整组选中插件在至少一个可选 scope 下仍可能安装，就可以出现在平台页；不要求它同时满足 user 和 project 两个 scope。
- 候选仍必须先受 manifest 支持平台、当前环境可执行性和整组选中插件兼容性约束。对显式单平台候选，整组选中插件都必须支持该平台；对 `全部支持平台`，按每个插件自己的支持平台集合解释。
- scope 页确认后，TUI 必须使用已选平台和已选 scope 重新展开真实目标，并执行环境可执行性、scope 合法性、Codex project installability、重复安装、required config 和写入安全预检。
- 如果 scope 让已选平台或 `全部支持平台` 展开的任一真实目标失效，TUI 必须回到平台页，展示该 scope 下不可继续的原因，例如“Codex 不能安装到当前项目”。回到平台页后，失效候选可以隐藏或置为不可选，但不能继续提交；已选插件和已选 scope 的上下文应尽量保留，用户可以返回 scope 页更换 scope。
- 这类 scope 失效发生在写入前，不能产生安装记录、运行时文件、诊断缓存、receipt 或其它写入副作用。

持久状态规则：

- install record、tracking manifest、project artifact identity、dependency index、diagnostic cache 和 receipt target 中只保存真实平台 `codex` 或 `claude`。
- `both` 只存在于用户请求、TUI 选择和命令解析阶段；写入、状态、诊断和回滚都必须面对展开后的真实目标。
- 删除 `auto` 不改变 scope 的取值，scope 仍为 `user` 或 `project`。

### Skill 触发策略配置

Skill 触发策略不再是安装选项，而是 AW 管理的内建配置。内建配置项与插件作者自定义 `config.schema` 共用配置查看、字段编辑、重置和结果展示体验，但字段由 AW 注入，插件作者不能把同名保留字段写进普通 schema；真正写入 runtime 时走 AW 内建 apply 链路。

触发策略使用平台中立语义：

```ts
type SkillTriggerMode = 'manual' | 'auto';

interface SkillTriggerConfigContract {
  skillName: string;
  defaultTrigger: SkillTriggerMode;
  allowDynamicTrigger: boolean;
}
```

作者 manifest 合同直接复用并升级 `skillTriggers.<skill>`：

```json
{
  "skillTriggers": {
    "codex-explore": {
      "defaultTrigger": "manual",
      "allowDynamicTrigger": true
    }
  }
}
```

字段语义：

- `defaultTrigger` 是插件作者为显式声明型 skill 声明的默认触发策略。
- `allowDynamicTrigger` 表示用户是否可以通过 AW 配置动态变更该 skill 的触发策略。
- `manual` 表示禁止模型自动触发，但保留用户显式触发入口。
- `auto` 表示允许模型自动触发。
- 新合同下 `skillTriggers.<skill>` 只允许 `defaultTrigger` 和 `allowDynamicTrigger`。旧的 `allowInstallOverride` 不再表达长期配置语义，不能继续作为新 manifest 的有效字段。
- `skillTriggers` 是作者显式声明型 SkillTrigger 的完整声明表，不再是可选 override 表；AW 管理面中的完整 SkillTrigger 集合还包括公共 `slashCommands` 生成物的隐式 fixed/manual 条目。
- 静态 `skills/<skill>` 子目录和 `artifacts.targets[].target = "codex.skill"` 声明的 `skillKey` 必须有 `skillTriggers.<skill>` entry。缺失任一 entry 时，build/validate 失败，不能回退到 `SKILL.md` 或 `agents/openai.yaml` 推断新合同默认策略。
- 公共 `slashCommands` 在 Codex 侧生成的 manual-only skill 属于 AW 受管 skill，但不要求作者手写 `skillTriggers.<command>` entry。AW 必须把它们注入为隐式 fixed/manual 字段：`defaultTrigger: "manual"`、`allowDynamicTrigger: false`。
- `skillTriggers` 的 key 必须对应可发现的作者声明型受管 skill key。未知 key、重复 key，或不对应静态 skill 目录 / 动态 `artifacts.targets[].skillKey` 的 key 都必须校验失败；公共 `slashCommands` 生成的 skill key 不能作为显式 `skillTriggers` key 重复声明。

生效规则：

- 每个 skill 独立计算触发策略，不使用插件级统一配置。
- 未写入内建配置时，effective 值等于该 skill 的 `defaultTrigger`。
- `allowDynamicTrigger: true` 且写入内建配置时，effective 值等于当前配置分层解析出的 `manual` 或 `auto`。
- 恢复默认通过清空或重置内建配置完成，不再保存 `default` 这种安装偏好值。
- `allowDynamicTrigger: false` 的 skill 在配置页只读展示默认策略；`aw config set` 必须拒绝写入对应内建字段。
- `allowDynamicTrigger: false` 时，effective 值永远等于 `defaultTrigger`。如果历史 `$aw.skillTriggers.<skill>.trigger` 已经存在，effective 计算必须忽略该存量值，`aw config list/get` 和 TUI 配置页要把它标记为已忽略的旧配置，而不是把它显示成当前值。
- 查询路径不能静默删除被忽略的旧配置。用户可以在 user 或 project shared 层通过 `aw config unset/reset`，或通过带明确配置清理语义的受控 cleanup/migration 动作清掉旧值；清理前后 effective 值都保持 `defaultTrigger`。如果旧值误写在 project local store，只能通过整层 `aw config reset <plugin> --scope project --local` 清理。
- 已有 install record 的 `options.skillTriggerPreference` 直接忽略，不参与默认值、effective 值、runtime patch、status 或 drift 判断。

配置分层沿用现有 AW config 语义：

- user scope runtime 使用默认值和 user 配置计算。
- project scope repo-visible runtime 使用默认值和 project shared 配置计算。
- project local 配置不能改变项目级 repo-visible skill 的触发策略。
- `aw config list/get --scope project` 读取 SkillTrigger 内建字段时，`effectiveValue` 和 `sourceLayer` 一律表示 project runtime 真值，只合并默认值和 project shared 配置；project local 中即使存在同名 `$aw.skillTriggers` 存量值，也不能影响该字段的 effective、runtime patch、status 或 drift。
- 仍合法且 `allowDynamicTrigger: true` 的 SkillTrigger key 如果已经误写到 project local store，读路径必须把它作为不可生效的存量值公开：`valueState: "invalid"`、`invalidReason: "unsupportedProjectLocalLayer"`，并继续暴露 `storedValue` 和 `storedSourceLayer: "local"`。它不能改变默认 `effective` / `生效` 视图里的 project runtime 真值，也不能被 TUI 展示成本地可编辑字段。
- `aw config set/unset <plugin> aw.skillTriggers.<skill>.trigger --scope project --local` 必须确定性失败，不写入 project local store，不触发 built-in apply pipeline，并提示项目本地层不适用于 SkillTrigger 内建字段。若未来提供按字段 reset，`reset` 作用到该内建 key 时同样失败；现有整层 `aw config reset <plugin> --scope project --local` 只作为 project local store 清理入口保留，不代表允许本地层配置 SkillTrigger。
- SkillTrigger 内建字段的读取、写入、清空和重置不依赖插件作者普通 `config.schema`。没有普通 schema、但存在显式 `skillTriggers` 或公共 `slashCommands` 隐式 fixed/manual 字段的插件，也必须能进入 `aw config` 和 TUI 配置页。
- 保存 SkillTrigger 内建字段后，执行层走 AW 专门的 built-in apply pipeline，把 effective 触发策略写回已安装 runtime；这条链路不要求存在 tracked dynamic artifact。
- built-in apply pipeline 至少覆盖静态 Codex skill、Claude Code skill、动态 `codex.skill` 产物，以及公共 `slashCommands` 生成的 Codex fixed/manual skill。普通插件 `config.schema` 和动态 renderer 仍使用既有配置 refresh 机制。
- CLI 只对当前可定位的已安装目标应用内建变更，不扫描所有历史项目。
- status、config JSON、repair、built-in apply 和 shared runtime replay 不能各自重新解释 SkillTrigger 真值；它们必须复用同一个 SkillTrigger resolver。resolver 的输入是 manifest 默认策略、AW 内建配置分层和 runtime target，输出统一的 effective 值、公开投影和 apply 输入。

shared runtime owner 的 SkillTrigger 真值合同：

- shared runtime owner 文件只负责记录 owner location、owner record digest、更新时间和其它完整性证据；新 schema 不再把 `preference` 作为必填字段或运行时真值。兼容读取旧 owner 文件时，旧 `preference` 只作为 legacy payload 保留或忽略，不能参与 effective、runtime patch、status 或 drift。
- `--takeover-shared-runtime`、卸载后的 shared runtime rematerialize、`aw init`、marketplace refresh，以及任何 replay shared runtime 的路径，都必须复用同一套 owner-effective 解析逻辑：先验证 owner 身份和 owner record，再从 owner location 当前可见的默认策略、user / project shared 内建配置计算 SkillTrigger effective 值。
- 接管 shared runtime 时只迁移控制权，不复制旧 owner 文件里的 `preference`，也不从被接管方的 install record `skillTriggerPreference` 推导新真值。
- owner 证据不可验证、owner record 与 owner location 不匹配，或 owner location 的 current effective built-in config 不可解析时，shared runtime replay 必须 fail closed；CLI / TUI / JSON 下一步给出确定性的 `repair` 或单目标 `--takeover-shared-runtime` 恢复指引，不能回退到 embedded 默认策略后继续写共享 runtime。

配置存储与公开 key：

- AW 注入字段不写入插件作者的普通 `config.schema`，也不要求插件声明普通 schema 后才能出现。
- 用户和 JSON 中使用的逻辑 key 统一为 `aw.skillTriggers.<skill>.trigger`，取值只允许 `manual` 或 `auto`。
- 配置 store 内部使用 AW 保留顶层 namespace `$aw` 持久化，例如 `{ "$aw": { "skillTriggers": { "<skill>": { "trigger": "manual" } } } }`。`$aw` 不是普通 config key，插件自定义 `config.schema` 不能声明、覆盖或读取这个 namespace。
- `aw config list/get --json` 必须能区分字段来源：普通插件字段标记为 `kind: "manifest"`，AW 注入字段标记为 `kind: "builtIn"` 且 `reserved: true`，并返回逻辑 key、展示标题、effective 值、来源层和是否可写。
- `aw config set/unset/reset --json` 使用 `receiptSchemaVersion: 2` 写命令 receipt；receipt 必须在 `affectedFields` 中回显被写入、清空或重置的字段身份，包括逻辑 key、展示标题、`kind`、`reserved`、作用层和本次动作。写命令不输出 `configSchemaVersion: 2`，也不能把 `aw config list/get --json` 的 `fields` 当作 receipt 主结构。
- fixed skill 的历史 `$aw` 覆盖值出现在 JSON 中时，必须在对应字段上使用稳定标记，例如 `valueState: "ignored"`、`ignoredReason: "fixedSkillTrigger"`，并暴露被忽略的值和来源层；effective 值和来源仍指向 `defaultTrigger` / `default`。
- 如果插件已经不在 current catalog 中，或插件仍在但某个历史 skill key 已经不在当前显式 `skillTriggers` 声明、动态 `codex.skill` 声明和公共 `slashCommands` 隐式 fixed/manual 生成集合中，存量 `$aw.skillTriggers.<skill>.trigger` 必须作为 orphaned 旧配置处理。`aw config list/get --json` 和 TUI 配置页要用稳定标记暴露它，例如 `valueState: "orphaned"`、`orphanedReason: "pluginRemoved" | "skillRemoved"`，并显示存量值和来源层；它没有 effective 值，不能参与 runtime patch、status 或 drift 判断。
- orphaned SkillTrigger 旧配置只允许清理，不允许继续写入。`aw config set` 必须拒绝这类 key；user 或 project shared 层的 `aw config unset <plugin> aw.skillTriggers.<skill>.trigger` 必须能按 key 删除该旧值，即使插件没有普通 `config.schema`、插件已不在 current catalog 中，或该 skill key 已经不在当前显式或隐式 SkillTrigger 集合中。project local 层不支持 SkillTrigger 按 key 清理，只能通过整层 `aw config reset <plugin> --scope project --local` 清理误写入的本地 store；`aw config reset` 仍可清理整个配置层。
- helper、lifecycle context 和动态 renderer 默认只接收普通 `config.schema` 解析出的 `config.values`；如果 renderer 需要 SkillTrigger effective 值，只能读取 AW 显式提供的只读 built-in context，不能从 `$aw` store 私自解析。

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

interface NextStepsPayloadBoundary {
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
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

公开 JSON 的版本边界：

- 所有公开 JSON payload、console item、friendly summary 和 receipt 中，新的 `nextSteps` 字段都必须是 `NextStepInstruction[]`，同一对象层级必须带 `nextStepsSchemaVersion: 1`。
- 需要兼容旧消费者时，只能额外双写 `legacyNextSteps: string[]`，不能继续让 `nextSteps` 在不同场景下有时是字符串数组、有时是对象数组。
- `aw status --json` 顶层新增 `statusSchemaVersion: 2`，同时将顶层 `consoleItemsSchemaVersion` 提升到 `3`。`statusSchemaVersion` 管理整个 status envelope、顶层字段和 `status --verbose --json` 的详细状态结构；`consoleItemsSchemaVersion: 3` 管理本轮新的 `consoleItems` 子结构，包括结构化 `nextSteps`、SkillTrigger 公共投影和旧 SkillTrigger 字段移除。旧 `consoleItemsSchemaVersion: 2` 只代表本轮之前的 console item V2 shape，不能承载本轮修改后的 `consoleItems`。
- `install`、`upgrade`、`uninstall`、`cleanup`、`repair`、`reinstall` 和 `config` 相关 JSON receipt 顶层新增 `receiptSchemaVersion: 2`。receipt 中的 target、action、nextSteps 和 legacyNextSteps 都以这个版本边界解释；配置写命令 receipt 额外用 `affectedFields` 表达被写入、清空或重置的字段身份。
- `aw config list/get --json` 顶层新增 `configSchemaVersion: 2`。未带 `configSchemaVersion` 的旧输出视为 legacy v1；本轮新增的 AW 内建字段、ignored/orphaned 状态和配置来源层都只按 v2 合同解释。
- `aw diagnose` 不再是公开命令，因此不再维护新的 diagnose JSON 合同；原 diagnose 可见信息迁移到 `status --verbose --json` 后，按 `statusSchemaVersion: 2` 输出。

本轮版本边界固定如下：

| 字段 | 版本 | 管理范围 |
|---|---:|---|
| `statusSchemaVersion` | `2` | status 顶层 envelope、顶层字段、verbose JSON 详细状态 |
| `consoleItemsSchemaVersion` | `3` | `consoleItems` summary shape、结构化 `nextSteps`、SkillTrigger 公共投影 |
| `nextStepsSchemaVersion` | `1` | 同层 `nextSteps: NextStepInstruction[]` |
| `receiptSchemaVersion` | `2` | 写命令 receipt 的 target、action、nextSteps、legacyNextSteps；配置写命令的 `affectedFields` |
| `configSchemaVersion` | `2` | `aw config list/get --json` 的 `fields: ConfigFieldEntryV2[]` |

- `statusSchemaVersion`、`consoleItemsSchemaVersion`、`configSchemaVersion` 和 `receiptSchemaVersion` 必须分别有清晰的公开 payload 边界。CLI 人类输出、TUI 页面和 legacy 兼容字段不能作为新 JSON schema 的主数据来源，也不能在不同命令里临时拼出彼此不一致的字段。
- `statusSchemaVersion: 2`、`consoleItemsSchemaVersion: 3`、`configSchemaVersion: 2` 和 `receiptSchemaVersion: 2` 的 payload 必须分别由对应的结构化编码边界产出。实现不能沿用人类输出 renderer、TUI 页面模型或旧 JSON payload 顺手追加字段来生成新合同；字段状态、`nextSteps`、target result 和配置 entries 必须先落到各自的结构化模型，再进入 JSON 输出。

SkillTrigger 公开投影使用直接替换策略：

- `statusSchemaVersion: 2`、`receiptSchemaVersion: 2`、TUI console item 和 friendly summary 中不再输出旧 `skillTriggerApplicability`、`installOptions`、`skillTriggerPreference`、`skillTriggerRuntimeMatches`、`skillTriggerRuntimeState`、`skillTriggerDrift` 字段。
- 这些旧字段可以继续作为内部过渡类型存在，但不能进入公开 JSON、人类 verbose 输出、receipt、TUI 页面或下一步指示；用户可见文案也不能继续使用“账本偏好”表达 SkillTrigger 真值。
- 所有公开出口如果需要描述 SkillTrigger 状态，必须复用同一套按 skill 展开的投影字段，不能在 status、receipt、TUI 和 config JSON 中各自发明字段名。

```ts
type SkillTriggerValueState = 'default' | 'configured' | 'fixed' | 'ignored' | 'orphaned';
type SkillTriggerRuntimeState = 'notInstalled' | 'matches' | 'mismatched' | 'missing' | 'unreadable' | 'notApplicable';
type SkillTriggerDriftReason = 'runtimeTriggerMismatch' | 'runtimeTriggerMissing' | 'runtimeUnreadable';

interface SkillTriggerPublicView {
  skillName: string;
  defaultTrigger: SkillTriggerMode;
  effectiveTrigger: SkillTriggerMode | null;
  allowDynamicTrigger: boolean;
  valueState: SkillTriggerValueState;
  sourceLayer: 'default' | 'user' | 'project' | 'local' | null;
  runtimeState: SkillTriggerRuntimeState;
  runtimeTrigger?: SkillTriggerMode;
  driftReason?: SkillTriggerDriftReason;
  storedTrigger?: SkillTriggerMode;
  ignoredReason?: 'fixedSkillTrigger';
  orphanedReason?: 'pluginRemoved' | 'skillRemoved';
}
```

字段语义：

- `defaultTrigger` 来自 current manifest 的 `skillTriggers.<skill>.defaultTrigger`；公共 `slashCommands` 生成的 Codex manual-only skill 使用 AW 注入的隐式 `manual` 默认值。
- `effectiveTrigger` 是最终要写入 runtime 的触发策略；orphaned 旧配置没有 effective 值，必须为 `null`。
- `valueState: "default"` 表示未写入内建配置，effective 来自默认策略。
- `valueState: "configured"` 表示 `allowDynamicTrigger: true` 且当前配置层写入了有效覆盖值。
- `valueState: "fixed"` 表示 `allowDynamicTrigger: false`，effective 固定等于默认策略，且没有需要提示的旧覆盖值。
- `valueState: "ignored"` 表示 fixed skill 存在历史 `$aw` 覆盖值；`storedTrigger` 暴露存量值，`ignoredReason` 必须为 `fixedSkillTrigger`，但 drift 判断仍只比较 `effectiveTrigger` 和 runtime。
- `valueState: "orphaned"` 表示存量 `$aw.skillTriggers.<skill>.trigger` 已不属于 current catalog、current manifest 显式声明或公共 `slashCommands` 隐式生成集合；它没有 `effectiveTrigger`，不能参与 runtime patch、status 或 drift，只能被清理。
- `runtimeState` 描述实际 runtime 产物与 `effectiveTrigger` 的关系；只有 `mismatched`、`missing`、`unreadable` 这类异常状态需要带 `driftReason`。
- `status --json` 可在 target、detail 或 console item 的稳定位置暴露 `skillTriggers: SkillTriggerPublicView[]`；receipt 如需暴露配置应用后的 SkillTrigger 结果，也只能复用同名数组或字段 entries 中的同一投影。

配置 JSON v2 使用字段 entries 作为主合同：

```ts
type ConfigFieldKind = 'manifest' | 'builtIn';
type ConfigValueState = 'default' | 'configured' | 'fixed' | 'ignored' | 'orphaned' | 'invalid';
type ConfigStoreKind = 'user' | 'projectShared' | 'projectLocal';

interface LegacyConfigStoreEntryV2 {
  plugin: string;
  storeKind: ConfigStoreKind;
  projectRoot?: string;
  reason: 'pluginRemoved' | 'schemaUnavailable';
  fieldVisibility: 'storeOnly';
  cleanupOnly: true;
}

interface ConfigFieldEntryV2 {
  key: string;
  title: string;
  kind: ConfigFieldKind;
  reserved: boolean;
  writable: boolean;
  valueState: ConfigValueState;
  effectiveValue: unknown | null;
  sourceLayer: 'default' | 'user' | 'project' | 'local' | null;
  storedValue?: unknown;
  storedSourceLayer?: 'user' | 'project' | 'local';
  ignoredReason?: 'fixedSkillTrigger';
  orphanedReason?: 'pluginRemoved' | 'skillRemoved';
  invalidReason?: 'unsupportedProjectLocalLayer';
}

interface ConfigJsonV2 {
  configSchemaVersion: 2;
  command: 'config:list' | 'config:get';
  plugin: string;
  key?: string;
  scope: 'effective' | 'user' | 'project';
  projectLayer: 'shared' | 'local';
  fields: ConfigFieldEntryV2[];
  legacyConfigStores?: LegacyConfigStoreEntryV2[];
}
```

要求：

- `fields` 是 `aw config list/get --json` 的主数据结构；旧 `summary.values` / `layers` 不能作为 built-in、ignored 或 orphaned 信息的唯一载体。
- `ConfigValueState` 不包含 `effective`。顶层 `scope: "effective"`、TUI `生效` 作用层和字段上的 `effectiveValue` 只表达读取视角与合并后取值，不能作为字段状态编码。
- 普通插件配置字段在 `scope: "effective"` 视图中仍按取值来源编码：来自 schema 默认值或未配置状态时使用 `valueState: "default"`；来自 user、project shared 或 project local 配置层的有效覆盖时使用 `valueState: "configured"`。CLI、TUI 和 JSON 都不得输出 `valueState: "effective"`。
- 普通插件配置字段使用 `kind: "manifest"`、`reserved: false`。
- 只要已有普通 manifest 配置 store 无法被 current manifest 的普通 `config.schema` 解释，`aw config list/get --json` 和 TUI 配置页都只承诺 store 级可见性：通过 `legacyConfigStores` 或等价结构说明哪个 store 仍存在，并标记 `fieldVisibility: "storeOnly"`、`cleanupOnly: true`。插件已不在 current catalog 时使用 `reason: "pluginRemoved"`；插件仍在 current catalog、但当前 manifest 没有普通 `config.schema` 时使用 `reason: "schemaUnavailable"`。在没有 current schema 的情况下，不枚举普通 raw key，不输出普通字段值，也不把这些历史 key 塞进 `fields`。
- 无法被 current manifest 普通 `config.schema` 解释的旧普通配置，字段级读取不属于本轮合同。`aw config get <plugin> <普通key> --json` 在无法从 current manifest schema 解释该 key 时，必须确定性失败；stdout 为空，stderr 说明该插件只剩 store 级旧配置、不能读取普通字段 raw value。用户只能通过整层 `aw config reset` 或 TUI `清理旧配置` 删除对应 store；`remove-config` 只服务仍绑定主体 target 的 `aw uninstall` / `aw cleanup` 流程。遗留 `$aw.skillTriggers` 能解析为 orphaned SkillTrigger 时仍按 built-in `fields` entry 暴露和按 key 清理。
- AW 注入 SkillTrigger 字段使用 `kind: "builtIn"`、`reserved: true`，`key` 必须是用户可操作的逻辑 key `aw.skillTriggers.<skill>.trigger`，不能暴露内部 `$aw` 存储路径作为主 key。
- project scope 下，SkillTrigger built-in entry 的 `effectiveValue` 和 `sourceLayer` 是 project runtime 口径，不是通用 `default < user < project shared < project local` 合并口径；project local 不进入该 entry 的 effective 计算，只能在存在存量值时按 invalid 存量值公开。
- `allowDynamicTrigger: false` 且没有历史 `$aw` 覆盖值的 SkillTrigger built-in entry 必须使用 `valueState: "fixed"`、`writable: false`、`effectiveValue: defaultTrigger` 和 `sourceLayer: "default"`。它不是普通 `default` 可编辑字段，也不是 `effective` 展示别名。
- 仍合法且 `allowDynamicTrigger: true` 的 SkillTrigger key 如果存在 project local 存量值，`aw config list/get --scope project --json` 必须在对应 built-in entry 上标记 `valueState: "invalid"`、`invalidReason: "unsupportedProjectLocalLayer"`，并通过 `storedValue` 和 `storedSourceLayer: "local"` 暴露该存量值；`effectiveValue` 和 `sourceLayer` 仍保持 project runtime 真值。
- fixed skill 的历史覆盖值使用 `valueState: "ignored"`、`ignoredReason: "fixedSkillTrigger"`；`effectiveValue` 和 `sourceLayer` 仍指向默认策略，`storedValue` 和 `storedSourceLayer` 暴露被忽略的旧值。
- orphaned SkillTrigger 旧配置使用 `valueState: "orphaned"`、`effectiveValue: null`、`sourceLayer: null` 和稳定 `orphanedReason`；它在 user 或 project shared 层可以被 `unset/reset` 清理，在 project local 层只能通过整层 reset 清理，任何层都不能被 `set` 写入。
- `aw config list --scope project --local --json` 可以用只读说明或同一 invalid entry 暴露 project local 中的 SkillTrigger 存量值，但 `writable` 必须为 `false`，且不能让它看起来会参与本地 effective 配置。`aw config get/set/unset <plugin> aw.skillTriggers.<skill>.trigger --scope project --local` 仍按 CLI 边界确定性失败。
- `aw config get <plugin> <key> --json` 仍返回 `fields` 数组；当 key 指向 orphaned SkillTrigger 时，返回该 orphaned entry，而不是抛普通 schema unknown key。
- CLI 人类输出和 TUI 配置页展示配置字段时，必须复用 `ConfigFieldEntryV2` 的 `kind`、`reserved`、`valueState`、`sourceLayer` 和可写性语义。`configured`、`fixed`、`ignored`、`orphaned`、`invalid` 这类状态不能在 CLI 和 TUI 中各自发明一套含义。
- CLI 人类输出和 TUI 配置页还必须共享同一套字段展示映射：`fixed` 展示为固定只读默认值；`ignored` 展示为已忽略旧配置并提供受控清理入口；`orphaned` 展示为可清理旧配置而不是当前字段；`invalid` 展示为不可生效的本地旧值；`configured` 只在 `writable: true` 时进入可编辑流程。
- 如需短期保留旧 `summary` 或 `layers` 字段，只能作为 legacy 兼容信息额外输出；新字段、测试和文档以 `configSchemaVersion: 2` 与 `fields` 为准。

配置写命令的 JSON receipt 使用 `receiptSchemaVersion: 2`，并通过 `affectedFields` 回显本次实际触碰的已知字段身份：

```ts
type ConfigFieldAction = 'set' | 'unset' | 'reset';

interface ConfigReceiptFieldEntryV2 {
  key: string;
  title: string;
  kind: ConfigFieldKind;
  reserved: boolean;
  action: ConfigFieldAction;
  scope: 'user' | 'project';
  projectLayer?: 'shared' | 'local';
  valueState?: ConfigValueState;
}

interface ConfigWriteReceiptV2 {
  receiptSchemaVersion: 2;
  command: 'config:set' | 'config:unset' | 'config:reset';
  plugin: string;
  affectedFields: ConfigReceiptFieldEntryV2[];
}
```

`affectedFields` 用于让 JSON 消费方判断本次配置写入触碰的是普通 manifest 字段还是 AW built-in 字段。`set` / `unset` 必须包含请求 key 对应的字段；整层 `reset` 必须包含当前 manifest 字段、AW built-in 字段，以及存量 `$aw.skillTriggers` 中能解析为 ignored、orphaned 或 invalid 的字段。普通 store 中无法归属到 manifest 或 AW built-in 的历史未知 key 可继续通过现有 removed key 摘要暴露，不强行塞进 `affectedFields`。

多目标写操作的 receipt 不能只给整体摘要，必须包含稳定的 per-target 结果结构。`receiptSchemaVersion: 2` 的公开 schema 至少要包含以下字段：

```ts
type TargetWriteState = 'completed' | 'rolledBack' | 'notRun' | 'failed';
type ConfigStoreRemovalState = 'removed' | 'notFound' | 'skipped' | 'failed';

interface ReceiptTargetIdentity {
  pluginName: string;
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
}

interface ConfigStoreIdentity {
  pluginName: string;
  storeKind: 'user' | 'projectShared' | 'projectLocal';
  projectRoot?: string;
}

interface ReceiptTargetResult {
  target: ReceiptTargetIdentity;
  action: string;
  state: TargetWriteState;
  message?: string;
  errorCode?: string;
  rollbackState?: 'notNeeded' | 'completed' | 'failed';
}

interface ConfigStoreRemovalResult {
  store: ConfigStoreIdentity;
  state: ConfigStoreRemovalState;
  reasonCode?: 'subjectFailed' | 'removeFailed';
  subjectTargets: ReceiptTargetIdentity[];
  message?: string;
}

interface CommandReceiptV2 {
  receiptSchemaVersion: 2;
  overallState: 'succeeded' | 'failed';
  targetResults: ReceiptTargetResult[];
  configStoreRemovals?: ConfigStoreRemovalResult[];
}
```

TUI 最近操作结果、CLI 人类输出和 JSON receipt 必须来自同一组 target result 数据。多目标失败时，用户必须能看出哪些目标已完成、哪些已回滚、哪些尚未执行、哪个目标失败，以及回滚是否失败；不能只输出“整体失败”或只列计划目标。

卸载、清理或其它破坏性流程附带 `remove-config` 时，配置删除结果必须按最终 config store 分组进入 receipt。配置 store 与 execution target 不是一一对应关系，不能把 `targetResults` 的单条成功直接等同于可删除配置；TUI 最近结果和 CLI 人类输出也必须使用同一组 `configStoreRemovals` 说明配置已删除、原本不存在、因主体失败跳过，或删除失败。

## 用户体验需求

### TUI 页面示意图总览

本节是唯一的 TUI 页面示意图来源。后续 `R*` 需求只写行为合同和验收口径，不再重复页面样例，避免两处示意图互相冲突。

示意图表达页面信息架构、主要区域和导航关系，不代表最终终端宽度、配色或具体组件实现。所有页面都遵守共同约束：

- 页面内不展示 `aw ...` 命令建议，不展示 raw command。
- 用户可见文案避免 `catalog`、`ledger`、`tracking`、`snapshot` 等内部词；需要表达 catalog 时使用“插件列表”或“本地插件列表”。
- 每个页面底部固定展示快捷键和操作方式；`q` 退出，子页面 `Esc` 返回，首页 `Esc` 退出。
- 空状态内容不展示。没有阻断、依赖、备份、不可删除项或其它发现时，不渲染对应区域，也不显示“无”或“不存在”。
- 操作名称使用短词：`状态`、`详情`、`清理`、`返回`、`保存`、`取消` 等，避免把动作写成长句。
- 页面示意图不为一眼能辨认的内容添加行内标题，例如 `简介`、`平台`、`状态`、`版本`。这类信息通过行序、缩进、符号和颜色区分。

信息层级与颜色规则：

- 页面标题、插件名、当前选中项和主要操作使用默认高亮或强调色。
- 状态符号和紧邻的关键状态文案使用状态色：异常红色，可升级黄色，已安装或成功绿色，未安装和次要平台弱化色。
- 简介、版本号、来源、说明文字、快捷键和其它辅助信息使用弱化色；弱化内容不能抢过插件名、状态和主操作。
- 失败结果、阻断原因和缺失依赖使用红色；执行中步骤使用黄色或青色；成功结果使用绿色。
- 颜色只表达层级和辅助状态，不改变文案含义；无颜色终端仍必须能靠符号和文字读懂页面。

平台和位置展示规则：

- 列出插件当前 manifest 支持的所有可安装平台。平台未安装时只列平台本身，不展开所有 scope。
- 如果某个平台已不在 current manifest 支持范围内，但存在可定位 AW 受管安装、marker 或残留证据，首页卡片和详情页平台区域都必须把它作为历史恢复目标列出，不能只在状态页或诊断详情里暴露。
- 历史恢复目标使用异常符号并带稳定标签，例如 `! Claude Code（历史残留）`、`! Claude Code（项目，历史残留）`。它只表示可进入卸载、清理、修复、认领、接管或其它受控恢复动作，不参与安装、升级或重新创建 current runtime 的候选。
- 如果首页卡片因空间限制压缩平台摘要，异常原因也必须点名被压缩的历史平台，例如“Claude Code 存在历史残留”；不能只显示泛化 `异常`。
- 已安装、可升级或异常的平台必须带状态符号，并用颜色作为辅助标记；颜色不能成为唯一识别方式。
- 用户级安装默认不展示 scope；项目级安装标记为`（项目）`。
- 同一平台出现多个 scope 时属于正常拓扑，必须列出所有 scope，例如 `✓ Codex（个人 + 项目）`。平台状态由各 location 的真实健康、版本、残留和归属状态聚合，不能仅因为 scope 数量大于 1 就显示异常。
- 平台状态符号沿用首页状态语义：`✓` 已安装，`↑` 可升级，`!` 异常，`○` 未安装。

本轮涉及的 TUI 页面如下：

```text
本地插件列表校验页
  └─ 覆盖后继续原入口或动作 / 取消后退出当前动作

首页
  └─ 插件详情页
       ├─ 依赖详情页
       ├─ 目标选择页
       │    └─ 依赖确认页
       ├─ 状态摘要页
       │    └─ 状态详细信息页
       ├─ 配置目标选择页
       │    └─ 配置管理页
       │         ├─ 配置字段编辑页
       │         └─ 配置删除或重置确认页
       ├─ 危险动作确认页
       ├─ 清理页
       │    └─ 高风险清理确认页
       └─ 写操作执行中页
            └─ 返回插件详情页，并显示最近一次操作结果
```

#### P0：本地插件列表校验页

仅在当前入口或即将执行的动作需要 shared runtime、native marketplace、本地 marketplace 注册或其它 `~/.aw` 产物，且本地 catalog 版本高于当前 CLI 版本，或已有本地 catalog 但 `sourceVersion` 缺失、非法、无法比较时出现。需要这类本地产物时，本地 catalog 完全不存在会自动初始化；当前 CLI 版本高于本地 catalog 时自动刷新；当前 CLI 版本等于本地 `sourceVersion`、但 bundle fingerprint 不一致或布局健康检查失败时也自动刷新；这些场景不进入确认页。

纯只读入口和纯 Codex project repo-managed 写入入口不出现此页，也不自动初始化或刷新 `~/.aw`。这包括只命中 Codex project repo-managed target 的配置保存、保存后的自动应用、`应用` 和 `重新应用配置`。这些入口在本地 catalog 缺失、落后、bundle fingerprint 不一致、布局损坏或版本领先时使用 embedded catalog 继续；需要解释时在状态详情或 verbose/json 诊断里说明。页面文案不使用 `catalog`。

```text
本地插件列表需要确认

当前 aw          0.3.0
本地插件列表      0.4.0

本地插件列表看起来来自更新版本的 aw。
继续使用当前版本会覆盖本地插件列表。

将要发生
  - 用当前 aw 内置插件包重建本地插件列表
  - 不升级或卸载任何已安装插件
  - 不修改插件配置

操作
> 取消
  覆盖

快捷键  ↑/↓ 选择 · Enter 确认 · q 退出
```

默认选中 `取消`。选择取消后，CLI 退出当前命令；TUI 退出当前动作或保留在原页面，不继续本次写入。

#### P1：首页

首页负责扫视和进入插件，不解释复杂问题。列表按状态分组，空分组不显示。

```text
aw 插件控制台

异常 2
! codex-explore              v0.1.4              处理
  只读探索代码、文档和长上下文。
  ! Codex（个人 + 项目）  ○ Claude Code
  异常：项目位置写入没有完整收口

! legacy-helper             旧配置              清理
  插件不在当前插件列表中，但仍有个人配置。
  配置残留：个人配置

可升级 1
↑ git-commit                 v0.1.0 -> v0.2.0    升级
  生成中文约定式 Git 提交。
  ↑ Codex  ○ Claude Code

已安装 1
✓ code-review                v1.0.0              详情
  审查代码变更并整理风险。
  ✓ Codex（个人 + 项目）  ○ Claude Code

未安装 1
○ dev-workflow               v0.1.0              安装
  创建和维护多 agent 工作流。
  ○ Codex  ○ Claude Code

操作
> 刷新
  退出

快捷键  ↑/↓ 选择插件 · Enter 详情 · r 刷新 · q/Esc 退出
```

首页不显示长摘要、诊断矩阵、内部字段或命令建议。插件很多时，分组列表可滚动，底部操作区保持稳定。

如果当前用户配置或当前项目配置中存在只剩 config store 的旧配置，且该插件不在 current catalog、没有已安装位置、没有残留 runtime 证据，首页必须把它作为 `异常` 分组里的旧配置占位项展示。占位项不新增公开 `consoleItems.status` 状态值；用户进入详情后只能查看已有配置来源，并通过 `配置` 或 `清理旧配置` 进入受控清理流程。插件仍在 current catalog、但当前 manifest 已没有普通 `config.schema` 时，不新增重复占位项；该插件详情页和配置页必须把旧普通配置 store 展示为可清理的 `schemaUnavailable` 残留。

#### P2：插件详情页

详情页是插件操作中心。首页选中插件后按 `Enter` 进入详情，详情页功能菜单承接推荐动作。

```text
codex-explore
v0.1.4
只读探索代码、文档和长上下文。
! 异常：平台侧写入没有完整收口

平台与安装
! Codex（个人 + 项目）
○ Claude Code

依赖插件
git-commit  code-review

功能
> 状态（推荐）
  依赖
  修复
  清理
  配置
  返回
  退出

快捷键  ↑/↓ 选择 · Enter 执行 · Esc 返回 · q 退出
```

没有最近操作时不显示结果区域。存在最近操作时，结果区域固定放在状态摘要之后。

```text
git-commit
v0.2.0
生成中文约定式 Git 提交。
✓ 已安装

上一步：升级成功
✓ Codex 已更新到 v0.2.0

平台与安装
✓ Codex
○ Claude Code

功能
> 配置
  卸载
  状态
  返回
  退出

快捷键  ↑/↓ 选择 · Enter 执行 · Esc 返回 · q 退出
```

失败结果只保留简短原因和可继续 UI 动作：

```text
上一步：卸载失败
Codex 无法完成标准卸载

可继续
> 状态
  清理
```

#### P2a：依赖详情页

已安装插件存在依赖时，详情页提供 `依赖` 入口。依赖页只展示当前插件已安装目标下的依赖状态，按真实平台和 scope 分组；没有依赖时不展示入口。

```text
依赖  dev-workflow

Codex（项目）
✓ git-commit        正常  v0.2.0
! code-review       异常：版本不一致
× codex-explore     缺失

Claude Code
✓ git-commit        正常  v0.2.0
× code-review       缺失

操作
> 状态
  返回
  退出

快捷键  ↑/↓ 选择 · Enter 执行 · Esc 返回 · q 退出
```

依赖状态必须同时使用符号、颜色和文字标记。正常依赖使用绿色 `✓`，异常依赖使用红色 `!`，缺失依赖使用红色 `×`；颜色不可作为唯一识别方式。

#### P3：目标选择页

当一个功能能作用于多个平台或位置时出现。只有一个明确目标时跳过此页。

未安装插件进入安装时，目标选择分成两个连续页面。第一页只收口平台，不展示平台和 scope 的组合；第二页再选择安装位置。触发策略不在安装流程中选择；用户可以安装后进入配置页管理，也可以先通过未安装插件的配置入口预置。

```text
选择安装平台

插件  dev-workflow

平台
> 全部支持平台
  Codex
  Claude Code

操作
  返回
  退出

快捷键  ↑/↓ 选择平台 · Enter 确认 · Esc 返回 · q 退出
```

当用户选择 `全部支持平台` 时，含义是按该插件的支持平台集合展开。单平台插件只安装到唯一支持平台，双平台插件安装到 Codex 和 Claude Code。页面文案不使用 `both` 作为裸英文标签，可在开发者帮助或 JSON 中保留机器值。

平台页按跨 scope 并集展示可选平台，但批量安装进入平台页前必须先确认整组选中插件至少有一个共同可用位置。若不存在共同位置，流程直接提示用户拆分安装，不展示平台页。用户选完位置后，TUI 重新校验已选平台和位置；如果该位置让平台不可安装，流程返回平台页并说明原因，不进入依赖确认或写入阶段。

```text
选择安装位置

插件  dev-workflow
平台  全部支持平台

位置
> 个人
  项目

操作
  返回
  退出

快捷键  ↑/↓ 选择位置 · Enter 确认 · Esc 返回 · q 退出
```

已经安装或可升级的插件进入写操作时，目标选择页展示可处理的明确目标。`install`、`upgrade`、卸载、清理、修复、重装、认领和接管类写操作不能因为用户省略平台而隐式选择目标；必须由 CLI 参数或 TUI 目标选择页显式给出目标。选中目标后按 `Enter` 直接确认，不额外提供 `继续` 操作。

```text
选择升级目标

插件  git-commit

目标
> 所有可升级目标
  Codex                  v0.1.0 -> v0.2.0
  Claude Code            v0.1.0 -> v0.2.0

说明
升级会分别刷新所选平台的安装状态。

操作
  返回
  退出

快捷键  ↑/↓ 选择目标 · Enter 确认 · Esc 返回 · q 退出
```

选择好平台、目标或位置后，如果安装或升级会连带安装、升级依赖插件，必须进入依赖确认页。页面列出依赖插件名称和将要处理的安装平台，不展示复杂状态矩阵。

```text
确认依赖

插件  dev-workflow
目标  Codex（项目）

需要一起处理
git-commit
  安装  Codex（项目）  v0.2.0
code-review
  升级  Codex          v1.0.0 -> v1.1.0

操作
> 取消
  安装

快捷键  ↑/↓ 选择 · Enter 确认 · Esc 返回 · q 退出
```

`所有可升级目标` 只适用于用户显式选择的升级批量目标。高风险 takeover、adopt 以及其它需要证明归属的恢复动作不能出现批量选项，必须单目标确认。

#### P4：状态摘要页

状态页是详情页下级页面，合并原 `状态` 和 `诊断` 的入口。默认只展示友好摘要，不列纯未安装位置。

```text
状态  codex-explore

整体状态
! 异常

位置
! Codex
  异常：平台侧写入没有完整收口
  修复，或查看详情

操作
> 修复
  清理
  详情
  返回
  退出

快捷键  ↑/↓ 选择 · Enter 执行 · Esc 返回 · q 退出
```

如果没有可在 TUI 内直接执行的动作，只显示状态说明，不把 CLI 命令降级成建议。

#### P5：状态详细信息页

用户主动选择 `详情` 后进入。此页可以展示更细的只读诊断事实，但仍然不展示命令建议、stdout 原文或内部错误栈。

```text
详情  codex-explore

诊断结论
平台写入不完整，需要恢复处理。

发现的问题
! Codex
  平台注册存在，但安装记录缺失。

清理评估
可以生成清理计划，执行前需要确认范围。

操作
> 清理
  修复
  返回
  退出

快捷键  ↑/↓ 选择 · Enter 执行 · Esc 返回 · q 退出
```

详细信息页消费结构化诊断数据，不解析人类输出文本。

#### P6：配置管理页

配置页用于长期管理插件配置，不是一次性写入向导。详情页进入 `配置` 时，必须先解析可配置目标：

- 已安装、可升级、异常或存在可定位 runtime drift 的插件，使用明确 location target。
- 未安装但 current catalog 声明了普通 `config.schema` 或 SkillTrigger 内建字段的插件，继续提供预配置入口；默认写入 `个人` 配置。只有当前 manifest 至少存在一个真实 project-installable target 时，才允许用户选择当前项目配置；纯 user-only、Codex native-only、Codex apps-only，或在当前支持平台中没有任何 project scope 可安装目标的插件，不展示当前项目预配置 target。
- 插件已退场、插件仍在但当前 manifest 已没有普通 `config.schema`、或仅存在 fixed/orphaned SkillTrigger 旧配置时，至少要能通过配置 store target 进入受控清理页面；该入口只展示和清理已有配置，不提供新值保存。若已有普通 manifest 旧配置无法被 current schema 解释，页面只展示 store 来源、legacy reason 和清理动作，不展示普通字段明细。

插件已退场、且只剩 config store 旧配置时，入口来源固定为首页旧配置占位项。用户从占位项进入详情页后，可以选择 `配置` 查看已有 store target，也可以选择 `清理旧配置` 直接进入危险确认；这两条路径都只处理当前用户配置和当前项目配置，不扫描历史项目，也不依赖 current catalog 或安装现场证据。插件仍在 current catalog 但普通 schema 已撤掉时，从该插件的普通详情页进入同一套 store-only 清理页。

如果当前插件只有一个可配置 target，可以直接进入配置管理页；如果同一插件在多个平台、scope、project 或 config store 下都有可配置 target，必须先进入配置目标选择页。

配置目标选择页只列明确 target，不提供“所有位置”这类隐式批量目标。target 可以是 location target，也可以是未安装预配置或 orphaned 配置清理使用的 config store target；页面必须用用户能理解的文案区分，例如 `Codex（个人）`、`个人配置`、`项目配置 /work/app`。用户选中目标后按 `Enter` 确认，不额外提供 `继续` 操作。

```text
选择配置目标

插件  codex-explore

目标
> Codex（个人）
  Codex（项目）  /work/app
  Claude Code（个人）

操作
  返回
  退出

快捷键  ↑/↓ 选择目标 · Enter 确认 · Esc 返回 · q 退出
```

配置管理页必须展示当前绑定的目标。对 location target，`应用`、失败后的 `重新应用配置`、最近结果和失败摘要先归属于这个明确 target，再按同 config store fan-out 规则扩展到 sibling target；不能把跨 store 或不兼容表单的多个安装位置隐式合并。对 config store target，页面只展示该 store 的配置读写或旧值清理结果；没有可定位 runtime target 时不展示可执行的 `应用` / `重新应用配置`，或以 no-op/skipped 结果说明没有需要应用的目标。普通旧配置无法被 current schema 解释时，config store target 只呈现 store kind、必要 project root、legacy reason 和可清理状态，不能展示 raw key、raw value 或临时推断出的字段表单。

```text
配置  codex-explore
目标  Codex（项目）  /work/app

作用层
> 生效
  个人
  项目
  本地

字段
token                    已配置             来源：个人
explorerModel             gpt-5.4-mini       来源：默认值
modelReasoningEffort      medium             来源：项目
codex-explore 触发方式     自动               来源：默认值
commit 触发方式            手动               来源：项目

最近结果
配置已保存，相关项目文件已刷新。

操作
> 更新
  清空
  重置
  应用
  返回
  退出

快捷键  ←/→ 切换作用层 · ↑/↓ 选择 · Enter 执行 · Esc 返回 · q 退出
```

敏感字段只显示脱敏状态。SkillTrigger 内建字段和插件自定义字段放在同一字段列表中，但需要用用户能理解的标题展示，不暴露保留 key。`本地` 只表示本机覆盖，不描述成会改变 repo-visible artifact 的共享真值；项目级 skill 触发策略不能在 `本地` 层改写。

作用层候选由当前 target 决定。`生效` 是选中 target 的只读合并视图；`个人` 对应 user store；`项目` 对应当前 target 的 project shared store；`本地` 对应当前 target 的 project local store。user target 不展示不可写入或不参与该 target effective config 的 project 层。config store target 只展示该 store 可解释的层；current manifest 仍存在且可解释当前配置字段时可以展示对应上下文的 `生效` 视图，普通旧配置无法被 current schema 解释或只剩 orphaned 旧值时不构造虚假的 effective config。

配置保存必须显式拆开 config store 和 execution target 两层语义。更新、清空或重置某一层时，先按最终写入的 config store 去重；同一 store 下当前可定位、表单 identity 一致、且会读取该 store 的 sibling location target 属于同一个 config apply group。表单只填写一次，config store 只写一次；保存成功后，built-in apply pipeline 和 dynamic artifact refresh 要 fan-out 到该组所有 target，并在最近结果、CLI 人类输出和 JSON receipt 中按 target 展示应用结果。跨 user / project shared / project local store，或表单 identity 不一致时，必须拆成多个 config write group，分别填写、保存和展示结果，不能在页面里静默合并。

#### P7：配置字段编辑页

从配置管理页选择 `更新` 或 `清空` 后进入。字段很多时先选字段，再进入对应输入控件。选中字段后按 `Enter` 进入编辑，不额外提供单独的编辑操作项。

```text
更新配置字段

目标  Codex（项目）  /work/app
作用层  项目

字段
> explorerModel             gpt-5.4-mini
  modelReasoningEffort      medium
  codex-explore 触发方式     自动
  token                     已配置

操作
  返回
  退出

快捷键  ↑/↓ 选择字段 · Enter 编辑 · Esc 返回 · q 退出
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

快捷键  Enter 保存 · Esc 取消
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

快捷键  Enter 保存 · Esc 取消
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

快捷键  ↑/↓ 选择 · Enter 保存 · Esc 取消
```

不允许动态变更的 skill 只读展示默认触发策略，不进入编辑页。若存在历史 `$aw.skillTriggers` 覆盖值，配置页要展示“旧配置已忽略”一类状态，并在支持按字段清理的配置层提供清理该旧值的重置入口；project local 误写入只能通过整层 reset 清理。清理动作不改变 effective 触发策略。

输入框内的 `q`、`b` 是普通字符，`Esc` 取消输入并返回上一页。

#### P8：危险动作确认页

卸载、重装、认领、接管共享运行时、重复安装处理、删除配置、重置配置等危险动作统一进入确认页，不使用文本式 `y/N`。

```text
确认卸载

插件  git-commit
目标  Codex

将要删除
  - Codex 平台的插件安装状态
  - AW 管理的安装记录
  - 相关动态诊断缓存

配置
  保留配置

操作
> 取消
  卸载

快捷键  ↑/↓ 选择 · Enter 确认 · Esc 取消 · q 退出
```

默认选中 `取消`。选择取消后不得写状态、写配置或删除文件。

卸载或清理附带 `删除配置` 时，确认页展示的删除范围必须按 config store 分组，而不是按 execution target 重复列出。若多个真实 target 命中同一个 config store，页面必须说明该配置只会在本组主体全部成功后删除一次；任一主体失败时保留该 store，并在最近结果和 receipt 中标记跳过配置删除。

删除或重置配置使用同一类确认页：

```text
确认重置配置

插件  codex-explore
目标  Codex（项目）  /work/app
作用层  项目

将要删除
  - 项目配置中的本插件配置

不会删除
  - 个人配置
  - 本地配置
  - 已安装插件文件

操作
> 取消
  重置

快捷键  ↑/↓ 选择 · Enter 确认 · Esc 取消 · q 退出
```

#### P9：清理页

清理先展示计划。能安全执行普通清理时，用户从本页确认；需要 `force` 语义时，再进入高风险确认页。清理目标必须来自显式平台选择；如果用户显式选择 `全部支持平台`，页面必须列出展开后的每个真实目标。

```text
清理  codex-explore

目标
Codex

计划删除
  - 损坏的安装记录
  - 未完成的 native marker
  - AW 管理的运行时残留

备份
  - 修改共享配置前创建备份

操作
> 清理
  删除配置  [否]
  返回
  退出

快捷键  ↑/↓ 选择 · Space 切换 · Enter 执行 · Esc 返回 · q 退出
```

如果存在阻断或不可删除项，页面必须明示，不能让用户误以为清理一定会成功。

多目标清理页不能只写“所有平台”。它至少要展示：

- 每个真实目标平台和位置。
- 每个目标的计划删除项、备份项和阻断项。
- 哪些目标会执行普通清理，哪些目标需要进入高风险确认。
- 任一目标失败时整体结果如何呈现，以及已执行目标是否需要回滚或保留为部分完成状态。
- 如果用户选择删除配置，哪些 config store 会被纳入删除计划，以及每个 store 依赖哪些主体成功后才能删除。

#### P10：高风险清理确认页

只有清理计划判断需要高风险语义时出现。它比普通危险确认页更详细，必须列出风险来源、备份策略、不可删除项和受影响依赖。多目标高风险清理必须按真实目标分组展示风险和删除范围，不能把多个平台压成一句总括文案。

```text
确认高风险清理

插件  codex-explore
目标  Codex

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

操作
> 取消
  清理

快捷键  ↑/↓ 选择 · Enter 确认 · Esc 取消 · q 退出
```

默认选中 `取消`。

#### P11：写操作执行中页

安装、升级、卸载、清理、修复、重装、认领、接管和配置保存等写操作执行时显示。完成后不停留在独立结果页，默认刷新并回到插件详情页。

```text
正在升级 git-commit

目标
Codex

进度
✓ 读取当前状态
✓ 执行升级
… 刷新插件状态

快捷键  q/Ctrl+C 完成后退出
```

执行中页的 `q` 和 `Ctrl+C` 是“安全延后退出”，不是强制终止，也不是取消写入。用户按下后，TUI 记录退出意图，当前写操作继续运行到正常结果或已定义的事务安全边界；不得中断单个写入、回滚、receipt 写入或诊断状态写回。到达结果状态后，TUI 按正常流程保留 per-target 结果、recent result、receipt 和诊断状态，然后退出控制台，不再刷新首页或等待新的菜单输入。

成功后返回详情页：

```text
git-commit
v0.2.0
生成中文约定式 Git 提交。
✓ 已安装

上一步：升级成功
✓ Codex 已更新到 v0.2.0

平台与安装
✓ Codex
○ Claude Code

功能
> 配置
  卸载
  状态
  返回
  退出

快捷键  ↑/↓ 选择 · Enter 执行 · Esc 返回 · q 退出
```

失败后也返回详情页，并展示最近一次操作结果和可继续动作。页面不能继续展示操作前的旧状态。

多目标写操作失败时，最近结果区域必须按真实目标展示结果层次，至少能区分已完成、已回滚、未执行和失败目标。结果区域使用与 JSON receipt 等价的 target result 数据，不只展示整体失败文案。

### R1：首页

首页必须是插件卡片列表，页面样例以 P1 为准。列表按状态分组：

1. `异常`
2. `可升级`
3. `已安装`
4. `未安装`

每个分组标题显示状态和数量。没有插件的分组不显示。

每个插件卡片展示：

- 状态符号和状态文案。
- 插件显示名，优先使用 `manifest.interface.displayName`，否则使用插件名。
- 插件简介，优先使用面向用户的简短说明；过长时截断，不能挤压主信息。
- 当前版本或 current catalog 版本。
- 平台与安装信息，必须列出 current manifest 支持平台和有现场证据的历史恢复目标，并遵守总览中的平台和位置展示规则。
- 主操作，例如 `处理`、`升级`、`卸载`、`安装`、`详情`。

卡片内部不为简介、平台、状态和版本等内容添加行内标题；这些信息通过位置、缩进、状态符号和颜色层级区分。

首页不得展示：

- 长摘要段落。
- raw command。
- 命令行建议。
- 完整诊断。
- 内部字段名。
- `catalog`、`ledger`、`tracking`、`snapshot` 等内部词。
- 未选择位置的完整矩阵。

插件数量超过屏幕高度时，列表必须可滚动。卡片不能因为状态、版本或主操作文案长度变化导致布局跳动或文字重叠。

首页不提供额外的打开操作项。选中插件后按 `Enter` 进入详情页。首页必须提供刷新操作，并支持 `r` 快捷键刷新。

首页候选来源除了已安装、状态证据和 current catalog 中的未安装插件，还必须合并当前用户配置与当前项目配置里只剩 config store 的旧配置。只要某个插件不在 current catalog、没有已安装位置、没有 runtime 残留证据，但仍有配置 store 或 orphaned SkillTrigger key，首页就把它放入 `异常` 分组，展示为旧配置或配置残留占位项，并提供进入详情的路径。该占位项不参与安装、升级或 runtime apply 候选；详情页只能提供 `配置` 和 `清理旧配置` 这类受控配置清理动作。插件仍在 current catalog、但已有普通配置 store 无法被当前普通 `config.schema` 解释时，首页沿用当前插件卡片，不额外生成同名占位项；详情页和配置页必须提供 store-only 查看和清理入口。

### R2：插件详情页

插件详情页是所有操作的中心页。进入插件后展示：

- 插件名、简介、版本、状态。
- 状态和异常原因合并展示；存在异常原因时显示在状态后面，不再单独拆成“状态”和“原因”两块。
- 最近一次操作结果区域。没有操作时不显示。
- 平台与安装区域，同时表达支持平台、当前安装情况和有现场证据的历史恢复目标，不再拆成单独的“平台”和“安装信息”。
- 插件依赖摘要。详情页主体只列依赖插件名称，依赖状态放到二级页面。
- 功能菜单。

详情页主体不为简介、平台、状态和版本添加冗余行内标题；这些信息通过固定位置、状态符号和颜色层级表达。

已安装插件存在依赖时，详情页必须提供 `依赖` 二级页面。依赖页按当前插件已安装目标的真实平台和 scope 分组，组内列依赖插件名称、依赖状态和必要的简短原因：

- 正常依赖使用绿色 `✓` 和 `正常` 文案。
- 异常依赖使用红色 `!` 和异常原因。
- 缺失依赖使用红色 `×` 和 `缺失` 文案。

依赖页只展示已安装目标下的依赖信息，不展开纯未安装平台的依赖矩阵。没有依赖时，不展示 `依赖` 入口。

最近一次操作结果区域只保留最新一条。失败时展示简短原因和可进入的 UI 动作，动作名使用 `状态`、`清理` 等短词。

详情页不得显示 raw command。推荐动作通过功能菜单标记，例如 `升级（推荐）` 或 `状态（推荐）`。

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
- 返回。
- 退出控制台。
- 详情。

状态页默认不显示纯未安装位置。首页的未安装插件卡片不等于状态详情里的位置矩阵。

用户选择 `详情` 后，TUI 可以执行与 `aw status --verbose` 等价的只读诊断，并展示更细的事实：

- 诊断结论。
- 发现的问题。
- 清理评估结果。
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

写操作执行中页是退出语义的例外页：`q` 和 `Ctrl+C` 只请求安全延后退出，不立即终止进程，不取消已经开始的写操作，也不跳过后续结果收口。若用户在执行中请求退出，控制台必须先让当前写操作进入正常结果状态，保留结果和必要诊断，再以退出路径结束。

退出验收要求：

- 选择 `退出` 后进程返回 exit code `0`。
- 不再触发新的首页刷新。
- 不再等待后续输入。
- 不输出未处理的 prompt cancellation 错误。
- 正在显示结果页、状态页、配置页或确认页时退出行为一致。
- 正在执行写操作时按 `q` 或 `Ctrl+C` 不会留下半份 receipt、半写入 per-target 结果或未落盘的回滚状态；操作完成并收口结果后退出。

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
- 目标平台和位置，展示时遵守总览中的平台和位置展示规则。
- 将删除或改写的范围。
- 是否同时删除配置。
- 同时删除配置时，按 config store 分组展示待删除配置和对应主体目标；不能把共享 store 当作每个 target 的私有配置重复删除。
- 清理类动作的计划、备份、阻断原因和受影响依赖。

多目标危险动作必须展示展开后的每个真实目标，不能只展示 `both` 或“所有平台”。确认页还必须说明任一目标失败时的处理口径，包括是否回滚已完成目标、是否保留部分完成状态，以及用户在哪里查看失败目标详情。

认领现有安装、接管共享运行时和其它需要证明归属的高风险恢复动作必须保持单目标确认，不提供 `both` 或“所有平台”的批量选项。

默认选中 `取消`。选择取消后不能写状态、写配置、删除文件或留下中间状态。

### R6：卸载与清理

TUI 功能菜单不能让健康安装同时显示 `卸载` 和 `清理`。

规则：

- 健康安装：显示 `卸载`，不显示 `清理`。
- 可升级安装：显示 `升级` 和 `卸载`，不显示 `清理`。
- 异常、残留、半完成、外部归属冲突、重复安装待处理：根据状态显示 `清理`、`修复`、`认领`、`处理重复安装` 等恢复动作。
- 卸载失败：结果区域说明失败原因，并提供 `状态` 和 `清理`。
- 清理必须先展示计划或风险确认，不能直接执行高风险删除。

直接 CLI 的普通插件 `aw cleanup <plugin>` 可以继续作为受控恢复评估入口，但必须显式传 `--platform codex|claude|both`。显式选择 `both` 时，CLI 输出和 JSON receipt 都要列出展开后的每个真实目标。TUI 默认不把清理作为健康安装的并列主操作。

`aw uninstall`、`aw cleanup` 和 TUI 对应流程附带 `remove-config` / `删除配置` 时，必须遵守同一套 config store 删除合同：

- 只删除本次请求目标对应 config store 中该插件的 AW 自管配置，不删除其它插件、其它 scope、其它项目或其它 store。
- config store 按插件名、store kind 和 project root 去重；user store、project shared store 和 project local store 分别成组，不能按 execution target 一条一删。
- 同一 config store 下本次涉及多个主体目标时，只有这些主体目标全部卸载或清理成功后，才删除该 store 一次。
- 任一主体目标失败、未执行或回滚后仍保留时，对应 store 的配置必须保留，并在 TUI 最近结果、CLI 人类输出和 JSON receipt 的 `configStoreRemovals` 中稳定标记为 skipped，原因是主体失败。
- 配置删除失败不回滚已经完成的主体卸载或清理，但整体结果必须明确标记配置仍未删除，JSON receipt 也要暴露失败 store。
- `aw config reset` 仍是独立配置管理入口。`remove-config` 只是把同一 store 的配置清理串到卸载或清理流程后面，不替代完整配置管理命令。

### R7：写操作后的返回与刷新

安装、升级、配置、卸载、清理、修复、重装、认领、接管、重复安装处理等操作完成后，TUI 默认返回当前插件详情页。

返回前必须刷新当前插件状态。刷新后的详情页需要：

- 展示最新状态。
- 展示最新安装位置。
- 展示最近一次操作结果。
- 如果操作失败，保留失败摘要和可继续动作。
- 如果操作成功，不能继续展示操作前的旧状态。

多目标写操作的最近结果必须按真实目标分组展示：

- 已完成目标。
- 已回滚目标。
- 未执行目标。
- 失败目标和失败原因。

如果回滚本身失败，结果区域必须明确标出回滚失败目标，并提供状态详情入口；不能把它折叠成普通失败摘要。

升级成功后，如果 current catalog 版本已经不高于已安装版本，插件不能继续显示 `可升级`。如果仍显示 `可升级`，必须是刷新后的版本判断结果，而不是旧页面缓存。

### R8：配置管理页

详情页提供 `配置` 入口。进入后打开插件配置管理页，而不是只进入一次性写入向导。配置入口必须先绑定明确 target：只有一个可配置 target 时可直接进入配置页；存在多个平台、scope、project 或 config store target 时，必须先让用户选择目标。

配置 target 分为两类：

- location target：插件名、平台、scope 和必要 project identity 的组合，用于已安装、可升级、异常或存在 runtime drift 的插件。
- config store target：插件名、store kind 和必要 project root 的组合，用于未安装预配置、插件退场后的旧配置清理，或只有 orphaned SkillTrigger 旧值的场景。

配置页不能把同名插件的多个 target 合并成一个隐式上下文，也不能静默挑选其中一个 target。用户选择 target 后，配置字段、作用层、保存结果、`应用`、失败后的 `重新应用配置`、最近结果和失败摘要都以该 target 为入口；当该 target 对应的 config store 被多个可定位 sibling location target 共享时，保存后的应用结果按同 store fan-out 规则扩展成 per-target 结果。

未安装插件的预配置 target 必须先按真实 target 能力裁剪，再展示配置入口。`个人` config store 可作为未安装预配置 target；`项目` config store 只有在 current manifest 对当前仓库存在可消费该配置的 project target 时才展示，例如 Claude project scope 可安装，或 Codex project scope 下至少有 repo-visible managed artifacts，且没有命中 apps / native-only project 不支持规则。项目配置 target 不能仅因为插件有普通 `config.schema` 或 SkillTrigger 内建字段就出现。

配置页覆盖：

- `生效` 配置视图。
- `个人` 配置层。
- `项目` 配置层。
- `本地` 配置层。
- AW 内建 SkillTrigger 配置项。
- 字段更新。
- 字段清空。
- 当前层重置。
- 保存后的配置应用或 artifact refresh 结果。

配置页必须遵守：

- 页面显式展示当前 target；返回目标选择页后可以切换 target。
- 作用层候选由 target 决定。project target 展示 `生效`、`个人`、`项目`、`本地`；user target 不展示不可写入或不参与该 target effective config 的 project 层。
- 配置保存按最终写入的 config scope/store 分组。跨 `user`、`project shared`、`project local` store 的批量配置必须拆成多个 config write group，分别确认、分别写入、分别展示结果。
- 同一个 config store 被多个当前可定位 location target 共享，且这些 target 的配置表单 identity 一致时，配置保存只写一次 store；保存成功后，built-in apply pipeline 和 artifact refresh 必须 fan-out 到该组全部 target。TUI 最近结果和 JSON receipt 必须按 target 展示 `completed` / `failed` / `notRun`，不能只显示当前入口 target 的摘要。
- 同 store sibling target 中任一 apply 失败时，已保存的 config store 保留；失败 target 进入配置应用失败结果，状态或诊断页继续能看到该 target 的 drift。不能因为其中一个 sibling 失败而回滚已经成功写入的共享配置。
- 敏感字段只显示“已配置”或等价脱敏状态。
- 字段来源要用用户能理解的文案展示，例如 `默认值`、`个人`、`项目`、`本地`。
- `项目` 和 `本地` 的差异必须清楚。
- `本地` 不能被描述成会改变 repo-visible artifact 的共享真值。
- SkillTrigger 内建字段与插件自定义字段合并展示，但需要有清晰标题，例如 `<skill> 触发方式`。
- 未声明普通 `config.schema`、但存在 SkillTrigger 内建字段的插件，也应能进入配置页查看或管理这些内建字段。
- 不允许动态变更触发策略的 skill 只读展示默认策略，不能被保存、清空或重置成其它 effective 值。若存在历史 `$aw.skillTriggers` 覆盖值，页面必须把它标成已忽略的旧配置，并允许用户在 user 或 project shared 层通过重置清理该旧值；project local 误写入只能通过整层 reset 清理。重置前后 effective 值都保持默认策略。
- 插件退场或 skill key 已从当前显式或隐式 SkillTrigger 集合删除时，配置页如遇到遗留 `$aw.skillTriggers` 字段，必须把它标成可清理的旧配置。页面不能把它显示为当前 effective 触发方式，也不能提供保存新值入口；user 或 project shared 层只能提供清理该 key 或重置当前配置层的入口，project local 层只能提供整层 reset 清理入口。
- 普通 manifest 配置 store 仍存在、但无法被 current manifest 普通 `config.schema` 解释时，配置页只承诺 store 级查看和整层清理：展示 store kind、必要 project root、legacy reason、存在旧配置和可清理状态。没有 current schema 时，不展示普通字段列表，不允许按普通 key 更新、清空或读取 raw value；若同一 store 里还存在 orphaned SkillTrigger key，只把这些 built-in 旧值作为可清理字段展示。
- project scope 的 SkillTrigger 不能在本地层编辑；页面应说明该字段由默认值或项目配置决定。本地视图不能把 SkillTrigger 内建字段放进可保存的 write group，用户在本地层选择字段清空、重置或保存时也不能间接写入 `$aw.skillTriggers`。
- 重置或删除配置必须走危险确认选项页。
- 保存配置后默认回到配置页或插件详情页时，需要展示最近一次配置操作结果。
- 配置刷新失败不能把内部 stack trace 放进默认页面，只提供状态页详细信息入口。
- SkillTrigger 内建字段保存失败时，页面要按配置应用失败展示，并说明失败目标；不能因为插件没有普通 `config.schema` 或没有动态 artifact 就拒绝进入配置页。
- 未安装插件如果 current catalog 声明了普通 `config.schema` 或 SkillTrigger 内建字段，详情页仍提供 `配置`，默认落到 `个人` config store；只有 current manifest 存在真实 project-installable target 时，才允许切换到当前项目 config store。保存这类预配置时只写 config store；没有已安装 sibling target 时不触发 runtime apply。
- 插件已退场或仅剩 orphaned SkillTrigger 旧值时，TUI 必须通过首页旧配置占位项提供 config store target 入口，用于查看和清理旧配置。该入口只列当前用户配置和当前项目配置中真实存在的 store，不从 current catalog 或安装现场反推目标；普通旧配置只要无法被 current schema 解释，就只保证 store 级可见和可清理，不保证字段级查看。插件仍在 current catalog 但普通 schema 已撤掉时，从当前插件详情页进入同一套 store-only 清理入口。

配置页的 `应用` 与失败后的 `重新应用配置` 复用同一条 TUI 恢复动作合同：

- 输入来自当前插件的明确配置 target。location target 进入执行前必须计算同 store apply group：同一 config store、表单 identity 一致、当前可定位的 sibling target 一起重放；跨 store 或不兼容表单的多个位置不能隐式合并。
- 多 location 插件必须先经过配置目标选择页；最近结果和失败摘要以入口 target 为上下文，并按实际 apply group 展示 per-target 结果。如果未来允许显式跨 store 多 target 配置恢复，也必须在执行前展开成多个 target result，不能只显示一个整体结果。
- 执行时读取当前 effective config，重新应用可重放的 runtime 写入；它不修改 user、project shared 或 project local config store，也不重新提交字段表单。
- 可重放范围至少包含 tracked dynamic artifact refresh 和 SkillTrigger built-in apply pipeline。只有 SkillTrigger 内建字段、没有普通 `config.schema` 或 tracked dynamic artifact 的插件，也必须执行 built-in apply，不能被当成无配置插件跳过。
- 如果插件没有任何可重放 runtime 写入，结果页展示“没有需要重新应用的项目文件”或等价 no-op 文案；这不是失败。
- 任一 runtime 写入失败时，结果页展示配置应用失败摘要，并保留状态页或诊断详情入口；默认页不能展示内部 stack trace。
- 本轮不新增 `aw config apply`、`aw config refresh` 或 `aw config reapply` 公开 CLI 子命令。`应用` / `重新应用配置` 是 TUI recovery action；脚本化用户遇到配置驱动的 runtime drift 时，统一使用 `aw repair <plugin> --platform <platform> --scope <scope>` 收口。
- `aw repair` 处理配置驱动的 runtime drift 时，必须读取当前 effective config 并重放可重放 runtime 写入，覆盖 tracked dynamic artifact refresh 和 SkillTrigger built-in apply pipeline；它不得修改 user、project shared 或 project local config store，也不得把恢复动作变成安装期 `--skill-trigger` 选择。
- 状态下一步、receipt 和 JSON 结构化 nextSteps 面向 CLI 消费方时，应把这类 drift 的脚本化恢复动作指向 `aw repair`；TUI 页面仍可以展示 `配置`、`应用` 或 `重新应用配置` 这类 UI 动作。

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

本轮保留 project-only 和 read-only 的隔离边界：并不是所有需要 current catalog 的入口都能在启动阶段写 `~/.aw`。只有当前入口或即将执行的动作需要 shared runtime、Codex user native runtime、Claude native runtime、本地 marketplace 注册或其它本地 catalog 产物时，才必须校验并同步本地 catalog。

比较对象：

- 当前 CLI 版本：发布包 package version。
- 本地 catalog 版本：`~/.aw/config.json` 的 `sourceVersion`。

需要本地 catalog 产物的入口按以下规则处理：

- 本地 catalog 完全不存在：直接用当前 CLI embedded bundle 初始化本地 catalog，相当于自动执行 `init`，初始化完成后继续启动。
- 当前 CLI 版本等于本地 catalog `sourceVersion`，且 bundle fingerprint 一致、布局健康：继续启动。
- 当前 CLI 版本等于本地 catalog `sourceVersion`，但 bundle fingerprint 不一致或布局健康检查失败：直接刷新本地 catalog，相当于自动执行 `init`，刷新完成后继续启动。
- 当前 CLI 版本高于本地 catalog `sourceVersion`：直接刷新本地 catalog，相当于自动执行 `init`，刷新完成后继续启动。
- 当前 CLI 版本低于本地 catalog `sourceVersion`：输出警告，要求用户确认是否覆盖本地 catalog。
- 本地 catalog 已存在但 `config.json` 缺失、无法解析、`sourceVersion` 缺失、不是字符串或不是严格 SemVer：输出警告，要求用户确认是否覆盖本地 catalog。

不需要本地 catalog 产物的入口按以下规则处理：

- `aw status`、`aw status --verbose`、`aw config list/get`、TUI 只读状态页，以及纯 Codex project repo-managed 安装、状态查看和配置恢复，不因为本地 catalog 缺失、落后、bundle fingerprint 不一致、布局损坏或版本领先而初始化、刷新或修复 `~/.aw`。
- 普通配置字段的 `aw config set/unset/reset --scope project` 与 `aw config set/unset/reset --scope project --local` 在目标展开后只写当前项目的 project shared 或 project local config store，且保存后的自动应用只命中 Codex project repo-managed target 或无可应用 runtime 时，也走同一条 embedded catalog 例外，不触发本地 catalog 初始化、刷新或覆盖确认。SkillTrigger 内建字段命中 `--scope project --local` 时按 R17 的确定性失败合同处理，不进入本地 catalog gate，也不写入配置 store。
- TUI 项目级配置保存、保存后的自动应用、`应用` 和 `重新应用配置` 只要最终执行目标仍是纯 Codex project repo-managed target，也走同一条 embedded catalog 例外。
- `aw repair <plugin> --platform codex --scope project` 在目标展开后只命中纯 Codex project repo-managed target，且恢复内容只需要 repo-visible artifact refresh 或 SkillTrigger built-in apply pipeline 时，也走同一条 embedded catalog 例外。
- 这些入口使用当前 CLI embedded catalog 继续。若本地 catalog 存在但没有被使用，应在 verbose、JSON 诊断或 TUI 状态详情中给出稳定说明；默认简洁输出不需要打扰用户。
- 这些入口后续如果转入需要 native runtime、shared runtime 或本地 marketplace 的动作，必须在该动作写入前运行本节的本地 catalog gate。
- 同一条 `aw repair` 如果实际转入需要 native runtime、shared runtime、本地 marketplace 或其它 `~/.aw` 产物的分支，必须在写入前运行本节的本地 catalog gate；不能因为命令名是 `repair` 就跳过 gate。

确认交互：

- CLI 使用 `y/n` 输入确认是否覆盖本地 catalog。
- TUI 使用选项确认页，不使用文本式 `y/N`。
- 用户选择覆盖后，刷新本地 catalog，再继续原入口。
- 用户不选择覆盖时，需要本地 catalog 的命令或动作直接退出；TUI 保留在原页面或退出当前动作，不能继续执行本次写入。
- 非交互环境遇到需要确认的覆盖场景时直接失败，不能默认覆盖，也不能默认继续使用不一致的本地 catalog。
- CLI 入口带 `--json` 时，本地 catalog gate 的警告、确认问题、取消说明和错误都写 stderr，不能写 stdout；用户确认覆盖并继续执行后，stdout 仍只能输出原命令最终的单一 JSON payload。
- CLI 入口带 `--json` 且在本地 catalog gate 失败时，进程返回非零退出码，stdout 为空，stderr 输出可读且稳定的错误；本地 catalog gate 不输出半份 JSON，也不输出独立的 `ok: false` JSON。

覆盖本地 catalog 只表示用当前 CLI embedded bundle 重建本地 catalog；它不是插件升级，也不能把已有插件版本状态伪装成已处理。

本地 catalog gate 完成后，原命令或动作仍按各自读写合同执行；gate 不授权查询入口写状态、诊断缓存、备份或插件配置。

## CLI 公开合同需求

### R12：平台选项与安装目标

所有公开 CLI 入口的 `--platform` 选项只接受 `codex`、`claude`、`both`。

通用要求：

- help、错误提示、JSON schema、测试夹具和文档都不能继续把 `auto` 列为 platform 值。
- 用户显式传入 `--platform auto` 时，命令必须失败，并提示改用 `codex`、`claude` 或 `both`。
- 如果旧代码路径仍保留内部自动推断 helper，这些 helper 不能暴露为用户可选平台，也不能影响默认行为。
- `auto` 这个词在 SkillTrigger 配置中仍可出现，但必须明确属于触发策略，不属于平台选择。

写命令默认行为：

- 绑定真实插件 target 的 `aw install <plugin>`、`aw upgrade <plugin>`、`aw repair <plugin>`、`aw reinstall <plugin>`、`aw uninstall <plugin>`、`aw cleanup <plugin>`、认领现有安装和接管共享运行时等写入口必须显式传 `--platform codex|claude|both`。省略时命令失败，不能默认 `both`，也不能退回 `auto` 推断。`aw repair --dependency-index` 和 `aw cleanup --dependency-index --prune-stale <token> --yes` 不绑定插件 target，不接受也不要求 `--platform`。
- `install`、`upgrade`、依赖安装/升级和 `reinstall` 的重新安装阶段，显式传 `--platform codex` 或 `--platform claude` 时，整组选中插件都必须当前支持该平台。任一插件不支持时，CLI 必须在写入前失败，不能只安装或操作兼容子集。
- `uninstall`、`cleanup`、`repair`、认领现有安装、接管共享运行时和 `reinstall` 的移除/恢复评估阶段，显式单平台可以命中历史不支持平台，但必须有现场受管证据；没有证据时失败。
- 显式传 `--platform both` 才能展开多个真实目标。安装和升级的 `both` 只按 current manifest 支持平台展开；恢复动作的 `both` 按“所有可处理目标”展开，可以包含有现场证据的历史不支持平台。`both` 不表示“猜一个平台”，也不表示“跳过不可执行平台”。
- `both` 展开后生成多个真实目标时，预检必须覆盖完整目标集。任一目标失败时，命令整体失败，不能先写成功目标再把失败目标当作跳过项。
- receipt、状态事件和 JSON 输出中的 target 必须列展开后的真实平台，不能把 `both` 写成已安装位置。

查询命令行为：

- `aw status --platform both` 表示查看所有真实平台的相关状态。
- `aw status` 未传 `--platform` 时，可以等价于 `--platform both` 展示有证据的所有平台状态。
- `aw status --platform auto` 不再是兼容入口。

TUI 目标选择行为：

- 平台、位置和目标选择页不提供额外的下一步操作项；用户选中平台、位置或目标后按 `Enter` 即确认当前选择。
- 批量安装进入平台页前必须确认整组选中插件存在共同可用 scope；不存在时直接失败并提示拆成多次安装，不允许继续展示一个后续永远无法提交的平台候选。
- 平台页只能提供整组选中插件共同支持的单平台；如果没有共同单平台但 `both` 可以展开，页面只保留 `全部支持平台`。
- 安装平台页按跨 scope 并集生成候选；某个平台只要在任一可选 scope 下仍可能安装，就可以出现。平台页不能取所有 scope 的交集后提前隐藏只在 user 或 project scope 可用的平台。
- scope 选择完成后，TUI 必须重新展开真实目标并执行完整预检。若所选 scope 让平台或展开目标失效，TUI 返回平台页，说明失效原因，并确保失效候选不能继续提交；该分支不能直接结束为泛化预检失败。
- 如果安装或升级会连带安装、升级依赖插件，TUI 必须在写入前展示依赖确认页。
- 依赖确认页只列依赖插件名称、将要执行的动作和安装平台信息，不展示复杂状态矩阵。
- 用户在依赖确认页取消时，本次安装或升级不得产生写入。

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
- `--verbose` 不写状态、不刷新诊断缓存、不创建备份、不修改插件配置，也不为了查询初始化或刷新本地 catalog。本地 catalog 不可用时，只读回退 embedded catalog，并在详细输出中说明。
- `--verbose` 应包含 cleanup 评估、阻断原因、受影响依赖、可恢复动作和必要的结构化下一步。

JSON 行为：

- `aw status --json` 输出简洁结构化状态。
- `aw status --verbose --json` 输出详细结构化状态。
- JSON payload 的 `command` 必须是 `status`。
- JSON payload 顶层必须带 `statusSchemaVersion: 2`。
- JSON payload 顶层必须带 `consoleItemsSchemaVersion: 3`，并与 `consoleItems` 同层输出。`statusSchemaVersion` 不取代 `consoleItemsSchemaVersion`；前者解释 status 顶层 envelope，后者解释本轮新的 `consoleItems` 子结构。
- JSON 中的 `nextSteps` 必须使用结构化下一步对象，并在同一对象层级带 `nextStepsSchemaVersion: 1`。若仍需保留旧 `string[]` 兼容字段，只能输出 `legacyNextSteps`，不能让 `nextSteps` 继续承载字符串数组。
- SkillTrigger 状态在 `statusSchemaVersion: 2` 中只使用 `skillTriggers: SkillTriggerPublicView[]` 投影，不再输出 `skillTriggerPreference`、`skillTriggerApplicability` 等安装期旧字段。

显式查询未安装插件时，命令可以返回该插件的简洁 `未安装` 结论，但不能展开所有未安装 platform/scope 位置矩阵。

### R14：移除 `aw diagnose`

`aw diagnose` 不再作为公开命令存在，也不保留可成功执行的兼容 alias。

要求：

- CLI help 不再列出 `diagnose`。
- TUI 不再调用 `diagnoseCommand()` 作为用户可见路径。
- 文档不再提示用户运行 `aw diagnose`。
- 所有用户可见的 CLI 文案都不再提示 `aw diagnose` 或“重新运行 diagnose”，包括错误提示、warning、下一步建议、receipt 摘要、JSON `nextSteps`、cleanup / repair / dependency index / prune token 相关恢复文案。
- 只读排查统一提示 `aw status --verbose`；需要恢复写入时统一提示 `aw repair ...`、`aw cleanup ...` 或对应的具体恢复动作，不能把已移除的 diagnose 当作前置步骤。
- 原本只有 `diagnose` 才能看到的信息，迁移到 `aw status --verbose`。
- 原本 `diagnose --deep` 的只读深度检查，迁移到 `aw status --verbose`，不再设计额外 `--deep` 用户选项。
- 直接运行旧入口 `aw diagnose ...` 时，CLI 必须返回确定性的迁移错误，而不是裸的 parser unknown command；错误说明 `diagnose` 已合并到 `status --verbose`，并提示用户改用 `aw status [插件名...] --verbose`。
- 旧入口迁移错误退出码为 `1`，不执行 status/diagnose 逻辑，不读取或写入插件状态，也不刷新本地 catalog。
- 旧入口即使带 `--json`，stdout 也保持为空，错误只写 stderr；不再维护 diagnose JSON 成功或失败 envelope。

Dependency index 维护型恢复入口：

- `aw repair --dependency-index` 是全局 dependency index 重建入口，不绑定单个插件 target，不要求 `--platform` 或 `--scope`。公开 help、文档和下一步指示应写成 `aw repair --dependency-index`，不能让用户为了修复 dependency index 选择平台或 scope。
- `aw cleanup --dependency-index --prune-stale <token> --yes` 是 stale dependency index reference 的显式退休入口，不绑定单个插件 target，不要求 `--platform` 或 `--scope`。`--yes` 只确认这个 prune token 对应的 dependency index 写入，不等同于普通插件 cleanup 的风险确认。
- 这两条维护命令收到插件名、`--platform`、`--scope` 或其它只对插件 target 有意义的参数时，必须确定性失败，错误说明该入口是全局 dependency index 维护动作，不接受插件目标。不能接受后静默忽略，也不能退回普通插件 repair / cleanup 路径。
- 这两条维护命令只读写 dependency index 及可验证的 install-state 文件，不执行插件 lifecycle、renderer、native marketplace 写入、shared runtime 写入或 SkillTrigger built-in apply pipeline。
- 这两条维护命令不因为本地 catalog 缺失、落后、bundle fingerprint 不一致、布局损坏或版本领先而初始化、刷新或覆盖确认本地 catalog；它们不需要 current catalog 作为目标展开来源。
- `aw status --verbose`、`status --verbose --json`、command receipt 和结构化 `nextSteps` 遇到 dependency index 不可信、coverage 不完整或 stale project reference 时，统一指向 `aw repair --dependency-index` 或 `aw cleanup --dependency-index --prune-stale <token> --yes`，不能再提示 `aw diagnose`。
- `aw repair --dependency-index --json` 和 `aw cleanup --dependency-index --prune-stale <token> --yes --json` 的 stdout 仍只输出各自命令的单一 JSON payload；warning、迁移提示、参数错误、token 失效和其它错误都写 stderr。失败时不能额外输出 diagnose JSON 或半份成功 payload。

维护命令参数矩阵：

| 命令 | 接受插件名 | 接受 `--platform` / `--scope` | 接受目标型参数 | 触发本地 catalog gate | `--json` stdout |
| --- | --- | --- | --- | --- | --- |
| `aw repair --dependency-index` | 否，传入即失败 | 否，传入即失败 | 否，`--adopt-existing`、`--takeover-shared-runtime` 等传入即失败 | 否 | 单一 repair payload |
| `aw cleanup --dependency-index --prune-stale <token> --yes` | 否，传入即失败 | 否，传入即失败 | 否，`--force`、`--plan`、`--remove-config` 等传入即失败 | 否 | 单一 cleanup payload |

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
- 暴露 `nextSteps` 的对象必须同时带 `nextStepsSchemaVersion: 1`。
- 旧字符串数组只能作为 `legacyNextSteps` 过渡字段双写；新 schema 中 `nextSteps` 不能再是 `string[]`。
- `status --json` 使用 `statusSchemaVersion: 2`，command receipt 使用 `receiptSchemaVersion: 2`。
- `status --json` 在新增 `statusSchemaVersion: 2` 的同时输出 `consoleItemsSchemaVersion: 3`；两者分别管理 status 顶层 envelope 和本轮新的 `consoleItems` 子结构。
- `config list/get --json` 使用 `configSchemaVersion: 2` 和 `fields: ConfigFieldEntryV2[]` 作为主合同。
- `kind: 'cliCommand'` 的下一步必须同时包含 `label`、`description` 和 `command`。
- `kind: 'uiAction'` 的下一步必须能映射到明确 UI 操作，不能只把 CLI 命令藏在 action 里。
- TUI 消费结构化对象时必须忽略 `command` 字段，不得把它渲染出来。
- `aw diagnose` 的公开 JSON 不再延续；原信息进入 `status --verbose --json` 后按 `statusSchemaVersion: 2` 解释。

### R17：SkillTrigger 内建配置与 CLI 边界

SkillTrigger 不再属于 install、upgrade、repair 或 reinstall 的命令选项。

CLI 入口要求：

- `aw install`、`aw upgrade`、`aw repair`、`aw reinstall` 的 help 不再展示 `-t` 或 `--skill-trigger`。
- 用户在这些命令上传入 `-t` 或 `--skill-trigger` 时，命令必须失败并说明触发策略已迁移到配置管理。
- `upgrade --all` 不再需要单独禁止 `--skill-trigger`；该参数在所有相关命令上都不存在。
- CLI 人类输出和下一步指示不得再提示用户通过重装、升级或修复来改触发策略。
- TUI 的安装、升级、修复和重装流程都不能夹带旧触发策略选择；触发策略只能通过配置页或 `aw config` 管理。

配置入口要求：

- `aw config list/get/set/unset/reset` 必须能处理 AW 注入的 SkillTrigger 内建字段。
- 内建字段和普通插件配置字段共享 user、project shared、project local 的展示模型，但字段适用层必须遵守“Skill 触发策略配置”中的分层规则。
- 未声明普通 `config.schema` 的插件，只要存在可展示的 SkillTrigger 内建字段，也能使用配置查询和 TUI 配置页。
- SkillTrigger 内建字段不能被普通 `config.schema` gate 拦截；`aw config` 解析、写入、清空和重置这些字段时，必须先识别 AW 注入字段，再决定是否需要普通 schema。
- 内建字段的用户可操作逻辑 key 是 `aw.skillTriggers.<skill>.trigger`；JSON 输出必须标记 `kind: "builtIn"` 和 `reserved: true`，普通 manifest 字段标记 `kind: "manifest"`。
- `aw config list/get --json` 顶层必须带 `configSchemaVersion: 2`，并通过 `fields` 数组稳定表达每个普通字段和 AW 内建字段；旧 `summary.values` / `layers` 不能作为新语义的唯一 JSON 出口。
- `aw config set/unset/reset --json` 顶层必须带 `receiptSchemaVersion: 2`，并通过 `affectedFields` 回显本次写入、清空或重置触碰的字段身份；每个 entry 至少包含逻辑 key、展示标题、`kind`、`reserved`、作用层和动作。写命令不能用 `configSchemaVersion: 2` 或 `fields: ConfigFieldEntryV2[]` 冒充读命令输出。
- 普通配置 store 存在、但无法被 current manifest 的普通 `config.schema` 解释时，`aw config list/get --json` 必须通过 `legacyConfigStores` 暴露 store 级残留，并用 `reason: "pluginRemoved"` 或 `reason: "schemaUnavailable"` 区分原因；普通 raw key 和 raw value 不能进入 `fields`、human output 或 TUI 字段表单。
- `aw config get <plugin> <普通key> --json` 遇到这类 store-only 旧普通配置时必须确定性失败；stdout 为空，stderr 说明只能按 store 清理。CLI 清理入口是整层 `aw config reset`；`remove-config` 不作为这类残留的独立配置管理入口。
- `aw config list/get --scope project` 读取 SkillTrigger 内建字段时，返回 project runtime 真值：只看默认值和 project shared 配置，`sourceLayer` 只能是 `default` 或 `project`。project local 中的同名 `$aw.skillTriggers` 值不能进入 `effectiveValue`，只能以 `valueState: "invalid"`、`invalidReason: "unsupportedProjectLocalLayer"` 和 `storedSourceLayer: "local"` 暴露为不可生效存量值。
- `aw config list --scope project --local` 可以继续展示普通 project local 配置字段；如果暴露 SkillTrigger 内建字段的误写存量值，只能作为只读 invalid entry 或说明出现，不能展示成本地可写字段，也不能改变 `fields` 的 runtime 真值口径。
- `aw config get <plugin> aw.skillTriggers.<skill>.trigger --scope project --local` 必须确定性失败，说明项目本地层不适用于 SkillTrigger 内建字段；`--json` 模式 stdout 为空、错误写 stderr、退出码非 0。
- `aw config set/unset <plugin> aw.skillTriggers.<skill>.trigger --scope project --local` 必须确定性失败，不写 project local store，不触发 built-in apply pipeline；`--json` 模式 stdout 为空、错误写 stderr、退出码非 0。若未来新增按字段 reset，该 key 在 project local 层也必须失败。现有整层 `aw config reset <plugin> --scope project --local` 只表示删除 project local store，可用于清理普通本地配置或误写入的存量内容，但不能被描述为 SkillTrigger 本地配置入口。
- 内建字段持久化在 AW 保留 `$aw.skillTriggers` namespace 下，不进入插件作者的普通 `config.schema`，也不传给插件 helper 的普通 `config.values`。
- 用户清空 SkillTrigger 内建字段后，effective 值回到插件声明的 `defaultTrigger`；公共 `slashCommands` 生成的 fixed/manual 字段回到 AW 隐式 `manual` 默认值。
- 用户不能写入 `default` 作为配置值；恢复默认只能通过 unset 或 reset 完成。
- `allowDynamicTrigger: false` 的字段如果存在历史 `$aw` 覆盖值，`aw config list/get --json` 必须把 effective 值显示为默认策略，并把存量值标为 `valueState: "ignored"`、`ignoredReason: "fixedSkillTrigger"`；人类输出和 TUI 配置页也必须说明旧值已忽略。
- 查询命令不能在读路径自动删除旧 `$aw` 覆盖值。user 或 project shared 层的 `aw config unset/reset` 可以删除 fixed skill 的旧值，但该删除只清理存量配置，不改变 effective 触发策略，也不触发“改成其它值”的语义。误写在 project local store 的旧值只能通过整层 `aw config reset <plugin> --scope project --local` 清理。
- 插件退场或 skill key 删除、改名后，遗留 `$aw.skillTriggers.<skill>.trigger` 不得变成静默孤儿值，也不得被普通 schema gate 挡住。`aw config list/get --json` 必须把它展示为 `valueState: "orphaned"`，并用 `orphanedReason` 区分插件不在 current catalog 与 skill 不在当前显式或隐式 SkillTrigger 集合中。
- orphaned SkillTrigger key 没有 effective 值，不能被 `aw config set` 写入，也不能参与 apply、status 或 drift。user 或 project shared 层的 `aw config unset <plugin> aw.skillTriggers.<skill>.trigger` 必须能删除指定 orphaned key；project local 层不支持按 key 删除，只能通过整层 `aw config reset <plugin> --scope project --local` 清理；`aw config reset` 可以继续删除整个配置层。人类输出和 TUI 配置页要把这类字段呈现为可清理的旧配置，而不是当前可编辑字段。
- 本轮不新增 `aw config apply`、`aw config refresh` 或 `aw config reapply`。脚本化重放 effective 配置的入口是 `aw repair <plugin> --platform <platform> --scope <scope>`；`aw config set/unset/reset` 仍负责配置写入及写入后的自动应用，不承担独立 refresh-only 子命令职责。

作者合同要求：

- 静态 `skills/<skill>` 子目录和动态 `artifacts.targets[].target = "codex.skill"` 的 `skillKey` 必须在 `skillTriggers.<skill>` 声明 `defaultTrigger` 和 `allowDynamicTrigger`。
- `defaultTrigger` 是显式声明型 skill 的必需默认策略来源，不再从 install record 推断。
- `allowDynamicTrigger: false` 时，AW 只能展示默认策略，不能提供配置写入口；没有历史 `$aw` 覆盖值时，配置 JSON v2 必须把该字段编码为 `valueState: "fixed"`。
- 新 manifest 中 `skillTriggers.<skill>` 只允许 `defaultTrigger` 和 `allowDynamicTrigger`。旧 manifest 中只表达安装期覆盖许可的 `skillTriggers.<skill>.allowInstallOverride` 不能继续作为新合同的长期语义。
- 缺失 entry、未知 key、缺少 `defaultTrigger`、缺少 `allowDynamicTrigger`，或出现 `allowInstallOverride` 时，build/validate 必须失败。
- 公共 `slashCommands` 生成的 Codex manual-only skill 不属于作者显式 `skillTriggers` 必填范围。AW 必须把它们视为隐式 fixed/manual built-in 字段：`defaultTrigger: "manual"`、`allowDynamicTrigger: false`；`aw config list/get` 和 TUI 配置页如展示这类字段，只能展示为固定只读值，不能提供保存新值入口。
- `docs/plugin-authoring.md`、`.agents/skills/create-aw-plugin/` 的作者参考、`.agents/skills/create-aw-plugin/scripts/validate_plugin.mjs` 和 `.agents/skills/create-aw-plugin/scripts/init_plugin.mjs` 都必须同步到这个作者合同；校验脚本不能继续生成或接受旧的 `allowInstallOverride` 示例，也不能接受静态 `skills/<skill>` 或动态 `codex.skill` 缺失 `skillTriggers` entry。

状态与刷新要求：

- status 详细结构化状态、TUI 状态页和 dynamic diagnostic cache 都以 `defaultTrigger`、内建配置 effective 值和实际 runtime 产物判断 SkillTrigger 状态。
- status、receipt、TUI 和 friendly summary 中的 SkillTrigger 公开字段必须复用 `SkillTriggerPublicView`；不能继续把 install record 的 `skillTriggerPreference` 或 `skillTriggerApplicability` 暴露成公开真值。
- install record 中旧的 `options.skillTriggerPreference` 直接忽略；即使旧值是 `manual` 或 `auto`，也不能影响新运行时结果。
- fixed skill 的历史 `$aw.skillTriggers` 覆盖值同样不参与 effective、runtime patch、status 或 drift 判断；状态页可以提示存在已忽略旧配置，但 drift 判断只能比较默认策略、effective 值和实际 runtime。
- SkillTrigger 内建字段保存后，built-in apply pipeline 按 effective 配置重新应用 runtime patch；失败按普通配置保存后的应用失败展示。配置页的 `应用` / `重新应用配置` 也必须复用同一条 built-in apply pipeline。
- built-in apply pipeline 必须覆盖静态 Codex skill、Claude Code skill、动态 `codex.skill` 产物，以及公共 `slashCommands` 生成的 Codex fixed/manual skill；没有 tracked dynamic artifact 时不能静默跳过。
- status、config JSON、repair、built-in apply 和 shared runtime replay 必须复用同一个 SkillTrigger resolver，不能各自用 install record、owner 文件或 runtime 产物重新解释触发策略真值。
- runtime 与 effective SkillTrigger 不一致时，状态应说明“触发策略与配置不一致”。TUI 的可继续动作指向配置页或重新应用配置；CLI 人类输出、JSON nextSteps 和 receipt 必须提供 `aw repair <plugin> --platform <platform> --scope <scope>` 作为脚本化恢复路径，不提示 `--skill-trigger`。
- `aw repair` 为配置驱动的 runtime drift 收口时，必须按当前 effective 配置执行 built-in apply pipeline，并按需要重放 tracked dynamic artifact refresh；该分支不得修改 config store，不得重新引入 install record 的旧 `skillTriggerPreference` 真值。
- shared runtime owner 文件不再持有 SkillTrigger 真值；旧 owner 文件中的 `preference` 即使存在，也只能作为 legacy 字段兼容读取，不能影响 runtime、status、refresh、repair 或 drift。
- shared runtime takeover、卸载后 rematerialize、`aw init`、marketplace refresh 和其它 shared runtime replay 路径，必须从 owner location 当前 effective built-in config 重新计算触发策略，不能读取 owner 文件或 owner install record 里的旧 preference。
- shared runtime replay 在 owner 证据不可验证、owner record 不匹配，或 owner effective config 不可解析时必须 fail closed，并给出 `repair` 或单目标 `--takeover-shared-runtime` 恢复指引；不得回退到 embedded 默认策略继续写共享 runtime。

### R18：关联文档与作者工具同步

公开合同变化必须同步到用户文档、作者文档和作者工具，避免需求与插件作者入口脱节。

- `docs/plugin-installation.md` 删除 `diagnose`、`--skill-trigger` 和 `platform=auto` 的公开描述，并补充显式平台要求；`install`、`upgrade`、`repair`、`reinstall` 都不能继续把 `--skill-trigger` 写成合法参数。旧 `aw diagnose` 入口的迁移提示只保留在 CLI 错误中，不作为新的公开文档入口。
- `README.md` 同步新的公开入口：交互控制台和脚本化命令列表不再列 `diagnose`，示例不再使用 `aw diagnose`、`--platform auto` 或安装期 `--skill-trigger`。
- `docs/plugin-installation-technical-details.md` 把 `aw diagnose` / `aw diagnose --deep` 说明迁移到 `aw status --verbose`，并删除把 diagnose 当作排障首选入口的建议；dependency index 恢复说明改为由 `status --verbose`、receipt 和结构化 `nextSteps` 引导到 `aw repair --dependency-index` 或 `aw cleanup --dependency-index --prune-stale <token> --yes`。
- dependency index 维护入口的公开文档和 help 必须说明它们不接受插件名、`--platform`、`--scope` 或其它目标型参数；参数错误、help 展示和测试按同一口径收口。
- `docs/architecture.md` 同步命令边界、平台选择和 SkillTrigger 真值模型：不再把 `diagnose` 当作公开命令，不再写 `platform=auto` 默认，不再把 install record 的 `skillTriggerPreference`、shared runtime owner 的 `preference` 或 apply 阶段 preference patch 描述成当前架构真相，并说明配置驱动的 runtime drift 由 `aw repair` 提供脚本化恢复。
- `docs/coding-conventions.md` 同步维护检查清单：SkillTrigger 的维护中心改为 manifest `defaultTrigger`、AW 内建配置 effective 值、built-in apply pipeline 和公开投影，不再要求围绕 install/upgrade/repair 的 `skillTriggerPreference` 传播检查。
- `docs/plugin-authoring.md` 和 `.agents/skills/create-aw-plugin/` 同步升级 `skillTriggers` 作者合同、静态和动态受管 skill 必填声明、公共 `slashCommands` 生成 skill 的隐式 fixed/manual 规则、保留 `$aw` 配置 namespace 和 built-in config JSON 标记。
- `.agents/skills/create-aw-plugin/scripts/validate_plugin.mjs`、`.agents/skills/create-aw-plugin/scripts/init_plugin.mjs` 和作者参考夹具同步校验静态 `skills/<skill>` 与动态 `codex.skill` 都声明 `defaultTrigger`、`allowDynamicTrigger`，不再生成或接受旧 `allowInstallOverride`；公共 `slashCommands` 生成物不要求作者补 `skillTriggers` entry。
- `pnpm plugin:test` 跟随新的平台选择合同；runner、help、错误提示、smoke test、`docs/plugin-authoring.md`、`.agents/skills/create-aw-plugin/` 和作者参考夹具必须同步更新。
- `pnpm plugin:test` 只接受 `--platform codex|claude|both`；传入 `--platform auto` 必须失败，并提示改用 `codex`、`claude` 或 `both`。
- `pnpm plugin:test <plugin>` 或 `pnpm plugin:test --all` 未传 `--platform` 时按 `--platform both` 处理。
- `pnpm plugin:test --platform both` 按每个插件 build 后 staging manifest 的最终支持平台集合展开。单平台插件只运行自己支持的平台；双平台插件分别运行 Codex 和 Claude 两轮；`both` 不要求每个插件同时支持 Codex 和 Claude。
- `pnpm plugin:test --platform codex|claude` 是显式单平台选择；任一选中插件的最终支持平台集合不包含该平台时，runner 必须在测试执行前失败，不能静默跳过或回退到另一平台。
- `docs/testing.md` 补充 JSON schema version、结构化 `nextSteps`、启动 catalog gate、显式平台和 TUI 危险确认的验收口径。

## 验收标准

### 版本规范与构建发布

- CLI package version 符合严格 SemVer 时，构建和发布流程可继续；不符合时构建、打包和发布失败。
- 插件 `manifest.version` 符合严格 SemVer 时，插件可进入 catalog 构建；不符合时构建失败。
- `v1.2.3`、`1.2`、`latest`、`^1.2.3` 等写法不能被自动清洗后通过。
- prerelease 和 build metadata 按 SemVer 2.0.0 处理；build metadata 不影响版本优先级。

### 启动 catalog 校验

- 需要 shared runtime、native marketplace、本地 marketplace 注册或其它 `~/.aw` 产物的入口，本地 catalog 完全不存在时自动初始化本地 catalog 后继续。
- 需要这类本地产物的入口，当前 CLI 版本等于本地 catalog `sourceVersion`、但 bundle fingerprint 不一致时，自动刷新本地 catalog 后继续。
- 需要这类本地产物的入口，当前 CLI 版本等于本地 catalog `sourceVersion`、bundle fingerprint 一致但布局健康检查失败时，自动刷新本地 catalog 后继续。
- 需要这类本地产物的入口，当前 CLI 版本高于本地 catalog `sourceVersion` 时自动刷新本地 catalog 后继续。
- 需要这类本地产物的入口，当前 CLI 版本低于本地 catalog `sourceVersion` 时，CLI 输出警告并要求输入 `y/n`；TUI 展示选项确认页。
- 需要这类本地产物的入口，已存在的本地 catalog `sourceVersion` 缺失、非法或无法比较时，CLI 输出警告并要求输入 `y/n`；TUI 展示选项确认页。
- 用户不选择覆盖本地 catalog 时，需要该本地 catalog 的命令或动作退出，不继续写入。
- 非交互环境在需要这类本地产物且遇到确认覆盖场景时直接失败。
- `--json` 模式下本地 catalog gate 的所有警告、确认和错误只写 stderr；成功继续后 stdout 是原命令的单一 JSON，取消、拒绝或非交互失败时 stdout 为空且退出码非 0。
- `aw status`、`aw status --verbose`、`aw config list/get` 不因为本地 catalog 缺失、落后、bundle fingerprint 不一致、布局损坏或版本领先而写入 `~/.aw`，只读回退 embedded catalog。
- 纯 Codex project repo-managed 安装、状态查看和配置恢复在本地 catalog 缺失、落后、bundle fingerprint 不一致、布局损坏或版本领先时仍可继续，不会为了当前项目初始化或刷新 `~/.aw`。
- 普通配置字段的 `aw config set/unset/reset --scope project` 与 `aw config set/unset/reset --scope project --local` 在目标展开后只写当前项目的 project shared 或 project local config store，且保存后的自动应用只命中 Codex project repo-managed target 或无可应用 runtime 时，不会为了配置写入或应用初始化、刷新或覆盖确认 `~/.aw`。SkillTrigger 内建字段命中 `--scope project --local` 时按 R17 确定性失败，不写 store，也不触发 `~/.aw` gate。
- TUI 项目级配置保存、保存后的自动应用、`应用` 和 `重新应用配置` 如果最终执行目标仍是纯 Codex project repo-managed target，不会进入本地插件列表校验页。
- `aw repair <plugin> --platform codex --scope project` 在目标展开后只命中纯 Codex project repo-managed target，并用于配置驱动 runtime drift 恢复时，即使本地 catalog 缺失、落后、bundle fingerprint 不一致、布局损坏或版本领先，也不会为了当前项目初始化、刷新或覆盖确认 `~/.aw`。
- 同一条 `aw repair` 如果实际需要 native runtime、shared runtime、本地 marketplace 或其它 `~/.aw` 产物，必须在写入前进入本地 catalog gate。
- TUI 启动和只读状态页不因本地 catalog 不可用而进入覆盖确认页；用户后续选择需要 native runtime 或 shared runtime 的动作时，必须在写入前进入本地插件列表校验或自动同步流程。

### 安装目标

- CLI help 和公开文档不再把 `auto` 列为 `--platform` 可选值。
- 用户传入 `--platform auto` 时命令失败，并提示改用 `codex`、`claude` 或 `both`。
- `aw status` 不传 `--platform` 时按 `both` 查看有证据的所有真实平台。
- `aw install <plugin>`、`aw upgrade <plugin>`、`aw uninstall <plugin>`、`aw cleanup <plugin>`、`aw repair <plugin>`、`aw reinstall <plugin>`、认领和接管类写入口不传 `--platform` 时失败，并提示显式选择 `codex`、`claude` 或 `both`。
- 批量安装、升级或其它新写入操作显式传 `--platform codex` 或 `--platform claude` 时，任一插件当前不支持所选平台都会在写入前失败，不会只处理兼容子集。
- 单平台插件安装或升级时使用 `--platform both`，只生成该插件当前支持的单平台目标。
- 双平台插件安装或升级时使用 `--platform both`，生成 Codex 和 Claude Code 两个平台目标。
- 批量安装多个插件时，`both` 按每个插件自己的 current manifest 支持平台集合展开，不要求所有插件支持同一组平台。
- 插件新版删除某个平台支持后，如果该旧平台仍有 AW 受管安装、marker 或可定位残留，`aw status --platform both` 能展示该旧平台状态；`aw cleanup`、`aw uninstall` 或可用的 `aw repair` 显式传该平台时能进入恢复流程，不会被 current manifest 支持平台门禁提前挡掉。
- 同一场景下，TUI 首页和详情页的平台摘要必须把该旧平台展示为历史恢复目标，带异常符号和稳定标签；状态页可以展开细节，但不能成为用户发现该平台的唯一入口。
- 恢复动作的 `--platform both` 会把有现场证据的历史不支持平台纳入“所有可处理目标”；没有现场证据的平台不会被凭空展开。
- 历史不支持平台不能被 install、upgrade 或 reinstall 的重新安装阶段重新写入；这类分支必须在写入前失败，并给出清理旧平台或选择当前支持平台的下一步。
- `aw reinstall --platform both` 同时命中当前支持平台和历史不再支持、但仍有受管安装或残留证据的平台时，整条命令在写入前失败；不能部分清理历史平台后继续重装当前支持平台。
- `both` 展开后的任一目标平台不可执行、scope 不合法或预检失败时，命令整体失败，且不产生部分写入。
- install record、project artifact identity、dependency index 和 receipt target 只出现真实平台，不保存 `both` 或 `auto`。
- 多目标写操作的确认页、进度、结果和 JSON receipt 都列出展开后的真实目标，并能区分每个目标的 `completed`、`rolledBack`、`notRun` 和 `failed` 状态。
- JSON receipt 顶层包含 `receiptSchemaVersion: 2` 和稳定的 per-target 结果数组；多目标失败时不能只返回整体失败文案。
- `aw status --platform both` 能查看所有真实平台的状态，`aw status --platform auto` 不再可用。
- TUI 安装流程的平台页只列平台选项，不列平台和 scope 的组合项。
- TUI 批量安装在进入平台页前发现整组选中插件没有共同可用 scope 时，直接失败并提示拆成多次安装；不会展示后续无法提交的平台或位置候选。
- TUI 安装流程的平台页按跨 scope 并集展示候选；只在某个 scope 下可安装的平台不能被交集口径提前隐藏。
- TUI 安装流程选择 `全部支持平台` 后，再进入 scope 选择页。
- TUI 安装流程选择 `全部支持平台` 后的预检覆盖展开后的完整目标集。
- TUI 安装流程在 scope 选择后发现平台或展开目标失效时，回到平台页并说明原因，不写入任何状态，也不以泛化预检失败直接结束流程。
- TUI 批量安装混合平台插件时，只展示整组选中插件共同支持的单平台；没有共同单平台但 `both` 可展开时，只展示 `全部支持平台`。
- TUI 目标选择页选中平台、位置或目标后按 `Enter` 确认，不再提供额外的 `继续` 操作。
- 安装或升级涉及依赖插件安装、升级时，TUI 在写入前展示依赖确认页，列出依赖插件和安装平台信息。

### 首页

- 打开 `aw` 后首页按状态分组展示插件卡片。
- 首页不显示 `arrow-up-circle`、`check-circle`、`alert-circle` 等 icon id。
- 首页状态符号按颜色语义渲染，且无颜色终端仍可识别状态。
- 首页卡片不显示 `简介`、`平台`、`状态`、`版本` 这类冗余行内标题。
- 首页不显示长摘要段落、命令建议或诊断矩阵。
- 首页不显示 `aw ...` 命令或任何复制到 CLI 执行的建议。
- `异常`、`可升级`、`已安装`、`未安装` 的排序稳定。
- 同一插件在同一平台同时拥有健康的 user 和 project 安装时，首页和详情页列出两个 scope，但不会仅因为 dual-scope 显示 `异常`。
- 插件当前只支持 Codex、但 Claude Code 仍有 AW 受管安装、marker 或残留证据时，首页卡片和详情页平台区域都显示 `! Claude Code（历史残留）` 或等价稳定标签，并在异常原因中点名 Claude Code；该平台不会展示为普通未安装平台。
- 未安装 catalog 插件仍能在首页出现并可进入安装流程。
- 插件不在 current catalog、也没有安装或 runtime 残留证据，但当前用户配置或当前项目配置中仍有旧配置时，首页在 `异常` 分组展示旧配置占位项；进入详情后只提供 `配置` 和 `清理旧配置` 等配置清理动作。

### 详情页

- 详情页不显示 `aw upgrade ...`、`aw cleanup ...` 等命令式建议。
- 详情页主体不显示 `简介`、`状态`、`版本` 这类冗余行内标题。
- 推荐操作以菜单标记呈现，例如 `升级（推荐）`。
- 详情页的下一步只展示 UI 动作或状态说明，不展示结构化 `command` 字段。
- 已安装插件存在依赖时展示 `依赖` 入口，并能进入依赖详情页。
- 依赖详情页按当前插件已安装目标的平台和 scope 分组。
- 依赖详情页用符号、颜色和文字同时标记依赖正常、异常和缺失状态。
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
- `aw status --verbose` 不写状态、诊断缓存、备份或插件配置，也不为了查询初始化或刷新本地 catalog。
- `aw status --json` 顶层包含 `statusSchemaVersion: 2`。
- `aw status --json` 顶层包含 `consoleItemsSchemaVersion: 3`，且它只解释本轮新的 `consoleItems` 子结构。
- `consoleItemsSchemaVersion: 2` 只代表本轮之前的旧 console item shape；结构化 `nextSteps` 或移除旧 SkillTrigger 字段后的 `consoleItems` 不能继续标成 V2。
- `aw status --json`、`status --verbose --json` 和 TUI console item 中的 SkillTrigger 状态使用 `skillTriggers: SkillTriggerPublicView[]`；公开输出不再出现 `skillTriggerPreference`、`skillTriggerApplicability`、`installOptions`、`skillTriggerRuntimeMatches`、`skillTriggerRuntimeState`、`skillTriggerDrift`。
- `aw diagnose` 不出现在 CLI help 中。
- 文档、TUI 和所有用户可见 CLI 输出不再引用 `aw diagnose` 或“重新运行 diagnose”；cleanup、repair、dependency index、prune token、receipt 和 JSON nextSteps 的代表性故障路径都覆盖这条断言。
- 直接运行 `aw diagnose ...` 返回 exit code `1` 和迁移错误，stderr 提示改用 `aw status ... --verbose`；stdout 保持为空，`--json` 也不输出 diagnose JSON。
- `aw repair --dependency-index` 不要求 `--platform` 或 `--scope`，不执行插件 target 展开，不触发本地 catalog 初始化、刷新或覆盖确认，只重建 dependency index 并报告 coverage。
- `aw cleanup --dependency-index --prune-stale <token> --yes` 不要求 `--platform` 或 `--scope`，不执行普通插件 cleanup，不触发本地 catalog 初始化、刷新或覆盖确认，只退休 token 对应的 stale dependency index reference。
- dependency index 维护命令传入插件名、`--platform`、`--scope` 或其它目标型参数时确定性失败；失败只写 stderr，`--json` 模式 stdout 为空。
- `status --verbose`、`status --verbose --json`、receipt 和结构化 `nextSteps` 遇到 dependency index 不可信或 stale reference 时，指向 `aw repair --dependency-index` 或 `aw cleanup --dependency-index --prune-stale <token> --yes`，不再指向 `aw diagnose`。
- dependency index 维护命令带 `--json` 时，stdout 是单一 JSON payload；warning 和错误写 stderr，参数错误或 token 失效时 stdout 为空。

### 下一步指示

- 公开 `nextSteps` 使用结构化对象，不再把裸命令字符串作为用户提示。
- 每条下一步都有动作名和作用说明。
- CLI 人类输出中出现命令时，同时解释命令用于什么场景、会查看或处理什么内容。
- CLI 人类输出不出现只有命令的 `下一步：aw ...`。
- TUI 所有页面都不显示 `aw ...` 命令建议。
- `cliCommand` 类型下一步不会被 TUI 渲染成命令文本。
- 暴露 `nextSteps` 的 JSON 对象同时包含 `nextStepsSchemaVersion: 1`，且 `nextSteps` 是结构化对象数组。
- 旧字符串数组只通过 `legacyNextSteps` 过渡字段暴露。
- command receipt 顶层包含 `receiptSchemaVersion: 2`。多目标写操作还必须包含稳定的 per-target 结果数组，TUI 结果和 CLI JSON 使用同一组目标结果数据。

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
- 写操作执行中按 `q` 或 `Ctrl+C` 不强制终止进程，不中断已开始的写入、回滚、receipt 写入或诊断状态写回；当前写操作收口到正常结果状态后再退出。
- 执行中请求退出后，不再刷新首页或打开新的菜单输入；per-target 结果、recent result、receipt 和诊断状态保持完整。
- 危险动作确认页使用选项菜单，不出现 `y/N` 文本确认。
- 确认页默认选中取消。
- 取消危险动作不产生写入。
- 多目标危险动作确认页列出每个真实目标和失败处理口径。
- 认领和接管类高风险恢复动作不提供批量目标。

### 卸载与清理

- 健康安装详情页不同时显示 `卸载` 和 `清理`。
- 健康安装显示 `卸载`。
- 异常、残留或半完成状态显示对应恢复动作，其中清理必须先进入预览或风险确认。
- 卸载失败后，详情页最近操作结果提供 `状态` 和 `清理`。
- 普通插件 `aw cleanup <plugin>` 必须显式传 `--platform codex|claude|both`；显式 `both` 时输出和 receipt 列出每个真实目标。
- `aw uninstall <plugin> --platform both --remove-config` 或 TUI 多目标卸载命中同一 config store 时，主体目标全部成功后只删除该 store 一次。
- 多目标卸载或清理附带删除配置时，只要同一 config store 下本次涉及的任一主体目标失败、未执行或回滚后仍保留，配置 store 就必须保留；TUI 最近结果、CLI 人类输出和 JSON receipt 标记“主体失败，因此跳过 remove-config”。
- 配置 store 删除失败不回滚已经成功的主体卸载或清理；结果和 JSON receipt 明确标记配置仍未删除。

### SkillTrigger 内建配置

- `aw install`、`aw upgrade`、`aw repair`、`aw reinstall` 的 help 不展示 `-t` 或 `--skill-trigger`。
- 用户在这些命令上传入 `-t` 或 `--skill-trigger` 时，命令失败，并引导到配置管理。
- TUI 目标选择页不展示 `默认`、`手动`、`自动` 的触发策略选择。
- TUI 的重装流程不展示或继承旧的安装期触发策略选择。
- 配置页展示 AW 注入的每个 skill 触发方式字段，且字段来源能显示为默认值、个人或项目。
- 未声明普通 `config.schema` 的插件，只要有 SkillTrigger 内建字段，也能进入配置页查看或管理。
- manifest `skillTriggers.<skill>` 使用 `{ defaultTrigger, allowDynamicTrigger }`，不再接受旧的 `allowInstallOverride` 作为新合同字段。
- 每个静态 `skills/<skill>` 子目录和动态 `artifacts.targets[].target = "codex.skill"` 的 `skillKey` 都必须有对应 `skillTriggers.<skill>`；缺失声明、未知 key 或缺少必填字段时，build/validate 失败。
- 公共 `slashCommands` 生成的 Codex manual-only skill 不要求作者声明 `skillTriggers.<command>`，并由 AW 隐式注入 `defaultTrigger: "manual"`、`allowDynamicTrigger: false`；配置页和公开投影如展示它，只能展示为固定只读值。
- `aw config` 使用逻辑 key `aw.skillTriggers.<skill>.trigger` 管理内建字段，JSON 中标记 `kind: "builtIn"` 和 `reserved: true`。
- `aw config list/get --json` 顶层包含 `configSchemaVersion: 2`，主数据结构是 `fields: ConfigFieldEntryV2[]`。
- `aw config set/unset/reset --json` 顶层包含 `receiptSchemaVersion: 2`，并通过 `affectedFields` 回显被写入、清空或重置字段的 `kind`、`reserved`、逻辑 key 和作用层；写命令不输出 `configSchemaVersion: 2`。
- SkillTrigger 内建字段持久化在 `$aw.skillTriggers` 保留 namespace 下，不进入普通 `config.schema`。
- SkillTrigger 内建字段的 list/get/set/unset/reset 不依赖普通 `config.schema`；没有普通 schema 的插件也可以通过 `aw config` 管理这些字段。
- `allowDynamicTrigger: true` 的 skill 可以通过配置页和 `aw config set` 修改触发方式。
- `allowDynamicTrigger: false` 且没有历史 `$aw` 覆盖值的 skill 只读展示默认触发策略；`aw config list/get --json` 对应 entry 使用 `valueState: "fixed"`、`writable: false`、`sourceLayer: "default"`，写入对应内建字段会失败。
- `allowDynamicTrigger: false` 的 skill 存在历史 `$aw.skillTriggers` 覆盖值时，effective 值仍等于 `defaultTrigger`；`aw config list/get --json` 标记 `valueState: "ignored"` 和 `ignoredReason: "fixedSkillTrigger"`，TUI 配置页说明旧配置已忽略。
- `aw config list/get` 不会静默删除 fixed skill 的历史 `$aw` 覆盖值；user 或 project shared 层的 `aw config unset/reset` 可以清理该旧值，且清理前后 effective 值不变。误写在 project local store 的旧值只能通过整层 `aw config reset <plugin> --scope project --local` 清理。
- 插件已不在 current catalog，或 skill key 已从当前显式或隐式 SkillTrigger 集合删除、改名时，遗留 `$aw.skillTriggers` 覆盖值在 `aw config list/get --json` 中标记为 `valueState: "orphaned"`，并暴露存量值、来源层和 orphan 原因。
- orphaned SkillTrigger key 不能被 `aw config set` 写入，不能参与 effective、runtime、status 或 drift；user 或 project shared 层的 `aw config unset` 可以按逻辑 key 删除该旧值，project local 层只能通过整层 reset 清理误写入内容，`aw config reset` 可以删除整层配置。
- TUI 配置页遇到 orphaned SkillTrigger key 时，把它展示为可清理的旧配置，不展示为当前触发方式，也不提供保存新值入口。
- 清空或重置 SkillTrigger 内建字段后，effective 值回到该 skill 的 `defaultTrigger`。
- 配置值只接受 `manual` 或 `auto`；不能把 `default` 写成持久配置值。
- project scope 的 SkillTrigger 不允许通过 project local 层改变 repo-visible runtime。
- `aw config list/get --scope project` 读取 SkillTrigger 内建字段时，`effectiveValue` 表示 project runtime 真值，只由默认值和 project shared 配置决定；project local 存量值不能改变 `sourceLayer`、runtime、status 或 drift，只能用 `valueState: "invalid"` 和 `invalidReason: "unsupportedProjectLocalLayer"` 暴露为不可生效旧值。
- `aw config list --scope project --local` 如果暴露误写在 project local store 的 SkillTrigger 存量值，必须显示为只读 invalid entry 或只读说明，不能提供字段编辑、清空或字段级 reset。
- `aw config get/set/unset <plugin> aw.skillTriggers.<skill>.trigger --scope project --local` 确定性失败；`--json` 模式 stdout 为空、错误写 stderr、退出码非 0。失败不会写 project local store，也不会触发 built-in apply pipeline。
- 整层 `aw config reset <plugin> --scope project --local` 仍可删除 project local store，但它只是本地配置清理动作，不是 SkillTrigger 本地配置入口，也不能触发 SkillTrigger runtime apply。
- 已有 install record 中的 `options.skillTriggerPreference` 不再影响 runtime、status 或 refresh，也不会自动迁移为配置项。
- 保存 SkillTrigger 内建字段后，AW built-in apply pipeline 会把 effective 触发策略应用到静态 Codex skill、Claude Code skill、动态 `codex.skill` 产物和公共 `slashCommands` 生成的 Codex fixed/manual skill；没有动态 artifact 的插件不会被跳过。
- runtime 与 effective SkillTrigger 配置不一致时，状态页和 CLI 下一步不提示 `--skill-trigger`；TUI 提示配置页或重新应用配置，CLI 人类输出、JSON nextSteps 和 receipt 指向 `aw repair <plugin> --platform <platform> --scope <scope>`。
- `aw repair` 用于收口配置驱动的 runtime drift 时，会按当前 effective config 重放 SkillTrigger built-in apply pipeline 和必要的 tracked dynamic artifact refresh，不修改 config store，也不读取 install record 旧 `skillTriggerPreference` 作为真值。
- shared runtime owner 文件不再把 `preference` 作为 SkillTrigger 真值；takeover、卸载后 rematerialize、`aw init`、marketplace refresh 和其它 shared runtime replay 路径都必须从 owner location 当前 effective built-in config 重新计算。
- owner 证据失效或 owner effective config 不可解析时，shared runtime replay fail closed，并给出 `repair` 或单目标 `--takeover-shared-runtime` 恢复指引。
- fixed skill 的历史 `$aw` 覆盖值不参与 runtime、status 或 drift 判断。
- receipt、TUI 最近结果和 friendly summary 如需展示 SkillTrigger 应用结果，复用 `SkillTriggerPublicView`，不能重新引入安装期偏好字段或“账本偏好”文案。
- 作者文档、作者工具、校验脚本和脚手架不再生成或推荐旧 `allowInstallOverride` 示例，也不接受静态 `skills/<skill>` 或动态 `codex.skill` 缺失 `skillTriggers` entry；公共 `slashCommands` 生成物不要求作者补 entry。

### 配置管理

- 详情页有清晰的 `配置` 入口。
- 同一插件只有一个可配置 target 时，`配置` 可直接进入该 target 的配置页。
- 同一插件存在多个平台、scope、project 或 config store target 时，进入配置页前必须先选择明确 target；页面不能静默挑一个位置，也不能把多个位置隐式合并。
- 未安装但 current catalog 声明普通 `config.schema` 或 SkillTrigger 内建字段的插件，详情页仍可进入 `配置`，默认写 `个人` 配置。
- 未安装且可配置的插件只有在 current manifest 存在真实 project-installable target 时，配置目标页才展示当前项目配置；纯 user-only、Codex native-only、Codex apps-only，或没有任何 project scope 可安装目标的插件只展示个人配置。
- 插件已退场或只有 orphaned SkillTrigger 旧配置时，TUI 通过首页旧配置占位项进入详情页，再查看和清理旧配置；入口不依赖 current catalog 或安装现场证据。插件仍在 current catalog 但普通 schema 已撤掉时，不重复生成首页占位项，但当前插件详情页仍能进入旧普通配置 store 的查看和清理。
- 首页旧配置占位项只列当前用户配置和当前项目配置中真实存在的 config store target，不扫描历史项目，也不提供保存新值、安装、升级或 runtime apply。
- 普通 manifest 配置残留只要无法被 current manifest 普通 `config.schema` 解释，就只保证 store 级可见和整层清理；`aw config list/get --json` 通过 `legacyConfigStores.reason` 区分 `pluginRemoved` 和 `schemaUnavailable`。TUI、CLI 人类输出和 JSON 都不展示普通 raw key 或 raw value，也不为没有 current schema 的普通旧字段提供字段级编辑、读取或按 key 清理；CLI 删除路径是整层 `aw config reset`，不是独立 `remove-config`。
- 配置页可查看 `生效`、`个人`、`项目`、`本地`。
- 配置页显式展示当前 target；作用层候选与该 target 匹配，user target 不展示不适用的 project 层。
- `生效` 只是配置读取视图，不是字段状态。`aw config list/get --scope effective --json`、CLI 人类输出和 TUI 配置页都不能生成或依赖 `valueState: "effective"`。
- 配置页和 CLI 配置输出使用同一套 `ConfigFieldEntryV2` 状态语义；`configured`、`fixed`、`ignored`、`orphaned`、`invalid` 的含义和可编辑性在两边一致。
- fixed SkillTrigger 字段在配置页和 CLI 配置输出中都展示为固定只读默认值，不能被渲染成普通默认可编辑字段、已配置字段或仅靠 `writable: false` 才能理解的隐含状态。
- 配置页支持字段更新、清空和当前层重置。
- 重置和删除配置走选项确认页。
- 敏感字段脱敏展示。
- 本地配置不被描述成共享配置真值。
- project scope 的本地视图不提供 SkillTrigger 内建字段编辑、清空或字段级重置入口；字段说明必须指向默认值或项目配置。
- 配置保存后的应用或 refresh 结果能在 UI 中看到。
- 跨 `user`、`project shared`、`project local` store 的配置写入会拆成多个 config write group，分别确认、分别保存、分别展示结果。
- 同一个 config store 下有多个当前可定位、表单 identity 一致的 sibling target 时，配置保存只写一次 store，并对同组 target fan-out 执行 apply；最近结果和 JSON receipt 按 target 展示结果。
- `aw config get <plugin> aw.skillTriggers.<skill>.trigger --json` 遇到 ignored 或 orphaned 旧配置时返回对应 `fields` entry，不被普通 manifest schema 当成 unknown key 拦截。
- 配置页的 `应用` / `重新应用配置` 不修改 config store，只按当前 effective config 重放可重放 runtime 写入。
- 配置页的 `应用` / `重新应用配置` 从当前明确 target 进入，但执行范围按同 store apply group fan-out；结果、最近结果和失败摘要按 target 展示。
- `应用` / `重新应用配置` 同时覆盖 tracked dynamic artifact refresh 和 SkillTrigger built-in apply pipeline。
- 没有普通 `config.schema` 或 tracked dynamic artifact、但存在 SkillTrigger 内建字段的插件，执行 `应用` / `重新应用配置` 时仍会运行 built-in apply pipeline。
- CLI 不新增 `aw config apply`、`aw config refresh` 或 `aw config reapply`；非交互恢复配置驱动 runtime drift 时使用 `aw repair <plugin> --platform <platform> --scope <scope>`。

### 作者测试入口

- `pnpm plugin:test` help、runner、错误提示、smoke test、作者文档和作者 skill 都不再把 `auto` 当作公开 platform 值。
- `pnpm plugin:test --platform auto` 失败，并提示可选值是 `codex`、`claude` 或 `both`。
- `pnpm plugin:test` 未传 `--platform` 时按 `both` 处理。
- `pnpm plugin:test --platform both` 按每个插件最终支持平台集合展开；单平台插件不会因为不支持另一个平台而失败。
- `pnpm plugin:test --platform codex|claude` 遇到任一选中插件不支持该平台时，在测试执行前失败。

### 关联文档与作者工具同步

- `README.md`、`docs/plugin-installation.md`、`docs/plugin-installation-technical-details.md` 不再把 `aw diagnose`、`aw diagnose --deep`、`--platform auto` 或安装期 `--skill-trigger` 作为公开使用方式；`aw reinstall` 文档也不能继续列出 `--skill-trigger`。
- `docs/plugin-installation.md` 和技术细节文档把旧诊断场景改写到 `aw status --verbose`，把 dependency index 恢复链路改写到 `aw repair --dependency-index` / `aw cleanup --dependency-index --prune-stale <token> --yes`，把触发策略调整改写到 `aw config` / TUI 配置页，并把配置驱动 runtime drift 的脚本化恢复写成 `aw repair`。
- `docs/architecture.md` 不再描述 `diagnose` 公开命令、写命令默认 `platform=auto`、install record `skillTriggerPreference` 真值、shared runtime owner `preference` 真值或 apply 阶段 preference patch，并记录 `aw repair` 是配置驱动 runtime drift 的 CLI 恢复入口。
- `docs/coding-conventions.md` 的 SkillTrigger 检查清单改为覆盖 manifest 默认策略、AW 内建配置、built-in apply pipeline、公开 JSON 投影和作者工具同步。
- `docs/plugin-authoring.md`、`.agents/skills/create-aw-plugin/`、作者参考夹具、`validate_plugin.mjs` 和 `init_plugin.mjs` 同步新 `skillTriggers` 合同，不再生成或接受 `allowInstallOverride`；公共 `slashCommands` 生成物按隐式 fixed/manual 规则处理，不要求作者补 `skillTriggers` entry。
