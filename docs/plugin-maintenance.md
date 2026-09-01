# 插件维护指南

本文件只面向本 monorepo 人类维护者，负责 CLI、Core、npm packages、内置插件源码和 Product Release 编排。它不是第二套 Catalog contract。单 Plugin Source 见[插件作者指南](plugin-authoring.md)，官方与第三方共用的 Catalog Workspace 合同见[Catalog 作者指南](catalog-authoring.md)。

## 源码与生成物

- 插件源码位于 `plugins/`，`plugins/<name>/.agents-plugin/plugin.json` 是源码 manifest 真值。
- catalog staging 和 runtime bundle 是构建产物，不要直接修改。
- 内置插件作者只维护 plugin source 和稳定 plugin version。不要手改 Git catalog refs、publication journal 或 Catalog store。
- 作者用 Plugin Manifest v2 的 `requires.aw.capabilities` 声明真实要求。未知但语法合法的 capability 是合法数据；当前 AW 未实现时，validator 报告 `awCapabilityUnsupported`。
- Catalog 生成和消费只使用 snapshot schema 6；Catalog source config 只使用 schema 2。旧 manifest、Catalog 或 source schema 只可作为拒绝 fixture 或历史记录，不是受支持作者合同。
- 创建或修改插件能力时只维护源码层；平台产物由 CLI、adapter 和发布流程生成。
- 插件和 Skill 的 production README 使用[插件与 Skill README 规范](readme-standard.md)。

## 同步规则

改动插件基础架构、manifest/schema、adapter 行为、scope 语义、分发或安装流程，或任何影响插件作者使用方式的能力时，必须同时检查公开 CLI、canonical registry 和 `aw-plugin-development`。改动 Workspace、Catalog metadata、inventory、聚合验证或 publisher 合同时，还必须检查 `aw-catalog-development`。

`aw review` 是独立的不可变归档入口：只把已有 `report.md`、可选 Quality Review result、checks/evidence、独立 `release-check.json` 和 workflow scope 写入 `reports/reviews/<kind>/<encoded-target-id>/<review-id>/`。Quality Review 只拥有设计、复杂度和 findings；Release Check 只拥有机器 readiness；Publication 只拥有 target/digest 绑定和 archive。该入口不得重评、封存 Eval、更新 README 或维护可变 index。

Eval 的机器真值由 `@lesliechan721/agent-skill-eval` 提供，固定流程是 Manifest v1 准备 `EvalSpec v1`，独立 Auditor 产生精确绑定 provider、workspace、current/optional previous target、case digest 和 selected cases 的 `EvalAudit v1`，Engine 产生 `EvalResult v1`。`runs` 和 `timeoutMs` 改变不影响 Audit 复用；旧版字符串 `workspace` v1 Spec 必须重新 prepare 和 Audit。`agent-skill-toolkit` 提供 Eval 设计、Audit 和 Review 工作流。插件不得复制 schema、digest、validator 或执行实现。

## 维护入口

