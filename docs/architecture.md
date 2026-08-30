# Architecture

本文件定义 CLI 的稳定产品合同和模块边界。TypeScript 实现方式见[编码约定](coding-conventions.md)，测试选择见[测试指南](testing.md)，单 Plugin Source 见[插件作者指南](plugin-authoring.md)，官方与第三方共用的 Catalog Workspace 见[Catalog 作者指南](catalog-authoring.md)，本仓库维护流程见[插件维护指南](plugin-maintenance.md)。

公开包 `@lesliechan721/aw-plugin-core` 拥有 plugin manifest 的版本、JSON Schema 和运行时结构验证合同。CLI 依赖同版本 core，并在该结构合同之上提供平台 adapter、Catalog、作者工具和 transport。Eval、core 与 CLI 使用同一版本发布，顺序为 `Eval → Core → CLI`。

## 设计边界

- AW 是个人本地工具。一个 `AW_HOME` 写锁足以保护强配置；不要为未证明的并发增加全局协调协议。
- Catalog 是公开产品，支持 Git 和本地路径等多个来源。来源独立解析、独立报告错误；一个来源失败不要求其它来源回滚，也不要求 npm 与 Git 形成强一致事务。
- `catalog-sources.json` 和 plugin config 是强配置。它们必须以原子替换提交。插件输出、依赖现场、lifecycle snapshot、Catalog cache 和 release prepared 目录都是弱状态，可删除和重建。
- 外部平台和用户编辑的插件目录不受 AW 完全控制。写操作应提供可观察结果和恢复入口，不建立无法兑现的全局补偿或完全正确保证。

## CLI Source Layout (`packages/cli/src`)

- `commands/write-commands.ts` 是 `install`、`upgrade`、`reinstall`、`uninstall`、`cleanup` 的公开写入口。
- `commands/rebuild-command.ts` 解析当前 Catalog、依赖和现场状态，并交给统一 rebuild 流程。
- `commands/rebuild-operations.ts` 编排 ownership 检查、清理、平台写入、lifecycle 和完成后检查。
- `commands/rebuild-integration.ts` 把插件能力转换成平台原生写入和 AW-owned 组件。
- `commands/status-v5.ts` 读取多来源 Catalog、live ownership 和平台组件，生成 status v5 和控制台输入。
- `commands/dependency-operation-plan.ts` 只生成一次命令内的依赖执行顺序；它不是持久安装记录。
- `utils/ownership.ts` 定义 owner marker、组件检查和安全删除边界。
- `utils/lifecycle-active-store.ts` 保存下一次 uninstall lifecycle 所需的弱状态。
- `utils/multi-source-catalog.ts` 和 `utils/catalog-source-cache.ts` 解析 Catalog Sources Config v2 的 Git/path source，并管理可重建的本地快照。
- `utils/plugin-config.ts` 与 `utils/plugin-config-write.ts` 管理 namespaced AW config store 和 config v4 输出。
- `output/command-receipt.ts` 生成五个写命令的 receipt v4。
- `authoring/` 是确定性作者实现；它随 CLI tarball 发布，运行时不读取仓库 `.agents` 或插件 Skill root。公开作者命令统一以 `--workspace-root` 定位任意本地 workspace；基于 Git base 的 status 差异检查和安全删除依赖 Git。
- Core 的 `plugin-authoring-capabilities` API 是 manifest 字段、类型、必填项和 accepted values 的稳定结构 registry。CLI 只叠加 requires、conflicts、profiles 和 validator provenance 等执行/作者适配事实，并通过 `aw plugin capabilities [--surface <surface>] [--json]` 在运行时公开组合结果。
- Core 的 AW capability registry 定义稳定 ID、集合规范化与摘要、Manifest 结构派生、受限生产源码扫描和 schema 1 runtime requirements receipt。未登记但语法合法的 ID 是可交换数据；是否支持只由当前 executable 的实现集合决定。`aw self describe --json` 公开该集合，`aw self check --json` 从最近的 receipt 或 Manifest 检查兼容性，`aw plugin requirements <plugin-directory> --add/--remove <capability> --json` 只修改 `requires.aw.capabilities`，并计算 declared、derived、detected 和 effective requirements。Plugin Manifest v2 要求显式 `schemaVersion: 2`。

公开包 `@lesliechan721/aw-plugin-core` 还拥有 Catalog Workspace v1 marker 与 metadata、单插件 bundle 和 schema 5 Catalog snapshot build/validate 的机器合同。固定源码入口是 `.aw-workspace.json`、`plugins/marketplace-source.json` 和 `plugins/<name>/.agents-plugin/plugin.json`；metadata 的 `catalog.version` 只允许稳定 `x.y.z` 或精确 `x.y.z-beta.N`。CLI 只负责参数、输出、安全目标选择，以及注入 build/test adapter；Core 不读取 `AW_HOME`、Catalog cache、安装状态、TUI 或 Git transport。

### Module Invariants

- renderer 只返回 `ArtifactPlan`，不直接写平台文件。
- build-generated Skill reference 必须由 `buildConfig.generatedSkillRuntimeFiles` 精确声明。源码 validation 不把声明目标误报为缺失；最终 bundle 必须生成目标并通过完整 runtime closure。
- 写入前验证 scope、路径边界、目标身份和最终 Skill tree。
- 插件依赖只来自 manifest `dependencies`，只在同一 source 内解析。依赖图拒绝缺失节点、环和超出既定上限的图；执行顺序是稳定的依赖优先拓扑序。
- live ownership 和实际平台组件是插件存在、清理和 status 的唯一真值。不得新增安装合同存储、第二套安装状态或持久依赖图。
- 配置写入、生命周期和平台写入各自保留最小的本地恢复；它们不组成跨第三方系统的事务。
- `aw-plugin-development` 不在构建时绑定 CLI registry，也不分发 capability Markdown。已安装 Author 从当前 PATH 查询 `aw plugin capabilities`，因此旧 development plugin 可以使用较新的 CLI 能力合同。
- `aw plugin remove <name> --workspace-root <root> --yes` 只删除 canonical `plugins/<name>` source root。Workspace 必须位于有有效 HEAD 的 Git worktree 中；目标必须存在于 HEAD，且当前目标 tree 的 inventory、文件 bytes 和 executable mode 必须与 HEAD 精确相同。命令拒绝目标内 tracked、staged、untracked、ignored、符号链接或额外节点，也拒绝仍由其它当前 manifest 依赖的目标。所有检查在删除前完成；缺少 `--yes` 不写入。成功不修改 Catalog version、不 commit、不 build、不 publish。删除 I/O 失败必须给出从已核验 HEAD 恢复目标的 Git 命令；命令不提供 force、backup、ledger 或补偿状态。

## Distribution and Runtime State

