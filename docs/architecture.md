# Architecture

本文件面向仓库维护者，负责 CLI 系统结构、模块边界和稳定产品合同。TypeScript 实现方式见[编码约定](coding-conventions.md)，测试设计见[测试指南](testing.md)，插件专用工作流见[插件维护指南](plugin-maintenance.md)。

## CLI Source Layout (`packages/cli/src`)

- `commands/write-commands.ts` 是 `install`、`upgrade`、`reinstall`、`uninstall`、`cleanup` 的公开写入口。
- `commands/rebuild-command.ts` 解析 current catalog 和 target，并把五个写命令交给同一条 rebuild 流程。
- `commands/rebuild-operations.ts` 只编排 ownership 检查、清理、平台写入、artifact 写入、lifecycle 和完成后检查。
- `commands/rebuild-integration.ts` 把插件能力转换成平台原生写入和 AW-owned 组件。
- `commands/status-v4.ts` 读取多源 catalog、live ownership 和平台组件，输出 status v4，并为控制台提供同一份数据。
- `authoring/` 是 `aw plugin init`、`add-skill`、`validate` 和 `check-versions` 的唯一确定性作者实现；该目录随 CLI tarball 发布，运行时不读取仓库 `.agents` 或插件 Skill root。
- 作者命令默认把插件根解析为 `<repo-root>/plugins/<plugin-name>`。`init`、`add-skill` 和单插件 `check-versions` 可用 `--plugin-root` 指定仓库内其它根；路径相对 `--repo-root` 解析，目录 basename 和 manifest name 必须匹配 plugin name。`validate` 和 `check-versions` 在读取 manifest 前对 repo root、plugin root、`.agents-plugin` 和 manifest 使用同一条逐节点 `lstat`、`realpath` 和边界身份围栏；默认根、显式根和 `--all` 都拒绝这些节点中的符号链接或错误类型，诊断只报告被拒节点，不解析或泄露链接目标。显式根的 `init` 不要求或修改 `plugins/marketplace-source.json`；`check-versions --all` 仍只扫描仓库 `plugins/`。
- `utils/ownership.ts` 定义 owner marker、组件检查和安全删除边界。
- `utils/lifecycle-active-store.ts` 保存最后一次成功写入所需的 lifecycle 输入。
- `utils/local-marketplace.ts` 校验 namespaced active marketplace，并在安全替换时重放 Codex Skill owner overlay。
- `utils/multi-source-catalog.ts` 是 schema 1 Git/path source 的唯一 runtime catalog resolver。
- `utils/plugin-config.ts` 与 `utils/plugin-config-write.ts` 管理 namespaced AW config store 和 config v4 输出。
- `output/command-receipt.ts` 生成五个写命令的 receipt v4。
- `generators/` 生成 instructions、permissions、hooks、agents、skills 和 MCP 等平台能力。
- `types.ts` 保存跨模块公开类型。插件 manifest 不支持顶层 `dependencies`。

写命令和 status 只根据 current catalog、live ownership 和平台组件执行。

### Core Types

- `PluginManifestSource`：插件源码 manifest。
- `PluginMeta`：manifest 加 bundle root 和 manifest path。
- `CatalogResolution`：current catalog identity、selector 和 strict cache 证据。
- `OwnedComponent` 与 `OwnerIdentity`：可检查、可删除的平台组件及其归属。
- `DesiredTarget` 与 `RebuildResult`：rebuild 的目标输入和统一结果。
- `StatusV4Payload`：status v4 公开结构。
- `ArtifactPlan`：renderer 和 AW apply 之间的 v2 数据合同。

### Module Invariants

- renderer 只返回 `ArtifactPlan`，不直接写平台文件。
- 写入前必须验证 scope、path boundary、target identity 和最终 Skill tree。
- Codex/Claude Skill 原生调用 metadata 来自最终文件树，AW 只校验和保留。
- command 分支不得新增另一套安装状态投影、依赖图或平台输出记录。

## Three-Layer Distribution Model

```text
Source layer
  plugins/marketplace-source.json
  plugins/<name>/.agents-plugin/plugin.json
  plugins/<name>/README.md
  plugins/<name>/skills/**
  plugins/<name>/skills/<skill>/README.md
  plugins/<name>/skills/<skill>/evals/**          [author-only]
  plugins/<name>/reports/<skill>/<batch-id>/      [formal source history]
    ├── report.md
    └── summary.json

Temporary evaluation layer
  .tmp/agent-workflows/evals/**                   [complete local evidence]

          ↓ pnpm build

Local schema 3 catalog snapshot (`packages/cli/plugins-dist/`)
  ├── catalog-manifest.json
  ├── .claude-plugin/marketplace.json
  ├── .agents/plugins/marketplace.json
  └── plugins/<name>/**

          ↓ make stage-catalog CATALOG_VERSION=<version>

Release staging (`.release/catalog-staging/catalog/`)
  ├── catalog-manifest.json
  ├── plugin-release-ledger.json
  ├── .claude-plugin/marketplace.json
  ├── .agents/plugins/marketplace.json
  └── plugins/<name>/**

          ↓ Git catalog publisher

Git catalog source

          ↓ path/Git source resolution

Local runtime
  <AW_HOME>/
  ├── catalog-sources.json
  ├── catalog-cache/**
  ├── marketplaces/<sourceId>/**
  ├── plugin-config/<sourceId>/<pluginName>/**
  └── lifecycle-active/<sourceId>/**
```

