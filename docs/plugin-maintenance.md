# 插件维护指南

本文件面向人类维护者，负责插件源码边界、维护入口和仓库级验证。它不保存完整 Agent 工作流、字段规范或模型 Eval 运行手册。

## 源码与生成物

- 插件源码位于 `plugins/`，`plugins/<name>/.agents-plugin/plugin.json` 是源码 manifest 真值。
- catalog staging 和 runtime bundle 是构建产物，不要直接修改。
- 作者只维护 plugin source 和稳定 plugin version。不要手改 Git catalog refs、release ledger 或 source cache。
- 作者声明真实的 `compatibility.aw.minVersion`；发布器会把所有插件声明与 schema 4 的 `0.0.0` floor 取最大值。当前没有 dependency 或 Portable 专用版本门槛。
- 创建或修改插件能力时只维护源码层；平台产物由 CLI、adapter 和发布流程生成。
- 插件和 Skill 的 production README 使用[插件与 Skill README 规范](readme-standard.md)。

## 同步规则

改动插件基础架构、manifest/schema、adapter 行为、scope 语义、分发或安装流程，或任何影响插件作者使用方式的能力时，必须同时检查旧的 `create-aw-plugin` 工作流和新的 `aw-plugin-development` 适配器。迁移期间两个入口都必须保持准确。

旧版插件开发 Review 合同的源码 owner 是 `.agents/legacy/plugin-development-review/`。旧 `create-aw-plugin`、`skill-review`、`review:publish` 和静态报告流程可以继续使用该 owner。`agent-skill-toolkit` 与 `aw-plugin-development` 不拥有、导出或投影旧版 Review schema、validator、inspector、bundle、target plan 或摘要 producer。

新的 `aw review` 是独立的不可变归档入口：只把已有 `report.md`、可选 Quality Review result、checks/evidence、独立 `release-check.json` 和 workflow scope 写入 `reports/reviews/<kind>/<encoded-target-id>/<review-id>/`。Quality Review 只拥有设计、复杂度和 findings；Release Check 只拥有机器 readiness；Publication 只拥有 target/digest 绑定和 archive。新入口不得导入旧 `ReviewInputBundle`、AW summary、target plan、batch 或 seal，也不得重评、封存 Eval、更新 README 或可变 index。

依赖方向只能从旧 owner 指向仍为 canonical 的新合同，例如 Review 维度、Eval audit 和 run bundle。新插件的 production source、manifest、staging 和 runtime bundle 不得导入旧 owner，也不得重新包装旧版合同。Stage 6 默认路由不再经过旧 owner。

## 维护入口

