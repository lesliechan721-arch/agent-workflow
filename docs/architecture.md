# Architecture

本文件定义 CLI 的稳定产品合同和模块边界。TypeScript 实现方式见[编码约定](coding-conventions.md)，测试选择见[测试指南](testing.md)，单 Plugin Source 见[插件作者指南](plugin-authoring.md)，官方与第三方共用的 Catalog Workspace 见[Catalog 作者指南](catalog-authoring.md)，本仓库维护流程见[插件维护指南](plugin-maintenance.md)。

公开包 `@lesliechan721/aw-plugin-core` 拥有 plugin manifest 的版本、JSON Schema 和运行时结构验证合同。CLI 依赖同版本 core，并在该结构合同之上提供平台 adapter、Catalog、作者工具和 transport。Eval、core 与 CLI 使用同一版本发布，顺序为 `Eval → Core → CLI`。

## 设计边界

- AW 是个人本地工具。一个 `AW_HOME` 写锁足以保护强配置；不要为未证明的并发增加全局协调协议。
- Catalog 是公开产品，支持 Git 和本地路径等多个来源。来源独立解析、独立报告错误；一个来源失败不要求其它来源回滚，也不要求 npm 与 Git 形成强一致事务。
- `catalog-sources.json`、`catalog-state.json` 和 plugin config 是强配置。它们必须以原子替换提交。普通配置和 owner marker 写入只在 allowed root 内检查现有祖先的 symlink/type，使用同目录独占临时文件，关闭后 rename。version-scoped publication journal 是强恢复和门禁状态，也必须原子写入。插件输出、依赖现场、Catalog store snapshot 和 release prepared 目录都是弱状态，可删除和重建。
- 外部平台和用户编辑的插件目录不受 AW 完全控制。写操作应提供可观察结果和恢复入口，不建立无法兑现的全局补偿或完全正确保证。
- 正式 `pnpm build`、`build:ensure`、release verification 和 build snapshot 始终使用 release 强缓存、clean build、generation stamp 和完整输出摘要。日常 `build:dev` 使用可删除的四目标弱缓存，分别处理 Eval、Core、CLI TypeScript 和 plugin bundle；损坏时只重建受影响目标，不建立发布状态。

## CLI Source Layout (`packages/cli/src`)

- `commands/write-commands.ts` 是 `install`、`sync`、`reinstall`、`uninstall`、`cleanup` 的统一写入口。
- `commands/rebuild-command.ts` 解析当前 Catalog、依赖和现场状态，并交给统一 rebuild 流程。
- `commands/rebuild-operations.ts` 编排 ownership 检查、清理、平台写入、完成后检查和 postApply。
- `commands/rebuild-integration.ts` 把插件能力转换成平台原生写入和 AW-owned 组件。
- `commands/status-v6.ts` 读取多来源 Catalog、live ownership 和平台组件，生成 Status v7 和控制台输入。
- `commands/dependency-operation-plan.ts` 只生成一次命令内的依赖执行顺序；它不是持久安装记录。
- `commands/operation-plan.ts` 只拥有 Review fingerprint 和 Receipt 中的已确认动作描述；rebuild executor 不执行该描述。
- `utils/ownership.ts` 定义 owner marker、组件检查和安全删除边界。
- `utils/multi-source-catalog.ts` 解析 Catalog Sources Config v2 的 Git/path source，并读取本地 Catalog store 中的 Active snapshot。
- `utils/plugin-config.ts` 与 `utils/plugin-config-write.ts` 管理 namespaced AW config store v3 和 config v4 输出。
- `output/command-receipt.ts` 生成五个写命令的 Receipt v6。
- `authoring/` 是确定性作者实现；它随 CLI tarball 发布，运行时不读取仓库 `.agents` 或插件 Skill root。公开作者命令统一以 `--workspace-root` 定位任意本地 workspace；基于 Git base 的 status 差异检查和安全删除依赖 Git。
- Core 的 `plugin-authoring-capabilities` API 是 manifest 字段、类型、必填项和 accepted values 的稳定结构 registry。CLI 只叠加 requires、conflicts、profiles 和 validator provenance 等执行/作者适配事实，并通过 `aw plugin capabilities [--surface <surface>] [--json]` 在运行时公开组合结果。
- Core 的 AW capability registry 定义稳定 ID、集合规范化与摘要、Manifest 结构派生、受限生产源码扫描和 schema 1 runtime requirements receipt。`effective` 是 `declared + derived`；`detected` 只给作者提示。扫描器只检查 `SKILL.md` 中独立 shell fence 和 Manifest executable entry；不扫描 inline command、reference、任意脚本或 Node transitive closure。第三方公开 `aw catalog build` 默认只 advisory；官方 `pnpm build` 必须使用 `--strict-requirements` 语义，把不匹配变为阻断，且 `release:verify:catalog:core` 通过该 build 覆盖此门禁。未登记但语法合法的 ID 是可交换数据；是否支持只由当前 executable 的实现集合决定。`aw self describe --json` 公开该集合，`aw self check --json` 从最近的 receipt 或 Manifest 检查兼容性，`aw plugin requirements <plugin-directory> --add/--remove <capability> --json` 只修改 `requires.aw.capabilities`，并计算 declared、derived、detected 和 effective requirements。Plugin Manifest v3 要求显式 `schemaVersion: 3`。

公开包 `@lesliechan721/aw-plugin-core` 还拥有 Catalog Workspace v1 marker 与 metadata、单插件 bundle 和 schema 7 Catalog snapshot build/validate 的机器合同。固定源码入口是 `.aw-workspace.json`、`plugins/marketplace-source.json` 和 `plugins/<name>/.agents-plugin/plugin.json`；metadata 的 `catalog.version` 只允许稳定 `x.y.z` 或精确 `x.y.z-beta.N`。CLI 只负责参数、输出、安全目标选择，以及注入 build/test adapter；Core 不读取 `AW_HOME`、安装状态、TUI 或 Git transport。

### Module Invariants

- renderer context 使用规范化的非空 `requestedArtifactIds` 精确限定本次请求；`config.schema/values/sources/issues` 和 `changedConfigKeys` 只包含这些 target 的 `refreshKeys` 并集。context 不公开 config store 路径，且 context 中的 home 与 renderer 进程的 `AW_HOME`、`AW_CODEX_HOME`、`AW_CLAUDE_HOME` 都指向本次请求的临时目录。renderer 只返回与请求集合精确相等的 `ArtifactPlan`，不直接写平台文件。AW direct writer 不请求 `codex-native` target。
- build-generated Skill reference 必须由 `buildConfig.generatedSkillRuntimeFiles` 精确声明。源码 validation 不把声明目标误报为缺失；最终 bundle 必须生成目标并通过完整 runtime closure。
- 写入前验证 scope、路径边界、目标身份和最终 Skill tree。
- Dynamic `codex.skill` 必须显式选择 `aw-extension` 或唯一受支持的 native delivery `{mode:"codex-native",identity:"shared",renderProfile:"user"}`。native delivery 是 Codex-owned dynamic Skill，scope 和名字来自 target；其 refresh key 只能在 user scope 写入，不能引用 sensitive 顶层字段或含 sensitive fixed/KV child 的 object 字段，project scope 的 set 必须拒绝，且不能与静态 Codex Skill 同名。同一插件 identity 的所有 Codex native 组件必须声明完全相同的 scope 集；静态 Skill、MCP、Hook 和 App 固定为 `{project,user}`，dynamic native 使用 target scopes，slash command 不属于该集合。config 只作为 surface 输入，不计入 Codex output owner 或冲突。
- Codex native dynamic projection 在 payload 内使用固定 `.agents-plugin/aw-codex-native-render.json` receipt。schema 1 的 kind 是 `aw-codex-native-render`，strategy 固定为 `shared-user`；它只保存 logical plugin/source/version、renderer、规范化 target identity、per-target config/artifact digest、聚合 config/render-input digest 和排除 receipt 自身后的 payload digest，不保存原始 config。所有 `codex-native` target 的 ID 与 Skill key 在整个 shared projection 内分别全局唯一，不受 scope 是否重叠影响。target 按稳定 ID 排序。AW 用完整 user effective config 的 sensitive leaf token 扫描最终 Skill tree 和序列化 receipt；命中时在 marketplace commit、Codex remove/add 和 activation 前停止。receipt 是可重建的 projection evidence，不是 installed ledger。
- 插件依赖只来自 manifest `dependencies`，只在同一 source 内解析。依赖图拒绝缺失节点、环和超出既定上限的图；执行顺序是稳定的依赖优先拓扑序。
- live ownership 和实际平台组件是插件存在、清理和 status 的唯一真值。不得新增安装合同存储、第二套安装状态或持久依赖图。
- 配置写入、生命周期和平台写入各自保留最小的本地恢复；它们不组成跨第三方系统的事务。
- `aw-plugin-development` 不在构建时绑定 CLI registry，也不分发 capability Markdown。已安装 Author 从当前 PATH 查询 `aw plugin capabilities`，因此旧 development plugin 可以使用较新的 CLI 能力合同。
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
- Manifest v3、Catalog snapshot v7、config envelope v3、owner marker/token v3、Intent v2、Status v7、Receipt v6、Catalog generation status v2、Catalog dev status Receipt v4 和 Catalog dev deactivate Receipt v3 是 beta hard cut。旧状态不读取、不迁移，也不自动删除。推荐使用新的 `AW_HOME`；如需保留旧环境，先用旧 CLI cleanup，再用新 CLI 重建强配置。

### Portable Agent Skills Distribution

`agent-skills` 是独立 distribution，不是 `PlatformName`，也不改变 marketplace product eligibility。插件通过 `distributions.agentSkills` 显式声明该能力；原生 `skills` 不自动成为 portable source，也不支持 portable-only plugin。每个 materialized Skill root 都包含同一插件级 `aw-plugin-requirements.json` receipt；同层 receipt 优先于祖先 Manifest。

Catalog build 把 portable static Skill、明确选择 `distributions: ["agent-skills"]` 的 `skillRuntimeFiles`，以及 dynamic artifact 的 `runtimeImports` 复制到 consumer bundle。runtime import 带 bundle-local path、digest 和 provider provenance；materialize 运行时不读取其它插件 bundle，也不导入其它 renderer 的输出。

Manifest v3 的每个 `buildConfig.runtimeExports[]` 必须由 Provider 显式声明 `{ name, source, requires: { aw: { capabilities: [] } } }`；旧的 `{ name, source }` 形状无效。Core 使用统一 capability ID 规范化和稳定 digest 校验 metadata，不扫描 export bytes 推断或双检。只有实际用于 `skill-runtime-file` 或 `artifact-runtime` 的 export capability 传播到 consumer；`buildImports`、自有 `skillRuntimeFiles.source` 和 `generatedSkillRuntimeFiles` 不传播。Bundle 先解析实际 runtime import，再把 source/staged `requirements.effective` 与传播集合合并成唯一最终集合；同一集合写入 bundle manifest、Catalog entry 和所有 native/portable Skill receipt，并在最终 bundle 写入前检查当前 AW 支持。export metadata 即使 bytes 不变也属于 import/projection identity。