- 仓库源码层是插件作者维护的输入。
- 任意路径段 basename 为 `.DS_Store` 的 macOS 临时文件不进入 production identity、catalog runtime bundle、安装制品、runtime digest 或 review 完整文件集合；其它 hidden production 文件仍按普通 runtime 内容处理。Skill 根的 `evals/**` 和插件根的正式 `reports/**` 也不进入 catalog runtime bundle、安装制品或 runtime digest。Skill `README.md` 是 production source，会随 Skill 发布。
- `.tmp/agent-workflows/evals/**` 只保存本地临时证据，不进入 Git 或 runtime bundle。插件正式报告位于 `plugins/<plugin>/reports/`，repo-local 静态 Skill 正式报告位于 `.agents/reports/`。Eval、评审、发布和登记步骤由 [create-aw-plugin](../.agents/skills/create-aw-plugin/README.md) 与 [skill-review](../.agents/skills/skill-review/README.md) 工作流定义。
- 本地 catalog snapshot 和 release staging 都是生成物，不手工修改。
- CLI version、catalog version 和 plugin version 是三套独立身份。
- `pnpm build` 在 `packages/cli/plugins-dist/` 生成 schema 3 snapshot。开发态 `catalogVersion` 使用 CLI package version，channel 由该版本是否为 prerelease 确定，因此 build 不需要发布版本输入。
- schema 3 manifest 保留 `catalogVersion`、`channel`、catalog compatibility 和 current entries，不包含 npm package identity。`compatibility.aw.minVersion` 取所有插件最低 CLI 版本与 schema 3 Git 分发 floor `0.1.0-beta.2` 的最大值，因此不能发布给不支持该格式和 source 路径的旧 CLI。每个 entry 包含 `artifactDigest`、`manifestDigest` 和基于真实 runtime 内容生成的 `contentDigest`。artifact 和 content digest 的每个 path record 都绑定 node kind 与规范 Git mode：regular file 只使用 `100644` 或 `100755`，symlink 使用 `120000`；snapshot digest 还把目录归一为 `040000`，不绑定 checkout 的其它权限位；`contentDigest` 只额外归一生成 manifest 的 plugin version。schema 3 validator 拒绝 Git commit 无法表示的空目录；仅包含 ignored 文件的目录仍按真实文件树处理。
- `make stage-catalog CATALOG_VERSION=<version>` 从隔离 build snapshot 生成 `.release/catalog-staging/catalog/`。它使用显式 catalog version，加入 `plugin-release-ledger.json`，完成 snapshot、digest、plugin version 和 ledger 校验后才替换成功产物。
- Git publisher 在隔离临时 repository 中发布。channel 固定为 `refs/heads/catalog/latest` 和 `refs/heads/catalog/beta`；版本 tag 固定为 annotated、immutable 的 `refs/tags/catalog-v<catalogVersion>`。首次 channel commit 是 orphan，后续 commit 只以当前 channel head 为 parent。catalog-only 使用一次 atomic push 同时发布 tag 和 channel；不支持 atomic 的 remote 会安全失败。跨 channel history read、ledger merge 和单次 publication 使用内部 `refs/heads/aw-release/publication-lock` 串行化；该 ref 只表示当前租约 owner，不是 release history，不使用 force 或 force-with-lease，完成后以普通 delete 释放。tag-first 用一次 atomic push 同时创建 immutable tag 和持久 `refs/heads/aw-release/tag-first-pending` guard；该 guard 覆盖 CLI 失败后的跨重试窗口，只允许 exact catalog version 恢复，其它 beta、latest 和 bootstrap publication 全部 fail closed。
- publisher 在 staging 前读取并验证两个 channel 的 schema 3 snapshot 和 ledger。新 publication 合并两个 channel 的完整历史后重新 stage；exact tag retry 使用该 tag 自带的 ledger 重建候选，避免其它 channel 的后续记录改变 immutable tag。每个 channel 的 catalog version 严格单调；相同版本只接受相同 runtime 内容。已有 tag 只有在其 peeled snapshot runtime 内容和规范化完整 ledger 都与候选相同时才可作为幂等重试复用；否则必须使用新的 catalog version。轻量 tag、损坏 snapshot、ledger 缺失和 digest 漂移均 fail closed。publisher 显式关闭 commit/tag 签名，使用自有空 `git init` template，并把所有临时 repository 固定为 SHA-1 object format；`GIT_DEFAULT_HASH` 和 global `init.defaultObjectFormat` 不能改变 official publication。publisher 隔离 hooks、global/info attributes 和内容转换，并在任何 commit tree 物化前用 tree-only 检查拒绝任意层级的 `.gitattributes`。通过该检查后，publisher 强制 stage snapshot 的全部文件，使嵌套 `.gitignore` 不能漏掉 runtime；最终 commit tree 必须与完整 staging tree 在 path、bytes、mode 和 symlink target 上一致。最终 commit tree 比较保留 regular file 的规范 mode，以及合法 symlink 的 `120000` mode 和原始相对 target；绝对或逃逸 target 仍由 schema 3 snapshot 校验拒绝。publisher 把已展开的 system/global Git 配置冻结到随机私有文件，固定 `core.symlinks=true`，再绑定和验证唯一 remote fetch/push URL；后续 fetch、lock、push、promotion 和 delete 只使用该不可变配置与私有 remote。无法把 `120000` 物化为符号链接的平台必须明确 fail closed，不能降级为普通文件。Git credential helper 配置和 SSH agent 通道保持可用。
- catalog-only、combined、bootstrap 和 promotion 入口在任何 catalog remote ref 写入前拒绝 dirty worktree；clean gate 也拒绝能进入 build input、TypeScript 编译或 package 的 ignored/untracked 文件，以及 registered source/build input 和 `scripts/release/**` 上的 `assume-unchanged` 或 `skip-worktree` Git index 标志，只允许生成 output、cache、report 和 `node_modules` 等明确非输入路径。registered source/build input 的完整 path chain 不允许符号链接；release snapshot 在复制前使用同一门禁，不能读取 HEAD 外 referent bytes。该门禁不检查生成的 `packages/cli/plugins-dist/`，其中通过 schema 3 校验的相对符号链接仍合法。combined 和 promotion recovery 只允许明确 CLI version sync 产生的两个 package manifest 修改，且每个 manifest 相对 HEAD 只能有未暂存的顶层 `version` 语义变化，并在 CLI publish 保留二次检查。promotion recovery 仅用于 tag 与 CLI 均已发布但 channel 尚未推进的固定恢复命令。catalog-only 必须从 npm registry 明确解析当前已发布的同 channel CLI，并通过 catalog compatibility 后才发布。组合发布在写入任何 catalog ref 或发布 CLI 前比较 registry dist-tag 与本地 CLI candidate；相同字符串跳过 CLI 发布，只有 precedence 严格更高的 candidate 才可发布，回退或同 precedence 不同字符串均 fail closed。standalone CLI publisher 和 combined publisher 使用同一个 publication lease；standalone 要求显式 `--cli-version`，在 build snapshot 前绑定 live package version，并在锁内重读 dist-tag。combined 复用已经持有的 lease。npm publish 从随机 `0700` 私有目录读取 CLI tarball；该目录保持 owner-owned 到 publish 子进程完成，然后清理。当前 CLI 已兼容时执行 atomic catalog 后发布 CLI；需要本次 CLI 时执行 immutable tag、CLI npm publish、channel promotion。catalog-only、bootstrap、combined 和 standalone CLI 都先绑定 build snapshot identity：`generationId`、`outputDigest`、`inputDigest`、`cliPackageDigest` 和 `headCommit`；publication lease、catalog/tag/promotion ref 与 npm 写入前重新执行对应的 semantic clean gate，并比较 live `inputDigest`、`cliPackageDigest` 和 HEAD。瞬时 dirty bytes 即使随后恢复，也不能作为已绑定 snapshot 发布。promotion 只允许 verified tag 的 fast-forward，并用一次 atomic push 同时推进 channel 和删除 `tag-first-pending` guard；失败时不降级，并提供固定 `release:promote:catalog:<channel>` 恢复入口。
- 首次 official cutover 只使用 `release:bootstrap:catalog:beta|latest`。它复用私有 build snapshot、私有 staging 和 Git publisher，并在 ref 写入前核对 generation identity 与 HEAD；不读取已发布 CLI compatibility。首次创建要求目标 channel 和同版本 tag 都缺失，二者都已存在且与候选完全相同时只做幂等确认。tag-only 部分发布、tag 漂移、轻量 tag、已有不同 channel 内容和不支持 atomic push 都 fail closed。beta 与 latest 的首次 commit 分别是独立 orphan。该入口不发布 CLI，首次迁移完成后普通更新必须使用 catalog-only 或 combined publisher。
- `<AW_HOME>/catalog-sources.json` schema 1 是唯一 runtime source 合同。文件缺失时读取内置 `official` primary，URL 固定为 `https://github.com/lesliechan721-arch/agent-workflow.git`；首次配置 mutation 才物化文件。stable CLI 的 `cliChannel` ref 是 `refs/heads/catalog/latest`，prerelease 是 `refs/heads/catalog/beta`。显式 ref 不映射 channel，`--default-ref` 才恢复 `cliChannel`。
- `scripts.node.packageRoot` 使用与 CLI `packageManager` 完全一致的 `pnpm@<exact version>`。staging 在包管理器启动前拒绝缺失或不匹配的声明；它优先执行已解析且版本匹配的 pnpm 入口，否则执行 CLI 的同版本 runtime dependency，不依赖 Corepack 或网络解析 package manager。
- catalog build-time runtime projection 由 `buildConfig.runtimeExports`、`buildImports` 和 `skillRuntimeFiles` 组成。export 是 provider 插件根内显式命名的 canonical regular source file；resolver 只读取调用者绑定的 catalog/source set，不联网，也不从 active install 或 sibling 目录布局推断来源。`@aw/cli` 是严格保留的 virtual build provider，只向 `buildImports` 暴露 `skill-frontmatter-capabilities`，不能用于 Skill 投影。普通 current catalog 使用当前 CLI package root。base/current 比较先按 Git base 和 current workspace 中完整、无符号链接的 `packages/cli/package.json` 加 source registry 判断 source ownership：两侧都拥有时分别绑定各自物化 root、provider version 和 digest；只有一侧拥有或任一侧不完整时失败。两侧都不拥有时，已安装 CLI 是同一个经 package name/version 和普通文件链验证的 external immutable provider，并从 canonical package root 独立物化两个 digest/identity 相同的 resolver root；base 不能复制或回退到 current root/bytes。
- `buildImports` 在 `scripts.node.build` 前解析为独立的只读绝对文件副本，只通过 `AW_PLUGIN_IMPORT_*` env 注入。它不能覆盖已有 env，且 build 后不会进入 runtime manifest。`skillRuntimeFiles` 在 staging build 后把 staged own source 或 catalog export 投影到已声明 static Skill 的 `references/`、`assets/` 或 `scripts/`；平台、路径、regular file、symlink 和 existing target 全部 fail closed。projection bytes 自然进入 artifact/content digest；bundle helper 返回 provider version、export/source identity 以及 source/target digest provenance，不新增模型可见文件。
- catalog build、`plugin:test`、plugin eval materialization 和 repo-local bundle 使用同一 catalog runtime import resolver。prepared bundle 必须复用 preparation 返回的 resolver context；build-free 对 `scripts.node` 或 build import fail closed；外部单插件 bundler 对 imports 缺少 resolver 时不得猜测来源。
- 声明确定性 `scripts.node.build` 的插件可用 `buildConfig.cacheable: true` 允许 build cache 按完整 registered input、environment 和 output identity 复用。该字段只接受 `true`，缺少 build 时无效并拒绝，且不进入 runtime manifest。未声明的 build 仍不复用。
- production dependency closure 包含传递 `dependencies`、`optionalDependencies`、required peer 和已安装的 optional peer。缺失 required dependency、required peer 或传递 optional dependency 时 staging fail closed，避免生成只适用于构建机 OS 的 catalog；缺失 optional peer 仍可跳过。bundle 把已解析依赖物化为普通目录树，不保留 staging 的符号链接或 Windows junction；alias 入口分别保留，多版本和 peer resolution 按已安装闭包重建。顶层 `optionalDependencies` 仍不受支持。
- Node runtime import closure 会复制静态相对 `import`、`require()` 和 `require.resolve()` 解析到的 JavaScript 文件。显式或 Node 风格解析到的 `.json` 文件作为 leaf 复制，不扫描其内容。CommonJS directory `main` 可以用 `../` 指向 package 目录外、plugin root 内的目标；解析仍按 Node legacy 顺序只尝试 main file、main target 的 `index.js`/`index.json`/`index.node`，再回退原目录 index，且 main target 内的嵌套 `package.json` 不参与解析。缺失、绝对、URL、不安全或逃逸 plugin root 的目标仍 fail closed；`.node` 不属于可移植 runtime bundle 合同。
- 新 CLI 不包含 npm catalog selector、registry resolver、package archive identity 或旧 strict cache。旧两个 npm catalog package 只作为已发布历史冻结；不删除、不 unpublish，也不继续更新。
- Release registry URL 只接受 HTTP(S)，并在协议检查前拒绝任意 URL 协议中的 username/password；npm 认证必须由 npm config 提供，不能放入 registry URL。release 命令的失败诊断必须脱敏 URL userinfo。
- `aw catalog source add/update/list/set-primary/remove` 管理 schema 1 source config。add/update 先用 `forceRemote` 只验证 candidate 中的目标 source，并只保留 lease-safe 普通证据；随后在 runtime lease 内执行引用预检、expected config digest 复查和原子替换。identity 变化、primary 变化和 remove 在发现 schema 1 owner、旧裸名 config/lifecycle 或旧 marketplace 时返回 `legacyStateUnsupported`，不自动迁移或清理。
- Git/path provider、schema 3 snapshot validator、source strict cache 和四 worker multi-source resolver 已作为独立内核存在。snapshot 根只接受 `catalog-manifest.json`、`.agents/`、`.claude-plugin/`、`plugins/` 和可选的发布端 ledger；validator 从真实 plugin manifest 重建完整 entry 投影。provider 从不可变 Git commit 或每次 path 复制物化已验证 snapshot。cache entry 和 selector 发布后，provider staging 清理是 housekeeping；Windows `EBUSY`/`EPERM` 只产生 warning，不覆盖已发布结果。
- Git provider 只允许 HTTPS、SSH、file URL 和规范绝对本地路径。它清除 Git 命令/配置注入环境，固定 protocol 与 SSH 命令边界，并在网络访问前拒绝改变 source identity 的 Git URL rewrite；managed bare cache 拒绝非受控 local config、内部 symlink 和 object alternates。Abort 和 remote deadline 必须完成整个子进程树清理后才释放 object lock。
- 新 source strict cache 按 `sourceId`、`sourceIdentity`、requested ref、resolved commit、manifest/snapshot digest 和 CLI compatibility 隔离。selector 只发布完成 entry；Git `requireRemote` 只回退同 source identity 和 ref 的兼容 entry，`forceRemote` 与 path source 不回退。
- source observation order 在磁盘 publication lock 内分配，并通过不可变 observation record 持久绑定 entry。selector 必须与 record、source identity、requested ref 和完整有效 entry 一致；悬空、损坏、超前或 identity 不匹配的 selector 先隔离，再参与 publication。
- multi-source resolver 提供 qualified plugin ID、全局裸名唯一性和 desired artifact key 碰撞预检。resolution 和 PluginMeta 只通过 current-cache lease 范围内的 callback 消费；callback 结果经过 lease-safe 深拷贝投影，protected path evidence 不能逃逸。`catalog source`、`init`、公开 `status`、config 和五个写命令均使用该 callback；owner/config/lifecycle store 使用 source namespace。
- catalog source config、plugin config 和 lifecycle active store 的权威存在性读取只把 `ENOENT` 及适用的 `ENOTDIR` 解释为缺失；`EPERM`、`EBUSY` 等 operational error 必须传播，不能选择默认 source、空 config 或跳过 lifecycle。
- 源码 plugin manifest 直接保存下一次稳定版本；`contentDigest` 排除生成 manifest 的 version 字段，用于识别插件内容。
- Beta 发布根据源码稳定版本、`contentDigest` 和已发布账本，在临时 staging 中物化 prerelease plugin version。只有该插件已发布的最高 beta identity 内容相同时才复用其版本；内容从 A 变为 B 再变回 A 时分配下一个 beta，保持 ledger 单调。Stable 发布直接使用源码 manifest version。
- release staging 包含发布端专用的 `plugin-release-ledger.json`。未发布的 schema 1 digest 合同已由 schema 2 替换；validator 拒绝 schema 1，不能在同一发布历史中混用两套 digest 语义。记录以 catalog channel/version 和 plugin name/version 的完整发布身份保留历史；同一 `plugin@version` 跨历史必须保持 `artifactDigest`、`manifestDigest` 和 `contentDigest` 不变。当前 snapshot 的每个 entry 必须有且只有一个当前 catalog 记录。publisher 从两个已发布 channel 合并 ledger，再生成候选 snapshot。
- source strict cache 使用 immutable entry、原子 selector publication 和有界 lock。
- active marketplace 只供平台原生能力读取。`AW_HOME` 同盘 sibling coordination root 提供 lifecycle lease 和 runtime lease；同时需要两者时，固定按 lifecycle、runtime 的顺序获取。runtime lease 串行根替换、catalog source config、user config 及 Codex user Skill overlay 的写入，lifecycle lease 保护 active snapshot。只读检查不获取排他租约，也不创建 coordination 状态。operation lock 也位于 sibling root，不进入被替换目录。重建必须保留 catalog source config、strict catalog cache、AW config store、Codex user Skill overlay 和 lifecycle active snapshot。marketplace generation 的 restore 和 rollback 只把明确缺失解释为 absent；backup 检查的 operational error 必须在删除 canonical root 前传播，失败的 rollback 不能记录为完成。新 generation 通过 postcheck 后，旧 generation 必须先原子移动到 `marketplaces/` 外的 AW-owned 同盘 quarantine；该 rename 是 durable commit，后续 quarantine 删除失败不得回滚新 generation。durable marketplace 或 lifecycle 结果完成后，coordination lease 的 `EBUSY`/`EPERM` 释放失败只产生 warning。
- orphan marketplace root 只在锁内的全局 consumer inventory 完整且最终 identity 复查通过后删除。strict root reader 在读取 `config.json` 和 marketplace manifest 前，从可信 marketplace 根逐节点 `lstat` 完整路径链；中间节点必须是非符号链接目录，最终 JSON 节点必须是 regular file。外部符号链接中的匹配 JSON 不能授权删除。删除先把 strict root 原子 rename 到 `marketplaces/` 外的 AW-owned 同盘 quarantine；rename 失败保留原 root，后续 cleanup 只重试严格验证的 quarantine。
- Codex consumer inventory 对 strict root 声明的 marketplace 名称始终扫描匹配 cache 和 installed residue，不依赖原生 marketplace 注册仍为 canonical。cache 和 installed residue 根必须先以 `lstat` 验证完整节点；普通文件、符号链接、foreign root 和 operational `ENOTDIR` 不能作为 absent，也不能跟随到外部内容。注册缺失或 foreign 时，任何匹配 residue 都 fail closed。foreign、损坏、缺失或非普通 manifest 产生带真实位置、可用 plugin identity 及 Codex user relevance 的 typed probe/inventory error；最终 consumer cleanup 不删除 marketplace。
- markerless Codex user Skill 只有在文件树与 current catalog 或当前 renderer 的期望树完全一致时，才按 pristine catalog 内容和 absent 状态处理。install/reinstall 可以为它原子写入 owner marker；内容变化、多余文件、符号链接或 foreign marker 仍按 collision 处理。