```text
Catalog Workspace
  plugins/marketplace-source.json
  plugins/<name>/.agents-plugin/plugin.json
  plugins/<name>/skills/**
          ↓ aw catalog build
generated schema 5 Catalog snapshot
  .aw/catalog/
          ↓ Git/path source 解析
installed plugin
          ↓ AW 写入
<AW_HOME>/
  catalog-sources.json                 [强配置]
  catalog-generations.json             [强选择状态]
  catalog-generations/<identity>/<digest>/{generation.json,snapshot/**}
  catalog-published-versions/<identity>/<version>.json
  plugin-config/**                     [强配置]
  catalog-cache/sources/<sourceId>/{current,last-good}/
  marketplaces/**
  lifecycle-active/**
  runtimes/codex/0.151.0/<platform-arch>/**
```

- 源码层是插件作者维护的输入。`evals/**`、正式报告和 `.DS_Store` 不进入 runtime bundle；Skill `README.md` 是 production source。
- 第三方 workspace 用 `aw catalog build` 生成 `.aw/catalog` schema 5 snapshot；本仓库维护者的 `pnpm build` 还会生成本地 staging。两种输出都是生成目录，不手工修改。
- Catalog v5 transport validation 只验证 snapshot 结构、路径、摘要、marketplace projection、release metadata 和 ledger。Path/Git provider、list 和 TUI 使用该层。producer、publication 和 published verification 使用 complete validation。安装先从 entry dependencies 计算闭包并逐 entry 检查 capabilities；通过后只对选中闭包执行完整 plugin validation。
- `aw catalog build` 从独立 workspace 生成 `.aw/catalog` development snapshot；`aw plugin build` 默认生成 `.aw/plugins/<name>`。两者先在同父 staging 完整构建和验证，再替换已证明为生成物的旧输出，并拒绝 workspace 外、符号链接及 `.git`、`plugins` 等受保护边界。
- `aw catalog init` 生成 `.aw-workspace.json`，唯一合法合同是 schema 1、`kind: "aw-catalog-workspace"` 和稳定非空的 `workspaceIdentity`。marker 必须存在；source、manifest 或 `catalog.version` 变化不改变该 identity，`--force` 也保留已有合法 identity。独立初始化的 Catalog Workspace identity 不同。生成输出 marker 不进入公开 plugin 或 snapshot digest。
- source plugin 的 authoring 输入树不允许符号链接。Manifest 声明的 source path 不能进入任意深度的 `.git/` 或 `node_modules/`；CLI 在读取 manifest、脚本或静态资源前统一检查该树，并跳过这两类不进入 source bundle 的目录。Catalog 严格校验把每个平台 `plugin.json` 与 bundle source manifest 的完整生成投影逐字段核对，并验证所有生成路径留在 bundle 内且存在。
- `aw catalog publish` 从干净且已有提交的 Source Workspace 发布到用户配置的 Git remote。CLI 先把已解析的 source HEAD 归档到隔离 workspace，在其中对每个插件执行公开 source validator，并只从该归档构建；ignored 或其它不属于 source HEAD 的工作树字节不能进入 snapshot。Core 准备 schema 5 published snapshot、完整 release ledger 和 release identity；CLI 的公共 preparation/publication service 负责 Git 前置条件、隔离 commit/tag、一次 atomic push 和完成后核验。branch 只是调用参数；第三方分支、`catalog/latest` 和 `catalog/beta` 使用同一算法、不可变 `catalog-v<version>` 注解 tag和 Workspace attempt。首次发布创建 root commit，后续发布只以读取并验证的远端 branch commit 为父提交。
 - 发布迁移可以把一个通过 transport、bundle artifact/content digest、marketplace projection、legacy release digest 和 ledger binding 校验的 published schema 4 snapshot 作为 schema 5 publication parent，并只继承其 Catalog version 和 release ledger。旧 bundle 不进入新产物；新 snapshot 仍从当前 Source HEAD 构建并执行 schema 5 complete validation。该兼容入口不适用于 Catalog source、安装或普通 transport validation；这些边界仍只接受 schema 5。
 - 作者命令在 CLI command layer 统一定位 Catalog Workspace。显式 `--workspace-root` 优先；否则从命令目标或 cwd 向上选择最近的合法 `.aw-workspace.json`。最近 marker 损坏时立即失败。`catalog init` 在没有祖先 Workspace 时选择 Git worktree root，再回退 cwd。Core build/validate API 仍只接受显式绝对 root。`aw catalog context --json` schema v2 严格只读地报告 Workspace、初始化建议、Git 和 publication target；`developmentSource.configured` 只表示存在唯一 owned managed source，且 path 匹配当前 Workspace `.aw/catalog`，不检查 snapshot 或 cache。context 不 build、不 fetch。
 - `aw catalog status` schema v2 默认只静态读取 Workspace marker、metadata、插件 source manifest、依赖图、可用的 Git 状态和 `.aw/catalog/.aw-generated.json` snapshot evidence；它不运行插件代码、不构建，也不创建 `.aw`。source identity 是排除 generated、dependency、eval/report 和 author-only metadata 的保守 canonical source 内容摘要。dirty Git 只作为静态事实，不阻止静态 status。只有显式 `--preflight` 才从 committed source HEAD 的临时归档运行公开插件 validator 和 build、读取远端 branch/tag/上一 snapshot，并调用与 `aw catalog publish` 相同的 Core publication preparation。`owner.url` 的 host 仍为 `example.invalid` 时，该共同 preparation 返回 blocking `catalogMetadataIncomplete`；静态 status 不受影响，且失败发生在 attempt 和远端写入前。preflight 不写 attempt、不 push，也不形成后续 publish 的持久授权；显式发布把用户授权的 descriptor digest 传回 CLI，publisher 在 attempt 和远端写入前核验该 digest 以及当前 source、remote、tag 和 plan identity。
- Publication target 只按 `--remote`、`origin`、唯一 remote 的顺序解析；多个且无 `origin` 时报告 ambiguous，没有 remote 时报告 unavailable。Branch 只使用显式值或固定默认 `catalog`，不读取当前 Git branch。preflight 和 publish receipt 保留最终 Workspace root、remote、branch 及各自 resolvedFrom。
- 第三方发布在第一次远端写入前保存 gitignored `.aw/publish/attempts/<version>.json`。每个版本文件独立保留；文件损坏或发布结果不确定时只阻止该版本，作者用 `aw catalog version <higher>` 恢复。该恢复合同不增加 force、补偿 push 或平台专用发布路径。
- Catalog manifest 保存规范化 marketplace owner/interface，验证器以它为唯一根 metadata 真值核对 Codex 和 Claude projection。`release.state=published` 的 snapshot 必须包含并完整验证 `plugin-release-ledger.json`；development snapshot 不包含 ledger。公开 Catalog 作者合同见[Catalog 作者指南](catalog-authoring.md)。
- `<AW_HOME>/catalog-sources.json` 缺失时读取内置 `official` source；第一次来源修改才物化该文件。稳定版 CLI 使用 `catalog/latest`，预发布 CLI 使用 `catalog/beta`。
- `catalog-sources.json` 只接受 schema 2。Path source 可带 `managedBy: { kind: "catalog-workspace", workspaceIdentity }`；Git source 和普通 `catalog source` CLI 不能声明或接管该 ownership。`aw catalog dev activate|status|deactivate --json` 按稳定 Workspace marker identity 管理当前 `.aw/catalog` path source。Workspace 移动时 activate 更新同一 owned source 的 path。status schema v2 严格只读：`ok` 只表示诊断可靠完成，`ready` 表示 snapshot current、唯一 managed source、path 匹配、cache current 且 cache digest 匹配 snapshot；阻止 readiness 的 issue 不使诊断失败。deactivate 不删除 snapshot。
- `runtimes/codex/**` 是可删除、可重建的弱状态。AW 只在用户级操作实际需要 Codex native 写入或移除时使用它。runtime 固定安装随 AW 发布更新的 `@openai/codex` 版本，不写入 `PATH`，也不读取或检测 Codex App。