Portable materializer 使用调用方提供的同 source Catalog plugin set，解析依赖优先的完整 closure，读取现有 scope config，并合并 static 与 `agent-skills.skill` dynamic entries。合并顺序是 `sourceDirs → distribution skillRuntimeFiles → renderer content.files`。任何无效 Skill、名字冲突、未解析模板或 sensitive config 明文都阻止整次输出；portable 与 Codex native projection 复用同一 sensitive 明文匹配规则。物化只使用操作级临时目录，并写 schema 1 `.aw-materialization.json`；它不创建 installed state、持久安装状态、Agent registry 或新锁。

`aw skill install` 先物化和 Review 完整候选，再通过 PATH 中兼容的 `skills >=1.5.23 <2.0.0` 执行 scope-wide 冲突预检、`skills add ... --yes` 和完成后验证。确认后的执行复用单一 `AW_HOME` mutation lock，并重新采集 Catalog、config、物化、版本和冲突证据；外部安装失败或验证缺项不做补偿回滚，receipt 提供重跑或外部 `skills remove` 恢复方式。project scope 在解析的项目根运行，user scope 使用 `--global`。

`aw skill materialize` 在同父目录 staging 中验证所选输出，再替换仅由相同 plugin ID、source identity 和 scope 的 schema 1 marker 证明属于 AW 的目标。foreign、身份不匹配、符号链接或过宽目标都 fail closed；命令不提供 force，也不创建 portable installed state。

TUI 在插件预览和详情中只根据 `distributions.agentSkills` 声明显示 Portable 能力，不提前运行 renderer 或声明精确候选数和安装 ownership。用户进入安装流后分别物化 project 和 user 的完整依赖闭包，以两者的稳定候选并集选择 Skill 和 Agent，再选择 scope；选择 scope 后按该 scope 重新物化，所选 Skill 在该 scope 不可用时阻止进入 Review。Review 只显示所选 scope 的实际候选、依赖贡献和冲突。执行复用 `aw skill install` 的锁内证据重采集，证据变化时必须回到 Review 重新确认。

## Catalog Sources

Catalog snapshot 的 logical identity 只来自 `.aw-generated.json.workspaceIdentity`。source ID、Git URL、SSH/HTTPS 文本和本地 path 不是 logical identity。

`catalog-state.json` 只为每个 source 保存 `Active` 和 `lastSync`。`Active` 绑定 logical identity、snapshot digest 和 Catalog store 目录。store 的唯一布局是 `<AW_HOME>/catalog-store/<sha256(UTF-8 logicalIdentity) hex>/<snapshotDigest hex>/{metadata.json,snapshot/**}`，metadata 保留原 logical identity；它不读取或迁移旧 URI identity 布局，也没有 current、last-good、Candidate、Previous、发布版本记录或 refresh policy。

手工 store 维护入口是 `aw catalog store status [--json]` 和 `aw catalog store prune [--dry-run] [--yes] [--json]`。status 和默认 dry-run 严格只读，不取得 mutation lock；`--dry-run` 与 `--yes` 互斥，只有 `--yes` 执行删除。实际 prune 使用现有单一 AW_HOME mutation lock，并在锁内重读合法 `catalog-state.json` 和重新枚举，永不复用锁外删除计划。对每个初次判定为可回收的 item，prune 在实际删除前再次确认当前节点身份、类型、store key/metadata identity、Active 引用和 retention evidence；证据漂移或 rename 失败时保留 item，并报告 `staleBeforeDelete`。重新确认通过后，prune 先把该精确节点原子 rename 为同一安全 identity 父目录下、本次 item 唯一的 `.delete-<uuid>.tmp` claim，并把 claim 根 mtime 设置为本次 claim 时间；时间更新失败时安全恢复原路径并报告 `staleBeforeDelete`。只有 claim 与已确认节点和父目录身份仍匹配时，才递归删除 claim。state 缺失表示无 Active；state 存在但损坏或 schema 无效时 fail closed。Active 永不删除。通过完整 store 验证的非 Active 正式 entry 只有在整棵安全树的最新 mtime 超过 30 天时可回收；严格命名的 `.staging-*` 和 `.replacement-*` 在超过 24 小时时可回收；`.quarantine-*` 还必须从自身 metadata 确定 canonical key，且对应正式 entry 存在并通过完整验证。严格命名的 `.delete-*` claim 也是可重建弱状态，只有根为普通目录、整棵树安全且最新 mtime 超过 24 小时时才可由后续 prune 重试；不满足条件的 claim 保留。任何 symlink、unsafe 或未识别 node、严格布局外内容、读取或验证失败都保留。可回收 bytes 只累计安全普通文件；读取失败为 unknown，不按 0 处理。单项 claim 删除失败后继续其它已安全分类项，并在重新检查后让 `entries`、`retained` 和 `errors` 使用实际 claim 的相对 store key、`deleteClaim` category 和当前 retention 状态；claim 已不存在时按删除成功处理。失败 claim 保留，可再次运行 prune。公开 schema v1 只含相对 store key 和脱敏原因，不含 AW_HOME 绝对路径。该命令不提供自动 GC、配置、read lease、引用计数、后台任务、迁移、额外锁或持久账本；删除的弱 snapshot 通过 source sync 重建。

公开入口是 `aw catalog source sync <id> [--check] [--yes] [--replace-damaged]` 和 `aw catalog source status [id]`。source status schema v2 为每个来源返回同一 Active capability compatibility 投影：无 Active 或 store 无法健康验证时为 `null`，支持时为 `supported`，不支持时为 `unsupported`，并只公开 `requiredCapabilities` 和 `missingCapabilities`。unsupported Active 不算 ready。纯 probe fetch 并执行完整的 snapshot transport validation，不解析未选择的 Plugin bundle；它返回绑定 source config、source identity、logical identity、ref、commit、version、channel 和 digest 的 candidate evidence，清理 staging，不写 store、Active 或 state，也不持有 AW_HOME mutation lock。`sync --check` 使用 probe，返回脱敏的 source impact，且只在短锁内更新 `lastSync`。普通 `sync` 锁外重新 resolve、验证、首次检查影响并发布 content-addressed store，再在短锁内重读 source config、expected Active 和必要 store evidence，重新采集影响，执行共享 activation policy，并原子切换 Active 和 `lastSync`。若同 key 的旧非 Active entry 已损坏，publication 先从已验证候选准备 replacement，再在现有 mutation lock 内重验 entry 和合法 generation state；仍无任何 Active 引用时才 quarantine、替换并验证。并发 writer 已修好时直接复用；key 已成为 Active 或 state 无效时保留旧 entry 并 fail closed。该自动恢复不要求 `--replace-damaged` 或 `--yes`，但候选本身的真实 impact 仍使用普通确认规则。CLI 的确认门禁使用锁内最新影响；TUI 把已确认影响的稳定 digest 绑定到 Review evidence，锁内影响变化时返回 typed stale。policy 模式是 `normal | explicitSourceChange | exactRepair | replaceDamaged`。Git normal 对相同 digest 保持 Active，只允许更高版本；同版本不同 digest、较低版本和 logical identity 变化返回 typed error。Path normal 允许内容变化。`explicitSourceChange` 必须由 service 核验当前 source fingerprint 或 identity 确实不同于 Active，才可接受已确认的版本冲突、回退或 logical identity 变化。所有 sync、refresh、TUI generation 和 dev activate caller 都经过此 policy。失败保留原 Active。普通 install、reinstall、uninstall、config、status、TUI 初始 load 和 Portable 命令只读取 Active store；`aw sync --refresh` 只刷新所选 intent root 涉及的来源。没有 Active 时 CLI 提示运行 source sync，TUI 提供显式获取或修复入口。`cleanup` 和 `cleanup --force` 不读取 Active，只凭 live ownership 或离线 evidence 清理 AW-owned 输出；source 或 store 缺失或损坏不能永久阻止 cleanup，且两者保留 foreign 或 shared 内容。

`aw catalog source add` 和 `update` 只原子修改 source config，不同步也不改 Active。相同 ID 的 add 只在 config 当前不存在时先清理 orphan state；清理失败则不提交 config。`remove` 在有引用或影响未知时要求 `--yes`，再原子提交 source config，并 best-effort 清理该 source 的 state；清理失败只产生 warning。普通 remove 继续拒绝删除 primary；内部 development caller 可同时提供一个不同且现存的 replacement primary，使删除目标 primary 和设置唯一 replacement primary 成为同一次纯 config transform 和原子替换。最后一个 source 始终不能删除。remove 和 source identity change 在同一个 source mutation lock 内重新采集影响；CLI 使用最新影响执行确认门禁，TUI evidence digest 变化时不提交 config。它不删除其它 store snapshot、插件内容或 live ownership。共享只读 source impact inventory 分类 installation、config、lifecycle intent 和 marketplace。它扫描 user state、当前 project state、平台全局注册及平台自身可枚举的历史 project 记录，不扫描未知 project。普通 inventory 默认不包含平台历史 project；impact 检查显式包含。公开 receipt 和 TUI 只投影 source/plugin/platform/scope、当前或历史 project 分类，不公开绝对路径。读取失败时 `inventoryComplete=false`，影响为 unknown，不能按零处理。current/candidate manifest 都可用时，impact 计算 added、removed、changed、newly incompatible 和 dependency changed plugin；generation 只把 removed、newly incompatible、dependency changed 及其传递 consumer 的现有引用列为 affected。remove 或 source identity change 使用该 source 的全部引用。user 和 current-project config 引用保留各自 scope，不能因 plugin ID 相同而合并。

Active state 有效但 store 缺失或损坏时，Git exact repair 使用当前 transport 配置和 `Active.resolvedCommit` 获取旧 snapshot，并验证 logical identity、snapshot digest、manifest digest 和 resolved commit 全部匹配；它不持久修改 source config。TUI repair 成功后停止，CLI source sync 修复后继续 normal sync 当前候选。旧 commit 不可取得，或 Path 当前内容不是旧 key 时返回 typed replace-required。`replaceDamaged` 绑定 expected Active、candidate 和 source config digest，在短锁内确认旧 entry 仍损坏，并只跳过无法完成的版本比较；除非同时核验 source config 确实变化，否则仍拒绝 logical identity 变化。精确 repair 对同 key 的损坏条目只 quarantine 和替换该条目，失败则恢复原目标，cleanup 失败只产生 warning。没有自动 GC、Candidate 持久状态、项目注册表、新锁层级或新恢复状态机。

