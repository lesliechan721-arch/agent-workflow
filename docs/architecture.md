# Architecture

本文件定义 CLI 的稳定产品合同和模块边界。TypeScript 实现方式见[编码约定](coding-conventions.md)，测试选择见[测试指南](testing.md)，单 Plugin Source 见[插件作者指南](plugin-authoring.md)，官方与第三方共用的 Catalog Workspace 见[Catalog 作者指南](catalog-authoring.md)，本仓库维护流程见[插件维护指南](plugin-maintenance.md)。

公开包 `@lesliechan721/aw-plugin-core` 拥有 plugin manifest 的版本、JSON Schema 和运行时结构验证合同。CLI 依赖同版本 core，并在该结构合同之上提供平台 adapter、Catalog、作者工具和 transport。两个 Windows Job 平台包、Eval、Core 与 CLI 使用同一版本发布，顺序为 `Windows x64 → Windows arm64 → Eval → Core → CLI`。

## 设计边界

- AW 是个人本地工具。一个 `AW_HOME` 写锁足以保护强配置；不要为未证明的并发增加全局协调协议。
- Catalog 是公开产品，支持 Git 和本地路径等多个来源。来源独立解析、独立报告错误；一个来源失败不要求其它来源回滚，也不要求 npm 与 Git 形成强一致事务。
- `catalog-sources.json`、`catalog-state.json` 和 plugin config 是强配置。它们必须以原子替换提交。普通配置和 owner marker 写入只在 allowed root 内检查现有祖先的 symlink/type，使用同目录独占临时文件，关闭后 rename。version-scoped publication journal 是强恢复和门禁状态，也必须原子写入。插件输出、依赖现场、Catalog store snapshot 和 release prepared 目录都是弱状态，可删除和重建。
- 外部平台和用户编辑的插件目录不受 AW 完全控制。写操作应提供可观察结果和恢复入口，不建立无法兑现的全局补偿或完全正确保证。
- 正式 `pnpm build`、`build:ensure`、release verification 和 build snapshot 始终使用 release 强缓存、clean build、generation stamp 和完整输出摘要。日常 `build:dev` 使用可删除的六目标弱缓存，分别处理两个 Windows Job 平台包、Eval、Core、CLI TypeScript 和 plugin bundle；损坏时只重建受影响目标，不建立发布状态。

## CLI Source Layout (`packages/cli/src`)

- `commands/write-commands.ts` 是 `install`、`sync`、`reinstall`、`uninstall`、`cleanup` 的写入口；`intent/`、`recovery/` 与 scope context 共用 User/Project 的声明读取、目标选择和恢复编排。
- `commands/rebuild-command.ts` 解析当前 Catalog、依赖和现场状态，并交给统一 rebuild 流程。
- `commands/rebuild-operations.ts` 编排 ownership 检查、preApply、清理、平台写入和完成后检查。
- `commands/rebuild-integration.ts` 把插件能力转换成平台原生写入和 AW-owned 组件。
- `commands/status-v6.ts` 读取多来源 Catalog、live ownership 和平台组件，供统一恢复状态与 TUI 投影复用；公开 `aw status --scope` 使用 `aw-recovery-status` schema 1。
- `commands/dependency-operation-plan.ts` 只生成一次命令内的依赖执行顺序；它不是持久安装记录。
- `commands/operation-plan.ts` 只拥有 Review fingerprint 和 Receipt 中的已确认动作描述；rebuild executor 不执行该描述。
- `utils/ownership.ts` 定义 owner marker、组件检查和安全删除边界。
- `utils/multi-source-catalog.ts` 解析 Catalog Sources Config v2 的 Git/path source，并读取本地 Catalog store 中的 Active snapshot。
- `utils/plugin-config.ts` 与 `utils/plugin-config-write.ts` 管理 namespaced AW config store v5 和独立版本的 config v4 输出。
- `output/command-receipt.ts` 保留内部后端 receipt 事实；公开恢复命令统一输出 `aw-recovery` schema 1。
- `authoring/` 是确定性作者实现；它随 CLI tarball 发布，运行时不读取仓库 `.agents` 或插件 Skill root。公开作者命令统一以 `--workspace-root` 定位任意本地 workspace；基于 Git base 的 status 差异检查和安全删除依赖 Git。
- `review/skill-materialization.ts` 复用本地 bundle 和 runtime import resolver，提供 Skill 物化共用的构建准备与临时环境。Eval 保留自己的 subject/Git 布局；构建和 renderer 均显式使用隔离 HOME、AW homes 和临时目录。普通 bundle 调用未提供 `commandEnv` 时沿用原进程环境；这种输入隔离不是 OS sandbox。
- Core 的 `plugin-authoring-capabilities` API 是 manifest 字段、类型、必填项和 accepted values 的稳定结构 registry。CLI 只叠加 requires、conflicts、profiles 和 validator provenance 等执行/作者适配事实，并通过 `aw plugin capabilities [--surface <surface>] [--json]` 在运行时公开组合结果。
- Core 的 AW capability registry 定义稳定 ID、集合规范化与摘要、Manifest 结构派生、受限生产源码扫描和 schema 1 runtime requirements receipt。`effective` 是 `declared + derived`；`detected` 只给作者提示。扫描器只检查 `SKILL.md` 中独立 shell fence 和 Manifest executable entry；不扫描 inline command、reference、任意脚本或 Node transitive closure。第三方公开 `aw catalog build` 默认只 advisory；官方 `pnpm build` 必须使用 `--strict-requirements` 语义，把不匹配变为阻断，且 `release:verify:catalog:core` 通过该 build 覆盖此门禁。未登记但语法合法的 ID 是可交换数据；是否支持只由当前 executable 的实现集合决定。`aw self describe --json` 公开该集合，`aw self check --json` 从最近的 receipt 或 Manifest 检查兼容性，`aw plugin requirements <plugin-directory> --add/--remove <capability> --json` 只修改 `requires.aw.capabilities`，并计算 declared、derived、detected 和 effective requirements。Plugin Manifest v3 要求显式 `schemaVersion: 3`。

公开包 `@lesliechan721/aw-plugin-core` 还拥有 Catalog Workspace v1 marker 与 metadata、单插件 bundle 和 schema 7 Catalog snapshot build/validate 的机器合同。固定源码入口是 `.aw-workspace.json`、`plugins/marketplace-source.json` 和 `plugins/<name>/.agents-plugin/plugin.json`；metadata 的 `catalog.version` 只允许稳定 `x.y.z` 或精确 `x.y.z-beta.N`。CLI 只负责参数、输出、安全目标选择，以及注入 build/test adapter；Core 不读取 `AW_HOME`、安装状态、TUI 或 Git transport。

### Module Invariants

- renderer context 使用规范化的非空 `requestedArtifactIds` 精确限定本次请求；`config.schema/values/sources/issues` 和 `changedConfigKeys` 只包含这些 target 的 `refreshKeys` 并集。同一 surface/scope 同时包含 Skill target 和读取 sensitive config 的非 Skill target 时，AW 把它们放入两个请求；两个请求使用同一份不可变 `previousArtifacts`，且各自只接受与本批 ID 精确相等的 `ArtifactPlan`。context 不公开 config store 路径，且 context 中的 home 与 renderer 进程的 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 都指向本次请求的临时目录。该输入隔离不是 OS sandbox。renderer 不直接写平台文件。AW direct writer 不请求 `codex-native` target。标准 config helper 只读取 CLI 已校验的 `AW_PLUGIN_CONTEXT` effective config，不读取 config store，也不重复 schema 或 value validation；缺少 context 或请求 user/project scope 时 fail closed。
- renderer 输出在 JSON 解析后、envelope 和 `ArtifactPlan` 详细结构验证前，统一拒绝包含 effective sensitive config 明文或其 JSON 转义形态的普通及 Portable dynamic artifact；扫描通过后仍执行完整 envelope 和结构验证。阻断只匹配至少 8 个 Unicode code point 的 string；此阈值是减少短值误报的产物门禁，不表示 secret 强度。preApply 和 renderer 在插件执行边界清理错误与输出摘要中的原值和 JSON 转义形态，再交给 debug、文本输出或 Receipt；日志和诊断脱敏所有长度的 sensitive 值。只有 AW 已生成或按内容验证的精确 receipt path 才从扫描中排除；不得按 basename 或通配符排除。错误只公开稳定 code，不回显 sensitive 值。
- build-generated Skill reference 必须由 `buildConfig.generatedSkillRuntimeFiles` 精确声明。源码 validation 不把声明目标误报为缺失；最终 bundle 必须生成目标并通过完整 runtime closure。
- 写入前验证 scope、路径边界、目标身份和最终 Skill tree。
- Dynamic `codex.skill` 必须显式选择 `aw-extension` 或唯一受支持的 native delivery `{mode:"codex-native",identity:"shared",renderProfile:"user"}`。所有 `codex.skill` delivery、`claude.skill` 和 `agent-skills.skill` target 的 refresh key 都不得引用 sensitive config；非 Skill target 可以读取 sensitive config。native delivery 是 Codex-owned dynamic Skill，scope 和名字来自 target；其 refresh key 只能在 user scope 写入，project scope 的 set 必须拒绝，且不能与静态 Codex Skill 同名。同一插件 identity 的所有 Codex native 组件必须声明完全相同的 scope 集；静态 Skill、MCP、Hook 和 App 固定为 `{project,user}`，dynamic native 使用 target scopes，slash command 不属于该集合。config 只作为 surface 输入，不计入 Codex output owner 或冲突。
- Codex native dynamic projection 在 payload 内使用固定 `.agents-plugin/aw-codex-native-render.json` receipt。schema 1 的 kind 是 `aw-codex-native-render`，strategy 固定为 `shared-user`；它只保存 logical plugin/source/version、renderer、规范化 target identity、per-target config/artifact digest、聚合 config/render-input digest 和排除 receipt 自身后的 payload digest，不保存原始 config。per-target config digest 绑定该 target 的 `refreshKeys` 对应 `values`、`sources` 和 `issues`，因此同值但来源变化会形成 render drift。旧 receipt 不兼容或损坏时报告可恢复的生成内容损坏，由现有 sync 重建；不增加 receipt 版本或迁移状态。所有 `codex-native` target 的 ID 与 Skill key 在整个 shared projection 内分别全局唯一，不受 scope 是否重叠影响。target 按稳定 ID 排序。AW 用完整 user effective config 的 sensitive string 检查最终 Skill tree；只有至少 8 个 Unicode code point 的原文或 JSON 转义形态会阻断。AW 生成并验证 receipt 内容后，才从该精确路径的扫描中排除 receipt；命中时在 marketplace commit、Codex remove/add 和 activation 前停止。receipt 是可重建的 projection evidence，不是 installed ledger。
- Codex 或 Claude 操作重建共享 marketplace 时，保留非本次重新物化目标的有效 Codex native dynamic projection。保留前校验来源、插件版本、target identity 和旧输出完整性；以新 Catalog payload 为底恢复动态 Skill 和平台 manifest 的 Skill 设置后，候选 payload digest 必须与旧 receipt 一致。版本单独比较，不依赖会规范化版本的 payload digest。保留原 receipt，不运行其它插件 renderer，也不按当前配置重新签发旧输出。缺失、损坏或与新 Catalog 不兼容的 projection 不复用，由该插件单独 sync 恢复，不阻断本次其它插件；来源身份冲突、不安全路径和实际 I/O 失败仍阻断。
- 插件依赖只来自 manifest `dependencies`，只在同一 source 内解析。依赖图拒绝缺失节点、环和超出既定上限的图；执行顺序是稳定的依赖优先拓扑序。
- live ownership 和实际平台组件是输出清理和 status 的现场证据；Intent 表示需求，不是 installed ledger。User 与 Project 各自使用 Intent v3 与独立本机偏好，普通恢复和清理不改声明、偏好或插件配置。不得新增安装合同存储、第二套安装状态或持久依赖图。
- Codex project cleanup 和 uninstall 对当前仓库的 `.agents/skills` 做单层 owner marker 扫描。扫描不依赖当前 Manifest 是否仍声明该 Skill，也不进入嵌套目录或其它项目；删除仍要求 source、plugin、platform 和 scope 的 owner identity 精确匹配。
- 配置写入、生命周期和平台写入各自保留最小的本地恢复；它们不组成跨第三方系统的事务。
- Config v2 与 Definition v3 只允许顶层 string 字段声明 `sensitive: true`，且该字段不得声明 default 或 choices。object、object child、KV additionalProperties child、number 和 boolean 都不得声明 sensitive。sensitive 值只允许写入 user scope；writer 拒绝 project scope，因此 TUI 隐藏 project sensitive 编辑入口不能替代安全边界。`aw config set` 拒绝用 argv `--value-json` 或 `--preset` 提交 sensitive 值；非交互或 JSON 模式必须用 `--value-stdin`，交互 TTY 可用隐藏输入。stdin 按 EOF 读取原始 UTF-8，不 trim。string value 与 object key 共用同一 validation 合同和 RE2-WASM Unicode 实现；声明 pattern 时必须同时声明 `maxLength`，pattern 最多 512 个 Unicode code point，`maxLength` 范围是 `0..4096`。匹配保持非锚定；作者需要整串匹配时必须显式使用 `^` 和 `$`。
- `aw-development-toolkit` 不在构建时绑定 CLI registry，也不分发 capability Markdown。已安装 Author 从当前 PATH 查询 `aw plugin capabilities`，因此旧 development plugin 可以使用较新的 CLI 能力合同。
- `aw plugin remove <name> --workspace-root <root> --yes` 只删除 canonical `plugins/<name>` source root。Workspace 必须位于有有效 HEAD 的 Git worktree 中；目标必须存在于 HEAD，且当前目标 tree 的 inventory、文件 bytes 和 executable mode 必须与 HEAD 精确相同。命令拒绝目标内 tracked、staged、untracked、ignored、符号链接或额外节点，也拒绝仍由其它当前 manifest 依赖的目标。所有检查在删除前完成；缺少 `--yes` 不写入。成功不修改 Catalog version、不 commit、不 build、不 publish。删除 I/O 失败必须给出从已核验 HEAD 恢复目标的 Git 命令；命令不提供 force、backup、ledger 或补偿状态。

## Distribution and Runtime State

```text
Catalog Workspace
  .aw-workspace.json
  plugins/marketplace-source.json
  plugins/<name>/.agents-plugin/plugin.json
          ↓ aw catalog build
generated schema 7 snapshot
  .aw/catalog/
          ↓ source sync
<AW_HOME>/
  catalog-sources.json                              [强配置]
  catalog-state.json                                [强状态]
  catalog-store/<sha256(UTF-8 logicalIdentity) hex>/<snapshotDigest hex>/
    metadata.json
    snapshot/**
  plugin-config/**                                  [强配置]
  marketplaces/**
  runtimes/codex/0.151.0/<platform-arch>/**
```

- 源码层是插件作者维护的输入。`evals/**`、正式报告和 `.DS_Store` 不进入 runtime bundle；Skill `README.md` 是 production source。第三方 workspace 和本仓库 staging 都生成 schema 7 snapshot；生成目录不手工修改。
- snapshot v7 transport validation 验证结构、路径、摘要、marketplace projection 和 release metadata。producer、publication、发布后核验和 destructive uninstall 使用 complete validation。destructive uninstall 在提交 Intent 或删除现场内容前完整验证所选 Active snapshot；失败时不修改 Intent，也不删除现场内容。安装先计算 selected dependency closure，检查 entry capability，再只验证该 closure 的 plugin。
- `aw catalog build` 和 `aw plugin build` 都在同父 staging 完整构建和验证后，才替换已证明为生成物的输出；它们拒绝 workspace 外、符号链接、`.git` 和其它受保护边界。`aw catalog init` 的合法 marker 是 schema 1、`kind: "aw-catalog-workspace"` 和稳定非空 `workspaceIdentity`；marker 不进入 snapshot digest。
- source plugin 输入树不允许符号链接，也不能进入 `.git/` 或 `node_modules/`。Catalog complete validation 核对 source manifest、平台 projection 和 bundle 路径。
- 每个 Catalog 命令自行从显式 `--workspace-root` 或 cwd 向上定位最近的合法 Workspace。`catalog init` 没有祖先 Workspace 时选择 Git worktree root，再回退 cwd。不存在独立的 Catalog context 命令或 context schema。`aw catalog status` 是静态命令：读取 Workspace、metadata、inventory、依赖图、可用 Git 状态和 snapshot evidence，不 build、fetch、创建 `.aw` 或运行插件代码。
- published snapshot 的 release metadata 只含 `state` 和 `sourceHead`，不含 plugin release ledger。Catalog manifest 的 owner/interface 是 Codex 和 Claude projection 的唯一根 metadata 真值。
- `<AW_HOME>/catalog-sources.json` 缺失时使用内置 `official` source；首次来源修改才物化文件。文件损坏时，TUI 提供显式 Review：精确备份原始 bytes，再原子恢复唯一的 primary `official`；恢复不修改 `catalog-state.json` 或 Catalog store，自定义来源需之后重新添加。并发修复或删除使恢复 stale，TUI 只重新加载当前状态。稳定 CLI 使用 `catalog/latest`，预发布 CLI 使用 `catalog/beta`。`catalog-sources.json` 使用 schema 2；Path source 可带由 Workspace marker identity 绑定的 managed ownership。
- `runtimes/codex/**` 和 store snapshot 都可删除和重建。它们不决定 live ownership，也不建立新的锁、GC、历史数据库、跨系统事务或补偿状态机。
- Manifest v3、Catalog snapshot v7、config envelope v5、owner marker/token v3、双 scope Intent v3、DeploymentPreferences v1、恢复回执 `aw-recovery` schema 1、状态 `aw-recovery-status` schema 1、Config Mutation Receipt v7、Catalog generation status v2、Catalog dev status Receipt v4 和 Catalog dev deactivate Receipt v4 是相应公开合同。旧 User v2、旧 Project 偏好 kind、Status v8、Native Receipt v6、Project Recovery Receipt v1 与 Project Status v1 不再作为恢复入口的支持格式或输出；旧文件保留，不自动迁移或删除。config envelope v4 及更旧版本报告稳定 unsupported issue；schema-independent `config reset` 仍可删除。

### Portable Agent Skills Distribution

`agent-skills` 是独立 distribution，不是 `PlatformName`，也不改变 marketplace product eligibility。插件通过 `distributions.agentSkills` 显式声明该能力；原生 `skills` 不自动成为 portable source，也不支持 portable-only plugin。每个 materialized Skill root 都包含同一插件级 `aw-plugin-requirements.json` receipt；同层 receipt 优先于祖先 Manifest。

Catalog build 把 portable static Skill、明确选择 `distributions: ["agent-skills"]` 的 `skillRuntimeFiles`，以及 dynamic artifact 的 `runtimeImports` 复制到 consumer bundle。runtime import 带 bundle-local path、digest 和 provider provenance；materialize 运行时不读取其它插件 bundle，也不导入其它 renderer 的输出。