## Write Pipeline

五个公开写命令只进入 namespaced multi-source resolver 和下列 rebuild pipeline，不进入旧 npm resolver：

```text
normalize target
  → resolve current catalog
  → build desired platform components
  → inspect live ownership
  → remove stale AW-owned components when required
  → write native and repo-managed components
  → run lifecycle when the command requires it
  → inspect the completed target
  → emit receipt v4
```

命令行为：

- `install`：按 current catalog 写入目标。
- `upgrade`：按 current catalog 重建已选择目标；`--all` 从 live owner 发现目标。
- `reinstall`：清理 AW-owned 组件，再按 current catalog 完整重建。
- `uninstall`：删除 AW-owned 组件，并在可用时使用 lifecycle active snapshot 运行 uninstall lifecycle。
- `cleanup`：只删除能证明属于 AW 的现场组件，不运行 uninstall lifecycle。

所有写命令都保留 AW config。只有 `aw config reset` 删除 config store。

### Lifecycle active store

`lifecycle-active/` 是唯一的生命周期例外状态。成功 install 或 upgrade 后，AW 保存下一次 uninstall 所需的脚本输入和 bundle 内容。它有以下边界：

- 它只服务 lifecycle 重放。
- 它不决定插件是否存在。
- 它不参与 status 健康判断。
- `reinstall` 的 cleanup 不运行旧 snapshot；重建使用 current bundle 运行 install lifecycle。
- `cleanup` 不运行 uninstall lifecycle。
- lifecycle active snapshot 缺失时，live ownership 仍是写入和清理真值。
- lifecycle promotion 在新 active snapshot 完整验证成功时完成 durable commit。之后旧 backup 的递归清理失败只产生 warning，不删除新 active 或用可能残缺的 backup 回滚；保留的 backup 由现有 recovery/housekeeping 路径重试清理。
- project lifecycle location 使用 canonical project realpath；只有明确缺失的路径可回退到 resolved path，`EPERM`、`EBUSY`、`EMFILE` 等 operational error 必须传播且不能生成替代 location key。

