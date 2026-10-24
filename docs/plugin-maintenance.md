# 插件维护指南

本文件只面向本 monorepo 人类维护者，负责 CLI、Core、npm packages、内置插件源码和 Product Release 编排。它不是第二套 Catalog contract。单 Plugin Source 见[插件作者指南](plugin-authoring.md)，官方与第三方共用的 Catalog Workspace 合同见[Catalog 作者指南](catalog-authoring.md)。

## 源码与生成物

- 插件源码位于 `plugins/`，`plugins/<name>/.agents-plugin/plugin.json` 是源码 manifest 真值。
- catalog staging 和 runtime bundle 是构建产物，不要直接修改。
- 内置插件作者只维护 plugin source 和稳定 plugin version。不要手改 Git catalog refs、publication journal 或 Catalog store。
- 作者用 Plugin Manifest v3 的 `requires.aw.capabilities` 声明真实要求。未知但语法合法的 capability 是合法数据；当前 AW 未实现时，validator 报告 `awCapabilityUnsupported`。
- Catalog 生成和消费只使用 snapshot schema 7；Catalog source config 只使用 schema 2。旧 manifest、Catalog 或 source schema 只可作为拒绝 fixture 或历史记录，不是受支持作者合同。
- 创建或修改插件能力时只维护源码层；平台产物由 CLI、adapter 和发布流程生成。
- 插件和 Skill 的 production README 使用[插件与 Skill README 规范](readme-standard.md)。
- Frontend Design 的作者依据见[来源与取舍](frontend-design-sources.md)；该记录不进入插件运行包。

## 同步规则

改动插件基础架构、manifest/schema、adapter 行为、scope 语义、分发或安装流程，或任何影响插件作者使用方式的能力时，必须同时检查公开 CLI、canonical registry 和 `aw-development-toolkit`。

