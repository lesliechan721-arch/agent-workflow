# NPM 插件市场分发方案 TODO 拆解

## 文档说明

- 来源计划：`docs/dev/plans/npm-plugin-marketplace-new.md`
- 目标：把长计划拆成可顺序推进的执行清单，方便按阶段开发、测试、验收和回顾。
- 使用方式：每个阶段都要同时勾掉开发项、自动化测试和人工验收；阶段门禁没过，不进入下一阶段。
- 统一约束：
  - 所有命令默认在 repo root 执行。
  - 常规测试保持 build-free，不隐式触发 `pnpm build`。
  - 运行时 bundle 只认 `embedded plugins root` 与 `~/.aw`。
  - 命令阶段不回写 repo `plugins/` 或包内 `plugins-dist`。
  - 当前方案不兼容旧 repo-root marketplace / 源码树 generated manifest 基线，只按新模型收口。

## 阶段总览

| 阶段 | 对应计划 | 目标 | 阶段门禁 |
|------|------|------|------|
| 阶段 1 | Phase 1 + Phase 4 | 冻结 build-time contract、发布入口和 runtime bundle 生成规则 | `pnpm build` 能稳定产出 `plugins-dist`，常规测试不依赖预生成 bundle |
| 阶段 2 | Phase 2 + Phase 1.6 | 落地 `~/.aw`、catalog 选择和账本保留 / 降级语义 | `aw init --force` 与 `validateLocalMarketplaceLayout()` 闭环通过 |
| 阶段 3 | Phase 3.0 + Phase 3.4 + Phase 4.3 | 跑通 `codex-config.ts` round-trip gate 和原生命令执行抽象 | TOML round-trip 保真，测试不依赖真实 CLI 二进制 |
| 阶段 4 | Phase 3.1 ~ 3.3 | 重构 Claude / Codex adapter 与状态检测矩阵 | 三层真值、fallback evidence、trust 计算全部可测 |
| 阶段 5 | Phase 5.1 ~ 5.5 | 串起 install / uninstall / upgrade / status / auto 平台推断 | 四个核心命令按新状态模型工作，失败语义可回归 |
| 阶段 6 | Phase 5.6 + 发包验证 | 收尾作者工具、夹具、文档和 tarball 验收 | 脚手架、活动文档和 tarball 全部收口到新模型 |

## 阶段 1：build-time contract 与 runtime bundle

### 目标

把发布入口、构建链路、manifest schema 和 bundle 生成规则一次定死，先把“包里到底长什么样”稳定下来。

### 开发 TODO

- [x] 调整仓库根 `package.json`，提供统一的 `build`、`test`、`test:unit`、`test:integration`、`test:coverage`、`test:smoke*`、`pack:cli` 入口。
- [x] 调整 `packages/cli/package.json`，补齐 `files`、`prepack`，不再固定私有 registry，并让 `build` 固定执行 `tsc -p tsconfig.json && node dist/scripts/bundle-plugins.js`。
- [x] 调整 `packages/cli/tsconfig.json`，把 `scripts/**/*.ts` 纳入编译输入。
- [x] 调整 `packages/cli/vitest.config.ts`，把 `tests/smoke/**` 从常规测试集合剥离。
- [x] 更新 `.gitignore`，忽略 `packages/cli/plugins-dist`。
- [x] 新建 `plugins/marketplace-source.json`，只承载 marketplace root 级源码元数据。
- [x] 给 `plugins/*/.agents-plugin/plugin.json` 补齐 `marketplace` entry metadata，并把它作为唯一源码输入。
- [x] 扩展 `packages/cli/src/types.ts` 与 `packages/cli/src/utils/manifest.ts`，收口 root metadata、entry metadata、`buildConfig`、`agentOverrides`、`manifestOverrides` 白名单。
- [x] 新建 `packages/cli/src/utils/template-engine.ts`，落地 `buildConfig.templates`。
- [x] 落地 `buildConfig.fileRules`、受限 `manifestOverrides`、`extensions.*.agentOverrides`。
- [x] 新建 `packages/cli/src/generators/local-plugin.ts`，负责从源码 manifest 生成运行时 bundle。
- [x] 新建 `packages/cli/scripts/bundle-plugins.ts`，负责生成 `packages/cli/plugins-dist` 与两份 marketplace mirror。
- [x] 统一生成 `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`，确保路径只指向 bundle 内真实文件。
- [x] 固定 runtime marketplace `name = "aw"`，两份 manifest 的 `source` 一律写成 `./plugins/<plugin>`。
- [x] 让 Claude generated bundle 全部落在 `./claude/**`，禁止回落到 root 默认 loader 路径。
- [x] 让 Codex generated bundle 显式写出 `skills`、`mcpServers`、`apps` 的 bundle-local 路径。
- [x] 删除 repo root runtime marketplace 和源码树 generated platform manifest 的运行时角色，避免后续实现继续误用旧入口。
- [x] 新建 `packages/cli/tests/helpers/embedded-root.ts`，供 build-free 测试生成 synthetic embedded root。