Git provider 保持非交互，并保留 timeout、protocol/ref/temp validation、credential URL 拒绝和诊断脱敏。`AW_CATALOG_REMOTE_TIMEOUT_MS` 只接受 `0` 或 `100..300000`；默认 full resolve deadline 是 180000 ms，ref probe deadline 是该值与 30000 ms 的较小值，`0` 对两者都表示无 deadline。单次 ref probe 和单次 full resolve 各自共享本次操作的 deadline；probe 后继续 full resolve 时重新建立 full deadline。消费端定向清理危险的 repository、worktree、index 和 object 环境变量；它保留 credential helper、SSH agent、自定义 SSH、proxy 和 `insteadOf`。AW 不保存 Catalog credential。

`aw catalog dev activate` build、complete validate、注册 managed Path source 并 sync；影响现有引用或影响未知时需要 `--yes`。`aw catalog dev status` 只读取 snapshot、source/path 和 Active digest；Receipt v4 的 `active.compatibility` 直接使用 generation status v2 的同一投影。无 Active 或无法判定时为 `null`；unsupported Active 使 dev status 不 ready，但结构损坏仍单独报告 repair-required 错误。`deactivate` 不删除 `.aw/catalog`；它先对仍为原 primary 状态的精确 managed Path source 执行 remove impact preflight，并核对 Workspace ownership。存在引用或 inventory 不完整时要求 `--yes`；`--source-id` recovery 无条件要求 `--yes`。执行绑定 preflight 的 config 和 impact digest；进入现有 AW_HOME mutation lock 后重新核对 source、managed owner、replacement 和 impact，漂移时在写入前返回 typed stale。primary development source 的删除和 replacement primary 切换只通过一次 `catalog-sources.json` 原子替换提交；generation state cleanup 在提交后 best-effort 执行。Catalog dev deactivate Receipt v3 必有脱敏的 `impact`；完成 preflight 后的成功、确认失败或执行失败返回 inventory，source absent 或 Workspace/config 无法完成 preflight 时为 `null`，且不得公开路径。失败不建立补偿事务，用户可修复 source、再 sync 或重跑 activate/deactivate。

## Write Pipeline

需要 Catalog 的四个公开写命令使用同一条 rebuild 流程：

```text
固定 Active snapshot 和目标
  → 生成临时依赖顺序与期望组件
  → 检查 live ownership
  → 仅为实际 Codex native 操作解析执行 manager
  → 必要时清理 AW-owned 旧组件
  → 写入原生和 AW-managed 组件
  → 完成后检查
  → 运行 postApply
  → 输出 Receipt v6
```

这四个命令在 `AW_HOME` mutation lock 内只采集一次当前 target 和当前 project 的现场 inventory。Active snapshot、marketplace 选择和 dependency plan 复用该内存 snapshot；执行不为计划再做第二次全量 inventory。计划完成后，writer 只对计划中的目标重新构建并检查 live ownership、native registration、有效 config 和固定 snapshot evidence。普通 inventory 不扫描历史项目、不建立全局 refcount，也不执行自动 dependency GC。

`cleanup` 和 `cleanup --force` 使用彼此独立的 offline cleanup 流程。普通 cleanup 只读取 live ownership 或已绑定的 offline evidence。force 只组合 live 可证明的专属路径与必要的本地 Active 所选 plugin bundle shallow evidence，并只 quarantine-delete `skill-directory` 或 exclusive `owned-text-file`。force 不调用普通 offline cleanup executor，不删除 activation、native registration、marketplace、shared config 或旧 installation contract。两者都不生成 Catalog dependency plan、不读取 dependent、不修改 Intent，也不进入上述 rebuild pipeline；force shallow discovery 只验证强 Active/store 边界、所选 entry 与所选 bundle，不完整验证其它 bundle，不解析 dependency，也不运行 renderer、native manager 或 postApply。

性能观察复用现有 debug event。`review.prepare.*` 记录 Review 准备阶段耗时；`performance:stage` 只记录 `catalog.load`、`catalog.validation`、`inventory`、`dependency.plan` 和 `target.build` 的阶段名与耗时，命令阶段另记录结果，Catalog load 另记录聚合 source/Active/validation 计数，不记录 digest、路径或错误文本。`native:start|success|error` 只记录白名单 `agent`、稳定 operation、`exitCode`、固定 reason 和 `durationMs`，不记录 args、cwd、stdout、stderr 或未知 error/cause 文本；`rebuild:action` 分别记录 `inspect`、`native.write`、`artifacts.write` 和 `postcheck.inspect` 等真实写阶段耗时。没有 native 或 artifact 动作时不伪造对应阶段。测试用 provider 调用次数、检查范围和阶段事件验证 write 性能边界。Warm install 的总时长只对受控 fake native runner 使用宽松门槛；本地 Catalog 阶段 p95 目标为 500ms，不能据此承诺第三方 CLI 时长。

首版不增加 authoritative installed-state DB、GC/read lease、新锁层级、全局事务或补偿状态机。Active snapshot 已是不可变内容寻址目录，操作直接引用它；当前可观察的重复 inventory 可以用操作内 snapshot 消除。这些事实不足以证明新增持久状态和协调协议的成本合理。

TUI 的所有写入口在进入 Review 前先进入 `ReviewPreparing`。普通 `ReviewPreparing` 只执行当前 intent 的验证和证据采集，不执行写入。用户显式选择“刷新并同步”是唯一例外：它在建立插件 Review 前刷新相关来源，并可切换可重建的 Active 弱状态；Esc 只取消后续 Review 和插件写入，不回滚已完成的 Active 刷新。一次成功的 TUI load 固定可用来源的 Active snapshot 子集，并保留其它来源的失败证据；子集 digest 只包含成功来源。同一 session 的浏览、设置、status、依赖 preview 和 Review 都读取该固定子集。load 只读取 source config、catalog state 和 Active store；它不 fetch 或同步，并在本地读取完成后立即进入 ready。页面只显示实际已开始的 status、Catalog、inventory、dependency plan、config、Portable 或 evidence 边界，并在 debug 日志记录阶段耗时。可用 Esc 协作式取消。取消会使迟到的只读结果失效。底层不支持 signal 的读取可以结束，但不能再创建 Review。准备成功时，Review 原位替换准备页，因此 Back 返回原页面并保留其选择或草稿。

插件安装主链固定为：选择根插件 scope，使用 Enter 选择至少一个目标平台并显式确认，只在计划含可配置依赖时编辑 dependency placement，然后进入 `ReviewPreparing` 和 Review。根插件 scope 不在依赖页重复编辑。依赖草稿按 `(pluginId, platform)` 保存 project 或 user 选择，并显示默认 project、健康 user 复用和 fixed-point 提升原因；user 选择必须说明它会影响其它项目或用户环境。返回 Review 前的页面时保留适用草稿；根 scope 或平台集合变化后确定性重算，并删除不再适用的 key。键盘合同继续使用当前焦点、Enter、Esc 和显式确认，不用 Space 切换选择。

TUI 初始 load 不访问网络，也不等待 freshness 检查。进入 ready 后，每个 session 只为 `autoCheck` 开启的 source 自动检查一次：primary 先开始，其它 source 最多并发两个。关闭 `autoCheck` 的来源只在用户显式检查时 probe。自动检查和“重新检查”使用轻量模式：健康 Git Active 先只解析远端 ref；ref 未变化时不 fetch，固定 commit 标记为 fixed 且不联网；ref 变化时才 fetch 并执行完整 transport validation。来源详情的“完整验证”强制完整 resolve。没有 Active、Active 损坏、repair、replaceDamaged 或 state recovery 也始终完整验证。Path source 在本地完整验证候选。检查结果只进入 session-private overlay，不修改 Status v7、Active、固定的 session Catalog 子集、插件列表或 target revision。远端失败只显示 `checkFailed`，健康 Active 仍可浏览。reload 不重复全量检查；来源详情的检查只处理目标 source。退出会取消所有 probe，session、token 和 source fingerprint 共同拒绝迟到结果。

TUI generation 使用 generation status v2 的 Active compatibility 投影。健康但 unsupported 的 Active 显示为 `incompatible`，技术详情显示 required 和 missing capability ID；不显示 available capability 全集，也不把该状态显示为损坏或提供重新下载修复动作。

候选 snapshot digest 相同时状态为 current；commit 变化只作为 provenance。Git 候选版本更高时提示更新；相同版本但 digest 不同为 version conflict，较低版本为 rollback，logical identity 变化或能力不兼容也阻止普通更新。能力诊断只从 typed compatibility error 投影 required 和 missing capability IDs；主视图只显示缺失数量，技术详情显示 missing IDs，不显示当前 AW 的 available 集合。候选不兼容时旧 Active 保持可用，普通 update 不出现，轻量检查和完整验证都保留相同结构诊断。版本比较复用 strict SemVer。Path digest 变化显示本地内容变化。TUI 只提示候选，绝不自动切换 Active。用户可从来源详情显式获取并启用、重新下载并精确修复、验证并切换，或使用当前候选替换无法修复的损坏 Active。更新成功只表示 Active Catalog 已切换；已安装插件不会自动升级，TUI 重新计算可用的插件升级。背景检查取得的完整 candidate 和 Manifest 只可在当前 TUI session 内复用于普通 activate/update Review preparation；复用绑定当前 session/token、source config fingerprint、明确为 null 或具体 key 的 Active store key，并要求完整 evidence。source mutation、repair、replaceDamaged、state recovery 或任一 binding 变化都回退到重新 probe。该 overlay 不持久 Candidate，不写 store 或临时 snapshot，也不改变 Status 或 Active。Execute 始终重新解析 candidate 并逐字段比较 Review evidence；变化时返回 `catalogGenerationReviewStale`。add/update 的主路径先按 Review config digest 保存配置，再启用确认的候选；配置成功但启用失败时保留新配置，并在 TUI 提供重试。generation state 无效时，TUI 可经独立 Review 原子重建只含目标 Active 的有效 state；它不修改 source config 或删除 store，且不信任无效 state 中的其它指针。Active store 损坏时，精确 repair 始终以强 Active state 为目标，并保持 Active 的 source fingerprint 和 provenance 不变。只有 metadata 和 snapshot 完整匹配时，弱 store entry 才能提供可信旧版本；任一不完整时不得声明 version conflict 或 rollback。旧版本不可用时，普通恢复或 update 在写 state 前阻止，并保留当前 Active；用户必须进入独立 replace Review。未保存的 config/source/Portable 草稿、ReviewPreparing、active Review 或写入进度阻止开始 Active 切换或 reload；freshness probe 可以完成并保留 session 结果。