已安装配置读取使用 `aw.installed-runtime-config.v2`、keys-only target 声明和 schema 2 单产物资源。旧 resourceVersion/artifactIds、v1 helper 和 expectedRevision 须按 [插件作者指南](plugin-authoring.md#已安装配置读取) 更新。Codex Enhance 外部执行使用 Adapter v5；它与 Eval Engine 的 instruction-v2 是不同合同，不联动改号。Config Definition v4 的结构能力由 Core、公开 schema、registry、CLI 与 TUI 共用实现，先交付支持新 capability 的 CLI，再分发依赖该能力的插件。升级后通过正常 build/sync/reinstall 更新资源，保留 ownership、native receipt、Status 和 cleanup 边界。

Codex Enhance 的注册配置、Adapter v5、worker 生命周期与通信/输出合同、内建后端及验证边界记录在 [适配器说明](../plugins/codex-enhance/skills/codex-subagent-guide/adapters.md)。该文件是唯一长期适配器说明，不另建 docs/codex-enhance-adapters.md 副本。普通调用按 Guide 的外部 reference 执行；调用模型填写复杂选择式时读 file-selection reference，适配器作者接入公共解析命令时读适配器文档。修改调用或结果含义时同步相应 Skill、角色资源和 README；本地任务草案不作为发行后的唯一规范来源。

Review 按任务交付人读报告，说明质量判断、findings、证据范围和未知项。报告不构成发布门禁；实际发布按 Catalog plan/apply 和 Product Release 合同执行。

Eval 的机器真值由 `@lesliechan721/agent-skill-eval` 提供，固定流程是 Manifest v1 准备 `EvalSpec v1`，独立 Auditor 产生精确绑定 provider、workspace、current/optional previous target、case digest 和 selected cases 的 `EvalAudit v1`，Engine 产生带必需 `processManagement` 证据的 `EvalResult v2`。Result v1 不再兼容。`runs` 和 `timeoutMs` 改变不影响 Audit 复用；旧版字符串 `workspace` v1 Spec 必须重新 prepare 和 Audit。`author-agent-skill` 设计或修改 Eval assets，`audit-agent-skill-evals` 独立审核 cases 或结果；AW 格式和辅助 validator 由 `aw-skill-eval-runner` 拥有。插件不得复制 schema、digest、validator 或执行实现。

## 维护入口

- 通过公开 `aw` CLI 安装相应插件后，`agent-content-toolkit`、`agent-skill-toolkit`、`aw-development-toolkit` 和 `aw-skill-eval-runner` 分别处理 Agent-facing 内容、Skill、AW Catalog/Plugin 与 AW Eval 运行。仓库不把插件源码投影为 `.claude/skills`。
- `agent-content-toolkit` 提供 `agent-content`，按请求写入或只读评审 Agent-facing 内容。
- `agent-skill-toolkit` 提供 Author、合并的 Reviewer、Simplifier 与 Eval Auditor，并依赖 `agent-content-toolkit`。Author 负责创建、修改及当前范围的自检与修复，不编排 Review 或模型实验。`review-agent-skill` 按单体、工作流或公开能力范围评审；它与 `simplify-agent-skill` 均由用户显式启动。通用方法不依赖 AW 的对象、命令或来源绑定；共享规范直接读取，自检与独立判断分别报告。
- `aw-development-toolkit` 提供 `develop-aw` 和仅用户显式调用的 `publish-aw-catalog`，并依赖两个通用工具插件。凡任务涉及 AW 插件及其 Skill 的分析、创建、修改、评审、简化、验证或物化，均可采用 `develop-aw`；它提供来源、可写 source/provider、profile、平台产物和领域依据，不接管通用任务的判断。所需证据按任务选择：源码分析不要求构建，完整产物不足时在已有授权内说明并执行本地 prepare。`aw review prepare` 供通用方法取得实际运行包；Portable 导出另要求 `distributions.agentSkills` 并使用 `aw skill materialize`。Publisher 使用 CLI 默认解析，仍须对完整 `planDigest` 授权。
- 使用默认模型 Eval 执行器时还需要 `aw-skill-eval-runner`。CLI 的普通 Eval 作者入口是 `aw skill eval prepare`；它只生成输入完整的 Spec，不运行模型。实际执行使用 `aw-skill-eval run <spec.json> --audit <audit.json> [--allow-unmanaged-processes]`，且单份运行前 Audit 必须与当前 Spec 的 provider、workspace、current/optional previous target、case digest 和 selected cases 精确绑定并通过。所有真实 run 在 output 和模型前执行 permission、macOS Codex 可执行入口与 keychain，以及进程管理预检。默认 managed 模式要求 Full Access 语义和可用的进程树检查；单次提权不等于 Full Access。只有用户明确接受本次风险时，才可增加一次性的 unmanaged flag；它只尽力终止直接 child，不保证后代清理，也不能绕过 cmux Codex wrapper 或 macOS keychain 检查。完整边界见[架构说明](architecture.md)。中断后重新 prepare、Audit 和 run，不维护 checkpoint ledger。`aw skill eval doctor --json` 只用于安装或升级、用户明确请求诊断，或模型已启动后的 run 失败；`aw-skill-eval inspect-result <result.json> --spec <spec.json> --audit <audit.json>` 只用于异常结果的分组检查。普通路径不运行这两个命令。独立 result-triage 按 Runner 的结果用途与异常条件执行；其余 clean success 交付后结束。
- `develop-aw` 的来源与物化方法处理既有合法 Catalog Workspace 中的 canonical `<workspace-root>/plugins/<name>`；Review 可选其中的源 Skill，由 CLI 按声明解析归属。缺少 Workspace 时，只有用户明确要求初始化，`develop-aw` 才进入 Catalog 初始化分支；否则报告缺口并固定当前目标。不含 AW manifest 的 repo-local 或 portable Skill 可直接采用通用方法；专项评审由用户显式启动 `review-agent-skill`。
- `aw-development-toolkit` 是 Agent-facing Developer Assistant，不是 SDK 或规范真值。它只能编排已安装 `aw` CLI 的公开作者命令；第三方 workspace 不要求有本仓库的 `packages/cli`、`node_modules` 或 release 脚本。
- AW Plugin 作者工具统一使用公开 CLI：`aw plugin capabilities`、`aw plugin init`、`aw plugin add-skill`、`aw plugin remove`、`aw plugin validate`、`aw plugin test`、`aw plugin build`、`aw plugin status` 和 AW 适配检查 `aw skill validate`。Catalog 作者工具使用公开 `aw catalog` 命令。Agent 插件不复制 AW manifest、Catalog 或校验实现。
- 普通 Skill 的创建和静态包检查由 `agent-skill-toolkit` 的独立 init/check 工具提供。固定输出的用途通过现有搜索和真实消费者核对，不另维护引用审计脚本。工具的权威源码、锁定依赖与独立打包器位于插件 `tooling/`，运行包只依赖 Node 和随包文件。通用工具不调用或复制 AW/skills-ref；AW 方法负责 Workspace、manifest、来源与产物对应及平台验证。四个脚本副本和三个许可文件由 staging build 生成，不手工维护。
- AW 来源、物化及与通用 Reviewer/Simplifier 的集成用例由 `aw-development-toolkit/skills/develop-aw/evals` 维护；通用插件只维护通用方法用例。用例的运行器格式属于测试基础设施，不成为 Skill 运行期的领域依赖。迁移 suite 时同步修改被测对象、参与者、fixture 路径和 Oracle 范围，保留通用 split 和执行安全约束，并重新取得实际运行证据。
- 已安装作者 Skill 先用 `aw self check --from <skill-root> --json` 消费同层 runtime requirements receipt；不使用 CLI 版本字符串推断兼容性。每个 runtime receipt 必须来自最终 materialized Skill，不能由 source 文档手写替代。
- Workspace v1 插件根固定为 `<workspace-root>/plugins/<plugin-name>`。所有作者命令使用 `--workspace-root`，不接受任意 `--plugin-root`。`validate`、`test` 和 `build` 仍接受 plugin directory 参数，但该目录必须是 workspace inventory 中的 canonical plugin。作者命令拒绝 workspace/plugin root、`.agents-plugin` 或 manifest path chain 中的符号链接和错误节点类型。`status --base` 和 `remove` 要求 Git；`status --all` 保留 `plugins/` 扫描语义。
- 模型 Eval 的准入与运行由专用工作流负责。人读 Review 按请求交付，不自动修改 production README。
- Reviewer 默认在对话中交付人读 Review；用户指定报告文件时写入该位置。判断对应实际 source/final 与验证范围，不代替模型 Eval、发布计划授权或发布验证。

## Catalog build-time 文件复用

Core 的公开 capability registry 保存 manifest 稳定结构事实。CLI 在运行时组合作者适配事实，并由 `aw plugin capabilities --surface <surface> --json` 查询。`aw-development-toolkit` 不生成或分发字段表，也不通过 `@aw/cli` build import 绑定构建时 CLI；判断型 reference 只指向当前 PATH 查询和 validator。

`buildConfig.generatedSkillRuntimeFiles` 只声明 `scripts.node.build` 必须创建的最终 Skill 文件。源码 closure 仅允许这些精确 target 尚未存在；build/materialization 后每个选中 surface 都必须存在 regular file，并通过完整 nested runtime closure。该字段不复制文件，也不形成安装依赖。

manifest `dependencies` 声明安装或升级某插件时必须同时满足的同 source 插件。它只接受插件名，不接受 `source/plugin`。`buildConfig.buildImports`、`skillRuntimeFiles.import` 和 artifact `runtimeImports` 是独立的 typed build-time reuse edge；它们不声明安装依赖，也不能用于推断 `dependencies`。artifact runtime import 在 Catalog build 时复制到 consumer bundle，renderer 只读取 bundle-local 文件。

- provider 用 `buildConfig.runtimeExports: [{ "name": "<stable-kebab-name>", "source": "./<file>", "requires": { "aw": { "capabilities": [] } } }]` 显式发布 canonical source file。`requires` 必填，空 capability 集合法；Provider 作者拥有该 metadata，Core 只做 capability ID 规范化、排序、去重和稳定 digest，不扫描 export 内容推断或双检 metadata。source 必须是插件根内 regular non-symlink file，且不能位于 Skill、report、eval、dependency 或 build temporary tree。
- consumer build 用 `buildConfig.buildImports: [{ "plugin": "<provider>", "export": "<name>", "env": "AW_PLUGIN_IMPORT_<NAME>" }]`。`scripts.node.build` 只读取该 env 指向的只读绝对文件，不使用 `../<sibling>`。Skill 文件投影用 `buildConfig.skillRuntimeFiles: [{ "skill": "<static-skill-key>", "target": "references/<file>", "import": { "plugin": "<provider>", "export": "<name>" } }]`；own staged source 把 `import` 换成 `source: "./<file>"`。
- 只有最终 runtime 用途传播 export capability：`skillRuntimeFiles.import` 和 artifact `runtimeImports`。Consumer 最终集合是自身 staged/source `requirements.effective` 与实际使用 runtime export capability 的并集；该唯一集合写入 bundle source manifest、Catalog entry 和全部 native/portable Skill receipts，并在 bundle 完成前检查当前 AW 支持。`buildImports`、consumer 自有 `skillRuntimeFiles.source` 和 `generatedSkillRuntimeFiles` 不传播；后两者仍由 consumer 顶层 `requires.aw.capabilities` 负责。
- `skillRuntimeFiles.platforms` 可限制 `claude` 或 `codex`；缺省为 consumer 支持的全部平台。target 只允许 static Skill 内 `references/`、`assets/` 或 `scripts/` 文件，source tree 或 staging build 已有 target 时必须改用不同路径，不能覆盖。
- 只有确定性、输出完全由 registered build input 决定的 `scripts.node.build` 才声明 `buildConfig.cacheable: true`。该字段不接受 `false`，也不能在没有 build script 时使用。
- Portable Agent Skills 使用 `distributions.agentSkills.skills` 声明独立的 `./` plugin-relative Skill root。`buildConfig.skillRuntimeFiles.distributions: ["agent-skills"]` 只投影到 portable surface；字段缺失时保持既有 native 行为，同时声明 `platforms` 和 `distributions` 时投影到两组明确 surface。`agent-skills.skill` dynamic target 必须由 `distributions.agentSkills` 门禁，并可用 `runtimeImports` 引用 build-time runtime export；bundle 保存其 bytes、digest 和 provenance，renderer materialize 时只读 consumer bundle-local 文件。
- 使用 Portable 字段的 source manifest 必须是 Manifest v3，并保留至少一个非空 native capability；空 `extensions` 和空 native 数组不满足该门禁。static portable root 的每个直接子目录必须是有效 `portable-agent-skills` Skill，并包含 production `README.md`。构建器负责注入保留的 runtime requirements receipt，源码和 renderer 不得声明该文件。
- `agent-skills.skill` 必须显式声明 `distribution: "agent-skills"`、`skillKey`、`scopes`、`states` 和 `refreshKeys`；不得从 native target 或 marketplace product 推导 distribution。所有 `codex.skill` delivery、`claude.skill` 和 `agent-skills.skill` 的 `refreshKeys` 都不得引用 sensitive config；非 Skill target 可以读取。作者 validator 以 distribution surface 运行 renderer fixture，设置 `AW_PLUGIN_DISTRIBUTION=agent-skills`，不设置第三种 `AW_PLUGIN_PLATFORM`。最终树按 `sourceDirs → distribution skillRuntimeFiles → renderer files` 合并，并拒绝无效 Skill、名字冲突、author-only 内容、未解析模板、至少 8 个 Unicode code point 的 sensitive string 原文或 JSON 转义形态，以及缺失 runtime file。该长度阈值不表示 secret 强度；日志仍脱敏所有长度。receipt 只有在 AW 生成或内容验证后，才从精确路径扫描中排除，不使用 basename 通配。
- 同一插件的静态 Codex Skill/MCP/Hook/App 与所有 dynamic native target 必须使用完全相同的 scope 集；静态组件固定为 `{project,user}`。renderer context 只公开本次请求的 refresh-key 并集，不公开 store 路径，并使用请求级临时 `AW_HOME`、`AW_CODEX_HOME` 和 `AW_CLAUDE_HOME`。同一 surface/scope 的 Skill 与读取 sensitive config 的非 Skill target 分批请求，复用相同不可变 `previousArtifacts`，每批返回精确 `ArtifactPlan`。该输入隔离不是 OS sandbox，executable source 仍是受信任代码。
- 消费者使用 `aw skill install <plugin> --scope <project|user>` 通过兼容的外部 `skills` CLI 安装 portable Skill，或使用 `aw skill materialize <plugin> --scope <project|user> --out <dir>` 安全导出。两个入口都先验证完整依赖闭包和全部候选；`--skill` 只过滤最终选择，不缩小验证边界。

## 本仓库 Product Release 编排

- 使用 `pnpm plugin:test <plugin>` 运行单插件确定性测试；使用 `pnpm plugin:test --all` 检查全部插件。
- PR/main 与发布候选共用三系统插件测试；Windows 按 `--test-shard <index/total>` 分片，全部分片成功才允许复用验证证据。平台专属用例在原生 runner 上执行，真实模型与长时资格仍单独启用；命令及验证边界见[测试指南](testing.md)。
- 日常开发运行 `aw plugin status`。production bundle 变化且稳定目标未变时，`unreleasedChanges` 是有效状态。
- `pnpm release` 是本 monorepo 对 Eval、Core、CLI npm packages、CLI tag 和可选 Catalog publication 的 Product Release 编排。它不是第二套 Catalog schema、publisher 或恢复合同。
- 本仓库官方 `pnpm build` 使用 `--strict-requirements` 语义；`release:verify:catalog:core` 通过该 build 覆盖 strict 门禁。第三方公开 `aw catalog build` 默认只 advisory。
- 选择 Catalog 轴时，`pnpm release` 通过公共 `aw catalog version` mutation 选择 metadata beta，并最终调用与第三方 Workspace 相同的 Catalog publish plan/apply、publication journal、tag 和失败恢复合同。具体 Catalog 行为以[Catalog 作者指南](catalog-authoring.md)和 Core validator 为准。
- 官方 Actions 使用独立 CLI/Catalog 源码 tag，main CI 成功后按生产内容自动准备 beta；手动 `source` 准备精确正式版。候选分支只包含允许的版本修改，main 不接收自动版本 commit。操作和外部配置见 [README](../README.md#本仓库维护与官方发版)。`pnpm release` 保留本地维护用途。
- 官方编排向 Core 唯一版本 owner 提供 latest/beta 的完整 first-parent 成功历史。未变化插件保留完整 stable/beta 版本，变化插件独立 patch 或递增 beta；不把 Catalog 版本赋给全部插件。删除重加保留历史，同版本不同内容阻断。第三方未提供官方历史时继续使用原 channel 合同。
- Actions 六平台只消费同一候选 tar，发布前保存 CLI attempt 或 Catalog pending journal/repository，发布和恢复继续使用公共 publisher。缺失或损坏的已尝试恢复包必须提升版本；npm repair 仍只属于 CLI package 轴。
- 新工作流的 generated standards、schemas 和 handoff contracts 必须通过 check-only contract test；CI 不自动改写生成文件。
- CLI 作者 validator 的 JavaScript import scanner 是唯一实现；门禁覆盖 static import、export-from、dynamic import、`require()`、`require.resolve()`、非代码文本过滤和 `${...}` 代码扫描。
- 三层插件应分别验证，并增加同时安装三个插件的组合测试。
- 通用确定性测试的分层、价值门禁和验证选择见[测试指南](testing.md)。
- 稳定发布时检查源码 manifest version 的流程见 README 的正式版发布说明。