Manifest v3 的每个 `buildConfig.runtimeExports[]` 必须由 Provider 显式声明 `{ name, source, requires: { aw: { capabilities: [] } } }`；旧的 `{ name, source }` 形状无效。Core 使用统一 capability ID 规范化和稳定 digest 校验 metadata，不扫描 export bytes 推断或双检。只有实际用于 `skill-runtime-file` 或 `artifact-runtime` 的 export capability 传播到 consumer；`buildImports`、自有 `skillRuntimeFiles.source` 和 `generatedSkillRuntimeFiles` 不传播。Bundle 先解析实际 runtime import，再把 source/staged `requirements.effective` 与传播集合合并成唯一最终集合；同一集合写入 bundle manifest、Catalog entry 和所有 native/portable Skill receipt，并在最终 bundle 写入前检查当前 AW 支持。export metadata 即使 bytes 不变也属于 import/projection identity。

Portable materializer 使用调用方提供的同 source Catalog plugin set，解析依赖优先的完整 closure，读取现有 scope config，并合并 static 与 `agent-skills.skill` dynamic entries。合并顺序是 `sourceDirs → distribution skillRuntimeFiles → renderer content.files`。任何无效 Skill、名字冲突、未解析模板或 sensitive config 明文都阻止整次输出；portable 与 Codex native projection 复用同一至少 8 Unicode code point 的原文和 JSON 转义匹配规则。`aw-plugin-requirements.json` 只有在 AW 生成或内容验证后，才从该精确路径的扫描中排除。物化只使用操作级临时目录，并写 schema 1 `.aw-materialization.json`；它不创建 installed state、持久安装状态、Agent registry 或新锁。

`aw skill install` 先物化和 Review 完整候选，再通过 PATH 中兼容的 `skills >=1.5.23 <2.0.0` 执行 scope-wide 冲突预检、`skills add ... --yes` 和完成后验证。确认后的执行复用单一 `AW_HOME` mutation lock，并重新采集 Catalog、config、物化、版本和冲突证据；外部安装失败或验证缺项不做补偿回滚，receipt 提供重跑或外部 `skills remove` 恢复方式。project scope 在解析的项目根运行，user scope 使用 `--global`。

统一 User/Project 恢复的 Portable 路径固定使用 `skills@1.5.23`、精确 Agent/Skill 集、`--copy --yes`；Project 在项目根非 global 执行，User 在经过完整祖先链检查的中性 cwd 以 global 执行。AW 写前独立检查 Project lock v1 或 global lock v3 的结构、路径和可读性；坏 lock 不能按空文件处理。Darwin arm64 的真实 provider 资格已验证三 Agent 的 global copy/list 布局，但 global local add 不写 lock、list.source 为 null、坏 lock 仍可能退出 0。User 的缺失目标可安装；现有同内容目标只算 external satisfied，异内容目标因归属未知而阻断自动覆盖，恢复方式是精确手动移除后 sync。不得扫描历史 generation 推断所有权，也不增加 installed ledger 或 marker。Project 只有可靠 provider source 关联、有效旧 generation 和安装树完整匹配时，才允许按 drifted 规则更新。候选任意层级含 `metadata.json` 或 `.git`、`__pycache__`、`__pypackages__` 目录时，写前返回 `portableProviderContentUnsupported`。此限制不改变一次性 `aw skill` 命令的兼容范围。两个 scope 的 Portable uninstall/cleanup 只报告 backend-action-unsupported 与精确残留指引，不执行自动 remove 或 prune。

安装后的完整 Skills CLI inventory 只作为观测输入，不直接成为本次 receipt 结果。显式 Agent 安装只投影所选 Skill 与请求 Agent 的精确组合；Skills CLI 清单返回显示名，绑定时只做大小写和空格到连字符的常规规范化，不猜测特殊别名。同名 Skill 只在其它 Agent 上可见或 Agent 身份无法可靠绑定时保持 unknown。精确重试只投影当前 `attemptedTargets`，不扩张为 Skill 与 Agent 的笛卡尔积。自动 Agent 安装只投影所选 Skill，并只保留 inventory 中可绑定的实际 Agent；无法绑定 Agent 的所选 Skill 保持 unknown。初次验证、只读复查和重试使用同一投影，unknown 不能直接重装。

`aw skill materialize` 在同父目录 staging 中验证所选输出，再替换仅由相同 plugin ID、source identity 和 scope 的 schema 1 marker 证明属于 AW 的目标。foreign、身份不匹配、符号链接或过宽目标都 fail closed；命令不提供 force，也不创建 portable installed state。

TUI 在插件预览和详情中只根据 `distributions.agentSkills` 声明显示 Portable 能力，不提前运行 renderer 或声明精确候选数和安装 ownership。用户进入安装流后分别物化 project 和 user 的完整依赖闭包，以两者的稳定候选并集选择 Skill 和 Agent，再选择 scope；选择 scope 后按该 scope 重新物化，所选 Skill 在该 scope 不可用时阻止进入 Review。Review 只显示所选 scope 的实际候选、依赖贡献和冲突。执行复用 `aw skill install` 的锁内证据重采集，证据变化时必须回到 Review 重新确认。

TUI 批量原生安装先选择 Codex、Claude Code 或两者，再选择 scope，并只把当前状态确认缺失且合法的精确目标送入 Review；已有、受阻或未知目标不会重复安装。

### User 与 Project 统一恢复

User Intent 与 Project Intent 都用严格 schema 3：`sources` 绑定 Catalog logical identity，`roots` 只保存 source-qualified plugin ID。User 存于 `<AW_HOME>/plugin-intents.json`，Project 存于当前 canonical 项目根的 `.agent-workflows/plugin-intents.json`。两份本机 `aw-deployment-preferences` schema 1 分别存于 `<AW_HOME>/deployment-preferences.json` 与 `<AW_HOME>/project-preferences/<project-key>.json`，保存 Agent 和 dependency placement override；User override 不能指向 project。旧 User v2 和旧 Project 偏好 kind 不读取，也不自动迁移；坏声明/偏好与缺失状态分开，不能解释为空需求。

入口解析 caller cwd 与显式 `--scope user|project`，然后向后端传固定 Context。User 不解析当前仓库，不读取项目需求或配置，并在完整祖先链不含 Git/AW 项目标记及可向上发现的项目配置的中性 cwd 运行第三方 backend；不安全时选经同样核验的仓库外操作级临时目录，无法取得时阻断。HOME、Agent homes、XDG、generationRoot 和 project key 在本次准备中固定，改变物理目标的环境变化使 Review stale。只读状态可为 backend 观察使用并清理操作级临时 cwd，不建立持久 runtime、generation 或锁。

`aw intent add/remove/list/retire`、`aw targets set/list/reset`、`aw install/sync/reinstall/uninstall/cleanup/status` 都要求显式 scope；`--target` 可重复，仅支持 `codex|claude-code|cursor`，且只作用本次请求。`--all` 选择当前 scope 的全部 root；`aw sync --all --scope user --check` 是恢复的只读观察，不与 `--refresh` 同用，未满足或未知时退出 1。旧 `aw project`、恢复命令的 `-p/--platform/both` 不保留别名。作者、config 和一次性 `aw skill` 命令的 platform 参数不变。

`intent add` 只从本地健康 Active 核实 root 和来源身份，不联网或安装；`intent remove` 只编辑当前 scope 声明，不依赖 Catalog 或现场。`targets set` 只替换 agents，`targets reset` 同时清空 agents 和 override；两者不安装。显式 target 优先于保存偏好；无目标且有 root 时返回 `localTargetsRequired`，声明保留。`install` 先原子保存所选 scope root，再尽力执行目标；安装失败不回滚声明。普通 sync、reinstall、uninstall、cleanup 不改声明、偏好或配置。已移除插件通过独立的 [`intent retire`](design/removed-plugin-cleanup.md) 精确停用。

每个 root×Agent 优先适用 Native；没有适用 Native 且 Manifest 显式声明 Portable 时才选择 Portable。Native 工具、权限、配置、信任或执行失败不自动降级。不支持与未知目标留在结果，独立安全目标可继续。完整当前 scope 需求用于保护，本次选中目标用于执行；缩小选择、未观察其它 scope 或缺少当前 Project 声明均不授权删除共享输出。Codex 共享一份 user native package，Project 只控制当前项目 activation。替换共享包显示其它消费者影响，foreign/shared 内容保留。User 不扫描调用仓库来推断其它项目没有需求。

`sync --refresh` 对选中 roots 的相关来源独立刷新；失败来源即使旧 Active 健康也不执行本次恢复，健康独立来源可继续。`config set/unset/reset --scope user --apply` 保留当前 cwd 已安装 user/project 消费者的刷新合同；Review 明示消费者范围，未安装 root 不因声明而被安装。Project 配置 apply 仍仅限当前项目。恢复 scope 与配置写层分离，User 普通恢复不消费调用仓库值。

公开写回执为 `aw-recovery` schema 1，包含 scope、command、ok、intent、selection、完整 requestedTargets、targetResults、remainingTargets、blockers/errors、recoveryActions，及 `declarationChanged`、`preferencesChanged`、`configChanged`、`outputsMayHaveChanged` 四个实际变化事实。目标分别报告 `execution: not-run|no-op|applied|partial|failed`、`observation: verified|missing|unknown` 和适用的 `content: absent|satisfied|drifted|conflict|unknown`。写请求仅全部完成才 `ok=true` 并退出 0，partial、unknown、blocked、failed 退出 1，参数错误退出 2。

`aw status --scope ...` 返回 `aw-recovery-status` schema 1：scope、ok、intent、selection、inventory、extraObserved、coverage、counts、allSatisfied、errors。合法空需求或全部目标满足为 true；明确缺失/冲突/不支持为 false；只剩未知、无目标或待物化为 null。需求无法安全读取时 inventory 为 null。`ok` 只表示本次读取与观察没有错误，待恢复本身不使 status 退出失败。状态不执行 renderer、preApply 或来源刷新，也不通过状态服务递归取状态。TUI 所需位置、依赖和残留事实保留在 inventory 中，Native 基础现场一次观察后投影。

真实资格按版本、OS、scope 和 Agent 分别记录。Darwin arm64 上精确 Codex CLI `0.151.0` 的 Project Native 报告通过；Claude Code `2.1.119` 的实际 Skill 加载、Cursor binary 与 Windows 等其它 OS 的相应行为仍无证据。真实 provider 文件复制/list 不等于 Agent 已加载，本机 `skills@1.5.23` 的 Project/User 文件与 list 行为已在隔离 HOME、XDG、Agent homes、项目和中性 cwd 下实测；global local add 不写 lock、list.source 为 null、坏 lock 仍可退出 0。其它 OS、相对 home、真实 Agent 加载和远程 Skill 来源不在这组资格证据内。

## Catalog Sources

Catalog snapshot 的 logical identity 只来自 `.aw-generated.json.workspaceIdentity`。source ID、Git URL、SSH/HTTPS 文本和本地 path 不是 logical identity。

`catalog-state.json` 只为每个 source 保存 `Active` 和 `lastSync`。`Active` 绑定 logical identity、snapshot digest 和 Catalog store 目录。store 的唯一布局是 `<AW_HOME>/catalog-store/<sha256(UTF-8 logicalIdentity) hex>/<snapshotDigest hex>/{metadata.json,snapshot/**}`，metadata 保留原 logical identity；它不读取或迁移旧 URI identity 布局，也没有 current、last-good、Candidate、Previous、发布版本记录或 refresh policy。

手工 store 维护入口是 `aw catalog store status [--json]` 和 `aw catalog store prune [--dry-run] [--yes] [--json]`。status 和默认 dry-run 严格只读，不取得 mutation lock；`--dry-run` 与 `--yes` 互斥，只有 `--yes` 执行删除。实际 prune 使用现有单一 AW_HOME mutation lock，并在首次删除前完成合法 `catalog-sources.json`、合法 `catalog-state.json` 和 store 根的完整读取，永不复用锁外删除计划。首次完整 inspection 的 source config、generation state 或 store 根读取损坏时 fail closed，实际 prune 不删除内容；首次 inspection 成功后的逐项复核异常只保留该项并返回 partial，已完成的删除必须保留在 receipt。对每个初次判定为可回收的 item，prune 在实际删除前再次确认当前节点身份、类型、store key/metadata identity、Active 引用和 retention evidence；证据漂移或 rename 失败时保留 item，并报告 `staleBeforeDelete`。重新确认通过后，prune 先把该精确节点原子 rename 为同一安全 identity 父目录下、本次 item 唯一的 `.delete-<uuid>.tmp` claim，并把 claim 根 mtime 设置为本次 claim 时间；时间更新失败时安全恢复原路径并报告 `staleBeforeDelete`。只有 claim 与已确认节点和父目录身份仍匹配时，才递归删除 claim。source config 缺失使用内置 `official`。只有 source ID 仍存在于有效 source config 的 Active 才保护 store key；无 config source 的 orphan Active 按普通 inactive retention 处理。同一 key 同时被有效 source 和 orphan source 引用时仍为 Active。schema v2 的每个 inspection entry 必有 `generationReference: active | orphan | none`；有效来源的 Active 是 `active`，只由已删除来源的 Active pointer 引用是 `orphan`，两者共享时 `active` 优先，其它正式项及 temporary/foreign 项是 `none`。Active 永不删除。通过完整 store 验证的非 Active 正式 entry 只有在整棵安全树的最新 mtime 超过 30 天时可回收；严格命名的 `.staging-*` 和 `.replacement-*` 在超过 24 小时时可回收；`.quarantine-*` 还必须从自身 metadata 确定 canonical key，且对应正式 entry 存在并通过完整验证。严格命名的 `.delete-*` claim 也是可重建弱状态，只有根为普通目录、整棵树安全且最新 mtime 超过 24 小时时才可由后续 prune 重试；不满足条件的 claim 保留。任何 symlink、unsafe 或未识别 node、严格布局外内容、读取或验证失败都保留。可回收 bytes 只累计安全普通文件；inspection 不完整时为 unknown，不按 0 处理。status 的单项 inspection error 返回 `ok: false`，但保留 entries、totals 和脱敏的 `catalogStoreInspectionFailed` errors；完整 inspection 返回 `ok: true` 和空 errors。prune 遇到单项 inspection error 时仍删除其它独立且已安全确认的 reclaimable item，最终返回 partial receipt；dry-run inspection 不完整也为 partial。单项 claim 删除失败后继续其它已安全分类项，并在重新检查后让 `entries`、`retained` 和 `errors` 使用实际 claim 的相对 store key、`deleteClaim` category 和当前 retention 状态；claim 已不存在时按删除成功处理。inspection error 和 delete error 都进入顶层 errors。失败 claim 保留，可再次运行 prune。prune 不修改 `catalog-state.json`。公开 schema v2 使用统一的应用级错误分类；明确的应用 code 保留，平台 errno 不作为公开 code，store 根读取失败统一为 `catalogStoreInspectionFailed`。receipt 只含相对 store key 和脱敏原因，不含 AW_HOME 绝对路径。该命令不提供自动 GC、配置、read lease、引用计数、后台任务、迁移、额外锁或持久账本；删除的弱 snapshot 通过 source sync 重建。

TUI 的 Store 页面只读取同一 status 服务。清理 Review 从 dry-run 检查冻结精确 `authorizedItems`，执行时把该集合交给同一 prune 服务。确认以后出现的新候选不在授权集合中，不能被本次操作删除；大小无法完整证明时显示未知，不能显示为零。TUI 不增加锁、自动 GC 或持久清理计划。

公开入口是 `aw catalog source sync <id> [--check] [--yes] [--replace-damaged]` 和 `aw catalog source status [id]`。source status schema v2 为每个来源返回同一 Active capability compatibility 投影：无 Active 或 store 无法健康验证时为 `null`，支持时为 `supported`，不支持时为 `unsupported`，并只公开 `requiredCapabilities` 和 `missingCapabilities`。unsupported Active 不算 ready。纯 probe fetch 并执行完整的 snapshot transport validation，不解析未选择的 Plugin bundle；它返回绑定 source config、source identity、logical identity、ref、commit、version、channel 和 digest 的 candidate evidence，清理 staging，不写 store、Active 或 state，也不持有 AW_HOME mutation lock。`aw catalog source sync <id> --check` 使用 probe，返回脱敏的 source impact，且只在短锁内更新 `lastSync`。普通 `aw catalog source sync <id>` 锁外重新 resolve、验证、首次检查影响并发布 content-addressed store，再在短锁内重读 source config、expected Active 和必要 store evidence，重新采集影响，执行共享 activation policy，并原子切换 Active 和 `lastSync`。若同 key 的旧非 Active entry 已损坏，publication 先从已验证候选准备 replacement，再在现有 mutation lock 内重验 entry 和合法 generation state；仍无任何 Active 引用时才 quarantine、替换并验证。并发 writer 已修好时直接复用；key 已成为 Active 或 state 无效时保留旧 entry 并 fail closed。该自动恢复不要求 `--replace-damaged` 或 `--yes`，但候选本身的真实 impact 仍使用普通确认规则。CLI 的确认门禁使用锁内最新影响；TUI 把已确认影响的稳定 digest 绑定到 Review evidence，锁内影响变化时返回 typed stale。policy 模式是 `normal | explicitSourceChange | exactRepair | replaceDamaged`。Git normal 对相同 digest 保持 Active，只允许更高版本；同版本不同 digest、较低版本和 logical identity 变化返回 typed error。Path normal 允许内容变化。`explicitSourceChange` 必须由 service 核验当前 source fingerprint 或 identity 确实不同于 Active，才可接受已确认的版本冲突、回退或 logical identity 变化。所有 sync、refresh、TUI generation 和 dev activate caller 都经过此 policy。失败保留原 Active。普通 install、reinstall、uninstall、config、status、TUI 初始 load 和 Portable 命令只读取 Active store；`aw sync --refresh` 只刷新所选 scope Intent root 涉及的来源。来源引用直接读取对应 scope Intent，不先投影 Native；无目标、Portable-only 或缺 Active 也保留合法 root，额外无引用 binding 不算引用，坏声明为 unknown。没有 Active 时 CLI 提示运行 source sync，TUI 提供显式获取或修复入口。普通 `cleanup` 不读取 Active，只凭 live ownership 或离线 evidence 清理 AW-owned 输出；`cleanup --force` 可把当前 Active 中所选 plugin bundle 的 shallow evidence 作为可选补充。source、Active 或 store 缺失或损坏不能永久阻止 Intent 取消，或阻止已有充分 live evidence 的清理；两者都保留 foreign、shared 和 native payload，且不能猜测输出路径。

`aw catalog source add` 和 `update` 只原子修改 source config，不同步也不改 Active。相同 ID 的 add 只在 config 当前不存在时先清理 orphan state；清理失败则不提交 config。经过 Review 的 add/update 在同一个 source mutation lock 内重新读取 current config、重新解析 source 并重建 proposed config；current 或 proposed config digest 漂移时，在 orphan state cleanup 和 config commit 前返回 typed stale。无外部 Review evidence 的普通非 primary CLI add 保持简单锁内写入，不采集 impact。`add --primary` 还从 proposed config 推导 primary change；有受影响引用或 inventory 不完整时需要 `--yes`，并在锁内重新采集 primary impact、复核 impact digest 和确认，再一次原子提交 config。`remove` 在有引用或影响未知时要求 `--yes`，再原子提交 source config，并 best-effort 清理该 source 的 state；清理失败只产生 warning。普通 remove 继续拒绝删除 primary；内部 development caller 可同时提供一个不同且现存的 replacement primary，使删除目标 primary 和设置唯一 replacement primary 成为同一次纯 config transform 和原子替换。最后一个 source 始终不能删除。remove 和 source identity change 在同一个 source mutation lock 内重新采集影响；CLI 使用最新影响执行确认门禁，TUI evidence digest 变化时不提交 config。它不删除其它 store snapshot、插件内容或 live ownership。共享只读 source impact inventory 分类 installation、config、lifecycle intent 和 marketplace。它扫描 user state、当前 project state、平台全局注册及平台自身可枚举的历史 project 记录，不扫描未知 project。普通 inventory 默认不包含平台历史 project；impact 检查显式包含。公开 receipt 和 TUI 只投影 source/plugin/platform/scope、当前或历史 project 分类，不公开绝对路径。读取失败时 `inventoryComplete=false`，影响为 unknown，不能按零处理。current/candidate manifest 都可用时，impact 计算 added、removed、changed、newly incompatible 和 dependency changed plugin；generation 只把 removed、newly incompatible、dependency changed 及其传递 consumer 的现有引用列为 affected。remove 或 source identity change 使用该 source 的全部引用。user 和 current-project config 引用保留各自 scope，不能因 plugin ID 相同而合并。