### Portable Agent Skills Distribution

`agent-skills` 是独立 distribution，不是 `PlatformName`，也不改变 marketplace product eligibility。插件通过 `distributions.agentSkills` 显式声明该能力；原生 `skills` 不自动成为 portable source，也不支持 portable-only plugin。每个 materialized Skill root 都包含同一插件级 `aw-plugin-requirements.json` receipt；同层 receipt 优先于祖先 Manifest。

Catalog build 把 portable static Skill、明确选择 `distributions: ["agent-skills"]` 的 `skillRuntimeFiles`，以及 dynamic artifact 的 `runtimeImports` 复制到 consumer bundle。runtime import 带 bundle-local path、digest 和 provider provenance；materialize 运行时不读取其它插件 bundle，也不导入其它 renderer 的输出。

Manifest v2 的每个 `buildConfig.runtimeExports[]` 必须由 Provider 显式声明 `{ name, source, requires: { aw: { capabilities: [] } } }`；旧的 `{ name, source }` 形状无效。Core 使用统一 capability ID 规范化和稳定 digest 校验 metadata，不扫描 export bytes 推断或双检。只有实际用于 `skill-runtime-file` 或 `artifact-runtime` 的 export capability 传播到 consumer；`buildImports`、自有 `skillRuntimeFiles.source` 和 `generatedSkillRuntimeFiles` 不传播。Bundle 先解析实际 runtime import，再把 source/staged `requirements.effective` 与传播集合合并成唯一最终集合；同一集合写入 bundle manifest、Catalog entry 和所有 native/portable Skill receipt，并在最终 bundle 写入前检查当前 AW 支持。export metadata 即使 bytes 不变也属于 import/projection identity。

Portable materializer 使用调用方提供的同 source Catalog plugin set，解析依赖优先的完整 closure，读取现有 scope config，并合并 static 与 `agent-skills.skill` dynamic candidates。合并顺序是 `sourceDirs → distribution skillRuntimeFiles → renderer content.files`。任何无效 Skill、名字冲突、未解析模板或 sensitive config 明文都阻止整次输出。物化只使用操作级临时目录，并写 schema 1 `.aw-materialization.json`；它不创建 installed state、持久 current cache、Agent registry 或新锁。

`aw skill install` 先物化和 Review 完整候选，再通过 PATH 中兼容的 `skills >=1.5.23 <2.0.0` 执行 scope-wide 冲突预检、`skills add ... --yes` 和完成后验证。确认后的执行复用单一 `AW_HOME` mutation lock，并重新采集 Catalog、config、物化、版本和冲突证据；外部安装失败或验证缺项不做补偿回滚，receipt 提供重跑或外部 `skills remove` 恢复方式。project scope 在解析的项目根运行，user scope 使用 `--global`。

`aw skill materialize` 在同父目录 staging 中验证所选输出，再替换仅由相同 plugin ID、source identity 和 scope 的 schema 1 marker 证明属于 AW 的目标。foreign、身份不匹配、符号链接或过宽目标都 fail closed；命令不提供 force，也不创建 portable installed state。

TUI 在插件预览和详情中只根据 `distributions.agentSkills` 声明显示 Portable 能力，不提前运行 renderer 或声明精确候选数和安装 ownership。用户进入安装流后分别物化 project 和 user 的完整依赖闭包，以两者的稳定候选并集选择 Skill 和 Agent，再选择 scope；选择 scope 后按该 scope 重新物化，所选 Skill 在该 scope 不可用时阻止进入 Review。Review 只显示所选 scope 的实际候选、依赖贡献和冲突。执行复用 `aw skill install` 的锁内证据重采集，证据变化时必须回到 Review 重新确认。

## Catalog Sources and Cache

Catalog snapshot 的 logical identity 只来自其 `.aw-generated.json.workspaceIdentity`。source ID、Git URL、SSH/HTTPS 文本和本地路径不是 logical identity；同一 Workspace 的 official HTTPS/SSH alias 和不同 source ID 因此共享同一不可变版本检查。

`<AW_HOME>/catalog-generations.json` 是 schema 1 强选择状态。每个 source 记录 `refreshPolicy`、可选 `logicalIdentity`、`active`、`candidate` 和 `lastCheck`；没有 Active 或 Candidate 时可以只保存 policy 和检查失败。每个 pointer 绑定 source identity 和不含凭据的 canonical source-config fingerprint。普通 Active 读取按 source identity 接受 ref 更新和 official HTTPS/SSH transport alias；Candidate 激活还要求当前完整 fingerprint。其它 URL、Path 或 subdir 改变 source identity 时旧 selection 失效。内容寻址 store 位于 `<AW_HOME>/catalog-generations/<logical-identity-hex>/<snapshot-digest-hex>/`，每个 generation 只包含 `generation.json` 和完整、独立的 `snapshot/`。首版不做 generation GC、reader lease 或 observation database。

刷新先在调用自己的 staging 中复制 snapshot，并完成 snapshot、兼容性、digest 和 generated marker 验证。Git source 在 mutation lock 的最终提交区原子创建或核验 `<AW_HOME>/catalog-published-versions/<sha256(logicalIdentity)>/<catalogVersion>.json`，固定绑定该版本第一次观察到的 snapshot digest。记录损坏或同版本不同 digest 返回稳定 `catalogImmutableVersionViolation`；较高版本使用独立记录，不受较低版本损坏影响。Path source 不读写该记录，也不扫描 generation。验证完成后 generation 以目录 rename 原子发布，最后通过强状态原子替换更新 pointer；失败只清理本次 staging，原 Active 保留。