### 自动化测试

- [x] 新建或更新 `packages/cli/tests/unit/manifest.test.ts`，锁定 marketplace root / entry metadata schema 和非法输入。
- [x] 新建 `packages/cli/tests/unit/marketplace.test.ts`，锁定 marketplace mirror、一致性和 `source` 规则。
- [x] 新建 `packages/cli/tests/unit/build-config.test.ts`，覆盖 `buildConfig` 校验。
- [x] 新建 `packages/cli/tests/unit/template-engine.test.ts`，覆盖模板渲染。
- [x] 新建 `packages/cli/tests/unit/file-rules.test.ts`，覆盖 include / exclude 行为。
- [x] 更新 `packages/cli/tests/unit/generators.test.ts`，覆盖 `local-plugin.ts` 的 Claude / Codex 生成结果。
- [x] 新建 `packages/cli/tests/smoke/build-smoke.test.ts`，验证 `pnpm build` 会真正执行 `dist/scripts/bundle-plugins.js`。
- [x] 运行 `pnpm test:unit`。
- [x] 运行 `pnpm test:smoke:build`。

### 人工验收

- [x] 在干净 checkout 下执行 `pnpm build`，确认会产出 `packages/cli/plugins-dist`。
- [x] 检查 `packages/cli/plugins-dist/.claude-plugin/marketplace.json` 与 `.agents/plugins/marketplace.json`，确认 root metadata、entry metadata 和 `source` 完整一致。
- [x] 抽查一个样例插件，确认 `.claude-plugin/plugin.json` 只引用 `./claude/**`，不会出现 `./skills`、`./commands`、`./agents`、`./hooks/hooks.json`、`./shared/**` 这类旧落点。
- [x] 抽查一个样例插件，确认 `.codex-plugin/plugin.json` 对 `skills`、`mcpServers`、`apps` 都写了显式 bundle 路径，不依赖默认发现。
- [x] 确认 `pnpm test:unit` 不要求预先存在 `packages/cli/plugins-dist`。

### 阶段门禁

- [x] `plugins-dist/plugins/*` 已经成为 npm 包内唯一 runtime 真值。
- [x] build-free 测试与 build smoke 的边界已经稳定。
- [x] 后续阶段不再需要回头改 bundle layout 或 manifest contract。

## 阶段 2：`~/.aw` 本地市场、catalog 与账本

### 目标

把 `~/.aw` 做成稳定的本地 marketplace 镜像，同时把 freshness、布局校验、账本保留和 degraded 语义一次落地。

### 开发 TODO

- [x] 扩展 `packages/cli/src/utils/paths.ts`，补齐 `resolveEmbeddedPluginsRoot()`、`resolveAwHome()`、`resolveClaudePluginsDir()`、Codex project / user `config.toml` 路径解析。
- [x] 给 `resolveEmbeddedPluginsRoot()` 加测试专用 override，并要求 override 也经过同一套布局校验。
- [x] 新建 `packages/cli/src/utils/local-marketplace.ts`，实现 `bundleFingerprint` 计算、staging copy、原子替换和布局校验。
- [x] 新建 `packages/cli/src/utils/plugin-catalog.ts`，实现 `currentCatalog` / `activeLocalBundle` / freshness fallback。
- [x] 新建 `packages/cli/src/commands/init.ts`，实现 `aw init [--force]`。
- [x] 在 `packages/cli/src/index.ts` 注册 `aw init`。
- [x] 落地 `~/.aw/config.json` schema。
- [x] 落地 `~/.aw/installed.json` schema，包括 `ledgerState`、Claude / Codex scope ledger、`sharedNativeRefs`、平台化 `capabilitySnapshot`。
- [x] 实现“合法账本保留、非法账本降级成 degraded ledger”的写回策略。
- [x] 实现 `validateLocalMarketplaceLayout()`，覆盖 marketplace `source`、platform manifest、bundle 内路径存在性和 Claude namespaced path 约束。
- [x] 实现 `ensureLocalMarketplace()`，固定 freshness gate 为 `sourceVersion + bundleFingerprint + 布局健康`。
- [x] 让 `status` 在 `~/.aw` 过期或损坏时回退到 `embedded plugins root` 做只读解析，但不自动物化本地市场。