- 通过公开 `aw` CLI 安装相应插件后，`author-agent-skill`、`review-agent-skill`、`review-agent-workflow`、`author-aw-plugin`、`review-aw-plugin` 和 `review-aw-workflow` 成为默认工作流入口。前 3 个处理通用 Agent Skill 与工作流；后 3 个处理 AW 插件与跨插件工作流。仓库不把插件源码投影为 `.claude/skills`。
- `agent-content-toolkit` 提供 `write-agent-content` 与 `review-agent-content`。
- `agent-skill-toolkit` 提供 Skill author/review 与 Eval design/audit，并依赖 `agent-content-toolkit`。
- `aw-plugin-development` 提供默认的 AW Author/Reviewer，并依赖 `agent-content-toolkit` 和 `agent-skill-toolkit`；使用默认模型 Eval 执行器时还需要 `aw-skill-eval-runner`，也可以安装其它输出 `EvalRunBundle v3` 的兼容 runner。
- AW Author/Reviewer 适用于任意兼容 workspace root；目标根由 `.agents-plugin/plugin.json` 标识，不限于 `plugins/<name>/`。repo-local 旧 `create-aw-plugin` 仍只处理本仓库 `plugins/<name>/`；不含 AW manifest 的 repo-local 或 portable Skill 使用通用 `review-agent-skill`。
- 旧 `pnpm review:publish`、旧 `.agents` Skills 和依赖保持可用，但只有用户手动显式指定 `create-aw-plugin` 或 `skill-review` 时才调用。它们是兼容入口，不是默认路由。
- 确定性作者工具统一使用公开 CLI：`aw plugin init`、`aw plugin add-skill`、`aw plugin validate`、`aw plugin status` 和独立 Skill 的 `aw skill validate`。`check-versions` 只保留为 deprecated 兼容别名。先运行 `aw --version`；不要使用 `npx` 或隐式安装。repo-local `create-aw-plugin`、`aw-plugin-development` Author 和 Skill Reviewer 只编排这些命令，不保存第二份核心 frontmatter 或 Codex metadata 实现。
- 默认插件根是 `<repo-root>/plugins/<plugin-name>`。兼容工作区使用其它布局时，`init`、`add-skill` 和单插件 `status` 显式传 `--plugin-root <path>`；该路径必须位于 Git repo root 内并与 plugin name 匹配。`validate` 和 `status` 拒绝 repo/plugin root、`.agents-plugin` 或 manifest path chain 中的符号链接和错误节点类型；不要用链接把作者根或 manifest 重定向到仓库外。`status --all` 保留 `plugins/` 扫描语义。
- 模型 Eval 和报告发布属于专用工作流，不在通用测试指南中重复定义。Reviewer 发布报告不修改 production README；登记由 Author 或 release 工具执行。
- Reviewer 默认只在聊天中交付 Quality Review。用户明确要求归档时，只有本次请求的顶层 Reviewer 使用 `aw review publish`；下层 Reviewer 只返回材料。修订已有记录时创建新 record 并使用 `--supersedes`。Quality Review 不拥有 readiness；独立生成的 `release-check.json` 只能作为可选附件。

## Catalog build-time 文件复用

CLI 的 `plugin-authoring-capabilities` registry 是 AW 插件作者字段视图的 canonical 数据源。`aw-plugin-development` 在 staging build 中通过 reserved `@aw/cli` build import 读取它，并生成六个聚焦 reference；插件源码不保存 registry 副本。复杂校验仍由 registry 的 `verifiedSource` 指向 canonical validator。

`buildConfig.generatedSkillRuntimeFiles` 只声明 `scripts.node.build` 必须创建的最终 Skill 文件。源码 closure 仅允许这些精确 target 尚未存在；build/materialization 后每个选中 surface 都必须存在 regular file，并通过完整 nested runtime closure。该字段不复制文件，也不形成安装依赖。

manifest `dependencies` 声明安装或升级某插件时必须同时满足的同 source 插件。它只接受插件名，不接受 `source/plugin`。`buildConfig.buildImports`、`skillRuntimeFiles.import` 和 artifact `runtimeImports` 是独立的 typed build-time reuse edge；它们不声明安装依赖，也不能用于推断 `dependencies`。artifact runtime import 在 Catalog build 时复制到 consumer bundle，renderer 只读取 bundle-local 文件。