Git 首次手动 refresh 直接建立 Active；已有 Active 时，高版本建立 Candidate，同版本同 digest 为 no-op。普通 channel 只以当前 config fingerprint 下 Active 与 Candidate 的最高版本为单调 baseline；remote 低于 baseline 时保留已有 Candidate 并报告 `channelRollback`。显式 ref 变化可建立较低的 `refChange` Candidate。同一未变化 Git config 返回其它 Workspace identity 时，refresh 返回 `catalogGenerationIdentityMismatch`，且不改 Active 或 Candidate。Path source 默认 `manual`，每次 add 或手动 refresh 都建立 immutable local generation 并直接切换 Active；它允许同一 Catalog version 对应不同 digest，不监听文件系统。refresh 结果用必填 `activeChanged` 说明本次是否切换 Active，并在存在 Active 时返回 `activeGenerationKey`；Path refresh 和首次 Git bootstrap 为 `true`，Candidate、no-op 和 channel rollback 为 `false`。Candidate activation 把检查状态更新为带激活时间和 commit 的 `activeReady`。refresh 的远端解析、snapshot staging 和验证不持有 mutation lock；最终 pointer 提交只短暂持锁并重读 source config fingerprint。source config mutation 和 activation 继续与普通 AW 写操作互斥。

最小公开入口是 `aw catalog source refresh <id>`、`aw catalog source activate-candidate <id>`、`aw catalog source generation-status [id]` 和 `aw catalog source refresh-policy <id> <startup|manual>`，均支持 `--json`。policy 更新只原子写 generation state，不访问远端；无 Active 的 source 也可修改 policy，Path 只允许 `manual`。resolver 按 `config A → generation state → config B` 读取一致 control snapshot；config digest 变化最多重试三次，仍变化返回 `catalogGenerationIdentityMismatch`。Active resolver 一次验证 pointer、metadata、content-addressed 目录和 snapshot，并返回 metadata、manifest 和固定 snapshot root。`CatalogGenerationSet` 携带 config digest、source identity 和稳定 `generationSetDigest`；operation context 复用同一 control snapshot 和已验证 generation，不二次读取或验证。

普通 install、upgrade、reinstall、uninstall、非离线 cleanup、plugin config、status、TUI 和 Portable 操作只读取 Active generation。每次操作建立一个 typed `CatalogOperationContext`，直接绑定 immutable snapshot 路径、已解析的本地 Catalog 证据和 `generationSetDigest`；依赖 closure、目标计划、Review 和执行都复用该 context。普通 operation context 的公开 source freshness 固定为 `active`；`remote | cache | path` 只描述 provider 或 refresh 输入，不能表示普通消费者当前绑定的数据。它不复制 generation，也不建立 reader lease。已有 Active 时，普通操作不调用 provider、不检查 Git branch，也不访问远端。Candidate 只有显式 activate 后才对新操作可见；Path 工作区变化也只有显式 refresh 后才建立新的 Active。

唯一的自动获取例外是：本次需要的已配置 source 完全没有 Active。操作开始时，每个缺失 source 最多尝试一次 bootstrap，最大并发数为 2；来源独立完成，多项失败按配置顺序选择首个错误。Git source 可以访问远端，Path source 读取本地路径。首次失败也保存 refresh policy 和 `lastCheck`。bootstrap 后重新解析完整 Active set。已有但损坏、metadata 或 source identity 不匹配的 Active 必须 fail closed，不自动联网修复。多来源中已有 Active 的 source 不因其它 source bootstrap 失败而调用 provider。

每个 source 仍在 `<AW_HOME>/catalog-cache/sources/<sourceId>/{current,last-good}/` 保留 transport cache。它只用于显式远端获取和 generation staging 输入，是可删除弱状态；它不决定 Active、普通读取、安装、配置或删除权限。

Git source 使用本机 Git 的 credential helper、SSH agent 和 SSH config 读取私有仓库。解析保持非交互，默认远端解析超时为 180 秒，并可用 `AW_CATALOG_REMOTE_TIMEOUT_MS` 调整；它禁止 URL 内嵌凭据、SSH local command 和 proxy command，且 AW 不保存 Catalog 授权信息。

`aw catalog source add` 和 `update` 先在 mutation lock 内原子提交 source config；只有 source identity 变化才失效该 source ID 的旧 generation pointer。ref 或 official HTTPS/SSH transport alias 变化保留旧 Active，普通操作可继续使用它；新 fingerprint 的 refresh 结果建立 Candidate，用户显式激活后才切换 Active。其它 URL、Path 或 subdir 变化使旧 selection 失效。刷新失败时 config 仍已提交，receipt 和 generation state 报告该 source 的诊断。其它来源不会因此失败。`set-primary` 只改 source config；`remove` 同时移除该 source ID 的 generation selection state，但不删除 immutable generation、插件内容或任何 live ownership 现场。

`aw catalog dev activate` 复用 current development snapshot；snapshot stale、invalid、absent 或显式 `--force-build` 时执行 Catalog build 和 complete validation。随后它通过统一 source service 新增或更新 managed path source，并刷新该 Path source 的 Active generation。snapshot build 与 source config、generation 不组成跨系统事务：config 失败保留 snapshot，refresh 失败保留已提交 source，并返回 partial receipt。`deactivate` 对 primary source 先选择真实 `official`，否则只接受唯一其它 source；没有候选或候选不唯一时不修改配置。

多来源 resolver 用操作已绑定的 immutable Active snapshots 调用普通消费者。回调只能返回普通数据，不能向公开结果泄漏 bundle root、manifest path 或其它内部路径。首版没有 generation GC，因此操作 context 可在本次操作或 TUI load session 内固定引用这些目录。

## Write Pipeline

五个公开写命令使用同一条 rebuild 流程：

```text
固定 Active `CatalogOperationContext` 和目标
  → 生成临时依赖顺序与期望组件
  → 检查 live ownership
  → 仅为实际 Codex native 操作解析执行 manager
  → 必要时清理 AW-owned 旧组件
  → 写入原生和 AW-managed 组件
  → 按命令运行 lifecycle
  → 完成后检查
  → 输出 receipt v4
```

一次写操作在 `AW_HOME` mutation lock 内只采集一个当前现场 inventory。来源身份检查、marketplace 选择和 dependency plan 复用该内存 snapshot；执行不为 plan 或 preflight 再做第二次全量 inventory。计划完成后，writer 只对计划中的目标重新构建并检查 live ownership、native registration、有效 config 和固定 generation evidence。删除操作为检查历史 project consumer 读取的 inventory 范围不同，不与普通 target inventory 合并。

性能观察复用现有 debug event。`review.prepare.*` 记录 Review 准备阶段耗时；`performance:stage` 只记录 `catalog.context`、`catalog.validation`、`inventory`、`dependency.plan` 和 `target.build` 的阶段名与耗时，命令阶段另记录结果，Catalog load 另记录聚合 source/pointer/validation 计数，不记录 generation key、路径或错误文本。`native:start|success|error` 只记录白名单 `agent`、稳定 operation、`exitCode`、固定 reason 和 `durationMs`，不记录 args、cwd、stdout、stderr 或未知 error/cause 文本；`rebuild:action` 分别记录 `preflight.inspect`、`native.write`、`artifacts.write` 和 `postcheck.inspect` 等真实写阶段耗时。没有 native 或 artifact 动作时不伪造对应阶段。测试用 provider 调用次数、检查范围和阶段事件验证 write 性能边界。Warm install 的总时长只对受控 fake native runner 使用宽松门槛；本地 Catalog 阶段 p95 目标为 500ms，不能据此承诺第三方 CLI 时长。