Review 仍是用户确认边界。插件 Review 按 Project intent、User intent、Shared Codex native、User activation、Project activation 和 AW extensions 分层。直接 CLI `--yes` 与 TUI 使用同一个 `requiresConfirmation` 和 `sharedImpact` descriptor；shared replace 或 reinstall 必须说明它可能影响其它项目。Review evidence 包含 Active snapshot digest。用户确认后才进入 `Progress` 并开始插件或配置写执行；`Progress` 不接受 Esc 取消，只能按现有约定请求在操作完成后退出。`ReviewPreparing` 的可取消准备状态和 `Progress` 的已接受写状态不得共用 busy 或取消语义；除上文明确的“刷新并同步”弱状态刷新外，准备阶段保持只读。Execute 在同一个 `AW_HOME` mutation lock 内重新读取 Active snapshot，验证 metadata 仍存在并比较 Review digest。Catalog generation Execute 也在该锁内逐字段匹配 Review 时 Active 的存在性、logical identity、snapshot digest、source fingerprint/identity、commit 和 manifest digest；无 Active Review 不允许覆盖并发新建的 Active。repair 在该匹配后才替换目标 entry，并复用同一锁 token 提交 state。provider resolve 和普通 content-addressed store publication 保持锁外；stale 操作最多留下可删除 orphan，不覆盖 Active。source config 或 Active digest 改变时，Execute 必须在 plugin、config 或 native 写入前返回 typed `operationReviewStale` 或新 Review。该检查不访问远端 branch。

已安装插件的 dependency placement 调整只从现有插件详情和依赖关系动作进入，不增加独立工具入口。project→user 使用同一计划、Review 和执行链。user→project 先只原子更新当前项目 desired intent；结果页明确要求用户随后显式清理 user actual，再运行 project sync。首版不自动串联 cleanup，也不扫描未知项目。pure-native Codex 的 user/project activation overlap 合法；含 AW-only extension 的 overlap 返回 `blocked` 和两条恢复路径。`needsSync` 及其恢复 `sync` 也进入现有 Review、Progress 和 Result 链。

Codex manager 解析也在同一个 `AW_HOME` mutation lock 内完成，并在执行时重新探测。仅修改已有 shared native 的 project activation 不使用 native manager；project intent 若需要写入、替换或移除 shared native package，仍解析同一个 user-level manager。正常写入优先使用兼容的 system CLI；system CLI 缺失时复用有效的 AW-managed cache，只有 cache 缺失或可安全重建时才需要本次授权。直接 TTY 可在首次获取前确认；JSON 和非交互命令必须传 `--allow-managed-codex-install`。已安装但过旧、版本不可解析或探测失败的 system CLI 会阻止操作，不能用 managed runtime 绕过。manager 选择不进入 Receipt v6 或 Status v7，也不成为 `operationReviewStale` 证据。

TUI preview 只读，并且只在最终计划含 Codex native 操作时探测 manager。若需要获取或重建 runtime，Review 明确显示 `@openai/codex`、固定版本和 AW-managed cache；执行该 Review 即授权本次获取，不再显示第二次确认。

依赖执行顺序只在本次命令内存在。Receipt v6 的 `overallState` 只能是 `succeeded | partial | failed`；结果使用 `changes`、`targetResults`、`warnings`、`recoveryActions` 和适用时的 `planFingerprint` 表达，不使用六层 `layers`。Receipt 顶层保留 requested/resolved plugin ID 和 dependency edge；`targetResults` 保留 relation、requiredBy、target state 和恢复建议。partial 或 failed 结果不能丢失目标关系和恢复信息。精确匹配的现有 shared native 公开为 `reuse`，并明确不建立 ownership ledger。receipt 不公开持久计划、锁或来源内部证据。

`OperationPlan` 只用于 Review、stale fingerprint 比较和 Receipt。真实执行继续由 rebuild executor 使用已准备的 target 和 live evidence 完成；不存在通用 `OperationAction` executor。

- `install`：按当前 Catalog 安装请求插件和缺失依赖；已存在且完整的依赖使用 `keep`，不重复安装。
- `reinstall`：先只清理 AW-owned 组件，再按当前 Catalog 完整重建。expected exclusive path 的 owner marker/header 缺失或损坏时，它不自动 force，也不覆盖该路径；返回 `exclusiveOwnerEvidenceInvalid`，恢复顺序固定为先运行同 target 的 `cleanup --force`，再运行 reinstall。
- `uninstall`：删除可由 live owner marker/token 证明属于 AW 的组件。它不重放历史脚本。
- `cleanup`：不运行 postApply，也不读取依赖图或安装门槛。它只清理明确选择目标中可由 live owner marker/token 证明属于 AW 的 activation 和 extension，保留 plugin config、依赖 placement、foreign 内容和 shared native payload。
- `cleanup --force`：用于恢复专属且已损坏的 AW-owned 输出；只接受 shallow plan 中精确的 `skill-directory` 与 exclusive `owned-text-file`。候选必须位于合法 platform/project root，路径链和目标不能是 symlink，节点类型、basename 和 artifactKey 必须一致，且不能是 shared config、native plugin store 或 marketplace root。合法 foreign owner 在 normal 和 force 中都保留。它不扩大到依赖 placement 或 shared native payload，且保留配置。

selected source/plugin 的 namespaced config inventory 损坏不阻止该目标的 cleanup 或 uninstall；命令保留坏 config，并提示之后使用 `config reset`。其它 plugin、ownership、foreign/shared/global、source、Catalog 和 state inventory 错误继续 fail closed。

TUI 把 `sourceMissing` 和 `bundleUnavailable` 统一投影为 offline cleanup。Review 不解析缺失的 bundle，而是绑定包含来源身份、目标位置和 live ownership fingerprint 的 typed evidence。Execute 在同一个 `AW_HOME` mutation lock 内重新读取 owner marker/header、shared owner 和 native registration；evidence 漂移时在写入前返回 stale Review。synthetic cleanup target 只使用这些 live evidence 发现的 matching-owner 组件，且普通 TUI 不启用 force。

每条失败链必须可用 `cleanup`、`cleanup --force`、`reinstall`、来源刷新或新版本发布恢复。无法证明 ownership 时宁可保留内容，也不能删除用户或共享内容。

### postApply

Manifest v3 只允许 `scripts.postApply: { path, timeoutMs? }`。AW 固定使用 Node，以 plugin root 为 cwd，并从 stdin 发送 JSON context v1。context 只含 plugin identity 和 root、target、effective config values，以及 `created | updated | removed | unchanged` component outcomes；它不含平台 home、store path、artifact 内容或 `sourceIdentity`。

每个 core target 成功 apply 和 verify 后运行 postApply。每次显式 reconcile 都运行，包括 no-op sync、root 和 dependency closure。blocked 或 failed target 不运行。postApply 不允许遗留后台后代；AW 在脚本正常退出、超时或中断后先终止并确认本次脚本的进程树，再完成该 target。脚本失败、超时或进程树清理无法确认只增加可见 warning；core 结果保持成功，不回滚，不写持久失败状态，后续 sync 会重试。身份无法证明属于本次脚本的 foreign 进程不会被终止。

## Live Status and Config

`aw status` 输出 Status v7。它组合 user/project intent、当前 Active Catalog、live native/config evidence 和 AW extension projection。它严格只读：不创建 `.agent-workflows`、AW_HOME 或平台目录，不运行 postApply，不下载或授权 manager，不调用 native add/remove，不修改 trust/config，也不调用 Catalog provider。对于 static native，status 只使用 official scoped list 检查 registration、plugin ID 和 active version。receipt-backed dynamic `codex-native` 还检查 AW-owned canonical marketplace source projection，但绝不运行 renderer；可重建的 source/renderer/config/render input/target evidence 变化报告 `renderDrift`。Active 缺失或来源不可用时，它保留可识别的 desired intent，并从 live AW ownership 输出结构化 `blocked`、`orphaned` 与恢复动作。PATH 中没有 Codex consumer 时，activation evidence 只标为 `assumed`，不把缺失 PATH 当成命令失败。
Status v7 的平台支持投影与 Core manifest 合同一致：`policy.products` 缺失或为空表示同时支持 Codex 和 Claude，token 按统一规则规范化。

每个 target 的 intent component 说明 enabled、scope 和 `root | dependency | managed | none` relation。target 顶层 `state` 的公开状态只能是：

| 状态 | 含义 | 建议 |
|---|---|---|
| `ready` | desired 与现场一致 | 无 |
| `needsSync` | desired 已保存，但组件缺失、可替换或待同步 | `aw sync` 或 `aw reinstall` |
| `orphaned` | 没有 desired root，但 managed/AW-owned 现场仍存在 | `aw cleanup` |
| `blocked` | 来源不可用，或 foreign、unreadable、collision 或其它安全问题阻止收敛 | 按 `recoveryActions` 刷新来源、清理 AW-owned 输出或手动修复 |
| `absent` | 没有 desired intent，也没有 managed/AW-owned 现场 | 无 |

`reasons` 说明状态的稳定 code、severity 和可公开的 collision evidence；`components` 提供每个组件的浅检查事实；`recoveryActions` 提供下一步恢复操作。共享 native 使用统一五态：`missing`、`usable`、`replaceable`（`outdated | damaged | renderDrift`）、`blocked`（`foreign | unreadable`）或 `unobserved`。只有成功的 `codex plugin list --marketplace <AW marketplace> --json` 决定 native installed、absent 和 active version；公开 Codex config 决定 activation 和 marketplace ownership；AW-owned canonical marketplace source projection 决定可重建的 `renderDrift`。Codex private cache 和 installed manifest 不进入普通 lifecycle、repair、residue 或 cleanup 成败判断，AW 也不直接删除它们。每个 status、Review preview 和锁内执行 session 按 marketplace 复用 operation-local exact/neutral list snapshot。每个 operation/marketplace 的相关 target 和 activation 全部是 user 时，每代只读取 neutral；存在 project 时，每代最多读取一次 exact 和一次 neutral。一次 session 只创建并清理一个独立 neutral 临时 cwd。preview 与锁内执行不共享 snapshot。锁内执行复用一代 pre snapshot；全部 native registration 与 activation mutation 完成后，每个发生真实 mutation 的 marketplace 只捕获一代 post snapshot，并让该 marketplace 的全部 target postcheck 复用它。no-op 不捕获 post snapshot。PATH 中没有 compatible consumer，或 consumer incompatible/unresolved 时，shared native 是 `unobserved`；desired target 使用 `needsSync` 和 `codexSharedNativeUnobserved` warning，compatibility blocker 仍独立保留。official list 调用失败是 `blocked/unreadable`。`foreign` 表示 exclusive artifact slot 已被当前插件不拥有的内容占用；它不能作为已安装证据。公开 collision evidence 只包含 `reason`（`ownerMismatch | unownedContent | typeMismatch`）、`artifactKind`、`artifactKey`、`expectedOwner` 和可选 `actualOwner`，不得包含组件绝对路径、credential、未知 stderr 或临时内部信息。