## Live Status

`aw status` 使用 multi-source `cacheFirst` 读取，并对每个 source 独立报告错误。它根据 schema 2 live owner 和真实平台组件报告 target；发现 schema 1 owner 时报告 `legacyStateUnsupported`，不迁移或删除。

显式 plugin、platform 或 scope selector 只投影可能影响所选目标的 inventory error。不能安全分类的全局读取错误仍然报告；所选 target 的组件检查错误仍由 target inspection 报告。

config inventory 按 store root 附带 scope：`AW_HOME` store 属于 user，project shared/local store 属于 project。lifecycle inventory 只在路径到达 canonical plugin root 后附带 plugin name；高层 namespace 错误保持较宽 relevance。

每个 target 的 `state` 只允许：

| 状态 | 含义 |
|------|------|
| `present` | 所有期望 AW-owned 组件都存在 |
| `absent` | 没有发现目标的 AW-owned 组件 |
| `partial` | 只存在部分组件，或组件内容不完整 |
| `error` | catalog、发现或组件检查失败 |

`absent` 建议运行 `aw install`。`partial` 建议运行 `aw reinstall`。`error` 保留错误并继续检查其它 target。

catalog 不可用和 bundle 不可用必须分别报告，不能合并成不可定位的通用状态错误。

status v4 JSON 结构：

