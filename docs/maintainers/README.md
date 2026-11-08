# AW 维护者指南

维护 CLI、Core、内置插件或仓库工具时，从下面的任务地图进入当前主题。用户操作见[根 README](../../README.md)，插件与 Catalog 公开合同见 [Reference 目录](../reference/)，README 规范见 [README 规范](../authoring/readme-standard.md)。

## 开发环境与源码边界

- 使用 `pnpm@10.33.0` 和 Node.js `>=22`；实际要求由[根 package.json](../../package.json)定义。
- `pnpm build` 编译 CLI，并生成本地 Catalog staging 和 runtime bundle；构建包含 TypeScript 类型检查。项目没有独立的 `typecheck` 命令。
- CLI 源码在 [`packages/cli/src/`](../../packages/cli/src/)，公开 manifest/schema 与确定性 Catalog 合同归 [`packages/plugin-core/`](../../packages/plugin-core/)。插件源码在 [`plugins/`](../../plugins/)，`plugins/<name>/.agents-plugin/plugin.json` 是该插件的源码 manifest 真值。
- `packages/cli/dist/`、`packages/cli/plugins-dist/`、Catalog staging 和 runtime bundle 都是生成物。修改权威源码，由现有构建生成；不手工修改生成物。
- 强配置、弱状态及恢复边界见下方[项目设计约束](#项目设计约束)；根 AGENTS 只保留常驻约束摘要和读取入口。
- 本地安装、打包和发布先读[开发与发版流程](../../README.md#本地开发与发版流程)与[发布流程](release.md)。选测试或验证命令先读[测试指南与 Test Value Gate](testing.md#test-value-gate)。普通 build、静态闭包检查与 smoke 只证明各自覆盖范围；真实客户端加载、平台原生资格与真实 Windows 行为要有对应环境的独立证据。

## 项目设计约束

新增持久或协调机制，修改并发、配置/状态写入、恢复或跨系统一致性，以及评审这些改动时，遵循以下规则：

- 本项目是个人本地工具，不为高并发设计。默认只使用一个 `AW_HOME` 写锁；只有已证明的真实并发边界才可以增加锁。
- CLI 和 Catalog 是公开产品，支持多个 Catalog 来源。每个来源可独立失败；不要求来源之间或 npm 与 Git 之间强一致。
- plugin config、catalog source config 和 catalog state 是强配置，写入必须原子提交。version-scoped publication journal 是强恢复和门禁状态，也必须原子写入。plugin outputs、依赖现场、lifecycle snapshot、Catalog store snapshot 和 prepared release 是可删除、可重建的弱状态。
- 插件安装依赖第三方工具，且用户可能手动修改其结果。动作应尽力完成，并允许部分成功；不要为不可控现场承诺完全正确或补偿回滚。
- 每条失败链必须保留 `cleanup`、`cleanup --force`、`reinstall`、source sync 或发布新版本中的至少一种恢复方式。安全边界不得删除 foreign 或 shared 内容；弱状态损坏也不得永久阻止清理。
- 新增 ledger、持久合同、摘要协议、锁层级、事务、补偿或迁移状态机前，必须证明高概率或高影响的可观察风险，且简单恢复渠道不足。低概率且低影响的问题不得增加代码复杂度；代码评审也忽略这类会增加复杂度的建议。
- 发布操作与恢复分别遵循 [CLI 发布与修复](release.md#61-cli-远端失败普通升级-vs-显式修复repair)和 [Catalog 发布计划与恢复门禁](../reference/catalog.md#publication-recovery)。普通发布、绑定原始证据的修复及同计划续跑不能互相替代。

## 同步规则与所有权约束

- **跨仓库与公共同步责任**：改动插件基础架构、manifest/schema、adapter 行为、scope 语义、分发或安装流程，或任何影响插件作者使用方式的能力时，必须同时检查公开 CLI、canonical registry 与 `aw-development-toolkit`。
- **配置能力发布顺序**：Config Definition v5 的结构能力由 Core、公开 schema、registry、CLI 与 TUI 共用实现，先交付支持新 capability 的 CLI，再分发依赖该能力的插件。
- **导入扫描器的单一真值**：CLI 作者 validator 的 JavaScript import scanner 是唯一实现；门禁覆盖 static import、export-from、dynamic import、`require()`、`require.resolve()`、非代码文本过滤和 `${...}` 代码扫描。严禁建立第二套扫描器实现。
- **插件组合验证**：三层插件应分别验证，并增加同时安装三个插件的组合测试。

## 维护入口与工具归属

通过公开 `aw` CLI 安装相应插件后，各插件工具分别由拥有它们的插件维护，具体插件方法规则指向实际既有 owner，不把所有 Skill 复制到维护者入口：
- `agent-content-toolkit`：提供 `agent-content`，负责 Agent-facing 内容（AGENTS.md、CLAUDE.md、角色说明与 reference）的编写与只读评审。
- `agent-skill-toolkit`：提供 Author、合并的 Reviewer、Simplifier 与 Eval Auditor，依赖 `agent-content-toolkit`。Author 负责创建、修改及当前范围的自检与修复；`review-agent-skill` 与 `simplify-agent-skill` 均由用户显式启动。
- `aw-development-toolkit`：提供 `develop-aw`（负责 AW 插件与 Skill 的分析、创建、修改、评审、简化、验证、物化与平台产物）和仅用户显式调用的 `publish-aw-catalog`（Catalog 发布编排）。它只编排已安装 `aw` CLI 的公开作者命令，不替代通用任务判断。
- `aw-skill-eval-runner`：提供默认模型 Eval 执行器真值与 `aw-skill-eval run`，插件不得复制 schema、digest、validator 或 runner 实现。

## 按任务进入

本目录维护仓库内部实现与维护主题，公开精确合同见 `docs/reference/`。按实际任务匹配下表，多项组合读取；未触及的追加条件不作为必读。

| 当前任务 | 当前正文 | 追加读取条件 |
| --- | --- | --- |
| 安装、同步、重建、移除、cleanup 或共享归属 | [插件生命周期](architecture/lifecycle.md) | 改状态证据或配置时读[状态与配置](architecture/config-and-status.md)；改平台投影时读[平台边界](architecture/platforms.md)。 |
| TUI 页面、键盘、导航、Review、结果或诊断投影 | [TUI 当前交互与能力](architecture/tui.md) | 仅改交互不追加底层合同；改变底层业务语义追加生命周期、状态、来源或公开 Review 合同。 |
| 配置行为、状态证据或判定 | [状态与配置](architecture/config-and-status.md) | 改作者声明、校验或版本语义读[Plugin Manifest 与配置声明合同](../reference/manifest-and-config.md)；改交互时读 TUI。 |
| Catalog 来源、Active、缓存或 Store | [Catalog Sources](architecture/catalog-sources.md) | 改外部格式或消费语义读[外部 Catalog 参考合同](../reference/catalog.md)；改发布流程读[发布流程](release.md)，改 CI 工作流读[CI 说明](ci.md)。 |
| manifest、资源、renderer 或 preApply | [Plugin Manifest 与配置声明合同](../reference/manifest-and-config.md) 与 [插件运行时合同](../reference/plugin-runtime.md) | 触及平台投影读[平台边界](architecture/platforms.md)；生命周期顺序读 [preApply](architecture/lifecycle.md#preapply)；涉及命令或原生制品读[托管命令](../reference/managed-commands.md)或[原生工具](../reference/native-tools.md)。 |
| 平台边界、原生/Portable 投影或 Windows helper | [平台边界](architecture/platforms.md) | 涉及命令或原生制品追加[托管命令](../reference/managed-commands.md)或[原生工具](../reference/native-tools.md)。 |
| Review/Eval 准备、取证、执行或来源绑定 | [Review 与 Eval 架构说明](architecture/review-eval.md) 与 [Review 取证与 Eval 评估合同](../reference/review-and-eval.md) | 具体 runner 用法和插件协议读取所属插件的 README、SKILL 和条件引用。 |
| 持久/协调机制、并发、配置/状态写入、恢复、跨系统一致性及相关评审 | 本页的[项目设计约束](#项目设计约束) | 再读相应架构主题；发布与发布恢复另读[发布流程](release.md)。 |
| CLI 命令、输出协议或非交互边界 | [CLI 合同](../reference/cli.md) | 业务语义再读对应架构；同批更新调用方、能力声明、脚本与 TUI 等价命令。 |
| 修改 TypeScript | [编码约定](coding-conventions.md) | 再读本次变更触及的产品合同。 |
| 添加或修改测试、选择测试层级或验证命令 | [测试指南](testing.md) | 须通过 Test Value Gate；涉及 CI 读[CI 说明](ci.md)；涉及发版读[发布流程](release.md)。 |
| CI 工作流或发版流水线 | [CI 说明](ci.md) | 涉及发版流程读[发布流程](release.md)。 |
| 官方 CLI/Catalog 发布与恢复 | [发布流程](release.md) | 第三方外部 Catalog 合同与恢复见[外部 Catalog 参考合同](../reference/catalog.md#publication-recovery)。 |
| 维护具体插件或 Skill | 该插件 README、相关 SKILL 及其条件引用 | 修改公共作者合同读 `docs/reference/`；修改用户说明时读[README 规范](../authoring/readme-standard.md)。 |
| 维护文档与 Agent 阅读入口 | 本页的[文档维护](#文档维护) | 再读改动主题及其实际消费者。 |

## 必须保留的行为区别

文档和实现一起保持以下区别。入口只帮助选择主题，完整条件由对应主题维护。

| 区别 | 维护时要保留的判断与入口 |
| --- | --- |
| 保存配置／应用配置 | 保存成功后，apply 或 status 失败仍保留已保存值；分别说明保存、未生效影响和恢复。见[状态与配置](architecture/config-and-status.md)。 |
| 刷新来源／升级安装 | 取得候选、启用 Active 和升级已安装插件是不同动作。见[来源](architecture/catalog-sources.md)与 [TUI 来源更新](architecture/tui.md#来源与插件更新)。 |
| 移除需求／清理输出 | Intent、安装事实和物理输出分层；取消项目需求不授予共享内容删除权。见[生命周期](architecture/lifecycle.md)。 |
| 成功／部分成功／失败／未知 | 独立目标可以部分成功；观测不足时保留 unknown，不推断未安装或安全可写。见[状态与配置](architecture/config-and-status.md)和[确认与结果](architecture/tui.md#确认与结果)。 |
| 普通恢复／绑定原始证据的修复 | CLI 新版本发布、精确 descriptor/attempt repair 和 Catalog 同 plan 恢复各有条件。pending journal/repo 缺失或损坏不能盲目重建；published tag 仍占用版本。见[发布流程](release.md)与[外部 Catalog 参考合同](../reference/catalog.md)。 |
| AW 所有／共享／归属未证实 | 管理记录和路径存在不授予删除权；force 也必须保持精确身份、foreign/shared/unknown 保护。见[Ownership 与删除权限](architecture/lifecycle.md#ownership-与删除权限)。 |
| 静态产物合格／真实客户端可用 | 构建、闭包、smoke 和真实客户端资格分别报告；静态通过不代表客户端已加载。见[测试指南](testing.md)与[CI 说明](ci.md)。 |

## 文档维护

行为变更先定位唯一完整定义及实际消费者，再修改当前主题。入口保留读取条件和链接，不复制另一份完整合同。使用现有修改和评审流程，不增加审批系统、持久登记表或文字测试门禁。

1. **定位当前主题。** 从上面的地图找到规则归属。没有归属时，先在现有地图中确定位置；不默认向架构文件尾部追加。
2. **改写原定义。** 将实现已经支持的行为、条件、例外和恢复动作合并到原段落，删除被取代的说法，并同步示例。未经实现验证的候选留在任务设计中，不写成当前能力。
3. **保留必要理由。** 不变量及其非显然原因与规则共置。权限边界、失败语义和设计约束不能以“代码可查”为由删除。对读者在实际环境中可通过 CLI、公开 schema 或已有资源直接取得的长字段、命令或文件清单，提供查询入口；只存在于维护者源码中的信息不算仓外可取得。外部作者和 Agent 必需的字段定义、约束和版本语义仍须有完整合同。
4. **只保留当前状态。** 当前处于开发阶段，文档只保留判断现在如何工作所需的信息。删除已被取代的正文、旧入口兼容壳和已完成任务中不再使用的过程资料，不保留独立的 Rxx 补丁章、验收编号、旧新对照、审阅往返或修复经过。仍有效的格式、版本边界、迁移窗口及恢复依赖的证据属于当前合同，按实际支持情况保留。
5. **同步消费者。** 同批处理仓内链接与锚点、当前可变分支公开链接、Agent 强制阅读指针及构建或运行时资源，直接指向当前完整定义。固定 tag/commit 的合同继续匹配该版本，不统一改为 main。入口和完整正文必须同时可用，不能用导航壳代替 Agent 读取完整要求。
6. **按任务审阅。** 用真实任务走完入口和正文：读者能否理解当前行为；条件与例外是否齐全；同一规则是否出现两份完整定义；文案是否对应已验证实现；过程编号是否已从当前规则中移出。说明实际检查范围，文件变短不等于任务更容易完成。

处理引用时，逐项区分活跃链接、测试输入、输出预期和历史样本，不全局替换 fixture 或旧格式案例。运行时资源必须核对实际 source 选择、路径、复制和闭包；网页导航不能代替安装产物中的实体资源。插件用户正常使用所需说明须在发布成果中可取得；维护资料只有存在运行时阅读消费者时才进入 Skill `references/`。归属、分发和读取时机分别判断，不能因目录名为 `docs` 就认定它不参与 source identity 或构建。

已有主题不能独立服务一个稳定读者任务，且新正文确实可以按条件选择读取时，才新增文件。新增前说明独立任务、共置为何不合适和维护成本。完成新一轮需求、增加几个字段或超过行数，都不足以新增章节树。主题内步骤和精确参考可以共置，不机械套四套目录。

根 README 约 150 行、根 AGENTS 约 3.2 KB、单个 Agent 指向文件约 30 KB 是边界复核信号。完整条件优先，不用超长行、删除例外、碎片化或多个每次必读文件满足数字。长而紧密相关的合同可说明理由后共置。

纯正文整理检查语义、链接、锚点、Agent 路由、差异和格式，不跑全套产品测试，不新增文案快照。移动插件资源或运行时引用时，按真实风险补做对应构建、闭包或 smoke；source identity 变化按既有流程报告，不自动 bump 或发布。涉及真实客户端投影时验证所需客户端，未覆盖部分明确记录。