首版不增加 authoritative installed-state DB、Observation Index、generation GC/read lease、新锁层级、全局事务或补偿状态机。Active generation 已是不可变内容寻址目录，操作 context 直接引用它；当前可观察的重复 inventory 可以用操作内 snapshot 消除。这些事实不足以证明新增持久状态和协调协议的成本合理。

TUI 的所有写入口在进入 Review 前先进入 `ReviewPreparing`。这个阶段只执行当前 intent 的验证和证据采集，不执行写入。一次成功的 TUI load 固定可用来源的 Active generation 子集，并保留其它来源的失败证据；子集 digest 只包含成功来源。同一 session 的浏览、设置、status、依赖 preview 和 Review 从该固定子集选择所需 source context。load 对 source config 和 generation state 只建立一份一致 control snapshot；同一 immutable Active/Candidate generation 的完整 transport validation 在一次 session 或紧邻的 mutation/reload 中复用，并只保留当前 pointer 集合，不形成跨进程或通用跨 session cache。load 时失败的来源不可操作，直到用户刷新来源并重新加载；后续页面不会再次 bootstrap。后台 refresh 产生 Candidate 或显式 refresh 尚未改变该子集。页面只显示实际已开始的 status、Catalog、inventory、dependency plan、config、Portable 或 evidence 边界，并在 debug 日志记录阶段耗时。可用 Esc 协作式取消。取消会使迟到的只读结果失效。底层不支持 signal 的读取可以结束，但不能再创建 Review。准备成功时，Review 原位替换准备页，因此 Back 返回原页面并保留其选择或草稿。

TUI 只在首屏使用已绑定 Active 和 live status 发布后，对 `refreshPolicy=startup` 的 Git source 启动内存后台刷新，最大并发数为 2。单个 source 失败不阻止其它 source；Controller dispose 取消未完成的 provider 和 staging。后台或手动 refresh 只更新持久 generation 视图、Candidate、lastCheck 和页面进度，不静默重载当前 session 的 status、插件和依赖。只有本进程 refresh 明确返回 `activeChanged=true`，且 session 没有绑定该 `activeGenerationKey` 时，Controller 才派生 `reloadRequired`；缺失 session key 本身不表示 Active 改变，Active 不兼容或 source load 失败也不能形成 reload 循环。来源详情和刷新完成页同时显示新 Active 与本次 session，并提供“重新加载Catalog”。显式 reload 不新增持久状态，并以 `bootstrapMissingActive: false` 重建 session；reload 完成后清除本次内存 Active 变化事件，来源仍失败时继续显示来源问题。未保存的 config/source/Portable 草稿、ReviewPreparing、active Review、写入或来源修改进度及 refresh 进度继续阻止 reload。激活只在用户确认 Review 后复用本地 Candidate；成功后自动重建 session，Candidate 在 Review 后漂移时必须返回 stale 并建立新 Review。

Review 仍是用户确认边界。Review evidence 包含 `generationSetDigest` 和所需 source generation 证据。用户确认后才进入 `Progress` 并开始写执行；`Progress` 不接受 Esc 取消，只能按现有约定请求在操作完成后退出。`ReviewPreparing` 的可取消只读状态和 `Progress` 的已接受写状态不得共用 busy 或取消语义。Execute 在同一个 `AW_HOME` mutation lock 内重新解析当前 Active set，验证绑定的 generation 目录和 metadata 仍存在，并比较 Review digest。source config 改变或 Candidate 被 activate 后，Execute 必须在 plugin、config 或 native 写入前返回 typed `operationReviewStale` 或新 Review。该检查不访问远端 branch。

Codex manager 解析也在同一个 `AW_HOME` mutation lock 内完成，并在执行时重新探测。Codex project scope 不使用 native manager。用户级正常写入优先使用兼容的 system CLI；system CLI 缺失时复用有效的 AW-managed cache，只有 cache 缺失或可安全重建时才需要本次授权。直接 TTY 可在首次获取前确认；JSON 和非交互命令必须传 `--allow-managed-codex-install`。已安装但过旧、版本不可解析或探测失败的 system CLI 会阻止操作，不能用 managed runtime 绕过。manager 选择不进入 receipt/status v5，也不成为 `operationReviewStale` 证据。

TUI preview 只读，并且只在最终计划含 Codex native 操作时探测 manager。若需要获取或重建 runtime，Review 明确显示 `@openai/codex`、固定版本和 AW-managed cache；执行该 Review 即授权本次获取，不再显示第二次确认。

依赖执行顺序只在本次命令内存在。receipt 可摘要公开 requested/resolved plugin ID、dependency edge、relation、requiredBy 和 dependency state；它不公开持久计划、摘要、锁或来源内部证据。

- `install`：按当前 Catalog 安装请求插件和缺失依赖；已存在且完整的依赖使用 `keep`，不重复安装。
- `upgrade`：按当前 Catalog 重建选择的目标和完整依赖闭包；`--all` 从 live owner 发现目标。依赖按稳定的依赖优先顺序重建。
- `reinstall`：先只清理 AW-owned 组件，再按当前 Catalog 完整重建。
- `uninstall`：删除 AW-owned 组件；可用时从 lifecycle active snapshot 重放历史 uninstall lifecycle。source 不可用且无法安全重放时，命令失败并提示 `cleanup`。
- `cleanup`：不运行 uninstall lifecycle。它可在 source 或 Catalog 不可用时，根据 live AW owner 现场清理。它保留 plugin config。
- `cleanup --force`：用于跳过依赖保护，或恢复专属且已损坏的 AW-owned 输出。它可能让 dependent 的依赖 readiness 变为未就绪，但不改写 dependent 自身的 ownership health；它不得删除 foreign 或 shared 内容，且保留配置。

TUI 把 `sourceMissing` 和 `bundleUnavailable` 统一投影为 offline cleanup。Review 不解析缺失的 bundle，而是绑定包含来源身份、目标位置和 live ownership fingerprint 的 typed evidence。Execute 在同一个 `AW_HOME` mutation lock 内重新读取 owner marker/header、shared owner 和 native registration；evidence 漂移时在写入前返回 stale Review。synthetic cleanup target 只使用这些 live evidence 发现的 matching-owner 组件，且普通 TUI 不启用 force。

每条失败链必须可用 `cleanup`、`cleanup --force`、`reinstall`、来源刷新或新版本发布恢复。无法证明 ownership 时宁可保留内容，也不能删除用户或共享内容。

### Lifecycle Active State