`set-primary` 和 `add --primary` 只在有受影响引用或 inventory 不完整时要求 `--yes`；完整且无引用的切换不要求确认。source config 变换从 current 和 proposed config 推导 `primaryChange { fromSourceId, toSourceId }`。它与 add、remove、identity change 或 generation mode 正交，并使用同一 inventory 和 impact digest。primary change 只影响无 namespace 的 legacy owner/config/marketplace、canonical `aw` registration 及其 Codex/Claude consumer 和 installed evidence；namespaced lifecycle 不重绑定。与 from/to 相关的 inventory error 使影响不完整。Catalog source impact 使用 schema v3，preflight inventory 使用 schema v2，source mutation receipt 使用 schema v6；三者都公开必填的 `primaryChange`，无切换时为 `null`。

Active state 有效但 store 缺失或损坏时，Git exact repair 使用当前 transport 配置和 `Active.resolvedCommit` 获取旧 snapshot，并验证 logical identity、snapshot digest、manifest digest 和 resolved commit 全部匹配；它不持久修改 source config。TUI repair 成功后停止，CLI source sync 修复后继续 normal sync 当前候选。旧 commit 不可取得，或 Path 当前内容不是旧 key 时返回 typed replace-required。`replaceDamaged` 绑定 expected Active、candidate 和 source config digest，在短锁内确认旧 entry 仍损坏，并只跳过无法完成的版本比较；除非同时核验 source config 确实变化，否则仍拒绝 logical identity 变化。精确 repair 对同 key 的损坏条目只 quarantine 和替换该条目，失败则恢复原目标，cleanup 失败只产生 warning。没有自动 GC、Candidate 持久状态、项目注册表、新锁层级或新恢复状态机。

Git provider 保持非交互，并保留 timeout、protocol/ref/temp validation、credential URL 拒绝和诊断脱敏。`AW_CATALOG_REMOTE_TIMEOUT_MS` 只接受 `0` 或 `100..300000`；默认 full resolve deadline 是 180000 ms，ref probe deadline 是该值与 30000 ms 的较小值，`0` 对两者都表示无 deadline。单次 ref probe 和单次 full resolve 各自共享本次操作的 deadline；probe 后继续 full resolve 时重新建立 full deadline。消费端定向清理危险的 repository、worktree、index 和 object 环境变量；它保留 credential helper、SSH agent、自定义 SSH、proxy 和 `insteadOf`。AW 不保存 Catalog credential。

`aw catalog dev activate` build、complete validate、注册 managed Path source 并 sync；影响现有引用或影响未知时需要 `--yes`。`aw catalog dev status` 只读取 snapshot、source/path 和 Active digest；Receipt v4 的 `active.compatibility` 直接使用 generation status v2 的同一投影。无 Active 或无法判定时为 `null`；unsupported Active 使 dev status 不 ready，但结构损坏仍单独报告 repair-required 错误。`deactivate` 不删除 `.aw/catalog`；它先对仍为原 primary 状态的精确 managed Path source 执行 remove impact preflight，并核对 Workspace ownership。存在引用或 inventory 不完整时要求 `--yes`；`--source-id` recovery 无条件要求 `--yes`。执行绑定 preflight 的 config 和 impact digest；进入现有 AW_HOME mutation lock 后重新核对 source、managed owner、replacement 和 impact，漂移时在写入前返回 typed stale。primary development source 的删除和 replacement primary 切换只通过一次 `catalog-sources.json` 原子替换提交；generation state cleanup 在提交后 best-effort 执行。Catalog dev deactivate Receipt v4 必有脱敏的 inventory v2 `impact`；完成 preflight 后的成功、确认失败或执行失败返回 inventory，source absent 或 Workspace/config 无法完成 preflight 时为 `null`，且不得公开路径。失败不建立补偿事务，用户可修复 source、再 sync 或重跑 activate/deactivate。

primary development deactivate 把 remove 和 primary change 放入同一 inventory、impact digest、mutation lock 和最终 config CAS。Catalog dev deactivate Receipt v4 使用 inventory v2 的脱敏 `impact`。

## Write Pipeline

需要 Catalog 的公开写命令和 `config ... --apply` 使用同一条 rebuild 流程：

```text
固定 Review evidence
  → TUI 明确确认或直接 CLI --yes
  → 固定 Active snapshot、目标、依赖顺序与期望组件
  → 对 target、schema、config、artifact 和 ownership 做只读 preflight
  → 运行 preApply
  → 仅为实际 Codex native 操作解析执行 manager
  → 必要时清理 AW-owned 旧组件
  → 写入原生和 AW-managed 组件
  → 完成后检查
  → 输出统一 `aw-recovery` schema 1 回执
```

这些命令在 `AW_HOME` mutation lock 内只采集一次当前 target 和当前 project 的现场 inventory。Active snapshot、marketplace 选择和 dependency plan 复用该内存 snapshot；执行不为计划再做第二次全量 inventory。计划完成后，writer 只对计划中的目标重新构建并检查 live ownership、native registration、有效 config 和固定 snapshot evidence。普通 inventory 不扫描历史项目、不建立全局 refcount，也不执行自动 dependency GC。

已确认从健康 Active Catalog 移除的插件通过独立 [`aw intent retire`](design/removed-plugin-cleanup.md) 停用。普通 `cleanup` 不自动分类或删除强配置；停用只修改显式选中的 scope，保存配置删除默认关闭，Portable 与共享残留必须可见。

`cleanup` 和 `cleanup --force` 使用专用 cleanup 流程，不进入恢复写入 pipeline。两种 scope 都只清理所选 Agent 中可证明归属的现场，不改 Intent、部署偏好或插件配置。无 Active 时仍可凭 live 或已绑定离线证据恢复，未知路径、foreign 与 shared 内容保持不动。`--force` 仅处理现有合同允许的专属损坏输出。两者都不运行 renderer 或 preApply。

性能观察复用现有 debug event。`review.prepare.*` 记录 Review 准备阶段耗时；`performance:stage` 只记录 `catalog.load`、`catalog.validation`、`inventory`、`dependency.plan` 和 `target.build` 的阶段名与耗时，命令阶段另记录结果，Catalog load 另记录聚合 source/Active/validation 计数，不记录 digest、路径或错误文本。`native:start|success|error` 只记录白名单 `agent`、稳定 operation、`exitCode`、固定 reason 和 `durationMs`，不记录 args、cwd、stdout、stderr 或未知 error/cause 文本；`rebuild:action` 分别记录 `inspect`、`native.write`、`artifacts.write` 和 `postcheck.inspect` 等真实写阶段耗时。没有 native 或 artifact 动作时不伪造对应阶段。测试用 provider 调用次数、检查范围和阶段事件验证 write 性能边界。Warm install 的总时长只对受控 fake native runner 使用宽松门槛；本地 Catalog 阶段 p95 目标为 500ms，不能据此承诺第三方 CLI 时长。

首版不增加 authoritative installed-state DB、GC/read lease、新锁层级、全局事务或补偿状态机。Active snapshot 已是不可变内容寻址目录，操作直接引用它；当前可观察的重复 inventory 可以用操作内 snapshot 消除。这些事实不足以证明新增持久状态和协调协议的成本合理。

TUI 的所有写入口在进入 Review 前先进入 `ReviewPreparing`。普通 `ReviewPreparing` 只执行当前 intent 的验证和证据采集，不执行写入。用户显式选择“刷新并同步”是唯一例外：它在建立插件 Review 前刷新相关来源，并可切换可重建的 Active 弱状态；Esc 只取消后续 Review 和插件写入，不回滚已完成的 Active 刷新。一次成功的 TUI load 固定可用来源的 Active snapshot 子集，并保留其它来源的失败证据；子集 digest 只包含成功来源。同一 session 的浏览、设置、status、依赖 preview 和 Review 都读取该固定子集。load 只读取 source config、catalog state 和 Active store；它不 fetch 或同步，并在本地读取完成后立即进入 ready。页面只显示实际已开始的 status、Catalog、inventory、dependency plan、config、Portable 或 evidence 边界，并在 debug 日志记录阶段耗时。可用 Esc 协作式取消。取消会使迟到的只读结果失效。底层不支持 signal 的读取可以结束，但不能再创建 Review。准备成功时，Review 原位替换准备页，因此 Back 返回原页面并保留其选择或草稿。

`ReviewPreparing` 的公共 snapshot 只包含 operation id、kind、subject、当前安全 stage、状态及安全错误字段。原始 `OperationIntent`、config updates、preset、source path 或 URL 只保存在 controller 私有、按 operation id 索引的内存中，并在成功或取消时清理。Config ViewModel 和 controller 公共 snapshot 对 sensitive 顶层字段只投影状态，不包含 value、effective value、draft、default 或 choices 原文。

TUI 保留首页，插件库合并 Catalog、安装目标和仅保留设置的对象，按全部、已安装、未安装、可更新、需要处理筛选。旧预览入口归一到同一插件详情；来源、搜索和批量选择只影响返回上下文。插件行与下方业务动作共用纵向焦点，按钮与快捷键复用动作。详情直接提供常用管理，依赖页统一展示上下游并保留关系证据差异。内容页只展示指定插件的目录版本组件清单，按需读取、会话内复用，状态重读时失效；启动不扫描全部内容，也不把目录清单视为旧安装内容。

首页仅有插件、插件清单、插件来源三个入口，状态附在各入口，不弹出项目恢复提醒。插件清单先显式选择个人或当前项目，再读取所选范围的需求与现场；进入页面本身不授权写入。已确认缺失或不完整的目标可进入统一恢复 Prepare/Review；来源阻断、无法确认目标与可重试失败分别显示。局部重查保留当前页的查询、焦点及旧快照，失败时标记旧快照未确认；`H` 重新加载完整会话。partial 结果保留精确失败目标与原请求。

统一恢复的 Review 固定当前 scope 和精确的 root×Agent 目标，并绑定完整声明、部署偏好、来源及后端证据。执行在现有 `AW_HOME` mutation lock 内、首次副作用前重读这些证据；声明、偏好或目标路径变化使 Review stale。普通 sync 不提交声明或偏好。失败重试只选择原请求中可安全重试的精确目标，重新准备并建立 Review，不将不规则目标集合展开为笛卡尔积。清单检查和导航不启用来源、不更新插件，也不执行平台写入。

插件安装主链固定为：先选择目标平台，再选择每个目标的合法 scope，只在同一可编辑依赖的跨平台使用范围存在实际分歧时要求决定 dependency placement，然后进入 `ReviewPreparing` 和 Review。平台页按 Codex、Claude Code、通用 Agent Skills 和“确定所选平台”的顺序显示；Codex 与 Claude Code 可以组合，通用 Agent Skills 进入独立流程，不能与原生目标组合。原生平台的 Enter 与 Space 都切换勾选；可见继续动作与 `c` 复用同一个确定动作。所选原生平台没有共同 scope 时，用户必须分别选择每个平台的合法 `(platform, scope)` 目标；不能恢复成一平台一个 scope 的限制。根插件 scope 不在依赖页重复编辑。依赖草稿按 `(pluginId, platform)` 保存 project 或 user 选择，并显示默认 project、健康 user 复用和 fixed-point 提升原因；user 选择必须说明它会影响其它项目或用户环境。返回 Review 前的页面时保留适用草稿；根 scope 或平台集合变化后确定性重算，并删除不再适用的 key。键盘合同继续使用当前焦点、Enter、Esc 和显式确认；原生平台与通用 Skills 列表均使用 Enter/Space 切换选择，`c` 才继续。通用 Skills 的行内摘要替代单 Skill 详情路由。首次 Portable 准备先显示只读等待页；Esc 取消请求并恢复原生平台草稿，迟到结果不能推进选择页或建立 Review。

TUI 初始 load 不访问网络，也不等待 freshness 检查。进入 ready 后，每个 session 只为 `autoCheck` 开启的 source 自动检查一次：primary 先开始，其它 source 最多并发两个。关闭 `autoCheck` 的来源只在用户显式检查时 probe。健康 Git Active 先只解析远端 ref；ref 未变化时不 fetch，固定 commit 不联网；ref 变化时才 fetch 并完整验证。检查结果只进入 session-private overlay，不修改统一恢复状态、Active、固定的 session Catalog 子集、插件列表或 target revision。远端失败只显示 `checkFailed`，健康 Active 仍可浏览。reload 不重复全量检查；退出时取消所有 probe，session、token 和 source fingerprint 拒绝迟到结果。

用户从 `configUnavailable` 明确进入嵌套 source recovery 时，config 草稿保持只读，只允许该恢复流程建立新的来源 Review；其它 Active 切换和 reload 仍受草稿门禁阻止。

会话导航待办只保存 `h/H` 意图，不授权丢弃草稿。写入成功后，SessionHost 等待本次操作消费的外部草稿清理，再检查剩余草稿；外部草稿确认绑定内存中的 owner、flow 和 revision。失败或部分成功取消待办并保留结果。历史、诊断和报告是会话级只读页面，不依赖业务状态加载成功，也不因关闭页面而丢弃父流程草稿。返回首页统一复位路由和界面焦点。

批量失败重试以根插件、实际平台和 scope 为选择目标，重新进入现有 planner、Review 与执行证据检查。不能从插件 ID 恢复成原来的全部平台；无法定位目标时不提供精确重试。统一诊断按操作类型适配返回结果及安全异常，保留来源配置提交、启用、主来源切换与 Portable 验证事实；原始异常和返回结果不进入公开历史或报告。

TUI generation 使用 generation status v2 的 Active compatibility 投影。健康但 unsupported 的 Active 显示为 `incompatible`，技术详情显示 required 和 missing capability ID；不显示 available capability 全集，也不把该状态显示为损坏或提供重新下载修复动作。

候选 snapshot digest 相同时状态为 current；commit 变化只作为 provenance。Git 候选版本更高时提示更新；相同版本但 digest 不同为 version conflict，较低版本为 rollback，logical identity 变化或能力不兼容也阻止普通更新。能力诊断只从 typed compatibility error 投影 required 和 missing capability IDs；主视图只显示缺失数量，技术详情显示 missing IDs，不显示当前 AW 的 available 集合。候选不兼容时旧 Active 保持可用，普通 update 不出现，轻量检查和完整验证都保留相同结构诊断。版本比较复用 strict SemVer。Path digest 变化显示本地内容变化。TUI 只提示候选，绝不自动切换 Active。用户可从来源详情显式获取并启用、重新下载并精确修复、验证并切换，或使用当前候选替换无法修复的损坏 Active。更新成功只表示 Active Catalog 已切换；已安装插件不会自动升级，TUI 重新计算可用的插件升级。背景检查取得的完整 candidate 和 Manifest 只可在当前 TUI session 内复用于普通 activate/update Review preparation；复用绑定当前 session/token、source config fingerprint、明确为 null 或具体 key 的 Active store key，并要求完整 evidence。source mutation、repair、replaceDamaged、state recovery 或任一 binding 变化都回退到重新 probe。该 overlay 不持久 Candidate，不写 store 或临时 snapshot，也不改变 Status 或 Active。Execute 始终重新解析 candidate 并逐字段比较 Review evidence；变化时返回 `catalogGenerationReviewStale`。add/update 的主路径先按 Review config digest 保存配置，再启用确认的候选；配置成功但启用失败时保留新配置，并在 TUI 提供重试。generation state 无效时，TUI 可经独立 Review 原子重建只含目标 Active 的有效 state；它不修改 source config 或删除 store，且不信任无效 state 中的其它指针。Active store 损坏时，精确 repair 始终以强 Active state 为目标，并保持 Active 的 source fingerprint 和 provenance 不变。只有 metadata 和 snapshot 完整匹配时，弱 store entry 才能提供可信旧版本；任一不完整时不得声明 version conflict 或 rollback。旧版本不可用时，普通恢复或 update 在写 state 前阻止，并保留当前 Active；用户必须进入独立 replace Review。未保存的 config/source/Portable 草稿、ReviewPreparing、active Review 或写入进度阻止开始 Active 切换或 reload；freshness probe 可以完成并保留 session 结果。

Review 仍是用户确认边界。插件 Review 按 Project intent、User intent、Shared Codex native、User activation、Project activation 和 AW extensions 分层。直接 CLI `--yes` 与 TUI 使用同一个 `requiresConfirmation` 和 `sharedImpact` descriptor；shared replace 或 reinstall 必须说明它可能影响其它项目。Review evidence 包含 Active snapshot digest。用户确认后才进入 `Progress` 并开始插件或配置写执行；`Progress` 不接受 Esc 取消，只能按现有约定请求在操作完成后退出。`ReviewPreparing` 的可取消准备状态和 `Progress` 的已接受写状态不得共用 busy 或取消语义；除上文明确的“刷新并同步”弱状态刷新外，准备阶段保持只读。Execute 在同一个 `AW_HOME` mutation lock 内重新读取 Active snapshot，验证 metadata 仍存在并比较 Review digest。Catalog generation Execute 也在该锁内逐字段匹配 Review 时 Active 的存在性、logical identity、snapshot digest、source fingerprint/identity、commit 和 manifest digest；无 Active Review 不允许覆盖并发新建的 Active。repair 在该匹配后才替换目标 entry，并复用同一锁 token 提交 state。provider resolve 和普通 content-addressed store publication 保持锁外；stale 操作最多留下可删除 orphan，不覆盖 Active。source config 或 Active digest 改变时，Execute 必须在 plugin、config 或 native 写入前返回 typed `operationReviewStale` 或新 Review。该检查不访问远端 branch。

dependency placement 只在安装流程中选择。已安装插件不提供调整入口。读取旧的 user→project override 时，Status 保留诊断并把迁移残留报告为 `needsSync`，但不自动清理、同步、重新安装或删除 override。恢复指引要求先卸载依赖者，再清理依赖的旧 scope，最后使用 `--dependency-scope` 按新 scope 重新安装依赖者；`needsSync` 仍提供根插件、平台和 scope 精确匹配的普通卸载入口，并继续执行依赖保护和 Review。pure-native Codex 的 user/project activation overlap 合法；含 AW-only extension 的 overlap 返回 `blocked` 和两条恢复路径。其它 `needsSync` 恢复操作继续进入现有 Review、Progress 和 Result 链。安装确认准备被依赖阻断时，TUI 保留具体依赖、平台、范围和安全诊断，显示原因，并提供进入该依赖平台维护页的入口；不能只显示通用的准备失败。