- provider 用 `buildConfig.runtimeExports: [{ "name": "<stable-kebab-name>", "source": "./<file>" }]` 显式发布 canonical source file。source 必须是插件根内 regular non-symlink file，且不能位于 Skill、report、eval、dependency 或 build temporary tree。
- consumer build 用 `buildConfig.buildImports: [{ "plugin": "<provider>", "export": "<name>", "env": "AW_PLUGIN_IMPORT_<NAME>" }]`。`scripts.node.build` 只读取该 env 指向的只读绝对文件，不使用 `../<sibling>`。Skill 文件投影用 `buildConfig.skillRuntimeFiles: [{ "skill": "<static-skill-key>", "target": "references/<file>", "import": { "plugin": "<provider>", "export": "<name>" } }]`；own staged source 把 `import` 换成 `source: "./<file>"`。
- `skillRuntimeFiles.platforms` 可限制 `claude` 或 `codex`；缺省为 consumer 支持的全部平台。target 只允许 static Skill 内 `references/`、`assets/` 或 `scripts/` 文件，source tree 或 staging build 已有 target 时必须改用不同路径，不能覆盖。
- reserved `@aw/cli` build import 只发布两个 canonical registry export：`skill-frontmatter-capabilities` 和 `plugin-authoring-capabilities`。两者都不能直接投影到 Skill。Eval corpus digest 只用 reserved `{ "plugin": "@aw/agent-skill-eval", "export": "case-corpus-digest" }` build import 或 `skillRuntimeFiles.import`，投影公开 Eval 包中的自包含 canonical 实现。reserved provider 不支持 artifact runtime，也不存在其它通用 CLI source export。版本比较工具只有在 base/current 都拥有完整 workspace CLI source 时才分别绑定对应 root/version；单侧 ownership 或 partial source 失败。两侧都不拥有时，从同一个经验证的 installed external provider 独立物化两个相同身份的 root；不得让 base 使用或复制 current registry root/bytes。
- 只有确定性、输出完全由 registered build input 决定的 `scripts.node.build` 才声明 `buildConfig.cacheable: true`。该字段不接受 `false`，也不能在没有 build script 时使用。
- Portable Agent Skills 使用 `distributions.agentSkills.skills` 声明独立的 `./` plugin-relative Skill root。`buildConfig.skillRuntimeFiles.distributions: ["agent-skills"]` 只投影到 portable surface；字段缺失时保持既有 native 行为，同时声明 `platforms` 和 `distributions` 时投影到两组明确 surface。`agent-skills.skill` dynamic target 必须由 `distributions.agentSkills` 门禁，并可用 `runtimeImports` 引用 build-time runtime export；bundle 保存其 bytes、digest 和 provenance，renderer materialize 时只读 consumer bundle-local 文件。
- 使用 Portable 字段的 source manifest 仍必须声明严格 SemVer 的 `compatibility.aw.minVersion`。V1 要求同一插件至少有一个非空 native capability；空 `extensions` 和空 native 数组不满足该门禁。static portable root 的每个直接子目录必须是有效 `portable-agent-skills` Skill，并包含 production `README.md`。
- `agent-skills.skill` 必须显式声明 `distribution: "agent-skills"`、`skillKey`、`scopes`、`states` 和 `refreshKeys`；不得从 native target 或 marketplace product 推导 distribution。作者 validator 以 distribution surface 运行 renderer fixture，设置 `AW_PLUGIN_DISTRIBUTION=agent-skills`，不设置第三种 `AW_PLUGIN_PLATFORM`。最终树按 `sourceDirs → distribution skillRuntimeFiles → renderer files` 合并，并拒绝无效 Skill、名字冲突、author-only 内容、未解析模板、sensitive config 和缺失 runtime file。
- 消费者使用 `aw skill install <plugin> --scope <project|user>` 通过兼容的外部 `skills` CLI 安装 portable Skill，或使用 `aw skill materialize <plugin> --scope <project|user> --out <dir>` 安全导出。两个入口都先验证完整依赖闭包和全部候选；`--skill` 只过滤最终选择，不缩小验证边界。

## 验证与版本

- 使用 `pnpm plugin:test <plugin>` 运行单插件确定性测试；使用 `pnpm plugin:test --all` 检查全部插件。
- 日常开发运行 `aw plugin status`。production bundle 变化且稳定目标未变时返回通过的 `unreleasedChanges`，不要求立即改 version。release train 使用 `pnpm release -- beta|release --catalog|--all --plugin <name>=major|minor|patch` 一次设置稳定目标并发布；candidate 身份由 registry、immutable Catalog history 和 ledger 生成。
- 正常维护发布只使用 `pnpm release`。它只提交指定的发布元数据，并从已提交的 source HEAD 生成和消费 immutable prepared state。
- 新工作流的 generated standards、schemas 和 handoff contracts 必须通过 check-only contract test；CI 不自动改写生成文件。
- CLI 作者 validator 的 JavaScript import scanner 是唯一实现；门禁覆盖 static import、export-from、dynamic import、`require()`、`require.resolve()`、非代码文本过滤和 `${...}` 代码扫描。
- 三层插件应分别验证，并增加同时安装三个插件的组合测试。
- 通用确定性测试的分层、价值门禁和验证选择见[测试指南](testing.md)。
- 稳定发布时检查源码 manifest version 的流程见 README 的正式版发布说明。