### 自动化测试

- [x] 新建或更新 `packages/cli/tests/unit/plugin-catalog.test.ts`，覆盖 `~/.aw` 优先级、freshness mismatch fallback 和只读解析。
- [x] 新建或更新 `packages/cli/tests/unit/local-marketplace.test.ts`，覆盖 `init`、`ensureLocalMarketplace()`、原子替换和布局校验。
- [x] 新建或更新 `packages/cli/tests/unit/installed-ledger.test.ts`，覆盖 `available | degraded`、`scopeInitialized = yes|no|unknown`、`sharedNativeRefs` 规范化。
- [x] 更新 `packages/cli/tests/integration/cli.test.ts` 或新增相关集成用例，覆盖 `aw init --force`、损坏目录修复、freshness 变化刷新。
- [x] 运行 `pnpm test:unit`。
- [x] 运行 `pnpm test:integration`。

### 人工验收

- [x] 在临时 home 下首次执行 `aw init --force`，确认 `~/.aw` 目录布局完整。
- [x] 修改 embedded bundle 内容后再次执行 `aw init --force`，确认 `bundleFingerprint` 变化会刷新 bundle，但不会丢掉合法 `installed.json`。
- [x] 手动破坏 `~/.aw` 中某个 marketplace `source` 或平台 manifest 路径，再执行 `aw init --force`，确认能修复。
- [x] 删掉或破坏 `installed.json` 后执行 `aw init --force`，确认会写出 degraded ledger，而不是健康空账本。
- [x] 在 `~/.aw` 过期的前提下执行 `status`，确认它只读回退到 embedded catalog，不会偷偷改写 `~/.aw`。

### 阶段门禁

- [x] `aw init --force` 与 `validateLocalMarketplaceLayout()` 已形成稳定闭环。
- [x] freshness、布局健康和账本保留 / 降级语义已经落定。
- [x] 后续命令可以放心依赖 `currentCatalog` 与 `installed.json` 模型。

## 阶段 3：`codex-config.ts` feasibility gate 与原生命令抽象

### 目标

先把 Codex 的 TOML round-trip 编辑能力和原生命令调用抽象跑通，不让后续命令链路建立在脆弱文本替换上。

### 开发 TODO

- [x] 在 `packages/cli/package.json` 增加 `toml-eslint-parser` 依赖。
- [x] 新建 `packages/cli/src/utils/codex-config.ts`，基于 AST / token / range patch 编辑 marketplace、plugin enabled 和 `developer_instructions`。
- [x] 在 `codex-config.ts` 里支持成对 sentinel 区块：`[[aw-managed:start ...]]` / `[[aw-managed:end ...]]`。
- [x] 在 `codex-config.ts` 里支持多行 `developer_instructions = """..."""` 的增量写入、删除和保真读取。
- [x] 明确拒绝 instruction 正文里出现 `[[aw-managed:` 前缀行。
- [x] 确保 `codex-config.ts` 保留无关 section、字段顺序、注释和用户手写文本。
- [x] 新建 `packages/cli/src/utils/native-cli.ts`，统一封装 `execFile`、timeout、cwd、stdout / stderr 和 fake runner。
- [x] 让测试与适配器都通过 `native-cli.ts` 注入 fake runner，不直接依赖本机安装的 Claude / Codex CLI。

### 自动化测试

- [x] 新建 `packages/cli/tests/unit/codex-config.test.ts`，覆盖 marketplace / plugins / `developer_instructions` 的 round-trip golden case。
- [x] 新建 `packages/cli/tests/integration/codex-config-smoke.test.ts`，作为 build-free feasibility gate。
- [x] 新建或更新 `packages/cli/tests/unit/native-cli.test.ts`，覆盖参数构造、超时和错误传播。
- [x] 补齐 `packages/cli/tests/fixtures/codex-config/**` golden fixtures。
- [x] 运行 `pnpm test:unit`。
- [x] 运行 `pnpm test:integration`。