Codex manager 解析也在同一个 `AW_HOME` mutation lock 内完成，并在执行时重新探测。仅修改已有 shared native 的 project activation 不使用 native manager；project intent 若需要写入、替换或移除 shared native package，仍解析同一个 user-level manager。正常写入优先使用兼容的 system CLI；system CLI 缺失时复用有效的 AW-managed cache，只有 cache 缺失或可安全重建时才需要本次授权。直接 TTY 可在首次获取前确认；JSON 和非交互命令必须传 `--allow-managed-codex-install`。已安装但过旧、版本不可解析或探测失败的 system CLI 会阻止操作，不能用 managed runtime 绕过。manager 选择不进入公开恢复回执或状态，也不成为 `operationReviewStale` 证据。

TUI preview 只读，并且只在最终计划含 Codex native 操作时探测 manager。若需要获取或重建 runtime，Review 明确显示 `@openai/codex`、固定版本和 AW-managed cache；执行该 Review 即授权本次获取，不再显示第二次确认。

TUI 的依赖关系页只解释当前数据，不改变 placement。正向声明边来自当前 source 的 manifest。Controller 从统一恢复状态 inventory 的 dependency component 读取 dependency ID、platform、scope、project 和 state；只有声明边有效、dependency state 为 `ready`，且 consumer 有当前现场 scope evidence（复用 `hasActualScopeEvidence`，不接受纯 Intent）时，才写入内部 `availablePlacementReferences`。它不重新计算 scope 选择。反向“哪些插件依赖它”同时保留已知声明边和这些可用关系，边分别显示为未验证与已验证；无位置的声明仍可阅读，不能按 `depth` 推断一条边。默认页面把它说明为本次状态检查：只检查当前项目和个人位置，其他项目未检查；它不表示插件已被调用，也不表示历史安装关系已经确认。共享节点明确标记为同一节点；graph blocker 或环显示为无效，不能渲染为正常树。该页不恢复已安装依赖迁移，不提供绕过依赖保护的删除入口，也不改变 `getBlockingDependents`、移除或 cleanup 门禁。

依赖执行顺序只在本次命令内存在。内部后端结果保留 relation、requiredBy、安全后端状态和恢复建议；统一 `aw-recovery` 回执保留请求的所有目标、阻断与未完成项，不公开持久计划、锁或来源内部证据。精确匹配的现有 shared native 可复用，不建立 ownership ledger。

`OperationPlan` 只用于 Review、stale fingerprint 比较和 Receipt。真实执行继续由 rebuild executor 使用已准备的 target 和 live evidence 完成；不存在通用 `OperationAction` executor。

- `install`：按当前 Catalog 安装请求插件和缺失依赖；已存在且完整的依赖使用 `keep`，不重复安装。
- `reinstall`：先只清理 AW-owned 组件，再按当前 Catalog 完整重建。expected exclusive path 的 owner marker/header 缺失或损坏时，它不自动 force，也不覆盖该路径；返回 `exclusiveOwnerEvidenceInvalid`，恢复顺序固定为先运行同 target 的 `cleanup --force`，再运行 reinstall。
- `uninstall`：删除可由 live owner marker/token 证明属于 AW 的组件。它不重放历史脚本。
- `cleanup`：不运行 preApply，也不读取依赖图、安装门槛或 Active。两种 scope 均只清理可由 live owner marker/token 或已绑定 offline evidence 证明属于 AW 的所选输出；保留 Intent、偏好、plugin config、foreign 内容和 shared/native payload。
- `cleanup --force`：用于恢复专属且已损坏的 AW-owned 输出，仍保留两份 Intent、偏好和配置。只接受 shallow plan 中精确的 `skill-directory` 与 exclusive `owned-text-file`；候选必须位于合法 Agent/scope root，路径链和目标不能是 symlink，节点类型、basename 和 artifactKey 必须一致，不能是 shared config、native plugin store 或 marketplace root。合法 foreign owner 在 normal 和 force 中都保留。

selected source/plugin 的 namespaced config inventory 损坏不阻止该目标的 cleanup 或 uninstall；命令保留坏 config，并提示之后使用 `config reset`。ownership、foreign/shared/global 或安全输出 inventory 错误仍 fail closed；强配置损坏由独立 `intent remove` 或 `intent retire` 报告，不被普通 cleanup 覆盖。

TUI 的普通 cleanup 走离线清理，不因 Active 缺少 entry 扩大到停用；`catalogSourceUnavailable`、`bundleUnavailable` 和 `codexIntentSourceUnavailable` 只说明当前恢复路由的不可用原因。Review 绑定目标位置与 live ownership evidence；Execute 在同一 `AW_HOME` mutation lock 内重新核验，漂移则在输出删除前返回 stale。实际删除竞态保留输出并返回 partial。受限高级 force 只接受当前 preview 的唯一 exact shallow `forceExclusive` 候选；完成后 reinstall 是新的操作和 Review。

每条失败链必须可用 `cleanup`、`cleanup --force`、`reinstall`、来源刷新或新版本发布恢复。无法证明 ownership 时宁可保留内容，也不能删除用户或共享内容。

### preApply

Manifest v3 只允许 `scripts.preApply: { path: string, timeoutMs?: number }`。旧 `postApply` 是未知字段，不能迁移或作为兼容别名。该入口只用于安装前环境校验或安装外部系统工具。AW 插件依赖仍由 manifest `dependencies` 声明，Node 依赖仍在 build-time bundle 中闭包。

AW 固定使用 bundle 内的 Node entry，以 plugin root 为 cwd，继承 `PATH`，并为脚本创建临时隔离 `HOME`。stdin 是 `PreApplyContextV1`：`{ schemaVersion: 1, plugin: { pluginId, name, version, rootDir }, target: { platform, scope, projectRoot? }, config: { values } }`。context 不包含 component outcome、平台 home、store path、artifact 内容或私有运行状态。stdout 和 stderr 按 effective sensitive config 脱敏。AW 等待 stdin 写入完成或受控失败、脚本退出和进程树清理后才完成 target；只有脚本明确以 code 0 且无 signal 退出并确认清理成功时，脚本未读取 stdin 造成的 `EPIPE` 才不改变成功结果。其它 stdin 错误使用稳定脱敏的 `preApplyInputFailed` 诊断。非零退出、spawn 失败或超时会终止进程树。

每个 target 每次命令最多运行一次，脚本必须幂等。`install`、`sync`、`reinstall` 和 `config ... --apply` 运行它；`cleanup`、`uninstall`、`status` 和 Review preparation 不运行。cleanup 为仍 desired 的 Codex target 执行内部 materialization reconcile 时也跳过 preApply。默认 timeout 是 300 秒，Manifest 和 CLI override 的有效范围都是 1 秒至 30 分钟。`--script-timeout` 只由会运行 preApply 的命令公开和消费。TUI 高级选项复用相同校验范围；Review 显示票据绑定的实际值和会运行脚本的 namespaced plugin、platform、scope，preview 和确认后的执行只使用该冻结值。只保存配置、`cleanup` 和 `uninstall` 不传递该选项。

preApply 只能在 TUI Review 明确确认或直接 CLI `--yes` 后开始，JSON、noninteractive 或内部非 direct-CLI 调用不能绕过该门禁。普通字段或整层删除确认不等于脚本授权。target 的 schema、config、artifact 和 ownership 只读 preflight 必须先成功。preApply 成功后才可为该 target 执行 stale cleanup、native/artifact write、postcheck 和 receipt。`reinstall` 也先运行 preApply，再 cleanup，并复用同一 target preflight。

preApply 失败时，该 target 不执行任何 AW-owned cleanup 或 write，receipt 记录稳定且脱敏的失败，并提供 `sync` 或 `reinstall` 恢复。其它 target 继续执行。AW 不回滚脚本已成功完成的外部动作，也不增加外部副作用 ownership、journal、补偿或 cleanup 能力。

preApply 不允许遗留后台后代；AW 在脚本正常退出、超时或中断后先终止并确认本次脚本的进程树，再完成该 target。进程树清理无法确认时，preApply 失败并阻止该 target 的 AW-owned cleanup 或 write。身份无法证明属于本次脚本的 foreign 进程不会被终止。

CLI 在 preApply 执行期间收到 `SIGINT` 或 `SIGTERM` 时，先清理脚本进程树和本次临时目录，再分别以标准信号退出码 `130` 或 `143` 退出，不继续其它 target。清理无法确认时以 `1` 退出。

## Live Status and Config

`aw status --scope user|project` 输出 `aw-recovery-status` schema 1，并在同一服务中组合该 scope 的 Intent、偏好、Active Catalog、live native/config evidence、Portable 观察和 AW extension projection。它严格只读：不创建持久 AW_HOME/runtime/generation/lock 或目标目录，不运行 renderer、preApply，不下载 manager，不调用 native add/remove，不修改 trust/config，也不刷新 Catalog 来源。第三方只读观察需要 cwd 时，可创建并清理经完整祖先链核验的操作级临时目录，HOME 和目标 homes 保持真实用户环境。需求不可安全读取时 inventory 为 null。已有 Native 位置与依赖事实仍在统一 inventory 中保留；基础 Native 现场只观察一次，不能通过 status 递归取状态。

Native 状态检查仍使用 official scoped list 核对 static registration、plugin ID 和 active version；dynamic `codex-native` 只读检查 AW-owned canonical marketplace projection 与 receipt，绝不运行 renderer。PATH 没有 Codex consumer 时，activation support 只标为 `assumed`，不能说真实 Agent 已加载。Core `policy.products` 缺失或为空表示同时支持 Codex 和 Claude。共享 native 证据只采集一次，按当前 scope 的 placement 投影；另一 scope 未观察不当作空需求。下述 target state 与 component 是内部现场事实和统一 inventory 的输入，不是第二套公开 统一状态 schema。

每个范围的 intent component 说明 enabled、scope 和 `root | dependency | managed | none` relation。target 和 placement 的 `state` 使用以下公开状态：

| 状态 | 含义 | 建议 |
|---|---|---|
| `ready` | 所需能力和依赖可用；允许不改变有效使用结果的 Codex 项目重复开启 | 无 |
| `needsSync` | desired 已保存，但组件或依赖缺失、不完整、可替换或待同步 | `aw sync` 或 `aw reinstall` |
| `orphaned` | 没有该范围的 desired，但实际激活或 AW-owned 扩展仍存在；用户级已启用时，无害的 Codex 原生项目重复开启除外 | `aw cleanup` |
| `blocked` | 来源不可用，或 foreign、unreadable、collision 或其它安全问题阻止收敛 | 按 `recoveryActions` 刷新来源、清理 AW-owned 输出或手动修复 |
| `absent` | 没有 desired intent、实际激活或需清理的范围输出；允许保留有效共享内容 | 无 |

`reasons` 说明状态的稳定 code、severity 和可公开的 collision evidence；`components` 提供每个组件的浅检查事实；`recoveryActions` 提供下一步恢复操作。共享 native 使用统一五态：`missing`、`usable`、`replaceable`（`outdated | damaged | renderDrift`）、`blocked`（`foreign | unreadable`）或 `unobserved`。只有成功的 `codex plugin list --marketplace <AW marketplace> --json` 决定 native installed、absent 和 active version；公开 Codex config 决定 activation 和 marketplace ownership；AW-owned canonical marketplace source projection 决定可重建的 `renderDrift`。Codex private cache 和 installed manifest 不进入普通 lifecycle、repair、residue 或 cleanup 成败判断，AW 也不直接删除它们。每个 status、Review preview 和锁内执行 session 按 marketplace 复用 operation-local exact/neutral list snapshot。每个 operation/marketplace 的相关 target 和 activation 全部是 user 时，每代只读取 neutral；存在 project 时，每代最多读取一次 exact 和一次 neutral。一次 session 只创建并清理一个独立 neutral 临时 cwd。preview 与锁内执行不共享 snapshot。锁内执行复用一代 pre snapshot；全部 native registration 与 activation mutation 完成后，每个发生真实 mutation 的 marketplace 只捕获一代 post snapshot，并让该 marketplace 的全部 target postcheck 复用它。no-op 不捕获 post snapshot。PATH 中没有 compatible consumer，或 consumer incompatible/unresolved 时，shared native 是 `unobserved`；desired target 使用 `needsSync` 和 `codexSharedNativeUnobserved` warning，compatibility blocker 仍独立保留。official list 调用失败是 `blocked/unreadable`。`foreign` 表示 exclusive artifact slot 已被当前插件不拥有的内容占用；它不能作为已安装证据。公开 collision evidence 只包含 `reason`（`ownerMismatch | unownedContent | typeMismatch`）、`artifactKind`、`artifactKey`、`expectedOwner` 和可选 `actualOwner`，不得包含组件绝对路径、credential、未知 stderr 或临时内部信息。

Codex 原生插件的有效开关按项目配置优先于用户配置计算，显式 project `false` 必须覆盖 user `true`。用户级 desired 且 user 已启用时，pure-native 的重复 project `true` 不产生 activation drift 或清理问题。User 恢复只处理用户激活，不读取或删除调用项目的关闭覆盖；需要启用当前项目时，显式保存 Project 声明并执行 `sync --scope project`。支持 native overlap 的依赖不能因两个范围均存在而报告 `dependencyScopeConflict`。AW-only extension 的位置冲突和所有范围均无 desired 的真实残留继续遵守原恢复边界。

TUI 必须把 `orphaned` placement 纳入“需要处理”问题列表，并提供指向该范围的清理入口；同插件另一范围为 `ready` 时，不能隐藏残留问题或把清理指向正常范围。

`state: present | absent | partial | error` 只可作为 `components` 中的 ownership-health adapter，不替代 target 顶层 `state`。每个 统一状态 reason 有必填 `severity: warning | blocking`。`needsSync` warning 本身不使命令失败；source、inventory 和安全 blocker 继续使 `hasErrors=true`。当前插件的普通 cleanup 和 uninstall 不删除 foreign component。

Codex 顶层 `components` 记录 `sharedNative` 和 `systemConsumer`；共享 native 证据包含 identity、state、reason 和 version。各 placement 的 `components` 记录自己的使用意图、激活、扩展与依赖 readiness。同一 shared native identity 在顶层只出现一次，不伪装成 user 与 project 两个 owner。pure-native user/project overlap 可以为 `ready`；mixed 或 AW-only extension overlap 为 `blocked`，由用户明确选择保留范围，分别移除另一范围的声明和输出，再同步保留范围。普通卸载不移除声明。foreign 恢复要求用户先移除或重命名冲突；普通 `cleanup` 明确保留 foreign 内容。

当前 desired-state 边界的稳定错误或 warning code 为 `pluginIntentStateInvalid`、`codexProjectPluginVersionTooLow`、`codexProjectPluginUnsupported`、`codexProjectConfigNotEffective`、`codexSharedNativeForeign`、`codexSharedNativeCorrupt`、`codexSharedNativeUpdateRequired`、`codexSharedNativeRenderDrift`、`codexSharedNativeUnobserved`、`codexExtensionScopeConflict`、`codexActivationDrift`、`codexExtensionDrift`、`codexIntentSourceUnavailable` 和 `operationReviewStale`。正常的 `needsSync` 或 drift warning 不要求 `status` 返回命令失败。

Codex 的有效共享 native、禁用 activation 配置和从 user 继承的可用性不构成 project 的显式使用或待清理输出。只有有效共享内容保留时显示正常未启用，不检查无使用范围的依赖，也不提供清理建议。依赖检查覆盖 desired scope、实际启用 scope 和存在适用扩展残留的 scope；没有 AW Intent 的手动启用仍检查实际范围，但不自动新增 Intent。user 只能使用 user 依赖；project 沿用显式 override 及健康 user 复用规则。配置不可读、native observation 失败和共享内容损坏的诊断不得由未启用规则吞掉。没有 desired scope 时，共享内容损坏提供手动说明：用户明确选择使用范围后，才能通过现有 install 重建；不提供无法生效的 sync/reinstall，也不自动新增 Intent。实际激活或扩展仍可按范围 cleanup，清理不承诺修复共享内容。

统一状态 对已检查的直接依赖继续在所属范围的 `components` 中公开 `ready | absent | blockedByCollision | incomplete | error` readiness。依赖问题携带 `dependencyPluginId`，并在可识别时携带稳定的 `rootIssueId` 和 `rootIssueCode`。`status --json` 只输出 `aw-recovery-status` schema 1，不提供旧 schema 参数或双轨输出。JSON、人类 CLI 和 TUI 使用同一 scope 的恢复状态事实；人类输出可按 verbose 控制组件细节。

TUI placement 在 ownership health 之外投影 collision blocker，但不能把 foreign-only collision 计为 installed。foreign-only placement 使用 `blocked`；`present` 或 `partial` placement 保留 installed ownership health，并同时保留 collision blocker。每个平台 placement 独立判断：混合平台仍可进入添加并只列可用 target；所有平台都阻断时，Preview 和平台菜单先提供“查看输出冲突”，且不显示添加、升级或重新安装。installed collision 仍提供安全移除入口，删除只处理 AW-owned 内容并保留 foreign 内容。

TUI 插件清单按显式 scope 组合当前 Catalog summary、统一恢复 status inventory、可识别的 config store 和 live ownership。已移除插件的声明、禁用 activation、Native、AW 输出、Portable 与 config-only 残留仍可见，进入独立“停用已移除插件”任务；普通 cleanup 只清理所选现场且不改强配置。新增安装只接受健康 Catalog summary 中符合资格的插件。foreign 与 shared 内容保留；成功后重新读取 Intent、Catalog、live ownership 与设置事实决定是否继续显示。

TUI 按当前 scope 将受阻、未确认、待同步、就绪依次作为互斥根分类；明确 false 与 unknown 同时存在时，底层 `allSatisfied` 仍为 false。声明根和额外现场分别显示，extraObserved 不把另一 scope 的已安装内容当作本 scope 的额外根。来源缺失、依赖、配置、collision 和残留保留具体诊断及下一步动作；诊断不写入新的持久数据库。TUI 的可见入口、状态与操作覆盖见 [CLI/TUI 能力覆盖](tui-capability-coverage.md)。

ownership health 只表示当前 live 组件是否完整。统一状态 的 shared native version 比较投影为 `replaceable: outdated`，target 状态为 `needsSync`，并使用 `codexSharedNativeUpdateRequired` 原因。控制台仍可保留私有 revision sidecar，用它区分 `current`、`upgradeAvailable` 和 `unknown`；该 sidecar 不进入公开 统一状态 JSON。

TUI 的 `PluginUpdateProjection` 把 runtime 的 target revision 与当前 session 的已验证 Catalog candidate 合并为插件级更新事实，并与 health 分开显示。它只在 installed version、目标 Active 或 candidate version、source identity、generation key、manifest/content evidence 和 capability compatibility 都可验证时提供“更新到 X”；Catalog version、ref commit 或未验证 candidate 本身都不能作为插件更新。candidate 需要切换 Active 时，来源切换 Review 与重新规划后的精确插件更新 Review 是两个确认边界。来源切换成功只说明 Active 已改变；插件写入失败仍单独报告。更新 intent 绑定 installed/active version、source identity 和 generation key；锁内任一项改变时返回 stale，不得无声跟随新 candidate。该 projection 和 candidate overlay 都是 session-private 数据，不改变 统一状态 JSON。