```json
{
  "schemaVersion": 4,
  "catalog": {
    "primarySourceId": "official",
    "configDigest": "sha256:...",
    "compositeDigest": "sha256:...",
    "sources": []
  },
  "filters": {},
  "targets": [],
  "errors": []
}
```

status 是只读操作。它不运行 lifecycle 或 renderer，不刷新 marketplace，也不创建 config 目录。

## Config

配置合并顺序是 manifest default、user store、project shared store、project local store。project repo-visible artifact 只使用允许共享的 project shared 配置。

- `aw config list/get --json` 输出 `configSchemaVersion: 4`，并为已解析 target 输出 `pluginName`、`pluginId`、`sourceId` 和 `sourceIdentity`。
- `aw config set/unset/reset --json` 输出 `receiptSchemaVersion: 4`。namespaced store 绑定 `sourceId` 和 `sourceIdentity`；read 入口遇到旧裸名 store 返回 `legacyStateUnsupported`。
- 平台 shared config 中可分离的 AW owner 使用可逆 schema 2 token，保留 `sourceId`、`sourceIdentity` 和 qualified `pluginId`。不可分离的同一 native key 在任何写入前返回 `artifactCollision`。
- config 写入只对当前可定位 target 运行完整 reinstall。
- `uninstall`、`cleanup` 和 `reinstall` 不删除 config。
- `config reset` 是删除 config store 的唯一入口。
- `config reset` 在 config lock 内拒绝目录、符号链接和身份不匹配的 store；多 store reset 在任何删除前验证全部目标，并通过原子文件删除提交 receipt。
- config value 和 source identity 读取检查从可信的 canonical `AW_HOME` 或 repository root 到最终 `config.json` 的完整 path chain，拒绝 `.agent-workflows`、store root 及其后代的符号链接，并要求最终节点是 regular file。namespaced source/plugin namespace 和 legacy plugin namespace 遇到普通文件、符号链接或其它非目录节点时，inventory 返回 `invalidPluginConfigStore` typed error；合法空目录和缺少 `config.json` 的 plugin 目录仍被忽略。inventory 不能跟随链接读取 store 外内容。
- sensitive config value 不进入 receipt、stderr 或 debug log。