### 人工验收

- [x] 用包含注释、空行、无关 section、多次增删的 `config.toml` 样本做 round-trip，确认文本结构稳定。
- [x] 验证 `[marketplaces.aw]` 的 `source` 始终写成 `~/.aw` 目录，不会误写成 manifest 文件路径。
- [x] 验证删除最后一个受管区块后，`developer_instructions` 字段会被移除，而不是留下空壳。
- [x] 验证 fake runner 能完整驱动命令测试，测试机上不装 Claude / Codex CLI 也能通过。

### 阶段门禁

- [x] `codex-config.ts` 已经达到可复用的 round-trip 水平。
- [x] `native-cli.ts` 已经可供 adapter 和命令层统一调用。
- [x] 如果这里还不稳定，后续阶段一律不接命令链路。

## 阶段 4：Claude / Codex adapter 与状态检测矩阵

### 目标

把平台真值、CLI 账本、tracking manifest 和 session 可见性彻底拆开，先让 adapter 和 detect 层把状态说清楚。

### 开发 TODO

- [x] 重构 `packages/cli/src/adapters/claude.ts`，改走原生 CLI 安装 / 卸载链路。
- [x] 在 Claude adapter 里落实三层状态读取：当前 scope `settings.json`、`known_marketplaces.json`、`installed_plugins.json`。
- [x] 在 Claude adapter 里落实 `activeLocalBundle` 解析，固定按 `known_marketplaces.installLocation + source` 定位当前 bundle。
- [x] 重构 `packages/cli/src/adapters/codex.ts`，落地 `requiresNativePlugin()`、`hasRepoManagedArtifacts()`、`catalogCompatibility` 和 `sharedNativeRefs` 语义。
- [x] 更新 `packages/cli/src/adapters/helpers.ts`，补齐 Claude scope-sensitive 解析、`platformRuntimeEvidence`、`platformNativeFallbackEvidence`、`externalOwnership` 检测。
- [x] 更新 `packages/cli/src/utils/tracking.ts`，让 tracking manifest 成为 repo-managed artifacts 的正式辅助真值。
- [x] 更新 `packages/cli/src/utils/detect.ts`，计算 `projectTrust`、`instructionsSessionState`、`repoManagedSessionState`。
- [x] 更新 `packages/cli/src/types.ts`，补齐 `scopeInitialized`、`catalogCompatibility`、`externalOwnership`、`projectTrust`、session state 等类型。
- [x] 把 Claude `claudeProjectKey` 与 Codex `codexProjectKey` 语义落定，避免串 repo、串 scope、串 symlink alias。

### 自动化测试

- [x] 更新 `packages/cli/tests/unit/detect.test.ts`，覆盖 Codex trust、layer enabled/disabled、instructions / rules / hooks / agents 的可见性。
- [x] 更新 `packages/cli/tests/unit/generators.test.ts`，覆盖 Claude agents frontmatter 和 Codex role file 输出契约。
- [x] 补 adapter / helper 级单测，覆盖 `platformRuntimeEvidence`、`platformNativeFallbackEvidence`、`externalOwnership`、`catalogCompatibility`。
- [x] 补 Codex role file 合法性校验测试，确认 `.codex/agents/*.toml` 能按上游约束解析。
- [x] 运行 `pnpm test:unit`。
- [x] 运行 `pnpm test:integration`。

### 人工验收

- [x] Claude `status` 能分清 declared source drift、materialized drift、`currentCatalog` 和 `activeLocalBundle`。
- [x] Claude `project` 与 `user` 两个 scope 的状态能独立判断，互不污染。
- [x] Codex `projectTrust = trusted | untrusted | unknown` 三种状态下，instructions / rules / hooks / agents 的会话可见性都符合预期。
- [x] 同一物理目录通过 symlink / alias / realpath 进入时，Claude project 相关性仍命中同一条记录。
- [x] 同名插件由非 `aw` marketplace 管理时，两端都只报 `externalOwnership`，不接管。

### 阶段门禁

- [x] Claude / Codex 的真值矩阵已经稳定，不再混用账本和平台真值。
- [x] fallback evidence、catalog compatibility 和 trust 语义已经可测、可解释。
- [x] 后续命令层只做编排，不再自己推导平台状态。