`state: present | absent | partial | error` 只可作为 `components` 中的 ownership-health adapter，不替代 target 顶层 `state`。每个 Status v7 reason 有必填 `severity: warning | blocking`。`needsSync` warning 本身不使命令失败；source、inventory 和安全 blocker 继续使 `hasErrors=true`。当前插件的普通 cleanup 和 uninstall 不删除 foreign component。

Codex target 可包含 `sharedNative { pluginId, state, reason?, version?, desiredVersion?, shared:true }`、`activation { user?, project?, effective?, evidence }` 和 `extensions { state, kinds }`。同一 shared native identity 在顶层只出现一次，不伪装成 user 与 project 两个 owner。pure-native user/project overlap 可以为 `ready`；mixed 或 AW-only extension overlap 为 `blocked`，并提供卸载不保留 scope root intent 后再同步的两条路径。foreign 恢复要求用户先移除或重命名冲突；普通 `cleanup` 明确保留 foreign 内容。

当前 desired-state 边界的稳定错误或 warning code 为 `pluginIntentStateInvalid`、`codexProjectPluginVersionTooLow`、`codexProjectPluginUnsupported`、`codexProjectConfigNotEffective`、`codexSharedNativeForeign`、`codexSharedNativeCorrupt`、`codexSharedNativeUpdateRequired`、`codexSharedNativeRenderDrift`、`codexSharedNativeUnobserved`、`codexExtensionScopeConflict`、`codexActivationDrift`、`codexExtensionDrift`、`codexIntentSourceUnavailable` 和 `operationReviewStale`。正常的 `needsSync` 或 drift warning 不要求 `status` 返回命令失败。

Status v7 对已检查的直接依赖继续在 `components` 中公开 `ready | absent | blockedByCollision | incomplete | error` readiness。依赖问题携带 `dependencyPluginId`，并在可识别时携带稳定的 `rootIssueId` 和 `rootIssueCode`。`status --json` 只输出 schema 7，不提供旧 schema 参数、fixture 或双轨输出。JSON、人类 CLI 和 TUI 使用同一 typed target model；人类输出可按 verbose 控制组件细节。

TUI placement 在 ownership health 之外投影 collision blocker，但不能把 foreign-only collision 计为 installed。foreign-only placement 使用 `blocked`；`present` 或 `partial` placement 保留 installed ownership health，并同时保留 collision blocker。每个平台 placement 独立判断：混合平台仍可进入添加并只列可用 target；所有平台都阻断时，Preview 和平台菜单先提供“查看输出冲突”，且不显示添加、升级或重新安装。installed collision 仍提供安全移除入口，删除只处理 AW-owned 内容并保留 foreign 内容。

TUI 插件清单继续组合当前 Catalog summary 和 status target。若 live ownership 仍存在，但当前 Catalog snapshot 已无该插件，目标保留 `bundleUnavailable`，并同时显示在浏览和已安装清单中。TUI 只提供普通 `cleanup`：Review 说明仅清理所选目标中 AW-owned 的 live activation 和 extension，保留 plugin config、依赖 placement、foreign 内容和 shared native payload，不运行 postApply，也不读取 dependent 图，并显示不含 `--force` 的等价命令。成功后是否从清单消失只由重新读取的 Catalog 和 live ownership 状态决定。

TUI 为每个插件选择一个稳定的 primary attention，包含 `warning | error`、稳定 code 和可读 message。选择顺序为：来源移除、artifact collision、来源不可用、依赖图无效、依赖目标不支持、依赖未就绪或缺失、scope 冲突、必填或无效配置、安装不完整、通用诊断。问题中心按 `sourceRemoved`、`artifactCollision`、`sourceUnavailable`、`dependency`、`scope`、`config`、`installation`、`diagnostic` 稳定分组和排序，并渲染真实分组标题和每组数量。Root Cause 只在 TUI 本地复用公开 `rootIssueId` 和 `rootIssueCode` 聚合，不扩展 Status schema；投影明确记录 root entity、affected targets 和 `direct | consumer` 关系。direct partial 或 error 使用 root code、root plugin entity、platform 和 scope 形成 canonical key，并与同 entity、同 root code 的 dependency evidence 合并。direct root 永远优先；过滤结果没有 direct target 时，从 dependency evidence 稳定合成 root，不能选择任意 consumer。payload target 顺序不影响结果。

ownership health 只表示当前 live 组件是否完整。Status v7 的 shared native version 比较投影为 `replaceable: outdated`，target 状态为 `needsSync`，并使用 `codexSharedNativeUpdateRequired` 原因。控制台仍可保留私有 revision sidecar，用它区分 `current`、`upgradeAvailable` 和 `unknown`；该 sidecar 不进入公开 Status v7 JSON。

Codex native refresh key 是 user-only。遗留 project override 保留在 store，但不参与 effective value。Status v7 使用非阻断 `configLayerUnsupported` warning 提示用户删除。TUI 禁止在 project 层设置该 key，只允许删除当前 project store 中确实存在的旧值。

配置按 manifest default、user、project 合并。user store 位于 `AW_HOME`，project store 位于项目 `.agent-workflows/plugin-config/`；两者都使用带 source identity 的 namespaced schemaVersion 3 envelope，并通过原子替换写入。store 结构层只验证 envelope identity 和标量或一层标量对象的基础值形状；字段的 type、preset、required、format、object property 和危险 key 约束在 effective resolution 中验证。无效高层覆盖保留低层值作为解释用 fallback，但 runtime 不使用该 fallback；任一无效覆盖或缺失 required 字段都阻止 apply。对象在层之间完整覆盖，不做子属性深合并。读取只在内存中 canonicalize；真实写入使用 canonical JSON，相同语义的 set 不写 store 或 apply，Review stale evidence 仍绑定原始 store bytes。旧 `plugin-config.local` 和 store v2 不读取、不迁移，也不由 reset 删除。`config set/unset` 要求当前 `config.fields`；它们可保留同层其它基础形状合法但 schema-invalid 的字段以增量修复。写后仍无效时 receipt 报告 `partial`、`configWrite: succeeded` 和 `applySkippedReason: invalidConfig`。`config reset` 是不依赖 Catalog、schema 或 store envelope 有效性的最终恢复入口。完整 plugin ID 和 scope 直接定位；裸名只在所选 scope 的 store 中唯一时允许。final regular file 和 symlink 只 unlink 自身；final directory 原子改名为同父 quarantine basename，不递归删除；其它特殊节点稳定拒绝。receipt 公开 `absent | deletedFile | unlinkedSymlink | quarantinedDirectory`，quarantine 只公开 basename。默认写命令只提交配置；显式 `--apply` 才对当前 cwd 可见的 desired placement 执行 sync。配置提交后，平台 apply 失败不回滚配置；receipt 和 status 报告 partial 结果，用户可再次 sync 恢复。

user scope 变更命中 `codex-native` target 的 `refreshKeys`，且 `--apply` 将更新可见 Codex placement 时，公开 CLI 必须在写 config 或 materialize 前要求 `--yes`；不带 `--apply` 仍只保存 user config。

TUI 把结构损坏的 store、Catalog/schema 不可用和字段覆盖无效分开处理。结构损坏页只显示 layer、脱敏 target 摘要和稳定 code，并只允许整层 reset 或返回；qualified plugin ID 和 scope 可直接建立 reset Review，不要求 Catalog 或 schema 可用。Catalog/schema 不可用时不打开字段编辑器；可确定设置层目标时仍可整层 reset。字段覆盖无效时继续提供字段修改、unset 和整层 reset，并只把低层脱敏值显示为“删除后恢复”的解释，不把它投影为可运行 effective。配置已提交但 apply 失败的结果页明确保留设置，并可通过新的 Review 重新采集 evidence 后调用现有 runtime replay；`invalidConfig` 结果只返回设置修复，不提供直接 retry apply。reset 结果页显示四种 receipt disposition，quarantine 仍只显示 basename。

控制台的插件设置入口先显示合并后的实际配置和值来源。用户选择修改后，再选择 user 或 project 写入层。编辑器以单个插件和单个写入层拥有草稿，并在字段旁显示当前有效值。对象字段支持逐个编辑子属性，但保存时写入完整对象。配置持久化、Review 和执行只作用于所选写入层。

控制台搜索把 query 与输入焦点分开；退出输入后 query 继续参与来源和安装状态筛选。所有字符输入显示静态光标，并按 grapheme cluster 和终端显示宽度保留输入尾部。当前设置层已有字段值时，字段动作先说明当前值、实际来源和删除后的继承结果；字段删除和整层删除都只进入草稿与 Review。Config Review preparation 复用本次 TUI session 的 Active snapshot、目标 fingerprint 和所选 config store digest，不重新运行完整 status 或访问 Catalog remote；Review 分别显示设置变更、应用影响和保持不变。user 变更可重新应用当前目录中已安装的 user 与 project 目标；project 变更只重新应用当前 project 目标。Review、stale fingerprint 和实际 writer 使用同一目标集合。

Catalog ref 页面只把 Release 和 Beta 投影为现有 explicit ref；底层仍只有 `cliChannel | explicit`。official HTTPS/SSH 切换只改变 transport location，并通过 source mutation Review 提交；Catalog logical identity 继续只来自 snapshot 的 Workspace identity，不修改 live owner identity。

### TUI 诊断投影与脱敏边界

TUI 在 Controller/ViewModel 层把现有 source、status target、dependency、config 和 Portable blocker 状态投影为统一诊断。该投影只存在于当前进程，不新增诊断数据库、持久状态或 Status v7 字段。产品层必须说明发生的情况、受阻或降级的能力、保留的安装或设置，以及下一步恢复动作；Active snapshot 正常、缺失和损坏必须使用不同影响与恢复动作。

技术层只接受白名单结构字段：安全错误 code、可选 stage、sourceId、requestedRef、resolvedCommit、lastSync 证据，以及有限的 platform、scope、plugin、dependency、field、freshness 或 compatibility context。技术层在显示前再次执行通用凭据脱敏、URL userinfo 和敏感 query 清理、已知 home、cwd、临时目录和来源路径替换，并截断文本。任意 native stderr、未知 `Error.cause`、内部绝对路径、digest、credential 或未证明安全的 status message 不进入诊断 ViewModel；不能证明 cause 安全时省略 cause，只保留 code、stage 和白名单 context。

## Platform Boundaries