- 通过公开 `aw` CLI 安装相应插件后，通用 Skill 工具、`aw-plugin-development` 和 `aw-catalog-development` 分别处理 Agent Skill、单 Plugin Source 和 Catalog Workspace。仓库不把插件源码投影为 `.claude/skills`。
- `agent-content-toolkit` 提供 `write-agent-content` 与 `review-agent-content`。
- `agent-skill-toolkit` 提供 Skill author/review 与 Eval design/audit，并依赖 `agent-content-toolkit`。
- `aw-plugin-development` 提供单 Plugin Source Author/Reviewer，并依赖 `agent-content-toolkit` 和 `agent-skill-toolkit`。`aw-catalog-development` 单向依赖它，提供 Catalog Author/Reviewer 和显式 Publisher；不得增加反向依赖。
- 使用默认模型 Eval 执行器时还需要 `aw-skill-eval-runner`。CLI 的普通 Eval 作者入口是 `aw skill eval prepare`；它只生成输入完整的 Spec，不运行模型。实际执行必须使用 `aw-skill-eval run <spec.json> --audit <audit.json>`，且单份运行前 Audit 必须与当前 Spec 的 provider、workspace、current/optional previous target、case digest 和 selected cases 精确绑定并通过。`runs` 和 `timeoutMs` 改变不影响 Audit 复用；旧版字符串 `workspace` v1 Spec 必须重新 prepare 和 Audit。Engine 内置 `codex-trigger` 和 `codex-conversation` registry；Manifest 只有在确实需要可信、协作式外部 provider 时才声明 `custom-process` escape hatch。它不是 sandbox：provider 和后代必须保留 Engine marker、留在初始进程组、不得 detach，并在最终 JSON 前退出；运行期检查失败会丢弃 grade 并停止 batch。它只在 macOS/Linux 启动。完整 containment 边界见[架构说明](architecture.md)。中断后重新 prepare、Audit 和 run，不维护 checkpoint ledger。`aw skill eval doctor --json` 只用于安装或升级、用户明确请求诊断，或 run 失败后的高级诊断；`aw-skill-eval inspect-result <result.json> --spec <spec.json> --audit <audit.json>` 只用于异常结果的分组检查。普通路径不运行这两个命令，clean success 不要求 triage。
- Plugin Author/Reviewer 只处理既有合法 Catalog Workspace 中的 canonical `<workspace-root>/plugins/<name>`。缺少 Workspace 时 Plugin Author 停止并指向 Catalog Author。不含 AW manifest 的 repo-local 或 portable Skill 使用通用 `review-agent-skill`。
- `aw-plugin-development` 是 Agent-facing Developer Assistant，不是 SDK 或规范真值。它只能编排已安装 `aw` CLI 的公开作者命令；第三方 workspace 不要求有本仓库的 `packages/cli`、`node_modules` 或 release 脚本。
- 确定性 Plugin 作者工具统一使用公开 CLI：`aw plugin capabilities`、`aw plugin init`、`aw plugin add-skill`、`aw plugin remove`、`aw plugin validate`、`aw plugin test`、`aw plugin build`、`aw plugin status` 和独立 Skill 的 `aw skill validate`。Catalog 作者工具使用公开 `aw catalog` 命令。Agent 插件不保存第二份 manifest、Catalog 或 Skill frontmatter 实现。
- 已安装作者 Skill 先用 `aw self check --from <skill-root> --json` 消费同层 runtime requirements receipt；不使用 CLI 版本字符串推断兼容性。每个 runtime receipt 必须来自最终 materialized Skill，不能由 source 文档手写替代。
- Workspace v1 插件根固定为 `<workspace-root>/plugins/<plugin-name>`。所有作者命令使用 `--workspace-root`，不接受任意 `--plugin-root`。`validate`、`test` 和 `build` 仍接受 plugin directory 参数，但该目录必须是 workspace inventory 中的 canonical plugin。作者命令拒绝 workspace/plugin root、`.agents-plugin` 或 manifest path chain 中的符号链接和错误节点类型。`status --base` 和 `remove` 要求 Git；`status --all` 保留 `plugins/` 扫描语义。
- 模型 Eval 和报告发布属于专用工作流，不在通用测试指南中重复定义。Reviewer 发布报告不修改 production README；登记由 Author 或 release 工具执行。
- Reviewer 默认只在聊天中交付 Quality Review。用户明确要求归档时，只有本次请求的顶层 Reviewer 使用 `aw review publish`；下层 Reviewer 只返回材料。修订已有记录时创建新 record 并使用 `--supersedes`。Quality Review 不拥有 readiness；独立生成的 `release-check.json` 只能作为可选附件。

## Catalog build-time 文件复用

Core 的公开 capability registry 保存 manifest 稳定结构事实。CLI 在运行时组合作者适配事实，并由 `aw plugin capabilities --surface <surface> --json` 查询。`aw-plugin-development` 不生成或分发字段表，也不通过 `@aw/cli` build import 绑定构建时 CLI；判断型 reference 只指向当前 PATH 查询和 validator。

`buildConfig.generatedSkillRuntimeFiles` 只声明 `scripts.node.build` 必须创建的最终 Skill 文件。源码 closure 仅允许这些精确 target 尚未存在；build/materialization 后每个选中 surface 都必须存在 regular file，并通过完整 nested runtime closure。该字段不复制文件，也不形成安装依赖。

manifest `dependencies` 声明安装或升级某插件时必须同时满足的同 source 插件。它只接受插件名，不接受 `source/plugin`。`buildConfig.buildImports`、`skillRuntimeFiles.import` 和 artifact `runtimeImports` 是独立的 typed build-time reuse edge；它们不声明安装依赖，也不能用于推断 `dependencies`。artifact runtime import 在 Catalog build 时复制到 consumer bundle，renderer 只读取 bundle-local 文件。