## Platform Boundaries

- Claude user/project 目标使用 Claude 原生目录、settings、skills 和 hooks 能力。
- Codex user 目标可使用 `codex plugin marketplace add/list/remove` 和 `codex plugin add/remove`。
- Codex project 目标只写当前仓库的 `.agents/skills/`、`.codex/config.toml`、`.codex/hooks.json`、`.codex/rules/` 和 `.codex/agents/`。
- Codex project 写入前要求 Codex `>= 0.145.0`；Claude 写入要求 Claude Code `>= 2.1.88`。
- MCP、apps、hooks、permissions、roles、instructions、skills 和 slash commands 仍是平台能力，不属于状态存储层。
- 公共 slash command 在 Claude 输出为 command，在 Codex 输出为 manual-only Skill。

## Catalog Freshness and Cache

| 入口 | freshness policy | 行为 |
|------|------------------|------|
| `aw status` | `cacheFirst` | 优先使用严格验证的本地 cache |
| 主控制台 | `cacheFirst` | warm load 使用本地 cache |
| `install`、`upgrade`、普通 `init` | `requireRemote` | 远程失败时只允许严格匹配的 cache fallback |
| `init --force` | `forceRemote` | 跳过 cache 快路径；公开命令不接受刷新失败后的 fallback 作为成功 |