TUI 依赖关系区分三类数据。Catalog declaration 说明插件声明需要什么；`availablePlacementReferences` 说明本次 统一状态 检查中，声明边、依赖 `ready` 状态和 consumer 当前现场位置可以同时匹配；历史 applied binding 则需要证明某次安装已把该边应用到该位置。历史 binding 尚未实现，因此不会填充 `placementReferences`，也不会把可用关系称为实际调用或已确认安装关系。`availablePlacementReferences` 只是 TUI 内部投影，不新增 Status JSON、I/O、持久记录、锁或现场扫描。图的证据分类不放宽锁内写入与依赖删除保护。

Codex native refresh key 是 user-only。遗留 project override 保留在 store，但不参与 effective value。统一状态 使用非阻断 `configLayerUnsupported` warning 提示用户删除。TUI 禁止在 project 层设置该 key，只允许删除当前 project store 中确实存在的旧值。

Config Definition v3 在顶层 Manifest v3 的 `config` 中用 `schemaVersion: 3` 单独声明。它支持最多 64 个本地 `definitions`、256 个顶层字段和 8 条连续引用边；对象属性中的引用也计入引用链，内联对象不增加引用层数。引用只允许 `#/config/definitions/Name`，覆盖项限于 title、description、default 和 required；未使用的定义也必须有效。编译后不含 definitions 或 `$ref`，保留配置版本和 presentation 元数据，继续使用同一字段和值校验器。旧无版本 Config v2 继续读取，不追加 v3 的字段数量限制；v2 类型仍限于标量或一层标量对象。v3 另支持顶层一维数组，元素由单一 items schema 约束为 string、number、boolean、fixed object 或 KV object；对象元素仍只有标量属性。数组、对象的递归嵌套、混合元素类型和 null 均拒绝。items 可用本地引用，但展开后仍检查上下文；items 本身不带 default、required 或 sensitive，对象元素的固定属性仍可 required。

`presentation.summaries` 声明 join 摘要，`fieldViews` 将摘要绑定到固定属性对象。每段只读本对象已声明且实际存在的 own scalar property；路径为单个 JSON Pointer token，支持 `~0`/`~1`，不沿原型链或读取外部数据。raw 显示实际标量，choiceTitle 可使用匹配的 choices 标题，缺失属性使用明确占位。最多 4 段，separator 最多 8 个 Unicode code point，path 最多 128 个字符；默认摘要最多 256 个 Unicode code point。摘要省略实际属性或超长时标记不完整，完整安全原值仍可读。摘要不参与值校验、dirty、预设匹配或 whole-object overwrite；敏感与无效状态先于摘要处理，终端控制字符在显示前移除。

Definition v3 通过 `aw.plugin-config.v3` 声明读取要求，配置摘要另需 `aw.plugin-config-summary.v1`。规范化 bundle 保留新合同，Catalog index 只传播 requirements 和既有摘要，不复制配置定义。先提供支持这些能力的 CLI，再分发新插件；旧读取器须明确拒绝不支持的合同。配置 schema identity 覆盖完整定义及呈现元数据，因此元数据改变也使旧 Review 证据失效。数组另外派生 `aw.plugin-config-array.v1`；对象数组的 `fieldViews.<field>.itemSummary` 将同一 join summary 应用于每个 fixed-object 元素，KV 对象数组使用安全预览。Store v5 只保存原值，不存引用、摘要、预设 ID 或 UI rowId。

数组最多 128 项，每个完整数组值的规范化紧凑 JSON UTF-8 编码最多 262144 字节，每个对象元素最多 32 个属性；default、preset、CLI 和 TUI 写入统一由 Core 校验。`validation.minItems/maxItems` 是非负整数，未声明 max 仍受 128 限制；`uniqueItems` 默认 false，true 时按规范化完整值判断重复并报错。对象 key 顺序不影响相等，数组顺序影响相等。`[]`、未设置和 unset 不等价，required 只要求存在，非空用 minItems。数组及其子项不支持 sensitive，数字必须有限且不作隐式类型转换。数组级 allowCustom=false 只能选择完整预设；数组诊断的 `path.segments` 使用字段、0-based 索引和属性的完整路径，界面显示 1-based 项号。

配置按 manifest default、user、project 合并。user store 位于 `AW_HOME`，project store 位于项目 `.agent-workflows/plugin-config/`；两者都使用 namespaced schemaVersion 5 envelope，并通过原子替换写入。user binding 严格绑定当前 source identity。project binding 只绑定从已验证 Active 或候选证据明确传入的 Catalog logical identity，不绑定 Git URL、SSH/HTTPS transport、本地 path 或 source identity；因此同一 source ID 和 logical identity 在 transport 改变后仍可共享读取。缺少 logical identity 证据时 project 读写 fail closed，不从 URL 或 path 推导。project 写入在 Review 和现有 AW_HOME mutation lock 内的最终提交前，以项目根相对 path 运行 `git check-ignore -q`：退出码 `0` 以 `projectConfigIgnored` 阻止写入且不改 store，`1`（包括已跟踪文件和有效 `!` 例外）允许写入，其它结果允许写入并产生 `projectConfigShareabilityUnverified` warning。只有已确认 ignore 后才运行 `-v` 读取解释；解释失败不推翻 ignore，且检查不使用 `--no-index`。Config Mutation Receipt v7 与 TUI 的安全 Review/结果投影显示该 warning。reset 不经过 Git visibility 门禁。

store 结构层只验证 envelope identity 和标量、浅层标量对象或同质一维数组的基础值形状；字段的 type、preset、required、format、object property 和危险 key 约束在 effective resolution 中验证。读取持久化 config 值时，按原始类型严格验证，不做输入 coercion，也不改写 store；只有显式修正错误类型后才返回 `configured`。无效高层覆盖保留低层值作为解释用 fallback，但 runtime 不使用该 fallback；删除 project 覆盖后若会暴露无效 user 值，fallback 明确投影为 `invalid`，且不使用 schema default 伪装有效值。对象和数组在层之间按整个顶层字段覆盖，不做子属性深合并、concat、按索引 patch 或按 ID 合并。读取只在内存中 canonicalize；真实写入使用 canonical JSON，相同语义的 set 不写 store 或 apply，Review stale evidence 仍绑定原始 store bytes。旧 `plugin-config.local`、store v2 和 envelope v4 及更旧版本不读取、不迁移或自动重写；所有新 namespaced 写入均为 v5，包括纯标量、对象和空 values。遇到旧格式保留原始文件，不把它当缺失配置继续运行；用户显式 schema-independent reset 后重新配置。删除数组不降级，也不提供降级导出工具。`config set` 要求当前 `config.fields`；`config unset` 还允许删除目标 store 中确实存在的 stale key，并在 receipt 标记 stale removal。stale removal 不伪造 effective config 变化，也不触发 apply。set、unset 可保留同层其它基础形状合法但 schema-invalid 的字段以增量修复。

Config Mutation Receipt v7 以 atomic patch 成功，或 reset 已删除或确认 absent，作为 commit point。`configWrite` 精确报告 `notStarted | failed | succeeded`。有实际 effective 变更的 `--apply` 在 commit point 前，以当前 source、platform、scope 和 dependency plan 只读解析实际 preApply 范围；该分支不运行 renderer、preApply、native manager 或平台写入，也不使用旧 effective config 的 runtime validation 阻止修复。范围按 target 解析；无法确定的 target 不执行，健康 target 继续，配置提交后用 typed partial 或 unavailable apply 结果报告。已知需要脚本但缺少授权时用 `preApplyAuthorizationRequired` 在提交前停止，并保持 `configWrite: notStarted`；对已保存配置的 replay 则保持 `configWrite: succeeded` 并返回 partial。无变化、只保存、只删除 stale key 或没有可见 target 时不要求脚本授权。commit point 后的 effective reread、Catalog/schema/source resolve、Status、target discovery、target validation 或 apply 失败都不得改写为配置写入失败；receipt 保持 `configWrite: succeeded`、`overallState: partial`，并用 discriminated `apply` 报告 `skipped | unavailable | succeeded | partial`。只有没有请求 `--apply` 才使用 `skipped/notRequested`。显式 `--apply` 无法解析 schema、source 或 effective config 时使用对应的 unavailable reason。每个可见 target 按自己的 platform 和 scope 解析 effective config：健康 target 继续 apply，无效 target 报告 `skipped/invalidConfig`；混合结果为 partial，全部无效为 `unavailable/invalidConfig`。公开 apply error 只包含稳定 stage、code 和脱敏 message。`config set`、`unset` 和 `reset` 的文本模式只在 stderr 输出 Receipt 中的安全 warnings；JSON stdout 仍是单个 Receipt，成功 warning 不改变退出码。无法 apply 时，文本输出 Receipt 的安全 code/message 或稳定 reason，并只用 target 的安全 message、error code 和适用的恢复命令。

Config Review 与锁内 writer 从同一次 user/project store 读取推导 mutation 前后影响；Review store evidence 覆盖所比较 effective config 实际依赖的所有层。普通 renderer target 比较其 `refreshKeys` 对应的 `values`、`sources` 和 `issues`，因此只改变来源也属于有效变化；preApply 按实际 platform/scope context 比较完整 `values`。`codex-native` renderer 固定比较 user profile，project role 等普通 project artifact 比较 project profile。只评估当前 cwd 可见的 desired placement，不扫描其它历史项目。store 有实际提交但这些有效输入都不变时，不要求 shared native 确认，不运行 preApply 或平台 apply；显式 runtime replay 不执行该 no-op 判定。before 无法读取时影响是 `unknown`，不能声明无变化；writer 可保守处理已解析的可见 target，但 impact 分析失败不得阻止 schema-independent reset 提交。

`config reset` 是不依赖 Catalog、schema 或 store envelope 有效性的最终恢复入口。完整 plugin ID 和 scope 直接定位；裸名只在所选 scope 的 store 中唯一时允许。final regular file 和 symlink 只 unlink 自身；final directory 原子改名为同父 quarantine basename，不递归删除；其它特殊节点稳定拒绝。receipt 公开 `absent | deletedFile | unlinkedSymlink | quarantinedDirectory`，quarantine 只公开 basename。默认写命令只提交配置；显式 `--apply` 才对当前 cwd 可见的 desired placement 执行 sync。普通 sync 对声明非空 `refreshKeys` 的动态 AW extension 重新运行 renderer，并按当前配置重写输出；Status 仍只检查 live ownership，不运行 renderer 或比较这类普通 extension 的正文。配置提交后，平台 apply 失败不回滚配置；receipt 和 status 报告 partial 结果，用户可再次 sync 恢复。user store 有实际写入或删除时，`otherProjectsMayRequireSync` 为 true；它只提示其它项目可能受影响，不依赖当前 cwd 的 effective config 或 apply 结果。project scope 始终为 false。

user scope 变更命中 `codex-native` target 的 `refreshKeys`，且 `--apply` 将更新可见 Codex placement 时，公开 CLI 必须在写 config 或 materialize 前要求 `--yes`；不带 `--apply` 仍只保存 user config。

TUI 把结构损坏的 store、Catalog/schema 不可用和字段覆盖无效分开处理。结构损坏页只显示 layer、脱敏 target 摘要和稳定 code，并只允许整层 reset 或返回；qualified plugin ID 和 scope 可直接建立 reset Review，不要求 Catalog 或 schema 可用。Catalog/schema 不可用时不打开字段编辑器；可确定设置层目标时仍可整层 reset。用户可从该页进入嵌套来源恢复；完成后返回原 plugin、layer、group 和 field 锚点，重新读取 schema 并重新校验父草稿。消失或变为无效的字段必须显式显示并阻止保存，直到用户放弃该项草稿；旧 Review ticket、evidence 和确认不能复用，也不能自动提交。字段覆盖无效时继续提供字段修改、unset 和整层 reset，并只把低层脱敏值显示为“删除后恢复”的解释，不把它投影为可运行 effective。配置已提交但 apply 失败的结果页明确保留设置，并可通过新的 Review 重新采集 evidence 后调用现有 runtime replay；`invalidConfig` 结果只返回设置修复，不提供直接 retry apply。reset 结果页显示四种 receipt disposition，quarantine 仍只显示 basename。

控制台设置总览显示实际或拟有效值，来源和待保存状态单独显示。选择新旧字段都直接编辑值，再选择合法的 user 或 project 目标并回到原分组；不同字段或同字段的不同目标可同时保留草稿。对象属性编辑以完整对象候选为单位；数组编辑持有完整列表 working value，添加、删除、移动和元素子编辑不写盘。确认整个列表并校验后仅选择一次合法 scope；取消元素保留其它草稿，取消列表保留原总览草稿。仅会话 rowId 保持焦点，不进入持久值或 Review 身份。保存时整体覆盖，不深合并。个人草稿被项目值覆盖时，主值仍显示项目有效值，并说明个人默认待修改；无效高层值不会自动回退。字段 unset 在编辑器可达，整层 reset 位于设置选项，二者仍经过草稿与 Review。

控制台搜索把 query 与输入焦点分开；退出输入后 query 继续参与来源和安装状态筛选。所有字符输入显示静态光标，并按 grapheme cluster 和终端显示宽度保留输入尾部。数字输入在解析前拒绝空白，空字符串按显式 set 保存；对象子属性与普通数字共用解析语义。统一值呈现显示实际属性值，摘要只用于显示；完整对象用于dirty、预设匹配及保存差异。保存汇总保留每个字段、目标和完整安全前后值，窄屏可继续阅读全部变更。Config Review preparation 复用本次 TUI session 的 Active snapshot、目标 fingerprint、Catalog operation context 和所选 config store digest，不重新运行完整 status 或访问 Catalog remote；需要 apply 时只读解析 dependency preApply 范围，并显示每个脚本 plugin 的身份和目标范围。执行只授权 Review 中以 source identity、platform 和 scope 绑定的脚本范围；空范围不提供通用脚本授权。user 变更可重新应用当前目录中已安装的 user 与 project 目标；project 变更只重新应用当前 project 目标。Review、stale fingerprint 和实际 writer 使用同一目标集合。

插件库统一显示目录、安装和仅保留配置的插件，以真实 pluginId 区分来源中的同名对象。`/` 在当前页输入查询，Enter 或 Esc 结束输入并保留查询；`f` 原位循环全部、已安装、未安装、可更新和需要处理五种筛选，非输入态的左右键切换来源。这些操作不增加浏览历史或清除选择。`m` 原位进入多选，Space 勾选、Enter 查看详情，返回后恢复查询、来源、筛选、焦点和选择。空结果仍可原位修改查询及筛选。

Catalog ref 页面只把 Release 和 Beta 投影为现有 explicit ref；底层仍只有 `cliChannel | explicit`。官方来源的下载方式从两个既定 HTTPS/SSH URL 派生，局部选择只修改 URL 草稿，通过 source mutation Review 提交；不新增持久 transport 字段。来源 ID 为 official 但 URL 为自定义地址时仍保留地址编辑，不静默替换镜像。Catalog logical identity 继续只来自 snapshot 的 Workspace identity，不修改 live owner identity。

### TUI 批量插件写入

批量选择页的插件行显示用途与版本信息，Space 修改插件选择，Enter 查看插件；选择工具作为独立动作展开，并与插件行共享焦点序列。首次安装的使用范围和工具是两个独立设置。维护任务默认沿用本次枚举的精确安装目标，范围编辑只能删减或恢复该集合，不添加缺失的平台或位置；范围变化后撤销旧 Review 并重新取证。

TUI 批量写入支持 install、sync、reinstall、uninstall 和普通 cleanup；force cleanup 仍只允许单个 target。一次批次固定一个 action 并建立一张 Review ticket；`selected` 选择使用共同 scope 和 platform，`targets` 选择沿用每个精确目标自己的 scope 和单个平台。执行完成后只记录一条 history；顶层 receipt 汇总所有分组的 target 和 rebuild 结果，分组结果只用于显示来源归属和计算重试根插件。批次不新增持久状态、ledger 或锁。

批量添加允许选择已有部分安装的插件，但至少要有一个可信、兼容且缺失的位置；“未安装”筛选仍只包含整个插件没有安装的位置。来源不可用、能力不足和 config-only 等新增选择门禁只适用于 browse 添加；installed 清单必须继续提供移除、同步和 cleanup 恢复入口。选择工具和 scope 后，TUI 把目标分成可添加、已有和受阻；只有可添加的精确单平台目标进入 `targets`，已有位置不重装。存在受阻目标时，TUI 必须显示每个原因，并要求用户显式选择只添加可执行子集或返回调整。位置摘要和可分页的完整位置明细使用同一草稿；窄屏必须能聚焦每个结果并返回原选择。

“按项目清单准备”使用当前项目的 sync-all 合同，允许准备尚未安装的已保存根；“修复异常”使用有版本证据的精确恢复任务，不能把未知版本的已有目标当成未安装。手动批量维护由 Controller 按动作和精确 status target 枚举位置，不从平台展示摘要反推 scope，也不按 supported scopes 扩张目标。合法的 Codex native 双位置启用保留两个请求位置；共享内容的写入影响仍由原 planner 在 Review 中说明。

批量选择分别记录已选状态、新增选择资格和执行资格。已选项始终能逐项取消；从当前清单消失的已选 ID 仍以不可用占位显示，不静默丢弃或执行。“全部已选”以选择集合为准。继续动作在窄屏保持可见，与候选使用同一焦点序列；聚焦插件保留用途说明。

普通批次按 source 分组，同一 source 的所有根插件通过一次 typed write 解析依赖和构建目标，因此共享依赖和 native projection 只处理一次。不同 source 独立执行；一个分组失败不回滚或阻止其它分组。当前项目的 sync-all 在准备 Review 时读取 Intent roots，并冻结规范化的 requested plugin IDs 和 source/platform 分组。确认后，executor 在现有单一 `AW_HOME` mutation lock 内重新读取 Intent，并用已冻结 ID 作为 selectors、`all:false` 重新解析；完整根集合或分组变化时返回 typed stale，不能把后来新增的 root 自动加入本次写入。

每个可执行分组分别绑定其 `operationPlan.planFingerprint`。锁内首次复核按去除全局 Intent digest 的分组计划语义比较；前序分组完成后，后续分组重新预览，只忽略已完成 target 和对应 Intent digest 的预期变化，再把当前完整 fingerprint 交给 typed writer。没有 operation plan 的预览失败分组也进入同一 Review，但标记为不可执行；确认固定保留已审核的失败结果。即使该来源在确认后恢复，也不能重新求值后开始写入，且不能阻止其它已审核分组继续。部分失败后的 retry 只从能恢复精确 `(pluginId, platform, scope)` 的失败 requested target，或失败 dependency 的 `requiredBy` 根计算新的 selected targets；无法细分到精确 target 的失败分组不提供重试。retry 必须重新读取 status、Intent、Catalog 和依赖，建立新的 preparation、evidence、fingerprint 和 Review ticket，不能复用旧计划。

来源列表的“检查全部”包含关闭自动检查的来源，同时最多检查两个来源。页面显示正在处理的来源和各自结果，不提供虚构百分比。必要时可获取和验证候选内容，结果保留在 session overlay；检查不启用或切换 Active Catalog。

### TUI 导航流程