`lifecycle-active/` 保存最近一次成功写入后、下一次 uninstall 所需的 bundle 和输入。它只服务 lifecycle replay，不决定插件存在，也不参与 status 健康判断。snapshot 缺失或损坏不会把 live owner 变成 absent；`cleanup` 仍可清理可证明属于 AW 的输出。

安装或升级的 lifecycle 写入失败时，AW 清理本次已拥有组件并保留可恢复的现场。达到持久平台写入点后的失败可以留下 partial 状态；用户使用 status 和 reinstall 或 cleanup 恢复。

## Live Status and Config

`aw status` 是只读操作。它组合多来源 Active Catalog、live owner、原生平台组件和有效配置，并对每个来源独立报告错误。它不运行 lifecycle，也不创建 config 目录。已有 Active 时，status 只读取 immutable local snapshot，远端调用数为零；无 Active 时只允许前述单次 bootstrap。普通 config read/write 和 TUI settings 使用相同规则。

每个 target 的状态为：

| 状态 | 含义 | 建议 |
|---|---|---|
| `present` | 所有期望 AW-owned 组件存在 | 无 |
| `absent` | 没有发现该 target 的 AW-owned 组件 | `aw install` |
| `partial` | 只有部分组件或组件不完整 | `aw reinstall` |
| `error` | Catalog、发现或组件检查失败 | 修复来源或现场后重试 |

组件状态为 `present | absent | partial | foreign | error`。`foreign` 表示 exclusive artifact slot 已被当前插件不拥有的内容占用；它不能作为已安装证据。公开 collision evidence 只包含 `reason`（`ownerMismatch | unownedContent | typeMismatch`）、`artifactKind`、`artifactKey`、`expectedOwner` 和可选 `actualOwner`，不得包含组件绝对路径、credential、未知 stderr 或临时内部信息。

target 聚合只使用 AW-owned live 证据。所有 own 组件健康时为 `present`；存在 own 组件但必要组件缺失或损坏时为 `partial`；没有 own 组件时为 `absent`。foreign-only target 为 `absent` 并带结构化 `artifactCollision`；own 不完整且存在 collision 时为 `partial` 并带相同错误。每个 Status v5 target error 有必填 `severity: warning | blocking`。`artifactCollision` 在所有 target state 中都是 `blocking`；`awCapabilityUnsupported` 保持非阻断。`hasErrors` 统计任意 blocking target error，并继续统计 source 和全局错误。当前插件的普通 cleanup 和 uninstall 不删除 foreign component；collision 只阻止 install、upgrade 和 reinstall，不阻止安全清理 AW-owned 内容。

Status v5 对已检查的直接依赖公开 `ready | absent | blockedByCollision | incomplete | error` readiness。依赖问题携带 `dependencyPluginId`；有可识别根因时还携带稳定的 `rootIssueId` 和 `rootIssueCode`。依赖 artifact collision 必须投影为 `blockedByCollision` 和 `artifactCollision` 根因。consumer 的依赖 warning 只进入 readiness 和 error evidence，不能把健康的 AW-owned target 从 `present` 改成 `partial`，也不能覆盖根因。

`status --json` 只输出 schema 5，不提供 schema 4 参数或双轨输出。公开状态只描述当前组件和安全诊断；它不输出内部 cache 路径、生命周期内容或依赖执行细节。人类 CLI 和 TUI 把 `artifactCollision` 显示为需要移除或迁移占用内容的输出冲突，不把它显示为安装不完整。

TUI placement 在 ownership health 之外投影 collision blocker，但不能把 foreign-only collision 计为 installed。foreign-only placement 使用 `blocked`；`present` 或 `partial` placement 保留 installed ownership health，并同时保留 collision blocker。每个平台 placement 独立判断：混合平台仍可进入添加并只列可用 target；所有平台都阻断时，Preview 和平台菜单先提供“查看输出冲突”，且不显示添加、升级或重新安装。installed collision 仍提供安全移除入口，删除只处理 AW-owned 内容并保留 foreign 内容。

TUI 插件清单继续组合当前 Catalog summary 和 status target。若 live ownership 仍存在，但当前 Catalog snapshot 已无该插件，目标保留 `bundleUnavailable`，并同时显示在浏览和已安装清单中。TUI 只提供普通 `cleanup`：Review 说明仅清理 AW-owned live 内容、保留 plugin config 且不运行 uninstall lifecycle，并显示不含 `--force` 的等价命令。普通 cleanup 继续执行 dependent 保护；成功后是否从清单消失只由重新读取的 Catalog 和 live ownership 状态决定。

TUI 为每个插件选择一个稳定的 primary attention，包含 `warning | error`、稳定 code 和可读 message。选择顺序为：来源移除、artifact collision、来源不可用、依赖图无效、依赖目标不支持、依赖未就绪或缺失、scope 冲突、必填或无效配置、安装不完整、通用诊断。问题中心按 `sourceRemoved`、`artifactCollision`、`sourceUnavailable`、`dependency`、`scope`、`config`、`installation`、`diagnostic` 稳定分组和排序，并渲染真实分组标题和每组数量。Root Cause 只在 TUI 本地复用公开 `rootIssueId` 和 `rootIssueCode` 聚合，不扩展 Status schema；投影明确记录 root entity、affected targets 和 `direct | consumer` 关系。direct partial 或 error 使用 root code、root plugin entity、platform 和 scope 形成 canonical key，并与同 entity、同 root code 的 dependency evidence 合并。direct root 永远优先；过滤结果没有 direct target 时，从 dependency evidence 稳定合成 root，不能选择任意 consumer。payload target 顺序不影响结果。

target health 只表示当前 live 组件是否完整，不表示 Catalog 版本是否更新。控制台可以从可靠的原生安装证据生成私有 revision sidecar，用它区分 `current`、`upgradeAvailable` 和 `unknown`；该 sidecar 不进入公开 Status v5 JSON。旧版但完整的原生安装仍为 `present`，仅 revision 为 `upgradeAvailable`。

配置按 manifest default、user、project shared、project local 合并。source config 和 plugin config 均使用原子替换。config 已提交后，后续平台重新安装失败不回滚该配置；receipt 和 status 报告 partial 结果，用户可重新安装恢复。

控制台的插件设置入口先显示合并后的实际配置和值来源。用户选择修改后，才选择 user、project shared 或 project local 写入层；编辑器继续以单个插件和单个写入层拥有草稿，并在字段旁显示当前全局有效值。配置持久化、Review 和执行仍只作用于所选写入层。

控制台搜索把 query 与输入焦点分开；退出输入后 query 继续参与来源和安装状态筛选。所有字符输入显示静态光标，并按 grapheme cluster 和终端显示宽度保留输入尾部。当前设置层已有字段值时，字段动作先说明当前值、实际来源和删除后的继承结果；字段删除和整层删除都只进入草稿与 Review。Config Review preparation 复用本次 TUI session 的 generation、目标 fingerprint 和所选 config store digest，不重新运行完整 status 或访问 Catalog remote；Review 分别显示设置变更、应用影响和保持不变。个人默认变更重新应用当前目录中已安装的 user 与 project 目标；项目 shared/local 变更只重新应用当前 project 目标。Review、stale fingerprint 和实际 writer 使用同一目标集合。