cache publication 必须满足：

- entry 写入完成前，reader 不能看到部分内容。
- selector index 只能指向已完成的 immutable entry。
- 较旧的远程观察不能覆盖较新的观察。
- source identity 不同的 selector index 互不复用。
- lock 等待有 deadline，释放时必须验证 owner token；Windows `EBUSY`/`EPERM` 释放失败使用有界重试。selector 或 config 已提交后，最终释放诊断不得把已提交 receipt 改成失败；action 本身失败时仍保留 action error 为主错误。
- 普通 read 或 preflight 没有 durable commit；其 lock release 永久失败必须返回可诊断失败。selector、observation counter、metadata 和 snapshot 的 operational read error（包括 Windows `EPERM` 及 descriptor exhaustion `EMFILE`/`ENFILE`）原样传播，不作为 corruption 隔离。
- 冲突 observation 不得污染已经提交的 entry。
- corrupt entry 必须隔离，后续 writer 仍能正常发布。
- cache 缺失或损坏不得阻断 active marketplace 重建。
- active marketplace 重建失败时，原 strict cache 保持可读。

按 `latest` 或 `beta` channel 选择的 current catalog，其 `compatibility.aw.minVersion` 高于当前 CLI 时，resolver 直接返回 `awVersionTooLow`。显式选择 exact catalog version 且版本不兼容时返回 `explicitCatalogIncompatible`。两种情况都不选择更早的 catalog version。

## Output Contract

- 五个写命令、`init` 和 config mutation 的 JSON receipt 使用 `receiptSchemaVersion: 4`。
- status JSON 使用 `schemaVersion: 4`。
- config read 使用 `configSchemaVersion: 4`。
- `--json` 成功时 stdout 只包含一个 JSON 对象。
- 错误说明和 verbose/debug 文本写 stderr，不污染 JSON stdout。
- 写命令失败时 receipt 保留失败 target，并返回非零退出码。
- `aw plugin validate --json` 保留单一 JSON stdout，包含 `ok`、profile、plugin directory、version check、warnings 和 errors；`aw plugin check-versions --json` 保留 schema 2 单一 JSON stdout。作者命令非交互，失败返回非零退出码。
- `add-skill` 写入前逐节点拒绝 plugin root、`.agents-plugin`、manifest、`skills` 和目标 Skill 的符号链接或错误节点类型；stage 位于已验证 plugin root。提交前重验目录和 manifest 身份，Skill target 必须不存在，manifest 使用同目录排他临时 regular file、`fsync` 和原子 rename 替换；失败清理 stage/temp 并保留原 manifest。

### Human/TUI progress