- 只删除可证明属于 AW 的 marker、managed block、artifact 或 namespaced 组件。
- 一次写操作按 `sourceId + sourceIdentity + marketplaceName + normalized marketplaceRoot + platform` 分组 native marketplace materialization。每组汇总全部 target 的动态 native overlay，并只执行一次 copy、staging validation、atomic swap 和 commit。共享投影 commit 必须先于该组的 plugin add/remove/activation；分组 materialization 失败时，该组不启动 native mutation。commit 后逐 target 执行平台 mutation；单 target 失败不回滚共享投影，也不回滚其它 target 的成功结果。
- primary source 默认继续使用 `aw` marketplace。若用户级 Codex 或 Claude 的 `aw` 已由 legacy 或 foreign source 占用，首次安装改用 source-bound `aw-<sourceId>`；两个平台使用同一名称。已有 canonical 注册继续决定名称，候选名称被 foreign source 占用时 fail closed。
- 外部 Codex/Claude 命令、用户手改目录和共享 marketplace 都是不受 AW 完全控制的边界。Claude 合法的未绑定默认安装记录不属于任何 marketplace；来源 inventory 必须保留并忽略它，不能把它归为 canonical 或 foreign。执行 native install 前，若任意 scope 存在与目标原生插件名称相同的未绑定 bare-key 记录，写命令必须在清理、mirror 和 native CLI 调用前 fail closed；不同名记录继续保留并忽略。cleanup 和 uninstall 不删除、迁移或重命名未绑定记录。命令允许部分成功，并报告残留和失败。
- Codex cleanup 和 uninstall 先检查 official scoped list、公开 config 和 AW ownership。没有 official installed native、AW-owned output 或待移除的 canonical marketplace 时，不解析或获取 manager。需要 official remove 且 system CLI 缺失时，可在本次授权下使用 AW-managed 官方 CLI。Codex private cache 和 installed manifest 不算 residue，也不影响 cleanup 成败；AW 不直接删除它们。foreign 内容始终保留。remove 或完成后检查失败时保留可公开观察的 residue，并提示重试 cleanup/uninstall、升级 AW 或安装兼容的官方 Codex CLI。
- Codex project config 的规范路径与 Codex user home 相同时，未发现 project owner 的默认 status 不生成 project placement；显式 project status 报告路径别名。`install`、`sync` 和 `reinstall` 不向这个 project placement 写入，用户必须进入独立项目目录；`cleanup` 和 `uninstall` 仍可处理已有 project owner。
- active marketplace 和 quarantine 都是弱状态。清理失败时保留它们，后续 cleanup 可重试；不得因为弱状态损坏永久阻止用户清理自己的 AW 输出。
- marketplace mirror 中的 Skill owner marker 只证明 overlay/payload 完整性。它属于可重建的弱 materialization，不进入 live installation inventory，也不阻止 source removal。
- 项目范围路径必须在项目边界内；不跟随不安全的符号链接或删除 foreign 内容。
- Codex project reconcile 只扫描当前 repo 的 `.agents/skills` 直接子目录，并把严格匹配当前 source ID、plugin ID、platform 和 scope 的 schema 3 owner marker 作为 stale Skill 清理授权。当前 renderer 返回 disabled 或当前 Manifest 不再声明的 owned Skill 进入既有 quarantine 清理；source transport identity 变化不阻止相同逻辑 owner 的清理。markerless、malformed、身份不匹配、符号链接、特殊节点和嵌套目录继续保留。
- Codex namespaced marketplace root 必须是精确的 `<AW_HOME>/marketplaces/<sourceId>`。写入和只读 inspection 使用同一检查：`lstat` 拒绝 AW_HOME、marketplaces 祖先或目标 symlink/错误节点类型，并用 `realpath` 确认 containment；不安全现场投影为既有 `marketplacePathUnsafe` blocker。

### Codex shared native 与 project activation

当前 write、Status v7 和 Receipt v6 使用以下合同。旧 Codex project materialization 不作为 AW fallback，也不维护第二套 project 安装模型。

- Intent 只表示 desired state。user/project enablement、选中平台和 scope 都是待达成目标，不是安装事实。Codex native installed、absent 和 active version 只来自成功的 official marketplace-scoped JSON list；公开 config 只提供 activation 和 marketplace ownership。private cache 和 installed manifest 不得把 absent 或 unobserved 提升为 installed。
- 用户确认后，Intent 可以在 best-effort actual materialization 前原子提交。平台写入或 post observation 失败不回滚 Intent；Receipt 报告失败，Status 以 `needsSync` 提供恢复入口。`reuse` target 在修改 extension 前必须使用锁内 pre snapshot 证明 shared native 为 installed；`none` target 的 extension mutation 只要求取得 installed 或 absent 的明确 pre observation。
- Intent 使用严格 schema 2：`kind` 固定为 `aw-plugin-intents`，字段固定为 `schemaVersion`、`kind`、`roots` 和 `dependencyScopeOverrides`。它不保存 native claim 或安装事实。旧 schema 1 不读取、不迁移。user 文件是 `<AW_HOME>/plugin-intents.json`；project 文件是仓库根 `.agent-workflows/plugin-intents.json`，可以随仓库共享。dependency override 以 `(source/plugin, platform)` 为键；project root 可选择 project 或 user dependency placement，user root 的依赖固定为 user。uninstall 在同一次 Intent 原子写入中删除当前 Catalog 依赖闭包对剩余 root 已不可达的 override；Catalog 证据不完整时保留 override。
- Codex plugin 只物化一份 shared native user package。project scope 只在当前项目的 Codex 配置中激活该 native plugin。shared-native ownership 不得为此保存 project claim path、global claim、refcount、native installed ledger 或第二套安装状态，也不扫描历史项目或通过全局项目扫描执行 auto-GC。qualification report 也不是 installed ledger。
- Shared native 的 status inspector 对 static native 只检查 official observation、公开 marketplace ownership 和路径边界。receipt-backed dynamic `codex-native` 还检查 AW-owned canonical marketplace source projection，但绝不运行 renderer；source/renderer/config/render input/target evidence 变化报告 `renderDrift`。它使用 `missing`、`usable`、`replaceable`、`blocked` 或 `unobserved` 五态；`replaceable` 的 reason 是 `outdated | damaged | renderDrift`，`blocked` 的 reason 是 `foreign | unreadable`。install postcheck 必须观察精确 plugin installed，remove postcheck 必须观察精确 plugin absent。write preview 与 mutation lock 内重算使用同一 public observation 和 AW-owned source projection；replace 不得复用现场，并按 shared impact 要求 `--yes` 或 TUI 确认。private cache 或 installed manifest 的 bytes、digest、缺失或损坏都不触发 replace/remove。
- 基础 Codex native plugin 合同最低为 `0.145.0`。涉及 project activation 的操作最低为 `0.151.0`。开发 qualification 固定拒绝非精确 `0.151.0`，避免把其它版本的行为外推到 rollout allowlist。
- PATH 中有 Codex CLI 时，操作按适用版本门禁探测它。PATH 中没有 system CLI 且操作只修改 project activation 时，不获取 manager。此时 AW 未观察到 system loader 或 Codex App，只把 project activation support 标记为 `assumed`。只有操作需要物化或移除 shared native package 时才解析 manager；system CLI 缺失时，AW-managed manager 必须取得精确 `0.151.0`。
- 每种 native kind 必须先通过显式真实 qualification 才能进入 rollout allowlist。未被行为证据证明的 kind 必须返回 `unsupported`，不能从帮助文本、源码字符串或相邻 kind 推断。当前 `0.151.0` qualification 可证明 Skill、MCP、Hook 和 App；slash command 因没有可用的离线运行时证据保持 `unsupported`。
- project activation 的最低行为合同是：native add 默认创建 user enabled；`user=false, project=true` 只在受信任的精确 project cwd 加载；neutral cwd 不加载；`user=true, project=true` 在两处加载同一 shared native plugin；project trust 未生效时 project-only activation 不加载。
- `status` 始终只读。它只能读取 Intent、live ownership 和 native evidence，并标明 observed 或 assumed；不得安装 manager、调用 native add/remove、修改 trust/config、创建 claim/refcount，或把 qualification report 当现场事实。
- 旧 Codex direct MCP/Hook residue 不由新 CLI 扫描、重建或删除。保留旧环境时，先用旧 CLI cleanup。

独立入口 `pnpm qualification:codex-project-native` 只用于 `0.151.0` rollout qualification。`pnpm qualification:codex-native-performance` 按 `CODEX_QUALIFICATION_VERSION` 和 `CODEX_QUALIFICATION_CLI` 显式验证 `0.145.0`、`0.151.0` 或 `0.153.0`。三个版本都必须接受 `plugin list --marketplace <name> --json`；`0.153.0` 的本地 marketplace scoped list 还必须在阻断 proxy 的隔离环境中成功，不得依赖远程 Catalog。代表性本地 native plugin 安装运行五次，其中位数必须低于 15 秒；如有同机旧实现基线，也可用改善至少 70% 代替该绝对条件。精确 binary 缺失时报告 `missing`，不得自动下载或把 fixture 结果作为真实性能证据。

两个 qualification 都使用临时 Codex home、临时用户 home、临时 AW home、临时项目和临时本地 marketplace，且不进入普通 test、build 或 release 默认链。它们不读取或修改真实用户 config/cache，不访问远程 Catalog。机器报告只说明该次 CLI/OS 和精确版本的 qualification 结果，不授权或记录任何用户安装。

Codex 性能门禁使用以下稳定上限。成功的 official native CLI 不做 process-table observation 或 scan。每个 marketplace observation generation 中，project 或 all-scope 最多运行一次 exact list 和一次 neutral list；user-only 最多运行一次 neutral list。Review preview 与 mutation lock 内的 generation 不共享 snapshot。锁内 no-op 最多两次 list；发生真实 mutation 时 pre/post 合计最多四次；完整 TUI project mutation 连同 preview 最多六次。所有 list 都必须是 marketplace-scoped JSON list，不允许额外 non-JSON list。同 source 的 root plugin 和五个依赖只执行一轮 Catalog copy、staging generation、atomic swap 和 commit。以上上限与 plugin 数量无关。

这些合同不接入 Codex app-server plugin/reconcile，也不保证运行中的 Codex App 自动刷新。App 的重新加载行为必须单独 qualification，不能由 CLI list 或文件变化推断。

## Agent Skill Eval 执行与 Runner 边界