Catalog ref 页面只把 Release 和 Beta 投影为现有 explicit ref；底层仍只有 `cliChannel | explicit`。official HTTPS/SSH 切换只改变 transport location，并通过 source mutation Review 提交；Catalog logical identity 继续只来自 generation 中的 Workspace identity，不修改 live owner identity。

### TUI 诊断投影与脱敏边界

TUI 在 Controller/ViewModel 层把现有 source、status target、dependency、config 和 Portable blocker 状态投影为统一诊断。该投影只存在于当前进程，不新增诊断数据库、持久状态或 Status v5 字段。产品层必须说明发生的情况、受阻或降级的能力、保留的安装或设置，以及下一步恢复动作；Active generation 正常、缺失和损坏必须使用不同影响与恢复动作。

技术层只接受白名单结构字段：安全错误 code、可选 stage、sourceId、requestedRef、resolvedCommit、last-good 证据，以及有限的 platform、scope、plugin、dependency、field、freshness 或 compatibility context。技术层在显示前再次执行通用凭据脱敏、URL userinfo 和敏感 query 清理、已知 home、cwd、临时目录和来源路径替换，并截断文本。任意 native stderr、未知 `Error.cause`、内部绝对路径、digest、credential 或未证明安全的 status message 不进入诊断 ViewModel；不能证明 cause 安全时省略 cause，只保留 code、stage 和白名单 context。

## Platform Boundaries

- 只删除可证明属于 AW 的 marker、managed block、artifact 或 namespaced 组件。
- primary source 默认继续使用 `aw` marketplace。若用户级 Codex 或 Claude 的 `aw` 已由 legacy 或 foreign source 占用，首次安装改用 source-bound `aw-<sourceId>`；两个平台使用同一名称。已有 canonical 注册继续决定名称，候选名称被 foreign source 占用时 fail closed。
- 外部 Codex/Claude 命令、用户手改目录和共享 marketplace 都是不受 AW 完全控制的边界。Claude 合法的未绑定默认安装记录不属于任何 marketplace；来源 inventory 必须保留并忽略它，不能把它归为 canonical 或 foreign。执行 native install 前，若任意 scope 存在与目标原生插件名称相同的未绑定 bare-key 记录，写命令必须在清理、mirror 和 native CLI 调用前 fail closed；不同名记录继续保留并忽略。cleanup 和 uninstall 不删除、迁移或重命名未绑定记录。命令允许部分成功，并报告残留和失败。
- Codex cleanup 和 uninstall 先直接检查 config、cache、manifest 和 ownership。没有可证明的 AW-owned native residue 或待移除的 canonical marketplace 时，不解析或获取 manager。发现 residue 且 system CLI 缺失时，可在本次授权下使用 AW-managed 官方 CLI 执行 remove。AW 不直接删除 Codex 私有 plugin storage；foreign 内容始终保留。remove 或完成后检查失败时保留 residue，并提示重试 cleanup/uninstall、升级 AW 或安装兼容的官方 Codex CLI。
- Codex project config 的规范路径与 Codex user home 相同时，未发现 project owner 的默认 status 不生成 project placement；显式 project status 报告路径别名。`install`、`upgrade` 和 `reinstall` 不向这个 project placement 写入，用户必须进入独立项目目录；`cleanup` 和 `uninstall` 仍可处理已有 project owner。
- active marketplace、backup、quarantine 和 lifecycle snapshot 都是弱状态。清理失败时保留它们，后续 cleanup 可重试；不得因为弱状态损坏永久阻止用户清理自己的 AW 输出。
- 项目范围路径必须在项目边界内；不跟随不安全的符号链接或删除 foreign 内容。

### Codex shared native 与 project activation 的 staged rollout gate

以下条目是目标架构门禁，不表示当前 write、status 或 materialization 已完成迁移。后续阶段必须硬切删除旧 Codex project materialization；不得保留旧路径作为 AW fallback，也不得同时维护两套 project 安装模型。

- Intent 只表示 desired state。user/project enablement、选中平台和 scope 都是待达成目标，不是安装事实。actual state 只来自当前 live ownership、Codex native config/cache/manifest，以及可观察的 native loader 证据。
- Codex plugin 只物化一份 shared native user package。project scope 只在项目的 Codex 配置中激活该 native plugin。不得为此保存 project path、global claim、refcount、native installed ledger 或第二套安装状态；qualification report 也不是 installed ledger。
- 基础 Codex native plugin 合同最低为 `0.145.0`。涉及 project activation 的操作最低为 `0.151.0`。开发 qualification 固定拒绝非精确 `0.151.0`，避免把其它版本的行为外推到 rollout allowlist。
- PATH 中有 Codex CLI 时，操作按适用版本门禁探测它。PATH 中没有 system CLI 且操作只修改 project activation 时，不探测 Codex App，也不获取 manager；系统把 App 的 project activation 能力标记为 `assumed`。只有操作需要物化或移除 shared native package 时才解析 manager；system CLI 缺失时，AW-managed manager 必须取得精确 `0.151.0`。
- 每种 native kind 必须先通过显式真实 qualification 才能进入 rollout allowlist。未被行为证据证明的 kind 必须返回 `unsupported`，不能从帮助文本、源码字符串或相邻 kind 推断。当前 `0.151.0` qualification 可证明 Skill、MCP、Hook 和 App；slash command 因没有可用的离线运行时证据保持 `unsupported`。
- project activation 的最低行为合同是：native add 默认创建 user enabled；`user=false, project=true` 只在受信任的精确 project cwd 加载；neutral cwd 不加载；`user=true, project=true` 在两处加载同一 shared native plugin；project trust 未生效时 project-only activation 不加载。
- `status` 始终只读。它只能读取 Intent、live ownership 和 native evidence，并标明 observed 或 assumed；不得安装 manager、调用 native add/remove、修改 trust/config、创建 claim/refcount，或把 qualification report 当现场事实。

独立入口 `pnpm qualification:codex-project-native` 只用于 rollout qualification。它使用临时 Codex home、临时项目和临时本地 marketplace，且不进入普通 test、build 或 release 默认链。机器报告只说明该次 CLI/OS 的 qualification 结果，不授权或记录任何用户安装。

## Agent Skill Eval Plan 与 Runner 边界