- 裸 `aw` 使用响应式 Ink 仪表盘。所有可用尺寸使用同一套单列页面和焦点顺序；`80 × 24` 是标准尺寸，`60 × 18` 是最低尺寸，低于最低尺寸时只显示尺寸提示。低于标准尺寸的 compact 模式只调整换行和信息堆叠，不改变导航路径。状态信息位于目标详情，写操作位于操作区，配置位于插件配置页。
- 默认仪表盘不加载组件诊断。`--verbose` 只显示 status v4 投影的安全 component key、state、error code 和脱敏 message，不显示 component path 或 label。
- 仪表盘和向导用 multi-source `cacheFirst` 读取；重复插件名显示 qualified `pluginId`。交互写操作使用同一 namespaced runtime，不回退到旧 npm catalog 写路径。
- 缺少必要参数的写命令只在真实 TTY、human 模式且非 CI 时进入向导。
- 向导在挂载前拒绝不可用 catalog 和当前操作的空候选集。file/directory 配置在仪表盘和向导中按私有值投影，命令摘要只显示占位符模板。
- 向导的可重放命令明确标注 shell：POSIX 使用 shell-safe 单引号；Windows 提供 PowerShell 命令和参数列表。
- 向导执行失败后只向 human stderr 输出固定安全错误；原始执行错误只进入遵守脱敏规则的 debug 事件。完整参数的非 TUI 命令保留原有错误合同。
- 运行前取消直接退出。真实写入开始后的 `Ctrl-C` 只登记“完成后退出”，不取消底层写操作。
- rebuild action 边界发出 `rebuild:action` 事件。source 固定包含 plugin、platform、scope 和 command；data 固定包含动作名和 start/success/failure，终态包含 duration。失败消息在进入可见日志前脱敏。
- 仪表盘和命令向导在会话 reporter 中消费 action event 与 notice，不直接写 stdout/stderr。它们显示当前 target、真实中文阶段、elapsed 和最近 8 条消息，内存最多保留 50 条；多 target 更新不能串线。结果页保留最近消息和 human receipt 摘要。无 action event 的读取只显示通用 spinner。
- sensitive config、未脱敏 event message 和 native raw invocation/data 不进入 frame、stdout 或 stderr。
- TUI 结束后必须恢复 session reporter；每个事件只向 debug logger 发送一次。
- `rebuild:action` 只服务 human、TUI、verbose 和 debug 诊断，不进入 v4 JSON receipt。普通 human reporter 忽略 event；verbose 写 stderr；`--json` stdout 仍只包含一个对象。
- `tui/controller.ts`、`tui/model.ts` 和 `tui/router.ts` 是单列 TUI 的内部控制层。裸 `aw` 默认入口挂载 `ConsoleAppV4`，从 status v4、plugin summary、source config 和 config read 投影页面模型；canonical `pluginId`、`sourceId`、`issueId` 和 `operationId` 是路由身份。旧三焦点 Dashboard 不再是生产入口。
- 新 Controller 首屏使用 `cacheFirst`，随后只对 Git source 运行可取消的 `forceRemote` 后台检查。成功检查发布 strict cache 后重新读取 status 投影；失败时只把已有缓存标为 degraded，无缓存标为 unavailable。generation token 防止旧检查覆盖较新结果。
- 交互写操作先建立短期内存 Review ticket。Review 证据绑定 catalog config/composite digest、选中来源 identity 与 snapshot/content digest、目标状态 fingerprint，以及适用的配置层和 store digest。执行前重新读取并比较证据；变化时不调用写入口，而是返回同 intent 的新 Review。插件写入在真实 target operation lock 内复核完整证据；config 写入按稳定顺序持有全部适用 target operation lock，并在 config transaction 和 store file lock 内、首次 store 或 target 写入前复核完整证据。stale 操作不写入。Controller 只保存安全结果摘要和固定 typed 错误，不保存底层 receipt、私有路径或有效配置值。
- 问题页从 status target error code、source health 和内部 plugin config preflight 投影结构化类别。问题写操作在 plugin write intent 上绑定 typed issue origin，仍经过同一 Review、evidence、operation lock 和写命令；完成后取消旧检查，并以新 generation 统一重载状态。公开 status v4 JSON 不包含这些 TUI 内部字段。
- typed issue origin 同时绑定类别、canonical plugin/source、platform、scope 和所选动作。建立 Review、执行前验证和锁内证据都必须保持该映射；伪造或已变化的问题不得写入。问题写入只有在新 generation 中确认原 typed issue key 消失后才成功；问题仍存在或写后重载失败进入失败结果，其中重载失败明确保留“写入可能已完成”的状态，不切换为启动失败页。
- `sourceMissing` 只允许预填原 source ID 后重新添加同 identity 来源；来源类型和位置仍由用户选择。`sourceChanged` 只提供变更检查和恢复原 identity 的人工路径。两者都不从问题页调用低层 cleanup，也不提供自动 identity 迁移。
- TUI 内部 config preflight 保留 `missing-required`、`invalid-config`、字段和安全来源层；单插件设置读取失败投影为不含值、路径或原始错误的 typed diagnostic。来源级不可用或降级与同 source 的 target `catalogSourceUnavailable` 合并为一个根问题，只聚合安全的受影响 target 数量。

## Key Paths

- `packages/cli/scripts/bundle-plugins.ts`：生成 catalog staging。
- `packages/cli/scripts/plugin-staging.ts`：生成 schema 3 manifest 和 release ledger。
- `scripts/release/stage-catalog.mjs`：生成 `.release/catalog-staging/catalog/` 发布交接目录。
- `scripts/release/git-catalog-publisher.mjs`：验证 remote 历史并发布 immutable tag 和 channel refs。
- `.agents/skills/create-aw-plugin/`：插件作者工作流与参考合同。
- `packages/cli/authoring/`：随 CLI 发布的确定性插件作者实现与脚手架模板。