- Skill-local `evals/manifest.json` 的准备合同是 CLI 拥有的 Manifest v1。`aw skill eval prepare` 通过 Catalog Workspace 解析 canonical plugin，并按一个 plugin、Skill、suite、profile 和可选 case/split 选择生成输入完整的 `EvalSpec v1` 目录。该目录包含 runtime target、可选 previous target、筛选后的 cases、Eval-owned fixture，以及移除被测 Skill 后的完整 subject workspace。profile 的 sensitive config 值不得进入 Spec。
- `prepare` 复用真实 bundle、依赖、profile config 和平台 materialization，但不启动 provider 或模型。它先在 staging 中验证路径、摘要和最终输入，再原子发布到 Workspace 外或 `<workspace>/.aw/evals/**` 中尚不存在的窄目录；`.aw/evals` 根、已有、过宽或含符号链接的目标 fail closed。
- Eval 执行的唯一机器 owner 是 npm package `@lesliechan721/agent-skill-eval` 的 `aw-skill-eval` bin。公开机器合同只包括 `EvalSpec v1`、`EvalAudit v1` 和 `EvalResult v2`。Engine 提供 `spec validate`、绑定 Spec 的 `audit validate`、绑定 Spec 与 Audit 的 `result validate`，以及唯一执行入口 `aw-skill-eval run <spec.json> --audit <audit.json> [--allow-unmanaged-processes]`；CLI 不提供第二个 `run` wrapper。成功的 `spec validate` receipt 在 `calculated.providerDigest` 公开正式 provider 摘要，Auditor 只复制该值，不实现摘要算法。
- 单份 `EvalAudit v1` 必须与当前 Spec 的 provider、workspace、current target、可选 previous target、case digest 和全部 selected case 精确绑定，且状态为 `pass`、没有 blocked case，才准许执行。workspace 摘要绑定全部普通目录和普通文件；空目录的新增、删除或重命名会使绑定失效，符号链接和其它特殊节点被拒绝。prepare、Spec validation 和运行快照使用同一算法。`runs` 和 `timeoutMs` 改变不影响 Audit 复用；旧版使用字符串 `workspace` 的 v1 Spec 必须重新 prepare 和 Audit。`EvalResult v2` 不兼容 Result v1；它绑定 Spec、Audit、target、case 和 provider 选择，保存每次运行的状态、耗时、usage、grade 和错误，并要求顶层 `processManagement` 记录本次 managed 或已确认 unmanaged 模式。
- 所有真实 provider run 都在创建 output 或启动模型前完成同一执行预检。macOS 必须先解析本次选中的 Codex 可执行入口，再只读检查用户 keychain search list；Engine 随后使用这个已解析的绝对入口，Eval fixture 的 PATH 不能替换它。入口是 cmux Codex shim/wrapper、存在 `accountsKeychainExport`，或检查失败时停止。Engine 不自动寻找替代 Codex，也不修改 keychain；调用方可显式用 `AW_SKILL_EVAL_CODEX_BIN` 选择原生 Codex 可执行文件。默认 managed 模式要求当前会话不是已知 restricted permission profile。macOS/Linux 通过进程检查观察和确认协作式后代清理，但不是 OS 强制 containment，因此 Result 不声明保证清理后代。Windows 在 spawn 前由随 Eval package 分发的原生 helper 创建 KILL_ON_JOB_CLOSE Job，并以 suspended 状态创建和分配 root；分配失败时 root 不恢复执行。helper 正常退出前终止后代并确认 Job 为空，调用方提前退出或强制结束 helper 时，最后一个 Job handle 关闭并清理 Job。helper manifest 绑定源码、精确 Go toolchain、固定交叉编译环境和两个 PE digest。普通 build 只校验并复制这些 artifact；强 release verification 必须用 manifest 指定的本机 Go toolchain 在隔离 cache/workspace 中重建，并逐字节比较。真实 Windows 支持仍须在对应架构运行独立 qualification；macOS 交叉编译和 mock 不是运行证据。单次 `sandbox_permissions=require_escalated` 不等于 Full Access，不能修复其它边界。
- Engine 创建的隔离 HOME 不继承宿主 Git credential helper。conversation、trigger、workflow、workflow adapter 和 custom process 都禁用 Git system config 与终端认证提示；Codex 工具子进程使用相同设置。这样不会因临时 HOME 缺少默认 macOS keychain 而启动 SecurityAgent，也不会让模型运行读取或写入宿主 Git credential。
- 只有用户明确接受本次运行可能遗留后代进程的风险时，才可在单次命令增加 `--allow-unmanaged-processes`。该授权不进入 Spec 或 Audit，不会形成静默 fallback，也不会自动重试。unmanaged-confirmed 模式跳过进程树检查，只尽力终止直接 provider child，不发现或保证清理后代进程；macOS keychain 预检仍然执行。
- Manifest suite 可选声明 `releaseProcessManagement: "managed-only" | "allow-unmanaged-confirmed"`。省略时 Release Check 使用 `managed-only`；只有显式声明后，unmanaged-confirmed 的 Result 才可满足该 suite 的 release evidence。
- Engine 的内置 provider registry 包含 `codex-trigger` 和 `codex-conversation`。Manifest 的 trigger 和 conversation suite 选择对应内置 provider；`custom-process` 是显式的、可信且协作式外部 provider escape hatch，不是任意外部程序 sandbox。其命令和本地资产在 prepare 时做边界检查，执行前必须单独披露未知调用成本、credential 和网络影响。
  - macOS/Linux 的 managed 模式只在进程检查可用时启动 `custom-process`。Windows spawn 必须先通过原生 Job helper；helper 缺失、架构不支持或 Job 分配失败时 fail closed，不回退到仅观察 PPID 的 managed 声明。
  - provider 及全部后代必须保留 Engine marker，并始终留在 Engine 创建的初始进程组。它们不得使用 `setsid`、`setpgid`、detached、daemonize 或 double-fork；不得遗留后台任务，且必须在输出最终 JSON 和退出前等待全部后代退出。
  - Engine 在运行期观察该合同；发现违反即失败。检查失效时 Engine fail closed：丢弃 grade 并停止 batch。用户态 macOS/Linux 无法对已逃逸且又失去检查的后代保证清理，因此不得盲杀 foreign 进程。
  - credential 递归清理只检查本次 provider 的 `outputDir`；其中的符号链接一律只 unlink，绝不跟随。subject workspace、Eval fixture 和其它 attempt 输入不扫描、不改 mode、也不删除。隔离 runtime home、HOME 和 temp 始终清理。output 脱敏失败时只尝试删除 `outputDir` 并让 attempt 失败；Engine 从已脱敏的内存结果写入 `provider-result.json`。
- `codex-workflow` 是 Engine-owned object provider。Manifest 必须显式提供非空 `command` 和可为空的 `allowedModels`；同一 adapter command 只接收固定的 `prepare` 与 `grade` phase。Engine 使用单一 attempt deadline，先取得有界 WorkflowRequest，再启动一个由 Engine 拥有的隔离 app-server root，且只接受 root thread 的完成事件。Engine 在清理 app-server 和临时 Codex home 前读取 raw rollout，并写入脱敏的 `workflow-evidence.json`、`workflow-trace.json` 和 `model-output.txt`；`skillLoads` 同时记录原生注入的 selected Skill 和显式读取的 `SKILL.md`，并按 thread 与 Skill 去重。grade 只读取规范化 evidence，且只能返回 grade。adapter 继续使用 verified-observed containment，但其环境不含 Codex/OpenAI credential 或 proxy。Windows 在模型调用前拒绝该 provider。
- 默认 Agent-facing 适配器插件是 `aw-skill-eval-runner`，Skill 是 `run-aw-skill-evals`。Runner 负责准备或验证 Spec、复用或取得独立 passing Audit、披露模型调用与副作用、取得所需授权、调用一次 Engine，并验证 Result。`aw skill eval doctor --json` 只用于安装或升级、用户明确请求 provider 环境诊断，或模型已启动后的 run 失败；它报告 permission profile、macOS keychain 状态和 managed/unmanaged 可用性，但不替代执行授权。`aw-skill-eval inspect-result <result.json> --spec <spec.json> --audit <audit.json>` 只在异常结果需要按 case、attempt 和 variant 分组检查时使用；普通成功路径不运行这两个命令。
- Spec 目录和运行输出都是可删除、可重建的弱状态。准备或执行中断后，删除本次不完整输出并重新 `prepare`、Audit 和 `run`；不自动重试，也不维护 batch checkpoint 或续跑 ledger。
- Conversation suite 或 case 可用最小 `environment.pathPrepend` 声明 Eval-owned PATH fixture。路径相对声明它的 Eval 根解析，必须是根内的普通文件或目录树，且不能包含符号链接。Runner 只复制已声明 fixture 到本次隔离 workspace，并只在那里设置 executable mode 和前置 PATH；Oracle 不依赖仓库私有 CLI 路径。声明 `workspace_valid: true` 的确定性 fixture 必须 materialize 后通过公开 `aw catalog status --json`，并让每个预期有效插件通过 `aw plugin validate --json`。该 preflight 不运行模型，也不代替 Oracle Audit。
- `hostSourceAccessAbsent` 只按 app-server 事件中的显式命令、审批和文件访问输入归因。命令输出、Agent 消息、reasoning 和 diff 中的宿主路径文本不是访问证据。
- macOS conversation provider 只使用一层 outer Seatbelt。它阻止宿主源码读取，并按 case 精确实施 workspace 只读或可写边界；turn 使用 `externalSandbox`，因为嵌套 Seatbelt 不可靠。app-server control-plane 和工具执行网络都保持可用，provider capabilities 和每次 evidence 必须公开这个限制。
- Oracle preflight 和 result triage 属于独立 Auditor，而不是 Engine。运行前没有 passing Audit 时不得启动模型。clean success 不要求 triage；只有 execution/grade 失败、current 结果混合、相对 baseline 回归，或结果将驱动生产 Skill 修改时，才在全新上下文做 result-triage。triage 默认返回聊天结论，且不是 Release Check 的机器输入。

## Quality Review、Release Check 与 Review Publication

这三种合同彼此独立：

- **Quality Review** 只报告设计、复杂度、findings、未知项和最小改动；主产物是 `report.md`，可选 `QualityReviewResult`。workflow Review 还定义有界的 scope。Review 不计算发布准备度，`QualityReviewResult` 也不拥有 Eval 证据等级。
- **Release Check** 是独立的机器检查，产物为 `release-check.json`。它消费自己的确定性输入并拥有 readiness 结论；它不是 Review mode，也不会把 readiness 或 Eval 等级写回 Quality Review。
- **Review Publication** 只归档已经存在的文件，并绑定目标和 digest。只有本次请求的顶层 Reviewer 可以发布其目标；下层 Reviewer 只返回材料，除非用户明确要求多个独立归档目标。Publication 不重新评审、不运行或封存 Eval 执行结果、不更新 README，也不维护可变 index。

公开入口是 `aw review digest|publish|verify|list|show`，并统一由 `aw.review-publication.v1` 表示运行时能力。`aw review digest <path>` 为 workflow scope component 提供 canonical production records v1 digest；它只接受仓库内普通文件或目录，并拒绝路径链、目标根或目录树中的符号链接及其它不安全节点。发布只在用户明确要求时执行；使用前先运行 `aw review publish --help` 确认当前参数。