## 阶段 5：install / uninstall / upgrade / status / auto 串联

### 目标

把命令层改成纯编排：统一读 `currentCatalog`、adapter 真值和 tracking / ledger，再按固定提交顺序改状态。

### 开发 TODO

- [x] 更新 `packages/cli/src/commands/common.ts`，让显式插件名统一走共享 catalog 解析。
- [x] 重构 `packages/cli/src/commands/install.ts`，接入 `ensureLocalMarketplace()`、`resolveTargetPlatforms()`、adapter 安装和 extensions 安装。
- [x] 重构 `packages/cli/src/commands/uninstall.ts`，按 `当前 scope 受管证据`、`platformNativeFallbackEvidence` 和 tracking manifest 做受控清理。
- [x] 重构 `packages/cli/src/commands/upgrade.ts`，落地 `current | missing | capabilityChanged` 的分支语义。
- [x] 重构 `packages/cli/src/commands/status.ts`，按四段输出：native state、scope initialized / catalog compatibility、generated artifacts、repo-managed session state / reason。
- [x] 落地 `--platform auto|both` 的推断规则，严格以 `scopeInitialized` 为准。
- [x] 固定提交顺序：先 native state 与 repo-managed artifacts，再 tracking manifest，最后 `installed.json`。
- [x] 落地统一失败语义：`operation_interrupted_after_native_write` 与 `operation_interrupted_after_artifact_write`。
- [x] 确保 `status` 保持只读，不自动 `init`，不自动修 drift。
- [x] 确保命令阶段不回写 repo `plugins/`、repo root marketplace 或包内 `embedded plugins root`。

### 自动化测试

- [x] 更新 `packages/cli/tests/integration/cli.test.ts`，覆盖 install / uninstall / upgrade / status / `--platform auto|both` 主路径。
- [x] 补失败注入集成测试，覆盖 native 已写成功但 tracking / ledger 提交失败、artifacts 已写成功但 ledger 提交失败等场景。
- [x] 补跨版本集成测试，覆盖 current catalog `missing`、能力变化、显式 `upgrade <plugin>` 与 `upgrade --all` 拒绝路径。
- [x] 补跨 scope / 跨 repo 集成测试，覆盖 Claude project 隔离、Codex `sharedNativeRefs` 保守删除、instruction-only / native-only / hybrid 组合。
- [x] 运行 `pnpm test:integration`。
- [x] 运行 `pnpm test`。

### 人工验收

- [x] `install` 在 current catalog miss 时直接报 `Unknown plugin`，其余命令在 fallback evidence 仍存在时不会错误退化成 `Unknown plugin`。
- [x] `upgrade --all` 在 `ledgerState = degraded` 或存在 `missing | capabilityChanged` 条目时会拒绝执行，并列出原因。
- [x] `status --platform auto` 在双平台环境下能并列展示；会修改状态的 `--platform auto` 在 `scopeInitialized = unknown` 时会拒绝自动推断。
- [x] Claude `uninstall --scope project` 只影响当前 project，user scope 状态不受影响。
- [x] Codex `uninstall --scope user` 在仍有 project shared refs 时不会误删 shared user plugin enabled，也不会误删 `[marketplaces.aw]`。
- [x] command 输出里能看清 `scopeInitialized`、`catalogCompatibility`、degraded reason、fallback evidence 和 trust 结果。

### 阶段门禁

- [x] 四个核心命令已经全部跑在新模型上。
- [x] `status`、`upgrade --all`、`--platform auto` 不会再把账本缺口误判成 `no`。
- [x] install / uninstall / upgrade 的失败恢复路径已经有自动化回归。

## 阶段 6：作者工具、夹具、文档与发包验收

### 目标

把仓库里的辅助工具、测试夹具、活动文档和最终 tarball 一次收口，避免代码改完但生态仍停在旧模型。

### 开发 TODO