普通消费任务、恢复入口和明确保留的 CLI 范围由 [CLI/TUI 能力覆盖](tui-capability-coverage.md) 记录。页面按首页、集合列表、实体详情、编辑器、操作流程和完整阅读六类模板组织；依赖图是集合模板的专用渲染器，业务路由与许可阶段继续保留。新增能力必须同步入口或缺口理由；作者工作流与机器接口分别说明，不以“高级排障”代替覆盖决定。

首页只有插件、插件清单、插件来源三个业务入口，固定描述为“管理  Agent Workflows 插件”（管理后两个半角空格）；`?` 打开临时帮助层，内容复用当前页面及焦点状态的快捷键提示；长帮助可用左右键分页，关闭后恢复原焦点和视口。可选择的页面内容与下方业务动作使用同一纵向焦点序列，不需要 Tab 切换区域。普通返回使用 Esc，风险取消和结果恢复仍有明确动作。长列表的 `a` 在当前对象与实际下方动作之间往返，只改变焦点和视口。输入与弹层独占其按键，可见动作与业务快捷键调用同一 handler；后台状态更新不把已聚焦的下方动作强制拉回列表对象。

操作 Review 先从执行计划分别投影用户汇总和技术详情，再独立分页；数据量不改变默认信息边界。技术分组中的共享、删除和脚本风险仍须在用户汇总中说明。完整汇总保留在页面，只有既有 `requiresConfirmation` 要求额外授权时才打开风险确认层，默认选择返回检查。确认层绑定当前 Review ticket，不建立另一套授权；它独占输入，取消保留页面上下文，失效或过期的 ticket 不可执行。风险内容超出空间时可分页阅读，低于最低终端尺寸不接受写入确认。

插件和来源卡片将身份放在顶部，行高按实际显示宽度计算，短用途允许换行。插件详情共用结构化身份、来源、目录版本和位置事实，安装版本及健康状态分别显示；声明版本只有真实证据存在时才显示，不能从目录版本补齐。常用动作直接可达；更多操作保留平台维护、来源和技术诊断。仅个人或项目声明、已保存配置或关系引用也保留原 canonical 身份，缺少目录定义不改用纯文本报告或切换到其它插件。普通 About 和常驻“完整基本信息”入口已移除，基础事实不生成分页 summary。插件详情的信息卡不进入焦点序列，名称与来源放在卡片顶边，位置健康标签右对齐；信息卡在为下方动作保留空间后按内容自适应高度，能完整显示时不显示分页栏和翻页提示；超出终端可用高度时，左右键按页阅读换行后的完整信息，并显示页码和首尾状态，上下键只选择真实动作。来源详情仍通过当前页信息焦点纵向阅读，`a` 在信息与动作之间切换，只有信息焦点显示翻页提示；技术全文使用公共 Reader。来源详情将地址、下载方式、版本策略、当前／候选目录、来源健康与检查结果分别显示，检查失败不覆盖当前版本的可用性。关系节点 Enter 进入统一插件详情，完整引用按需进入 Reader。平台观测缺失仍显示未知，不以缺少安装摘要推断未安装。内容清单使用同页纵向滚动，并区分目录版本与已知安装版本。批量和任务 Review 的插件摘要来自已确认的结构化目标与版本证据，未知版本明确显示未知，不从文案或当前目录版本推断。结果先列插件结论，再列位置和所需插件；独立位置行保留所属插件身份，完整失败节点及精确重试仍可达。

插件设置卡片在顶边右侧显示值来源，描述保留在对应卡片内：未聚焦时最多两行，聚焦后展开全文。超出单屏的卡片正文使用 PgUp/PgDn 阅读；左右键仍只切换可见分组。错误信息和待保存状态保留，敏感值继续使用既有安全投影；不另设底部描述区。

查询区按主标签、搜索、状态筛选、选择摘要的顺序只显示实际维度，不建立第二焦点区。左右切当前主标签，`/` 原位搜索，`f` 切状态；空搜索的光标位于占位文字之前，占位文字不计入输入值；输入时左右只移动光标，普通字母不触发背景动作。主标签选中项使用强调色，其余弱化；查询行与动作行的快捷键统一在右侧，包括 `/`。计数基于当前主标签和搜索，隐藏非当前零项，当前筛选变零仍保留条件。返回与刷新以实体或动作 ID 保留焦点、查询、选择和滚动。普通动作标题白色，焦点由强调色、背景和指示符表达；成功、警告、错误和未知只用于独立状态事实，并配文字或符号，禁用动作保持灰色。不从插件状态或名称给动作上色，不生成没有信息的孤立状态符号；实际状态、版本、风险和禁用原因继续保留。

插件清单先选择个人或当前项目，再按所选范围的根聚合。声明区包含该范围全部声明，额外安装区仅含该范围非声明及非声明依赖的可归属根；左右切分区，`f` 按根总体状态筛选，优先级为受阻、未确认、待同步、就绪。位置状态继续独立，“共用个人安装”只采用已有 sharedUser 证据。“同步可执行项”不受查询影响，Review 保留当前范围的完整请求、精确目标与受阻项；多选同步只使用勾选根。受阻问题按已有安全动作分流，不把配置或输出冲突一律送到来源页。局部检查失败保留旧清单并标记过期，成功重查后清除标记；未进入的另一范围不主动读取。

平台维护每个平台只有一个入口，位置卡绑定精确 `(pluginId, platform, scope)`。多个位置初次进入不预选，Enter 选定后才启用对应动作；上下移动只改变焦点。单位置初次可自动选择，返回保留有效选择；已选目标失效后清空且不自动换到其它位置，即使仅剩一个。补充安装入口明确标出新位置，并进入原安装选择与 Review 流程，不作为已选位置的维护写入。新增位置不加入原授权。实际许可、共享影响与受限清理继续由原 planner 和 ownership 门禁决定，未知状态不产生伪安全写入。

内容名称、类型、工具和可选简介分别投影。卡片顶边显示名称、右侧类型；正文显示简介预览和工具标签。短条目 Enter 不打开额外详情，长名称／长简介和真实读取问题使用公共 Reader，返回恢复查询、焦点与滚动。普通缺简介不构成 issue；真实条目读取失败保留条目安全问题，整体或部分清单不可读保留覆盖状态，不把不完整清单说成零项。保留路径、符号链接和读取预算边界。更多操作的每个平台入口及维护页的每个位置都使用独立卡片呈现真实事实。依赖入口仅在任一方向存在已知边时显示，未知无边不能声称已确认零关系。双向图的当前节点和直接依赖从左侧起始，不为上游横向汇合右移整图；箭头指向所需插件，实线／虚线表达边证据，节点标签表达健康；共享和循环以引用呈现，完整关系可达，不改变卸载许可。

安装平台没有共同合法范围时逐平台确定根目标，随后复用依赖位置草稿；仅在真实依赖范围分歧时进入决定页。混合根范围通过精确批量目标保留，显式依赖范围按来源和平台传入同一预览与执行边界，不改变根插件范围。

分页阅读页共用先换行后分页的 Reader 和横向页码，使用左右方向键及 PgUp/PgDn，页脚提示翻页和 Esc 返回，不再占用正文菜单展示 p/n 翻页动作。首末页不可用方向调暗，页数至少为 1；尺寸变化后位置合法且全文可达。来源标签、配置分组、关系树和输入光标保留自身方向键语义，集合纵向滚动提示不改成横向。阅读页的 `[y] 复制全文` 只在用户触发后复制当前阅读对象的完整正文，复用安全化原文，不复制分页切片或显示宽度产生的软换行。复制成功或失败有明确反馈，失败保留阅读位置及已有报告保存入口；输入和弹层不触发背景复制。剪贴板使用当前操作系统已有工具，Linux 需要相应桌面会话及 wl-copy、xclip 或 xsel，不自动安装工具。

TUI 浏览历史的每一帧有会话内稳定 ID。安装、插件维护、配置、来源恢复和 Portable 安装流程记录自己的 flow ID、父 flow、稳定起点帧和返回目标。Flow 只管理导航归属和内存草稿引用；它不保存执行计划，不替代 Review ticket，也不是持久状态。

冻结的插件恢复任务可以作为设置编辑或显式更新的起点。嵌套流程保留父任务的精确目标和批量草稿归属，完成后返回父任务并重新取证；普通详情入口没有外层 flow 时也遵守同一返回合同。嵌套更新完成不清除仍有剩余目标的外层批量草稿。来源问题优先进入对应恢复入口，不被版本未知的通用重检入口遮蔽。

没有业务分歧的恢复任务自动只读准备并进入一次影响 Review。推荐更新只有在冻结的精确目标仍完整、全部可执行、版本证据未变、无需启用来源且无需选择 scope 时，才自动只读准备真实 Review；调整选择只能删减或恢复本次冻结的推荐插件集合，并重新取证和签发 Review ticket。版本、位置、来源、删除或可执行子集需要决定时保留选择。取消或返回 Review 不得自动再次进入准备。依赖图按根插件和方向保留会话内展开、焦点和滚动上下文；普通节点详情返回恢复阅读位置，失效节点按有效祖先或根规范化，不保存到磁盘。

操作进入结果页前，Controller 必须删除该 flow 的选择、输入、准备、Review 和 Progress 帧。插件安装把原预览锚点更新为插件详情，再追加只读 Result。因此关闭 Result 后先到插件详情，再返回保留 query、来源、焦点实体和滚动位置的原列表。回首页必须把历史重置为唯一根帧。确认前返回会撤销旧 Review ticket，并保留所属 flow 的草稿；再次确认必须重新准备证据。执行后的重试也必须建立新 attempt 并重新读取证据。

状态刷新后，Controller 必须按实体 ID 校验当前路由和逐层恢复的祖先。插件、来源或问题消失时回对应安全列表；来源筛选失效时回同模式的未筛选列表。所有包含插件或来源实体的 route 都遵守该规则。依赖移除阻断页只说明依赖者和返回路径，不提供绕过依赖保护的强制清理入口。

控制台进程由一个 Session Host 持有当前 Controller、进度 feed 和 session epoch。`h` 只清除当前导航 flow、Review ticket、临时进度和草稿，并回到唯一根帧；它保留本次加载的状态 snapshot、来源检查时间和 session cache。`H` 先保护所有草稿，再取消并等待本 session 的只读请求；确认没有写操作后，才销毁旧订阅并用新的 runtime dependencies、进度 feed 和 Controller 读取本地状态。迟到响应必须同时受 session epoch 和 Controller 内的 flow、frame 或 request identity 保护。执行中 `h`/`H` 只覆盖一个待处理导航；Esc 只撤销该导航。只有 succeeded Result 才自动执行待处理导航，且先把结果交给共享 history owner；partial、stale、blocked 或无法确认清理结果都停留在 Result。Session Host 不用取消 signal 中断写操作，也不新增持久状态。正常退出和异常退出都必须在 session reporter 仍绑定时封闭新入口，等待现有写操作，再取消并等待只读请求，最后释放 Controller。

### TUI v7.2 投影与键盘修复

v7.2 只调整 TUI 的页面投影、阅读和键盘路径。它不新增 CLI 入口、Status JSON、I/O、持久记录、锁或恢复状态机。

- R01：批量 sync、reinstall、uninstall 和 cleanup 的“修改处理范围”只删减或恢复本次已有位置。重新检查后出现的新位置不会自动加入；位置变化时用户必须重新确认；空集合不执行，也不补造缺失位置。
- R02：静态行在 compact 页面仍显示核心 value；辅助说明要么在默认页可读，要么有完整阅读入口。长节点、来源和设置前后值使用分页 reader；行高预算按实际渲染计算，小屏不以截断代替完整阅读。
- R03：同一插件的不同平台和 scope 分别显示结论和严重度。平台汇总只用于排序和建议，不把一个范围的问题复制到另一个范围。
- R04：下载方式和风险确认层共享局部返回规则；Esc 或 `b` 恢复原上下文，`h`、`H`、`q` 和 Ctrl-C 都经过草稿守卫。Ctrl-C 与 `q` 在有草稿时要求同一确认；写入进行中仍等待完成后退出，输入框的普通字符处理不变。
- R05：可见确认按钮和 `c` 复用同一稳定 action ID 与 handler，包括推荐更新、选择校验、目标和导航。
- R06：批量安装用同一有序分组模型决定渲染和导航：顶部操作、使用范围、工具。初始焦点落在首个可操作项，视口随焦点移动。

### TUI 诊断投影与脱敏边界

TUI 在 Controller/ViewModel 层把现有 source、status target、dependency、config 和 Portable blocker 状态投影为统一诊断。该投影只存在于当前进程，不新增诊断数据库、持久状态或 统一状态 字段。产品层必须说明发生的情况、受阻或降级的能力、保留的安装或设置，以及下一步恢复动作；Active snapshot 正常、缺失和损坏必须使用不同影响与恢复动作。

技术层只接受白名单结构字段：安全错误 code、可选 stage、sourceId、requestedRef、resolvedCommit、lastSync 证据，以及有限的 platform、scope、plugin、dependency、field、freshness 或 compatibility context。技术层在显示前再次执行通用凭据脱敏、URL userinfo 和敏感 query 清理、已知 home、cwd、临时目录和来源路径替换，并截断文本。任意 native stderr、未知 `Error.cause`、内部绝对路径、digest、credential 或未证明安全的 status message 不进入诊断 ViewModel；不能证明 cause 安全时省略 cause，只保留 code、stage 和白名单 context。

操作结果诊断在 CLI/runtime 服务边界抽取可信 code、stage、target、exitCode 和已知 cause，再进入 TUI 私有投影；未知异常正文、任意 stderr 和未知 cause 不进入公共 snapshot。结果分别记录配置提交、AW 写入、preApply 外部影响和最终复核，配置提交后的 apply/status 失败仍显示已保存；preApply 开始后失败时，本目标 AW 写入尚未开始，但外部影响只能标为可能存在。SessionHost 持有最多 20 条安全内存记录并跨会话重载复用，记录 ID 绑定 session epoch 和 operation ID；公共 snapshot 只包含小摘要和记录 ID。单次诊断正文最多 256 KiB 或 1000 行，截断必须明确标记。完整正文与短摘要共用脱敏规则，但不先按短摘要的 240 字符限额删除尾部；详情、技术信息和报告按终端显示宽度换行，再按显示行分页，CJK 和长行尾部仍可阅读。安全报告先预览，再由用户显式保存到本地唯一文件；不自动上传，也不建立持久诊断状态或改变 Receipt、Status JSON schema。

## Platform Boundaries

- 只删除可证明属于 AW 的 marker、managed block、artifact 或 namespaced 组件。
- 一次写操作按 `sourceId + sourceIdentity + marketplaceName + normalized marketplaceRoot + platform` 分组 native marketplace materialization。每组汇总全部 target 的动态 native overlay，并只执行一次 copy、staging validation、atomic swap 和 commit。已删除插件的整体 cleanup 不进入本条的重建顺序：它保留目标插件的 marketplace 投影与归属证据，先完成原生卸载及 absent 后检查，再移除该插件投影并保持其他插件有效；失败时保留重试所需证据。其他 native materialization 的共享投影 commit 必须先于该组的 plugin add/remove/activation；分组 materialization 失败时，该组不启动 native mutation。commit 后逐 target 执行平台 mutation；单 target 失败不回滚共享投影，也不回滚其它 target 的成功结果。
- primary source 默认继续使用 `aw` marketplace。若用户级 Codex 或 Claude 的 `aw` 已由 legacy 或 foreign source 占用，首次安装改用 source-bound `aw-<sourceId>`；两个平台使用同一名称。已有 canonical 注册继续决定名称，候选名称被 foreign source 占用时 fail closed。
- 外部 Codex/Claude 命令、用户手改目录和共享 marketplace 都是不受 AW 完全控制的边界。Claude 合法的未绑定默认安装记录不属于任何 marketplace；来源 inventory 必须保留并忽略它，不能把它归为 canonical 或 foreign。执行 native install 前，若任意 scope 存在与目标原生插件名称相同的未绑定 bare-key 记录，写命令必须在清理、mirror 和 native CLI 调用前 fail closed；不同名记录继续保留并忽略。cleanup 和 uninstall 不删除、迁移或重命名未绑定记录。命令允许部分成功，并报告残留和失败。
- Codex cleanup 和 uninstall 先检查 official scoped list、公开 config 和 AW ownership。没有 official installed native、AW-owned output 或待移除的 canonical marketplace 时，不解析或获取 manager。需要 official remove 且 system CLI 缺失时，可在本次授权下使用 AW-managed 官方 CLI。Codex private cache 和 installed manifest 不算 residue，也不影响 cleanup 成败；AW 不直接删除它们。foreign 内容始终保留。remove 或完成后检查失败时保留可公开观察的 residue，并提示重试 cleanup/uninstall、升级 AW 或安装兼容的官方 Codex CLI。
- Codex project config 的规范路径与 Codex user home 相同时，status 不重复读取或投影 project activation，未发现 project owner 的默认 status 不生成 project placement；显式 project status 报告路径别名。`install`、`sync` 和 `reinstall` 不向这个 project placement 写入，用户必须进入独立项目目录；`cleanup` 和 `uninstall` 仍可处理已有 project owner。
- active marketplace 和 quarantine 都是弱状态。清理失败时保留它们，后续 cleanup 可重试；不得因为弱状态损坏永久阻止用户清理自己的 AW 输出。
- marketplace mirror 中的 Skill owner marker 只证明 overlay/payload 完整性。它属于可重建的弱 materialization，不进入 live installation inventory，也不阻止 source removal。
- 项目范围路径必须在项目边界内；不跟随不安全的符号链接或删除 foreign 内容。
- Codex project reconcile 只扫描当前 repo 的 `.agents/skills` 直接子目录，并把严格匹配当前 source ID、plugin ID、platform 和 scope 的 schema 3 owner marker 作为 stale Skill 清理授权。当前 renderer 返回 disabled 或当前 Manifest 不再声明的 owned Skill 进入既有 quarantine 清理；source transport identity 变化不阻止相同逻辑 owner 的清理。markerless、malformed、身份不匹配、符号链接、特殊节点和嵌套目录继续保留。
- Codex namespaced marketplace root 必须是精确的 `<AW_HOME>/marketplaces/<sourceId>`。写入和只读 inspection 使用同一检查：`lstat` 拒绝 AW_HOME、marketplaces 祖先或目标 symlink/错误节点类型，并用 `realpath` 确认 containment；不安全现场投影为既有 `marketplacePathUnsafe` blocker。

### Codex shared native 与 project activation

当前恢复写入和统一状态的 Native 现场投影使用以下合同。旧 Codex project materialization 不作为 AW fallback，也不维护第二套 project 安装模型。