### Immutable record

每条 record 位于：

```text
reports/reviews/<kind>/<encoded-target-id>/<review-id>/
```

文档把稳定编码后的中间目录抽象为 `<target-id>`；实现使用 `id-` 加 target id 的 UTF-8 base64url。`kind` 只能是 `skill`、`workflow`、`aw-plugin` 或 `aw-workflow`。`review-id` 格式为 `<YYYYMMDDTHHMMSSZ>-<target-digest-8>-<report-digest-8>`。

record 最少包含 `manifest.json` 和 `report.md`。schema 1 manifest 只拥有 record identity、`publishedAt`、目标 `{ kind, id, digest }`、report/附件的路径与 digest、source `{ commit, dirty }` 和可选 `supersedes`；它不解释 report、result 或 release check 的语义。可选内容为 `review-result.json`、唯一 kebab-case kind 的 `checks/<kind>.json` 与 `evidence/<kind>.json`、`release-check.json`，以及 workflow 的 `scope.json`。JSON 附件必须以 canonical JSON 归档，manifest 的文件清单必须完全匹配实际普通文件。

leaf `skill` 使用静态 Skill 或 `plugin/skill` id，`aw-plugin` 使用插件 production bundle digest；二者不接受 scope。`aw-plugin --target` 可使用 id 对应的默认 `plugins/<id>`，也可使用仓库内其它 plugin root；path chain、root 和 manifest 必须是非符号链接，且 manifest name 必须匹配 root 的 target id。production digest 始终从该实际 root 构建，并使用同一仓库中所需的 provider source set，因此仍绑定 build/generated runtime bytes。实际引用的 direct provider root 必须位于同一仓库内；其完整 path chain、root、`.agents-plugin` 目录和 manifest 都必须是预期的普通非符号链接节点。

`workflow` 和 `aw-workflow` 必须提供 schema 1 `scope.json`，其 `kind`、`id`、用户结果、入口、非空组件和代表性路径、外部依赖及排除项共同形成 target digest；归档后的 `scope.json` 是该 target binding 的 canonical 副本。每个 component path 必须解析为仓库内现存的普通文件或目录，完整 path chain 和目录树不得包含符号链接。component digest 使用与 production tree 相同的 canonical records v1：按 codepoint 排序相对路径，绑定普通文件执行模式和文件 SHA-256；单文件使用 `.` 作为 tree-relative path。发布时必须重算并拒绝伪造或 stale digest。公开 `verify` 验证归档后的 canonical scope、component digest 声明和 target digest 绑定；它不把当前源码是否仍与历史 scope 相同混入不可变记录验证。scope target digest 仍只使用 canonical scope JSON，不混入第二个 target digest 协议。

发布先在同一 target 父目录创建临时 record，写完并验证 inventory/digest 后原子 rename 到不可变最终目录；失败清理临时目录。相同 target digest 与 report digest 只有在 target、report、所有附件、source 和 `supersedes` 都等价时才幂等返回原 record；同一 target/report digest 的不同输入必须失败，不能覆盖。`supersedes` 必须引用一个已验证、同 kind 且同 target id 的 record；它可以引用旧 target digest。`verify` 验证一个 record 的完整 binding 和 digest；`show` 要求全仓唯一 review id；`list` 扫描固定 records 根的 manifest，按 `publishedAt`、`reviewId` 稳定排序，并可按 kind 和 target id 过滤。归档根不计入发布时的 source dirty 检查。

## Release Flow

根级正常发布入口只有 `pnpm release`。它要求 `beta|release` 渠道和 `--cli|--catalog|--all` 中一个显式发布轴。

- `release/version-targets.json` 使用 schema 2，且只保存 CLI 稳定 target。`plugins/marketplace-source.json.catalog.version` 是唯一可写 Catalog version 真值，并表示下一次精确候选。`aw catalog version <exact>` 和 `aw catalog version --bump major|minor|patch` 是唯一公开 Catalog version mutation；bump 以当前 stable SemVer base 为输入。
- `--cli-bump` 更新 CLI target 和三个 public package；`--catalog-bump` 只编排公共 Catalog version mutation；可重复的 `--plugin <name>=major|minor|patch` 更新所选插件。CLI/plugin metadata 和自动 Catalog metadata 使用独立白名单 commit；Catalog commit 精确只包含 `plugins/marketplace-source.json`。没有版本变化时不创建空 commit。
- Catalog beta 版本只读取 source metadata、immutable `catalog-v<version>` tag 和 publication journal。当前 exact version 只有同一 journal plan 时可复用；beta 已使用时在同一 base 选择下一个未使用的 `beta.N`。stable metadata 在 beta 渠道选择该 base 的 beta；stable 发布可以把 beta metadata 提升为同 base stable。
- Plugin beta 和 stable 使用每个当前 Plugin 在目标 branch 的 first-parent 发布历史中最近的 manifest entry。branch tip 已有全部当前 Plugin 时不继续扫描；tip 缺少 Plugin 时，只按需读取更早 snapshot 的 marker 和 manifest，并要求有效 published manifest 和相同 Workspace identity。beta 在历史基线缺失或 stable base 提高时为 `beta.1`；同 base 且相同 `contentDigest` 复用，内容改变则递增 `beta.N`；base 降低拒绝。stable 在 `contentDigest` 改变但 version 未提高，或 version 降低时拒绝。Plugin 移除后重加继续使用删除前的最近历史基线。
- 所选轴无候选时在远端写入前失败。CLI 和 Catalog 远端状态独立读取。Catalog-only 不查询或发布 npm package，不要求 CLI tag，也不执行 provider-side CLI compatibility gate。
- 元数据 commit 后运行所选轴的完整 release verify，再从更新后的干净 source HEAD 生成 `.release/prepared/descriptor.json`。Catalog snapshot 和 publication plan 只读取已提交的 Workspace metadata，并由与 `aw catalog publish plan` 相同的公共 preparation service 生成；publication 不接受独立 Catalog version override。
- 发布顺序是 `Eval → Core → CLI → CLI tag → Catalog`。CLI tag 是 `origin` 上指向 prepared source commit 的注解 `cli-v<version>`；Catalog 继续使用独立 channel ref 和 `catalog-v<version>` tag。
- beta CLI 选择候选时，把 registry 中三个包已出现的最高 beta 和本地已尝试 beta 都视为已占用。部分发布或第一次写入结果不确定后，普通发布保留稳定 target 并选择下一个 beta，再以新 beta 重新发布三个包。稳定 CLI 失败仍要求提升稳定 target。
- `pnpm release -- --repair-cli` 是同一 CLI 候选的显式补发入口。它只接受与 `attempted.json` 精确绑定且未变化的 prepared descriptor、source commit、build 和 tarball；逐包核验已存在的远端 tarball，只发布 registry 明确缺失的包，最后重新核验整组三包并补 CLI tag。内容冲突或查询不确定时停止；它不发布 Catalog。
- `pnpm release -- --repair-cli-tag` 只从有效 prepared descriptor 核验并补发 CLI tag。它不准备新候选或修改分支。

`.release/prepared/` 在 gitignore 下，是可删除的弱状态；删除后重新 prepare。`.release/attempted.json` 只服务 CLI/npm 安全门禁。Catalog 使用 schema v2 `.aw/publish/<version>/journal.json` version-scoped journal；pending 隔离 repo 位于同目录的 `repository/`。状态是 `prepared | uncertain | published`。journal 是强恢复和门禁状态；pending repo 是同版本恢复必须保留的暂存 artifact。新 plan 先在同父 `.<version>.<uuid>.tmp/` 写完并核验 journal、repo 和授权绑定，再单次原子 rename 为版本目录。失败只清理本次 temp；正式目录的并发等价 plan 幂等返回，不同 plan 要求提升版本。旧 `<version>.json` 和 `<version>.repo` 不参与读取或迁移。

对于 `prepared` 或 `uncertain`，journal 或 repo 任一缺失或损坏时，停止并提升版本，不得盲目重建或复用该版本；`published` journal 缺失时，远端 immutable tag 仍占用版本。相同 journal plan 可以对账或续跑。发布成功时先原子写 `published` journal，再尽力删除 `repository/`；安全清理失败只产生稳定 warning，不覆盖已核验的远端成功事实。

Catalog 的公开 surface 是 `aw catalog publish plan` 和 `aw catalog publish apply --expected-plan-digest <digest> --yes`。plan 展示最终 Workspace identity、source HEAD、remote identity、branch、parent、tag、snapshot digest 和 `expectedCommit`。`planDigest` 是 canonical `{ descriptor, expectedCommit }` 的摘要；snapshot `.aw-generated.json` 的 `workspaceIdentity` 必须显式等于 descriptor identity，因为 marker 不进入 snapshot digest。apply 只用 digest 在 `.aw/publish/*/journal.json` 中唯一选择 schema v2 journal，不读取当前 metadata version 定位。它重新核验所选 Workspace identity、remote identity digest、branch、授权摘要、pending repo 和远端 refs；不要求当前 HEAD、clean state 或 metadata version 仍等于 plan，也不重新 build 或 validate source。remote alias 名称可变化，但 identity digest 和 branch 不可变化。publisher 保留 annotated tag、branch lease、atomic push 和 post-verify。两 ref 都正确即成功；都不存在时 atomic push；仅一条缺失时补写；冲突时停止。CLI tag 推送异常时先读取远端；预期 tag 已指向 source commit 即成功，缺失时用 tag repair 补发，冲突时停止。

Catalog publication 的 JSON 失败合同统一为 `{ ok: false, code, message }`，退出码为 1。inspection typed error 保留原 code；其它 journal、repository 或 remote error 使用 `catalogPublicationFailed`。JSON message 和普通 stderr 使用同一脱敏文本，不包含 Workspace、AW_HOME、publication repository、临时目录的绝对路径，也不包含 remote credential、query 或 hash；稳定 Workspace identity、ref 和 version 信息可以保留。

## Key Paths

- `packages/cli/scripts/bundle-plugins.ts`：生成 catalog snapshot。
- `packages/cli/scripts/plugin-staging.ts`：生成 Catalog staging 内容。
- `scripts/release/prepared-release.mjs`：生成、验证和消费本地 prepared release。
- `scripts/release/release.mjs`：一键发布公共编排入口。
- `scripts/release/cli-git-tag.mjs`：CLI source tag 检查、发布和恢复。
- `scripts/release/catalog-publication.mjs`：把官方 channel/remote 参数交给 CLI 公共 Catalog publisher。
- `packages/cli/authoring/`：随 CLI 发布的确定性插件作者实现。