- provider 用 `buildConfig.runtimeExports: [{ "name": "<stable-kebab-name>", "source": "./<file>", "requires": { "aw": { "capabilities": [] } } }]` 显式发布 canonical source file。`requires` 必填，空 capability 集合法；Provider 作者拥有该 metadata，Core 只做 capability ID 规范化、排序、去重和稳定 digest，不扫描 export 内容推断或双检 metadata。source 必须是插件根内 regular non-symlink file，且不能位于 Skill、report、eval、dependency 或 build temporary tree。
- consumer build 用 `buildConfig.buildImports: [{ "plugin": "<provider>", "export": "<name>", "env": "AW_PLUGIN_IMPORT_<NAME>" }]`。`scripts.node.build` 只读取该 env 指向的只读绝对文件，不使用 `../<sibling>`。Skill 文件投影用 `buildConfig.skillRuntimeFiles: [{ "skill": "<static-skill-key>", "target": "references/<file>", "import": { "plugin": "<provider>", "export": "<name>" } }]`；own staged source 把 `import` 换成 `source: "./<file>"`。
- 只有最终 runtime 用途传播 export capability：`skillRuntimeFiles.import` 和 artifact `runtimeImports`。Consumer 最终集合是自身 staged/source `requirements.effective` 与实际使用 runtime export capability 的并集；该唯一集合写入 bundle source manifest、Catalog entry 和全部 native/portable Skill receipts，并在 bundle 完成前检查当前 AW 支持。`buildImports`、consumer 自有 `skillRuntimeFiles.source` 和 `generatedSkillRuntimeFiles` 不传播；后两者仍由 consumer 顶层 `requires.aw.capabilities` 负责。
- `skillRuntimeFiles.platforms` 可限制 `claude` 或 `codex`；缺省为 consumer 支持的全部平台。target 只允许 static Skill 内 `references/`、`assets/` 或 `scripts/` 文件，source tree 或 staging build 已有 target 时必须改用不同路径，不能覆盖。
- 只有确定性、输出完全由 registered build input 决定的 `scripts.node.build` 才声明 `buildConfig.cacheable: true`。该字段不接受 `false`，也不能在没有 build script 时使用。
- Portable Agent Skills 使用 `distributions.agentSkills.skills` 声明独立的 `./` plugin-relative Skill root。`buildConfig.skillRuntimeFiles.distributions: ["agent-skills"]` 只投影到 portable surface；字段缺失时保持既有 native 行为，同时声明 `platforms` 和 `distributions` 时投影到两组明确 surface。`agent-skills.skill` dynamic target 必须由 `distributions.agentSkills` 门禁，并可用 `runtimeImports` 引用 build-time runtime export；bundle 保存其 bytes、digest 和 provenance，renderer materialize 时只读 consumer bundle-local 文件。
- 使用 Portable 字段的 source manifest 必须是 Manifest v2，并保留至少一个非空 native capability；空 `extensions` 和空 native 数组不满足该门禁。static portable root 的每个直接子目录必须是有效 `portable-agent-skills` Skill，并包含 production `README.md`。构建器负责注入保留的 runtime requirements receipt，源码和 renderer 不得声明该文件。
- `agent-skills.skill` 必须显式声明 `distribution: "agent-skills"`、`skillKey`、`scopes`、`states` 和 `refreshKeys`；不得从 native target 或 marketplace product 推导 distribution。作者 validator 以 distribution surface 运行 renderer fixture，设置 `AW_PLUGIN_DISTRIBUTION=agent-skills`，不设置第三种 `AW_PLUGIN_PLATFORM`。最终树按 `sourceDirs → distribution skillRuntimeFiles → renderer files` 合并，并拒绝无效 Skill、名字冲突、author-only 内容、未解析模板、sensitive config 和缺失 runtime file。
- 消费者使用 `aw skill install <plugin> --scope <project|user>` 通过兼容的外部 `skills` CLI 安装 portable Skill，或使用 `aw skill materialize <plugin> --scope <project|user> --out <dir>` 安全导出。两个入口都先验证完整依赖闭包和全部候选；`--skill` 只过滤最终选择，不缩小验证边界。

## 本仓库 Product Release 编排

- 使用 `pnpm plugin:test <plugin>` 运行单插件确定性测试；使用 `pnpm plugin:test --all` 检查全部插件。
- 日常开发运行 `aw plugin status`。production bundle 变化且稳定目标未变时，`unreleasedChanges` 是有效状态。
- `pnpm release` 是本 monorepo 对 Eval、Core、CLI npm packages、CLI tag 和可选 Catalog publication 的 Product Release 编排。它不是第二套 Catalog schema、publisher 或恢复合同。
- 本仓库官方 `pnpm build` 使用 `--strict-requirements` 语义；`release:verify:catalog:core` 通过该 build 覆盖 strict 门禁。第三方公开 `aw catalog build` 默认只 advisory。
- 选择 Catalog 轴时，`pnpm release` 通过公共 `aw catalog version` mutation 选择 metadata beta，并最终调用与第三方 Workspace 相同的 Catalog publish plan/apply、publication journal、tag 和失败恢复合同。具体 Catalog 行为以[Catalog 作者指南](catalog-authoring.md)和 Core validator 为准。
- 正常产品发布只使用 `pnpm release`。它只提交指定的发布元数据，并从已提交的 source HEAD 生成和消费 immutable prepared state；npm repair 仍只属于 CLI package 轴。
- 新工作流的 generated standards、schemas 和 handoff contracts 必须通过 check-only contract test；CI 不自动改写生成文件。
- CLI 作者 validator 的 JavaScript import scanner 是唯一实现；门禁覆盖 static import、export-from、dynamic import、`require()`、`require.resolve()`、非代码文本过滤和 `${...}` 代码扫描。
- 三层插件应分别验证，并增加同时安装三个插件的组合测试。
- 通用确定性测试的分层、价值门禁和验证选择见[测试指南](testing.md)。
- 稳定发布时检查源码 manifest version 的流程见 README 的正式版发布说明。