- Intent 只表示需求，不是安装事实。Codex native installed、absent 和 active version 只来自成功的 official marketplace-scoped JSON list；公开 config 只提供 activation 和 marketplace ownership。private cache 和 installed manifest 不得把 absent 或 unobserved 提升为 installed。
- User 与 Project Intent 都使用严格 schema 3，只保存 source-qualified root 和来源 logical identity binding；Agent 及 dependency override 属于各 scope 独立本机偏好。Native 执行只处理实际现场，不写 Intent。显式 install 可先提交需求；平台执行失败不回滚声明。普通 sync、reinstall、uninstall 和 cleanup 保留两份声明。
- Codex plugin 只物化一份 shared native user package。project scope 只在当前项目的 Codex 配置中激活该 native plugin。shared-native ownership 不得为此保存 project claim path、global claim、refcount、native installed ledger 或第二套安装状态，也不扫描历史项目或通过全局项目扫描执行 auto-GC。qualification report 也不是 installed ledger。
- 静态 Codex native Skill 属于可重建的 marketplace 插件副本，不生成逐 Skill owner marker，也不作为 AW-owned Skill 单独预检、写入或清理。更新和重装使用共享原生安装观察、marketplace 来源归属与路径边界；已有逐 Skill 标记缺失不阻断操作。用户确认共享更新后允许从 Catalog 重建该副本，副本中的手工改动可能被覆盖。独立 AW 扩展仍按精确 owner identity 保护，来源冲突和不安全路径仍阻断。
- Shared native 的 status inspector 对 static native 只检查 official observation、公开 marketplace ownership 和路径边界。receipt-backed dynamic `codex-native` 还检查 AW-owned canonical marketplace source projection，但绝不运行 renderer；完整有效的 projection 与当前 renderer/config/render input/target evidence 不同才报告 `renderDrift`。回执或生成内容缺失、格式损坏和摘要不匹配报告 `replaceable: damaged`，实际 I/O 失败报告 `blocked: unreadable`，来源或插件身份冲突及不安全路径报告 `blocked: foreign`，并保留具体 projection diagnostic。CLI、Status 和 TUI 不把生成内容缺失解释为个人配置变化，也不据此判断 Codex private cache 是否损坏。它使用 `missing`、`usable`、`replaceable`、`blocked` 或 `unobserved` 五态；`replaceable` 的 reason 是 `outdated | damaged | renderDrift`，`blocked` 的 reason 是 `foreign | unreadable`。install postcheck 必须观察精确 plugin installed，remove postcheck 必须观察精确 plugin absent。write preview 与 mutation lock 内重算使用同一 public observation 和 AW-owned source projection；replace 不得复用现场，并按 shared impact 要求 `--yes` 或 TUI 确认。private cache 或 installed manifest 的 bytes、digest、缺失或损坏都不触发 replace/remove。
- 基础 Codex native plugin 合同最低为 `0.145.0`。涉及 project activation 的操作最低为 `0.151.0`。开发 qualification 固定拒绝非精确 `0.151.0`，避免把其它版本的行为外推到 rollout allowlist。
- PATH 中有 Codex CLI 时，操作按适用版本门禁探测它。PATH 中没有 system CLI 且操作只修改 project activation 时，不获取 manager。此时 AW 未观察到 system loader 或 Codex App，只把 project activation support 标记为 `assumed`。只有操作需要物化或移除 shared native package 时才解析 manager；system CLI 缺失时，AW-managed manager 必须取得精确 `0.151.0`。
- 每种 native kind 必须先通过显式真实 qualification 才能进入 rollout allowlist。未被行为证据证明的 kind 必须返回 `unsupported`，不能从帮助文本、源码字符串或相邻 kind 推断。当前 `0.151.0` qualification 可证明 Skill、MCP、Hook 和 App；slash command 因没有可用的离线运行时证据保持 `unsupported`。
- project activation 的最低行为合同是：native add 默认创建 user enabled；`user=false, project=true` 只在受信任的精确 project cwd 加载；neutral cwd 不加载；`user=true, project=true` 在两处加载同一 shared native plugin；project trust 未生效时 project-only activation 不加载。
- `status` 自动对 PATH Codex 执行适用最低版本的 `--version` 探测，并复用 marketplace-scoped JSON list 校验合同和观察安装。POSIX 启动器不要求 npm 目录形状；Windows 保留现有启动边界。探测结果在本次状态加载内复用，不获取或安装 managed runtime。查询失败或 JSON 无效不能解释为组件缺失，TUI 按原因区分状态未确认、激活范围不一致、版本待同步和真实内容缺失或损坏。
- `status` 始终只读。它只能读取 Intent、live ownership 和 native evidence，并标明 observed 或 assumed；不得安装 manager、调用 native add/remove、修改 trust/config、创建 claim/refcount，或把 qualification report 当现场事实。
- `status` 文本分别显示 Codex 的共享内容及各 scope 的 activation 与现场。当前 Catalog 已移除插件时，仍用本地 Intent、live ownership 和公开原生状态解析查询；禁用 activation、原生安装或 AW 投影单独存在时也显示残留，并提供独立 `intent retire` 入口。原生状态无法观察时保留诊断，不能当作 absent；来源不可用不能证明插件已移除。
- 旧 Codex direct MCP/Hook residue 不由新 CLI 扫描、重建或删除。保留旧环境时，先用旧 CLI cleanup。

独立入口 `pnpm qualification:codex-project-native` 只用于 `0.151.0` rollout qualification。`pnpm qualification:codex-native-performance` 按 `CODEX_QUALIFICATION_VERSION` 和 `CODEX_QUALIFICATION_CLI` 显式验证 `0.145.0`、`0.151.0` 或 `0.153.0`。三个版本都必须接受 `plugin list --marketplace <name> --json`；`0.153.0` 的本地 marketplace scoped list 还必须在阻断 proxy 的隔离环境中成功，不得依赖远程 Catalog。代表性本地 native plugin 安装运行五次，其中位数必须低于 15 秒；如有同机旧实现基线，也可用改善至少 70% 代替该绝对条件。精确 binary 缺失时报告 `missing`，不得自动下载或把 fixture 结果作为真实性能证据。

两个 qualification 都使用临时 Codex home、临时用户 home、临时 AW home、临时项目和临时本地 marketplace，且不进入普通 test、build 或 release 默认链。它们不读取或修改真实用户 config/cache，不访问远程 Catalog。机器报告只说明该次 CLI/OS 和精确版本的 qualification 结果，不授权或记录任何用户安装。

Codex 性能门禁使用以下稳定上限。成功的 official native CLI 不做 process-table observation 或 scan。每个 marketplace observation generation 中，project 或 all-scope 最多运行一次 exact list 和一次 neutral list；user-only 最多运行一次 neutral list。Review preview 与 mutation lock 内的 generation 不共享 snapshot。锁内 no-op 最多两次 list；发生真实 mutation 时 pre/post 合计最多四次；完整 TUI project mutation 连同 preview 最多六次。所有 list 都必须是 marketplace-scoped JSON list，不允许额外 non-JSON list。同 source 的 root plugin 和五个依赖只执行一轮 Catalog copy、staging generation、atomic swap 和 commit。以上上限与 plugin 数量无关。

这些合同不接入 Codex app-server plugin/reconcile，也不保证运行中的 Codex App 自动刷新。App 的重新加载行为必须单独 qualification，不能由 CLI list 或文件变化推断。

## Agent Skill Eval 执行与 Runner 边界

- Skill-local `evals/manifest.json` 的准备合同是 CLI 拥有的 Manifest v1。`aw skill eval prepare` 通过 Catalog Workspace 解析 canonical plugin，并按一个 plugin、Skill、suite、profile 和可选 case/split 选择生成输入完整的 `EvalSpec v1` 目录。该目录包含 runtime target、可选 previous target、筛选后的 cases、Eval-owned fixture，以及移除被测 Skill 后的完整 subject workspace。`plugins` 选择参与插件并提供公共配置；可选 `configByScope.user` 和 `configByScope.project` 只能覆盖 `plugins` 已选插件，并按顶层字段替换公共配置。未覆盖字段继承公共配置。profile 的 sensitive config 值不得进入 Spec。
- `prepare` 复用真实 bundle、依赖、profile config 和平台 materialization，但不启动 provider、模型或真实 native CLI。普通 target 和 role 读取 profile scope 的合并配置；共享 `codex-native` Skill 按其生产合同读取 user scope 的合并配置。物化结果保留参与插件的静态与动态 Skill、共享 native Skill、role 配置和完整 runtime tree。source binding 的 profile digest 绑定实际使用的各 scope 合并配置。它先在 staging 中验证路径、摘要和最终输入，再原子发布到 Workspace 外或 `<workspace>/.aw/evals/**` 中尚不存在的窄目录；`.aw/evals` 根、已有、过宽或含符号链接的目标 fail closed。
- Eval 执行的唯一机器 owner 是 npm package `@lesliechan721/agent-skill-eval` 的 `aw-skill-eval` bin。公开机器合同只包括 `EvalSpec v1`、`EvalAudit v1` 和 `EvalResult v2`。Engine 提供 `spec validate`、绑定 Spec 的 `audit validate`、绑定 Spec 与 Audit 的 `result validate`，以及唯一执行入口 `aw-skill-eval run <spec.json> --audit <audit.json> [--allow-unmanaged-processes]`；CLI 不提供第二个 `run` wrapper。成功的 `spec validate` receipt 在 `calculated.providerDigest` 公开正式 provider 摘要，Auditor 只复制该值，不实现摘要算法。
- 单份 `EvalAudit v1` 必须与当前 Spec 的 provider、workspace、current target、可选 previous target、case digest 和全部 selected case 精确绑定，且状态为 `pass`、没有 blocked case，才准许执行。workspace 摘要绑定全部普通目录和普通文件；空目录的新增、删除或重命名会使绑定失效，符号链接和其它特殊节点被拒绝。prepare、Spec validation 和运行快照使用同一算法。`runs` 和 `timeoutMs` 改变不影响 Audit 复用；旧版使用字符串 `workspace` 的 v1 Spec 必须重新 prepare 和 Audit。`EvalResult v2` 不兼容 Result v1；它绑定 Spec、Audit、target、case 和 provider 选择，保存每次运行的状态、耗时、usage、grade 和错误，并要求顶层 `processManagement` 记录本次 managed 或已确认 unmanaged 模式。
- 所有真实 provider run 都在创建 output 或启动模型前完成同一执行预检。macOS 必须先解析本次选中的 Codex 可执行入口，再只读检查用户 keychain search list；Engine 随后使用这个已解析的绝对入口，Eval fixture 的 PATH 不能替换它。入口是 cmux Codex shim/wrapper、存在 `accountsKeychainExport`，或检查失败时停止。Engine 不自动寻找替代 Codex，也不修改 keychain；调用方可显式用 `AW_SKILL_EVAL_CODEX_BIN` 选择原生 Codex 可执行文件。默认 managed 模式要求当前会话不是已知 restricted permission profile。macOS/Linux 通过进程检查观察和确认协作式后代清理，但不是 OS 强制 containment，因此 Result 不声明保证清理后代。Windows 在 spawn 前由当前架构的 optional 平台包提供原生 helper。helper 创建 KILL_ON_JOB_CLOSE Job，并以 suspended 状态创建和分配 root；分配失败时 root 不恢复执行。helper 正常退出前终止后代并确认 Job 为空，调用方提前退出或强制结束 helper 时，最后一个 Job handle 关闭并清理 Job。Eval 包不包含 PE；x64 和 arm64 PE 分别由对应的 `os`、`cpu` 受限平台包分发。helper manifest 绑定源码、精确 Go toolchain、固定交叉编译环境和两个 PE digest。普通 build 只校验并复制这些 artifact 到对应平台包；强 release verification 必须用 manifest 指定的本机 Go toolchain 在隔离 cache/workspace 中重建，并逐字节比较。真实 Windows 支持仍须在对应架构运行独立 qualification；macOS 交叉编译和 mock 不是运行证据。单次 `sandbox_permissions=require_escalated` 不等于 Full Access，不能修复其它边界。
- 原生 Codex app-server 的 macOS/Linux managed 进程树持续检查 marker，允许工具宿主使用独立进程组；清理按 marker、PID 和启动时间确认归属，并保留检查失败与清理未确认的失败边界。下述 `custom-process` 的同进程组合同不用于原生 Codex。
- POSIX marker 采样区分“匹配”“缺失”和单进程环境不可读。`ps` 的命令降级输出不直接证明 marker 缺失；仅对当前进程树中的可疑 PID 在同一采样预算内复查一次，并保留启动时间身份校验。复查后已退出或为僵尸的进程不触发 marker 丢失；仍存活且缺 marker 或持续不可读时失败，诊断中的不可读 marker 匹配值为 `null`。
- Trigger 执行或清理失败时仍保存脱敏的 `provider-evidence.json` 和 `provider-trace.json`，但不产生成功 grade。原生 POSIX 进程检查失败时，evidence 附带首次失败和最后清理检查的相关进程元数据、触发分支与 PID；不保存进程命令、环境或 marker 值。
- Engine 创建的隔离 HOME 不继承宿主 Git credential helper。conversation、trigger、workflow、workflow adapter 和 custom process 都禁用 Git system config 与终端认证提示；Codex 工具子进程使用相同设置。这样不会因临时 HOME 缺少默认 macOS keychain 而启动 SecurityAgent，也不会让模型运行读取或写入宿主 Git credential。
- 只有用户明确接受本次运行可能遗留后代进程的风险时，才可在单次命令增加 `--allow-unmanaged-processes`。该授权不进入 Spec 或 Audit，不会形成静默 fallback，也不会自动重试。unmanaged-confirmed 模式跳过进程树检查，只尽力终止直接 provider child，不发现或保证清理后代进程；macOS keychain 预检仍然执行。
- Manifest suite 可选声明 `releaseProcessManagement: "managed-only" | "allow-unmanaged-confirmed"`。省略时 Release Check 使用 `managed-only`；只有显式声明后，unmanaged-confirmed 的 Result 才可满足该 suite 的 release evidence。
- Engine 的内置 provider registry 包含 `codex-trigger` 和 `codex-conversation`。Manifest 的 trigger 和 conversation suite 选择对应内置 provider；`custom-process` 是显式的、可信且协作式外部 provider escape hatch，不是任意外部程序 sandbox。其命令和本地资产在 prepare 时做边界检查，执行前必须单独披露未知调用成本、credential 和网络影响。
  - macOS/Linux 的 managed 模式只在进程检查可用时启动 `custom-process`。Windows spawn 必须先通过原生 Job helper；helper 缺失、架构不支持或 Job 分配失败时 fail closed，不回退到仅观察 PPID 的 managed 声明。
  - provider 及全部后代必须保留 Engine marker，并始终留在 Engine 创建的初始进程组。它们不得使用 `setsid`、`setpgid`、detached、daemonize 或 double-fork；不得遗留后台任务，且必须在输出最终 JSON 和退出前等待全部后代退出。
  - Engine 在运行期观察该合同；发现违反即失败。检查失效时 Engine fail closed：丢弃 grade 并停止 batch。用户态 macOS/Linux 无法对已逃逸且又失去检查的后代保证清理，因此不得盲杀 foreign 进程。
  - credential 递归清理只检查本次 provider 的 `outputDir`；其中的符号链接一律只 unlink，绝不跟随。subject workspace、Eval fixture 和其它 attempt 输入不扫描、不改 mode、也不删除。隔离 runtime home、HOME 和 temp 始终清理。output 脱敏失败时只尝试删除 `outputDir` 并让 attempt 失败；Engine 从已脱敏的内存结果写入 `provider-result.json`。
- `codex-workflow` 是 Engine-owned object provider。Manifest 必须显式提供非空 `command` 和可为空的 `allowedModels`；同一 adapter command 只接收固定的 `prepare` 与 `grade` phase。Engine 使用单一 attempt deadline，先取得有界 WorkflowRequest，再启动一个由 Engine 拥有的隔离 app-server root，且只接受 root thread 的完成事件。Engine 在清理 app-server 和临时 Codex home 前读取 raw rollout，并写入脱敏的 `workflow-evidence.json`、`workflow-trace.json` 和 `model-output.txt`；`skillLoads` 同时记录原生注入的 selected Skill 和显式读取的 `SKILL.md`，并按 thread 与 Skill 去重。grade 只读取规范化 evidence，且只能返回 grade。adapter 继续使用 verified-observed containment，但其环境不含 Codex/OpenAI credential 或 proxy。Windows 在模型调用前拒绝该 provider。
- `WorkflowRequest v1` 可选 `evaluation`，包含有界 `artifacts`、具名 `checks`、`interactions` 和可选 `setupPrompt`。它们是 Eval-owned 输入，不写入被测者的 prompt、角色配置或工作区。每个 interaction 提供语义条件、隐藏答复和受保护产品路径；Engine 复用现有独立只读 grader，实际问题满足条件且观察到的受保护产物未提前改变时才回复对应问题。普通文本问答按相同条件续接，不按回合无条件补答。`setupPrompt` 创建真实前提轮次，测量起点单独记录，不能把导入历史或准备动作计为本轮行为。
- 启用 `evaluation` 的 workflow 使用与 conversation 相同的一层 macOS OS 文件边界：阻止被测进程读取准备输入、其他运行和输出，只开放当前 subject；没有该能力时在被测者调用前拒绝，不静默退回仅按文件名隐藏。网络能力保持开启。未启用此选项的旧 workflow 请求沿用原路径。额外语义 matcher/grader 是真实模型调用，消耗同一 attempt deadline，费用和 usage 计入结果，仍受原 passing Audit 和运行授权门禁约束。
- 交互 workflow 的 evidence 增加 Engine-owned `evaluation`：实际接收事件的顺序、线程身份、有界普通文件快照、实际答复及独立逐项判断。快照不证明两个可观察事件之间没有隐藏写入；缺少读写归因、在途任务接收、判断独立性或固定阶段范围证据时保留 `unknown`。被测进程清理后才做最终独立核对。必需检查缺失、重复、失败或未知时，即使 adapter 返回通过，Engine 也不接纳通过结果；原 adapter 仍只负责 `prepare/grade`，不取得模型凭据，不新增持久恢复状态。
- 默认 Agent-facing 适配器插件是 `aw-skill-eval-runner`，Skill 是 `run-aw-skill-evals`。Runner 负责准备或验证 Spec、复用或取得独立 passing Audit、披露模型调用与副作用、取得所需授权、调用一次 Engine，并验证 Result。`aw skill eval doctor --json` 只用于安装或升级、用户明确请求 provider 环境诊断，或模型已启动后的 run 失败；它报告 permission profile、macOS keychain 状态和 managed/unmanaged 可用性，但不替代执行授权。`aw-skill-eval inspect-result <result.json> --spec <spec.json> --audit <audit.json>` 只在异常结果需要按 case、attempt 和 variant 分组检查时使用；普通成功路径不运行这两个命令。
- Spec 目录和运行输出都是可删除、可重建的弱状态。准备或执行中断后，删除本次不完整输出并重新 `prepare`、Audit 和 `run`；不自动重试，也不维护 batch checkpoint 或续跑 ledger。
- Conversation suite 或 case 可用最小 `environment.pathPrepend` 声明 Eval-owned PATH fixture。路径相对声明它的 Eval 根解析，必须是根内的普通文件或目录树，且不能包含符号链接。Runner 只复制已声明 fixture 到本次隔离 workspace，并只在那里设置 executable mode 和前置 PATH；Oracle 不依赖仓库私有 CLI 路径。声明 `workspace_valid: true` 的确定性 fixture 必须 materialize 后通过公开 `aw catalog status --json`，并让每个预期有效插件通过 `aw plugin validate --json`。该 preflight 不运行模型，也不代替 Oracle Audit。
- `hostSourceAccessAbsent` 只按 app-server 事件中的显式命令、审批和文件访问输入归因。命令输出、Agent 消息、reasoning 和 diff 中的宿主路径文本不是访问证据。
- macOS conversation provider 只使用一层 outer Seatbelt。它阻止宿主源码读取，并按 case 精确实施 workspace 只读或可写边界；turn 使用 `externalSandbox`，因为嵌套 Seatbelt 不可靠。app-server control-plane 和工具执行网络都保持可用，provider capabilities 和每次 evidence 必须公开这个限制。
- Oracle preflight 和 result triage 属于独立 Auditor，而不是 Engine。运行前没有 passing Audit 时不得启动模型。clean success 不要求 triage；只有 execution/grade 失败、current 结果混合、相对 baseline 回归，或结果将驱动生产 Skill 修改时，才在全新上下文做 result-triage。triage 默认返回聊天结论，且不是 Release Check 的机器输入。