- [x] 更新 `packages/cli/tests/fixtures/**`，全部切到 `embedded plugins root + ~/.aw` 新模型。
- [x] 更新 `packages/cli/tests/integration/authoring-tools.test.ts`，覆盖作者工具回归。
- [x] 更新 `.agents/skills/create-agent-workflows-plugin/SKILL.md`。
- [x] 更新 `.agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js`，脚手架只生成源码结构和带 `marketplace` block 的 `.agents-plugin/plugin.json`。
- [x] 更新 `.agents/skills/create-agent-workflows-plugin/references/*.md`，去掉旧 repo-root marketplace / 源码树 platform manifest 口径。
- [x] 清理或标记历史文档，并补回链到当前计划。
- [x] 处理 `docs/dev/plans/project-init.md`。
- [x] 处理 `docs/codex-claude-plugin-marketplace-research.md`。
- [x] 处理 `docs/dev/plans/npm-plugin-marketplace.md`。
- [x] 处理 `docs/dev/plans/npm-plugin-marketplace-copy.md`。
- [x] 处理 `docs/dev/plans/codex-repo-managed-artifacts.md`，要么同步到新模型，要么先标成历史文档。
- [x] 新建 `packages/cli/tests/smoke/pack-smoke.test.ts`，覆盖 `pnpm pack:cli` tarball 内容和 embedded runtime smoke。

### 自动化测试

- [x] 运行 `pnpm test:integration`，确认 fixtures 与 CLI 行为已经切到新模型。
- [x] 运行 `pnpm test:smoke:pack`。
- [x] 运行 `pnpm test:smoke`。
- [x] 运行 `pnpm pack:cli`，并让 `pack-smoke` 从解包目录校验 tarball 内容。

### 人工验收

- [x] 在临时仓库执行 `node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js ...`，确认只生成源码结构，不生成 runtime marketplace，也不生成源码树 `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json`。
- [x] 检查 `SKILL.md` 与 `references/*.md`，确认不再把 repo root marketplace 或源码树平台 manifest 当成运行时真值。
- [x] 检查同主题旧计划，确认它们已经删除或带上明确的“历史文档”标记，并回链当前计划。
- [x] 检查所有仍作为活动文档保留的内容，确认没有再把 repo root marketplace、源码树 platform manifest 或“命令阶段生成 runtime manifest”写成当前默认路径。
- [x] 解包 `pnpm pack:cli` 产物，确认 tarball 内存在 `package/dist/index.js`、两份 marketplace manifest、样例插件三份 platform manifest。
- [x] 在解包目录验证 `resolveEmbeddedPluginsRoot()` 能定位到 tarball 内的 `plugins-dist`，并能完成一次最小 `aw init --force` 或 catalog 读取 smoke。

### 阶段门禁

- [x] 作者工具、测试夹具、活动文档和 tarball 已全部收口到新模型。
- [x] 仓库里不再同时存在“活动中的新模型”和“未标历史的旧模型”两套口径。
- [x] 发布前的最终 smoke 已经可重复执行。

## 总体验收清单

- [x] `plugins-dist/plugins/*` 是 npm 包内唯一 runtime 真值。
- [x] `pnpm build`、`pnpm test`、`pnpm test:unit`、`pnpm test:integration`、`pnpm test:smoke*`、`pnpm pack:cli` 都能从 repo root 直接执行。
- [x] `pnpm test` 与 `pnpm test:integration` 在干净 checkout 上不依赖预生成 `packages/cli/plugins-dist`。
- [x] `aw init` 只复制和校验，不做二次生成。
- [x] `installed.json` 只做 CLI 管理账本，不冒充 Claude / Codex 平台真值。
- [x] Claude / Codex 都已经有 `missing`、`capabilityChanged`、fallback evidence、`externalOwnership` 的正式受控路径。
- [x] Codex `developer_instructions` 已全部改走 `developer_instructions` 字段和 sentinel 受管区块，不再写 `config.toml.instructions`。
- [x] `status` 仍是只读命令，`upgrade --all` 与 `--platform auto` 都遵守 `scopeInitialized` 和 degraded gate。
- [x] 作者工具、活动文档、测试夹具和 tarball 全部对齐 `embedded plugins root + ~/.aw` 新模型。

## 建议执行顺序

1. 先完成阶段 1，把包的 runtime contract 冻结。
2. 再做阶段 2，让 `~/.aw` 和 catalog 模型稳定下来。
3. 阶段 3 单独收口 `codex-config.ts`，不要和大命令改造混在一起。
4. 阶段 4 先把 adapter / detect 层状态讲清楚，再进入阶段 5 命令编排。
5. 最后做阶段 6，把作者工具、夹具、文档和 tarball 一次收尾。