- Skill-local `evals/manifest.json` 的准备合同是 CLI 拥有的 `AwSkillEvalManifest v1`。`aw skill eval prepare` 通过 Catalog Workspace 解析 canonical plugin，复用真实 bundle、依赖、profile config 和平台 materialization，输出一个 profile 的输入完整 `AwSkillEvalExecutionPlan v4` 目录。Plan 输入只引用目录内的 target、可选 previous target、筛选后的 cases、provider capability 文档、suite metadata/fixture 和移除目标 Skill 后的完整 subject base；最终目录在 staging 完整验证后原子发布，已有、过宽或含符号链接的目标 fail closed。profile 不得把 sensitive config 值带入 Plan。
- `aw skill eval check` 只读取 Manifest 注册的 document/schema，并用 Draft 2020-12 `json-schema` checker 输出 CLI 拥有的 `AwSkillEvalCheckResult v1`。它不 build 或 materialize plugin，不运行 renderer、provider、任意脚本或模型，不生成 `EvalRunBundle`，也不消费 provider/model 凭据；结果只绑定 document 和 schema 摘要。
- `aw` 的 Eval 子命令只有 `aw skill eval prepare|check|provider`。`prepare` 和 `check` 是确定性操作，不启动模型；`provider` 是 Plan 记录的低层 provider 进程入口，不是第二个运行编排器。
- Eval 执行的唯一机器 owner 是 npm package `@lesliechan721/agent-skill-eval` 的 `aw-skill-eval` bin。当前合同固定为 Plan v4、`EvalRunBundle v4`、`EvalAuditResult v3`、provider capabilities v2 和 provider output v1。兼容 bundle 使用 `runner.id` 和 `runner.version` 标识实际执行器，Audit 是独立输入和结果，不嵌入 bundle。
- 默认适配器插件是 `aw-skill-eval-runner`，Skill 是 `run-aw-skill-evals`。任何会启动模型的执行都必须先取得覆盖当前 Plan 的 passing preflight Audit，再调用 `aw-skill-eval run <plan.json> --audit <audit.json>`；CLI 不提供第二个 `run` wrapper。
- Plan、bundle 和运行输出都是可删除、可重建的弱状态。准备或执行中断后，删除本次不完整输出并重新 `prepare`、Audit 和 `run`；不维护 batch checkpoint 或续跑 ledger。
- Conversation suite 或 case 可用最小 `environment.pathPrepend` 声明 Eval-owned PATH fixture。路径相对声明它的 Eval 根解析，必须是根内的普通文件或目录树，且不能包含符号链接。Runner 只复制已声明 fixture 到本次隔离 workspace，并只在那里设置 executable mode 和前置 PATH；Oracle 不依赖仓库私有 CLI 路径。声明 `workspace_valid: true` 的确定性 fixture 必须 materialize 后通过公开 `aw catalog status --json`，并让每个预期有效插件通过 `aw plugin validate --json`。该 preflight 不运行模型，也不代替 Oracle Audit。
- `hostSourceAccessAbsent` 只按 app-server 事件中的显式命令、审批和文件访问输入归因。命令输出、Agent 消息、reasoning 和 diff 中的宿主路径文本不是访问证据。
- Plan 可用可选的 `minimumEvidenceLevel` 固定最低证据要求。省略时为 `executed`；要求 `comparative` 时，默认 runner 只在 macOS/Linux 的 Full Access verified observation 或更强 external containment 下接受 grading。verified observation 必须在 bundle 中保留非 OS 强隔离限制，不能记录后代清理保证。
- Oracle preflight、result triage 和证据准入属于 `review-agent-skill` 或发布消费侧。运行前没有 passing Audit 时不得启动模型；没有 result triage 的 bundle 只能作为原始诊断证据，不得影响 Review finding、生产 Skill 修改或发布结论。

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
- Catalog 候选只读取 source metadata、immutable `catalog-v<version>` tag 和 Workspace attempt。当前 exact candidate 未发布且未尝试时复用。beta 已使用时在同一 base 选择下一个未使用的 `beta.N`；stable metadata 在 beta 渠道选择该 base 的 beta。stable 发布可以把 beta metadata 提升为同 base stable；若 exact stable 已发布或已尝试，必须显式 bump。任何存在的 attempt 文件（包括损坏文件）都占用其 exact version。
- 所选轴无候选时在远端写入前失败。CLI 和 Catalog 远端状态独立读取。Catalog-only 不查询或发布 npm package，不要求 CLI tag，也不执行 provider-side CLI compatibility gate。
- 元数据 commit 后运行所选轴的完整 release verify，再从更新后的干净 source HEAD 生成 `.release/prepared/descriptor.json`。Catalog snapshot 和 publication descriptor 只读取已提交的 Workspace metadata，并由与 `aw catalog publish` 相同的公共 preparation service 生成；publication 不接受独立 Catalog version override。
- 发布顺序是 `Eval → Core → CLI → CLI tag → Catalog`。CLI tag 是 `origin` 上指向 prepared source commit 的注解 `cli-v<version>`；Catalog 继续使用独立 channel ref 和 `catalog-v<version>` tag。
- beta CLI 选择候选时，把 registry 中三个包已出现的最高 beta 和本地已尝试 beta 都视为已占用。部分发布或第一次写入结果不确定后，普通发布保留稳定 target 并选择下一个 beta，再以新 beta 重新发布三个包。稳定 CLI 失败仍要求提升稳定 target。
- `pnpm release -- --repair-cli` 是同一 CLI 候选的显式补发入口。它只接受与 `attempted.json` 精确绑定且未变化的 prepared descriptor、source commit、build 和 tarball；逐包核验已存在的远端 tarball，只发布 registry 明确缺失的包，最后重新核验整组三包并补 CLI tag。内容冲突或查询不确定时停止；它不发布 Catalog。
- `pnpm release -- --repair-cli-tag` 只从有效 prepared descriptor 核验并补发 CLI tag。它不准备新候选或修改分支。

`.release/prepared/` 在 gitignore 下，是可删除的弱状态；删除后重新 prepare。`.release/attempted.json` 只服务 CLI/npm 安全门禁。Catalog 的唯一门禁是 Workspace `.aw/publish/attempts/<catalogVersion>.json`；公开命令和官方 release 在任何可能的远端写入前原子创建同一文件，失败后保留。普通 Catalog 发布不得重跑已尝试的同一版本，且不提供 repair。

Catalog publisher 使用 prepared snapshot 写入相应 channel 和版本 tag。远端原子写失败或结果不确定时，同样必须提升 Catalog 版本后重发。CLI tag 推送异常时先读取远端；预期 tag 已指向 source commit 即成功，缺失时用 tag repair 补发，冲突时停止。

## Key Paths

- `packages/cli/scripts/bundle-plugins.ts`：生成 catalog snapshot。
- `packages/cli/scripts/plugin-staging.ts`：生成 Catalog staging 内容。
- `scripts/release/prepared-release.mjs`：生成、验证和消费本地 prepared release。
- `scripts/release/release.mjs`：一键发布公共编排入口。
- `scripts/release/cli-git-tag.mjs`：CLI source tag 检查、发布和恢复。
- `scripts/release/catalog-publication.mjs`：把官方 channel/remote 参数交给 CLI 公共 Catalog publisher。
- `packages/cli/authoring/`：随 CLI 发布的确定性插件作者实现。