## AW Review 准备、只读取证与来源绑定

`aw review inspect <target> [--workspace-root <root>] [--materialization <receipt>]... [--view review|release] [--json]` 为源 Skill、Plugin 或 Catalog 取得当前来源和产物事实，由 `aw.review-inspection.v2` 表示能力。默认 review 视图直接返回必要 source 路径及每个 Skill 的 source、profile、final、digest、证据位置和缺口；不展开内部 join 表或计算无关的 required Eval。release 视图保留完整 subjects、requiredFinals、finalMappings、requiredEvals 和 verified bindings，供 Release Checker 消费。两种视图使用相同的来源核验与产物解析；不保留 inspection v1 输出。

review 视图可用重复的 `--skill`、`--platform codex|claude|agent-skills`、`--scope user|project` 和 `--config <file>` 选择本次范围。单源 Skill 的选择不能静默扩大到 Plugin；动态源按实际 artifact/sourceDirs/renderer 映射，有歧义时明确报错。未指定的 profile 从声明枚举，不猜当前客户端。release 视图只接受完整 Plugin/Catalog 范围，拒绝这些选择参数，不能通过过滤减少 required 集合。

`ok` 表示取证是否完成，不表示质量或发布通过。review 视图完成时，缺失或陈旧 final 保留为 missing/stale，退出码为 0；损坏来源、非法参数或不支持的 profile 返回失败和退出码 2，缺少必要配置返回 3。只有当前已验证的 final 才能为 ready；产物冲突仍是 invalid 和明确问题。release 视图单独保留证据完整性，Checker 要求每个 required final 为 resolved 且有 matched final，不以 inspection 的 ok 推断发布 readiness。

Inspection 不运行 renderer、build、test、模型或网络命令。它复用 Core 的 Workspace/snapshot 校验，发布要求使用官方 Eval parser；不调用会执行 renderer fixture 的 `aw plugin validate`，也不通过可能 bundle 的版本或归档路径取得摘要。binding 自身有效与匹配本次选择分别检查：默认配置不被已有自定义 binding 覆盖；canonical 路径去重，同选择、同 digest 时稳定选择证据路径，不同有效 digest 时报告歧义。相同内容的不同 profile 仍是独立覆盖项。release 消费者用 `{kind}:{id}:{scope}:{inputDigest}` 区分 Eval、Portable 和 Review 的配置身份。

`aw review prepare <plugin-or-source-skill> --platform <platform> --scope <scope> --out <new-dir> [--skill <name>]... [--config <file>] [--workspace-root <root>] [--json]` 由 `aw.review-preparation.v1` 表示能力，一次准备单插件、单 profile 的所选 Skill。它不依赖 Eval，复用 bundle/runtime imports 和所选平台的真实投影；Codex native 使用声明的 shared-user 渲染语义，Portable 必须有自己的 distribution。只请求必要 Skill target，不运行无关非 Skill renderer。配置对象采用 `{plugin: {field: value}}`，只使用 manifest 默认值和已验证的非敏感覆盖，不隐式读取真实用户配置。配置逐键遵守实际 scope：任何 Codex native target 引用的 refresh key 固定为 user，即使该键也用于普通 project Skill；其它键使用所选 Skill 的配置 scope。输入摘要绑定有效值、来源和实际渲染输入。

prepare 可执行本次必要的 build/renderer，在隔离环境和 staging 中生成副本；输出必须是新的安全目录，不得覆盖源码、共享输入、已有产物或真实安装位置。全部所选 final 通过布局、metadata、资源闭包和普通节点检查，且来源及配置在准备期间未变化后，才提交 out。失败只清理自有 staging，并报告实际错误和未清理的 residue；发现 sourceChanged 时不自动回滚源码。成功回执返回实际 Skill 路径、profile、digest 和 sourceBindingPath，可直接开始本次只读审核；跨请求复用或输入改变时重新 inspect。构建/最终包失败退出 1，参数/路径/不支持能力退出 2，缺必要配置或准备期间来源变化退出 3。

必需 Eval 仅来自当前 manifest 的明确声明。没有 required suite 是合法情况，动态 Skill 也不自动增加模型测试要求。Eval prepare 当前提供 Codex 目标；Review prepare 的 Claude 和 Portable final 不自动产生对应平台的 Eval 要求，也不能替代 required Eval。已有必需 suite 无法映射到受支持目标时报告缺口，不静默忽略该要求。

AW Eval prepare、Skill materialize 和 Review prepare 均生成 schema 2 的 `aw-source-binding.json`，公开 receipt 返回其路径。生产者和读取器统一使用 v2；旧 v1 凭据必须通过对应 prepare/materialize 入口在新目录重新生成，不原地迁移或修改版本号。该文件位于被测 Skill 内容之外，绑定实际 Workspace source 或 Catalog snapshot 身份、规范化 profile 输入和生成的 target/相关 workspace 摘要。Review profile 保存 platform、scope、inputDigest 和已验证的非敏感配置覆盖，artifact 使用 review-skill，并按同一选择算法重新核验配置及来源归属。来源身份和内容摘要使用已有机器实现；准备期间来源变化时不发布有效绑定，不重新 build 来验证绑定。文件不保存敏感值，不改变通用 `EvalSpec`、`EvalAudit` 或 `EvalResult` 合同。

Eval 绑定还覆盖所选 suite/default、用例与实际复制的 fixture 输入，并保存准备时的 provider 摘要。消费者通过当前绑定关联 Spec 的 target、cases、workspace 和 provider；完整源 corpus 的 canonical 摘要与准备后选集文件的字节摘要属于不同对象，不能直接比较。

Portable 输出的每个 Skill 保留实际来源插件；依赖 Skill 不能归到根插件。消费者按当前依赖闭包及声明重新检查这项归属。Portable profile 摘要同时绑定有效配置值及其来源；相同值从 user 改由 project 提供时，旧凭据也必须重新物化，因为 Renderer 可以读取配置来源。

来源绑定是可删除、可重建的弱证据，供后续只读消费者重新校验，不是签名、安装 ledger 或运行授权。旧产物缺少绑定时重新 prepare/materialize；检查器不能凭同名路径、有效旧 EvalSpec 或模型填写的字段推断 currentness。检查源码漂移不需要运行被审插件代码，也不新增锁、journal 或恢复状态机。

## 人读 Review、可选 Release Check 与 Review Publication

这三种合同彼此独立：

- **人读 Review** 默认只报告设计、复杂度、findings、未知项和最小改动。质量判断只读 source、final 与 Eval 证据，不计算发布准备度。完整审核请求涵盖必要本地 prepare，先说明 build/renderer 和隔离输出后执行；已有匹配 final 时直接复用。明确禁止执行或仅要求静态读取时保持源码审核；必要 profile/config 未确定时先补齐输入。准备不提供源码修改、模型运行、安装或发布授权。workflow Review 还定义有界的 scope。
- **Release Check** 是可选的 AW-owned machine consumer。只有用户明确请求且环境存在兼容 checker 时，它才对单个 Plugin 或完整 Catalog 生成 `release-check.json` 并拥有 readiness 结论。它只消费 inspection、逐 subject Review 与实际 required Eval 链；没有 required Eval suite 是合法输入，不自动补做模型 Eval。缺少实现或证据时结果为 incomplete 或 unsupported，不由人读报告手工推断 ready。
- **Review Publication** 只归档已经存在的文件，并绑定目标和 digest。只有本次请求的顶层 Reviewer 可以发布其目标；下层 Reviewer 只返回材料，除非用户明确要求多个独立归档目标。Publication 不重新评审、不运行或封存 Eval 执行结果、不更新 README，也不维护可变 index。

Release Checker 显式消费 inspection 的 release 视图并验证 schema/view；CLI 与相关插件需同步升级，不以旧能力名宣称兼容。归档入口仍为 `aw review digest|publish|verify|list|show`，由 `aw.review-publication.v1` 表示。`aw review digest <path>` 为 workflow scope component 提供 canonical production records v1 digest；它只接受仓库内普通文件或目录，并拒绝路径链、目标根或目录树中的符号链接及其它不安全节点。发布只在用户明确要求时执行；使用前先运行 `aw review publish --help` 确认当前参数。

### Immutable record

每条 record 位于：

```text
reports/reviews/<kind>/<encoded-target-id>/<review-id>/
```

文档把稳定编码后的中间目录抽象为 `<target-id>`；实现使用 `id-` 加 target id 的 UTF-8 base64url。`kind` 只能是 `skill`、`workflow`、`aw-plugin` 或 `aw-workflow`。`review-id` 格式为 `<YYYYMMDDTHHMMSSZ>-<target-digest-8>-<report-digest-8>`。

record 最少包含 `manifest.json` 和 `report.md`。schema 1 manifest 只拥有 record identity、`publishedAt`、目标 `{ kind, id, digest }`、report/附件的路径与 digest、source `{ commit, dirty }` 和可选 `supersedes`；它不解释 report、result 或 release check 的语义。可选内容为 machine `review-result.json`、唯一 kebab-case kind 的 `checks/<kind>.json` 与 `evidence/<kind>.json`、`release-check.json`，以及 workflow 的 `scope.json`。JSON 附件必须以 canonical JSON 归档，manifest 的文件清单必须完全匹配实际普通文件。

leaf `skill` 使用静态 Skill 或 `plugin/skill` id，`aw-plugin` 使用插件 production bundle digest；二者不接受 scope。`aw-plugin --target` 可使用 id 对应的默认 `plugins/<id>`，也可使用仓库内其它 plugin root；path chain、root 和 manifest 必须是非符号链接，且 manifest name 必须匹配 root 的 target id。production digest 始终从该实际 root 构建，并使用同一仓库中所需的 provider source set，因此仍绑定 build/generated runtime bytes。实际引用的 direct provider root 必须位于同一仓库内；其完整 path chain、root、`.agents-plugin` 目录和 manifest 都必须是预期的普通非符号链接节点。

`workflow` 和 `aw-workflow` 必须提供 schema 1 `scope.json`，其 `kind`、`id`、用户结果、入口、非空组件和代表性路径、外部依赖及排除项共同形成 target digest；归档后的 `scope.json` 是该 target binding 的 canonical 副本。每个 component path 必须解析为仓库内现存的普通文件或目录，完整 path chain 和目录树不得包含符号链接。component digest 使用与 production tree 相同的 canonical records v1：按 codepoint 排序相对路径，绑定普通文件执行模式和文件 SHA-256；单文件使用 `.` 作为 tree-relative path。发布时必须重算并拒绝伪造或 stale digest。公开 `verify` 验证归档后的 canonical scope、component digest 声明和 target digest 绑定；它不把当前源码是否仍与历史 scope 相同混入不可变记录验证。scope target digest 仍只使用 canonical scope JSON，不混入第二个 target digest 协议。

Catalog composition 与 portfolio 的人读报告写入用户指定目录；它们不伪装成 workflow，也不新增 archive kind。

发布先在同一 target 父目录创建临时 record，写完并验证 inventory/digest 后原子 rename 到不可变最终目录；失败清理临时目录。相同 target digest 与 report digest 只有在 target、report、所有附件、source 和 `supersedes` 都等价时才幂等返回原 record；同一 target/report digest 的不同输入必须失败，不能覆盖。`supersedes` 必须引用一个已验证、同 kind 且同 target id 的 record；它可以引用旧 target digest。`verify` 验证一个 record 的完整 binding 和 digest；`show` 要求全仓唯一 review id；`list` 扫描固定 records 根的 manifest，按 `publishedAt`、`reviewId` 稳定排序，并可按 kind 和 target id 过滤。归档根不计入发布时的 source dirty 检查。

## Release Flow

根级正常发布入口只有 `pnpm release`。它要求 `beta|release` 渠道和 `--cli|--catalog|--all` 中一个显式发布轴。

- `release/version-targets.json` 使用 schema 2，且只保存 CLI 稳定 target。`plugins/marketplace-source.json.catalog.version` 是唯一可写 Catalog version 真值，并表示下一次精确候选。`aw catalog version <exact>` 和 `aw catalog version --bump major|minor|patch` 是唯一公开 Catalog version mutation；bump 以当前 stable SemVer base 为输入。
- `--cli-bump` 更新 CLI target 和五个 public package；`--catalog-bump` 只编排公共 Catalog version mutation；可重复的 `--plugin <name>=major|minor|patch` 更新所选插件。CLI/plugin metadata 和自动 Catalog metadata 使用独立白名单 commit；Catalog commit 精确只包含 `plugins/marketplace-source.json`。没有版本变化时不创建空 commit。
- Catalog beta 版本只读取 source metadata、immutable `catalog-v<version>` tag 和 publication journal。当前 exact version 只有同一 journal plan 时可复用；beta 已使用时在同一 base 选择下一个未使用的 `beta.N`。stable metadata 在 beta 渠道选择该 base 的 beta；stable 发布可以把 beta metadata 提升为同 base stable。
- Plugin beta 和 stable 使用每个当前 Plugin 在目标 branch 的 first-parent 发布历史中最近的 manifest entry。branch tip 已有全部当前 Plugin 时不继续扫描；tip 缺少 Plugin 时，只按需读取更早 snapshot 的 marker 和 manifest，并要求有效 published manifest 和相同 Workspace identity。beta 在历史基线缺失或 stable base 提高时为 `beta.1`；同 base 且相同 `contentDigest` 复用，内容改变则递增 `beta.N`；base 降低拒绝。stable 在 `contentDigest` 改变但 version 未提高，或 version 降低时拒绝。Plugin 移除后重加继续使用删除前的最近历史基线。
- 所选轴无候选时在远端写入前失败。CLI 和 Catalog 远端状态独立读取。Catalog-only 不查询或发布 npm package，不要求 CLI tag，也不执行 provider-side CLI compatibility gate。
- 元数据 commit 后运行所选轴的完整 release verify，再从更新后的干净 source HEAD 生成 `.release/prepared/descriptor.json`。Catalog snapshot 和 publication plan 只读取已提交的 Workspace metadata，并由与 `aw catalog publish plan` 相同的公共 preparation service 生成；publication 不接受独立 Catalog version override。
- 发布顺序是 `Windows x64 → Windows arm64 → Eval → Core → CLI → CLI tag → Catalog`。CLI tag 是 `origin` 上指向 prepared source commit 的注解 `cli-v<version>`；Catalog 继续使用独立 channel ref 和 `catalog-v<version>` tag。
- beta CLI 选择候选时，把 registry 中五个包已出现的最高 beta 和本地已尝试 beta 都视为已占用。部分发布或第一次写入结果不确定后，普通发布保留稳定 target 并选择下一个 beta，再以新 beta 重新发布五个包。稳定 CLI 失败仍要求提升稳定 target。
- `pnpm release -- --repair-cli` 是同一 CLI 候选的显式补发入口。它只接受与 `attempted.json` 精确绑定且未变化的 prepared descriptor、source commit、build 和 tarball；逐包核验已存在的远端 tarball，只发布 registry 明确缺失的包，最后重新核验整组五包并补 CLI tag。内容冲突或查询不确定时停止；它不发布 Catalog。
- `pnpm release -- --repair-cli-tag` 只从有效 prepared descriptor 核验并补发 CLI tag。它不准备新候选或修改分支。

`.release/prepared/` 在 gitignore 下，是可删除的弱状态；删除后重新 prepare。`.release/attempted.json` 只服务 CLI/npm 安全门禁。Catalog 使用 schema v2 `.aw/publish/<version>/journal.json` version-scoped journal；pending 隔离 repo 位于同目录的 `repository/`。状态是 `prepared | uncertain | published`。journal 是强恢复和门禁状态；pending repo 是同版本恢复必须保留的暂存 artifact。新 plan 先在同父 `.<version>.<uuid>.tmp/` 写完并核验 journal、repo 和授权绑定，再单次原子 rename 为版本目录。失败只清理本次 temp；正式目录的并发等价 plan 幂等返回，不同 plan 要求提升版本。旧 `<version>.json` 和 `<version>.repo` 不参与读取或迁移。

对于 `prepared` 或 `uncertain`，journal 或 repo 任一缺失或损坏时，停止并提升版本，不得盲目重建或复用该版本；`published` journal 缺失时，远端 immutable tag 仍占用版本。相同 journal plan 可以对账或续跑。发布成功时先原子写 `published` journal，再尽力删除 `repository/`；安全清理失败只产生稳定 warning，不覆盖已核验的远端成功事实。

Catalog 的公开 surface 是 `aw catalog publish plan` 和 `aw catalog publish apply --expected-plan-digest <digest> --yes`。plan 展示最终 Workspace identity、source HEAD、remote identity、branch、parent、tag、snapshot digest 和 `expectedCommit`。`planDigest` 是 canonical `{ descriptor, expectedCommit }` 的摘要；snapshot `.aw-generated.json` 的 `workspaceIdentity` 必须显式等于 descriptor identity，因为 marker 不进入 snapshot digest。apply 只用 digest 在 `.aw/publish/*/journal.json` 中唯一选择 schema v2 journal，不读取当前 metadata version 定位。它重新核验所选 Workspace identity、remote identity digest、branch、授权摘要、pending repo 和远端 refs；不要求当前 HEAD、clean state 或 metadata version 仍等于 plan，也不重新 build 或 validate source。remote alias 名称可变化，但 identity digest 和 branch 不可变化。publisher 保留 annotated tag、branch lease、atomic push 和 post-verify。两 ref 都正确即成功；都不存在时 atomic push；仅一条缺失时补写；冲突时停止。CLI tag 推送异常时先读取远端；预期 tag 已指向 source commit 即成功，缺失时用 tag repair 补发，冲突时停止。

Catalog publication 的 JSON 失败合同统一为 `{ ok: false, code, message }`，退出码为 1。inspection typed error 保留原 code；其它 journal、repository 或 remote error 使用 `catalogPublicationFailed`。Git transport 失败在 message 中保留退出 code 和经过脱敏、压缩及长度限制的 stderr。JSON message 和普通 stderr 使用同一脱敏文本，不包含 Workspace、AW_HOME、publication repository、临时目录的绝对路径，也不包含 remote credential、query 或 hash；稳定 Workspace identity、ref 和 version 信息可以保留。

## Key Paths

- `packages/cli/scripts/bundle-plugins.ts`：生成 catalog snapshot。
- `packages/cli/scripts/plugin-staging.ts`：生成 Catalog staging 内容。
- `scripts/release/prepared-release.mjs`：生成、验证和消费本地 prepared release。
- `scripts/release/release.mjs`：一键发布公共编排入口。
- `scripts/release/cli-git-tag.mjs`：CLI source tag 检查、发布和恢复。
- `scripts/release/catalog-publication.mjs`：把官方 channel/remote 参数交给 CLI 公共 Catalog publisher。
- `packages/cli/authoring/`：随 CLI 发布的确定性插件作者实现。
