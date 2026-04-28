# Skill 安装触发偏好 TODO 拆解

## 文档说明

- 来源计划：`docs/dev/plans/skill-trigger-install-preference.md`
- 目标：把 skill 安装触发偏好方案拆成可以顺序推进、独立验收的阶段任务。
- 使用方式：每个阶段先完成开发项，再补自动化测试，最后通过阶段验收；阶段验收不过，不进入下一阶段。
- 统一约束：
  - 所有命令默认在 repo root 执行。
  - skill 默认触发策略继续来自平台原生文件：Codex 使用 `agents/openai.yaml`，Claude Code 使用 `SKILL.md` frontmatter。
  - `skillTriggers` / `allowInstallOverride` 的权威来源固定为 embedded / pristine bundle 中的 `.agents-plugin/plugin.json`，不能信任 `~/.aw` 运行时副本。
  - 命令阶段只物化 `~/.aw/plugins/<plugin>/<platform>/skills`，不回写 `plugins/` 源码或 `packages/cli/plugins-dist/`。
  - `manual` 表示禁用模型自动触发但保留用户显式触发入口；`auto` 表示允许模型自动触发；`default` 表示恢复 pristine 默认策略。
  - available ledger 才能参与 replay、status 确定性 drift 和 sibling 胜者选举；degraded ledger 下只能按本次显式 CLI 偏好物化，不能信任历史 sibling record。
  - strict fail fast 只用于用户显式 `--skill-trigger manual|auto` 且实际需要改写的 `allowInstallOverride: true` skill；维护性 replay / status / warning 路径遇到 malformed pristine skill 时降级为 `unknown` 或 skipped warning。

## 阶段总览

| 阶段 | 对应计划 | 目标 | 阶段门禁 |
|------|------|------|------|
| 阶段 1 | 实现步骤 1 | 冻结类型、manifest contract 和 bundle layout 保留规则 | source / bundle manifest 能准确接受、拒绝和保留 `skillTriggers` |
| 阶段 2 | 实现步骤 2 前半 | 接入 CLI 参数、入口解析、warning 错误通道和 per-target install options | `install` / 显式 `upgrade` 能按 target 解析偏好，degraded ledger 拒绝隐式继承 |
| 阶段 3 | 实现步骤 3 | 落地 skill trigger 物化、patch、签名、胜者选举和 conflict warning 工具 | runtime skill 子树可从 embedded pristine 安全物化，签名和 warning 可只读推导 |
| 阶段 4 | 实现步骤 4 前半 | 接入 install / 显式 upgrade / `upgrade --all` 与 ledger 写入 | 安装和升级在 native install 前物化偏好，失败时可回滚并正确写 ledger |
| 阶段 5 | 实现步骤 4 后半 | 接入 uninstall、local marketplace rebuild、ledger replay 和 degraded 维护语义 | `aw init --force`、stale refresh、bundle refresh 和卸载都能重物化或安全跳过 |
| 阶段 6 | 实现步骤 5 status 部分 | 扩展 status 的 ledger 偏好、runtime 匹配、drift 和 unknown 输出 | status 保持只读，并能解释共享 marketplace 当前 skill trigger 状态 |
| 阶段 7 | 实现步骤 5 文档 / 作者工具 | 更新用户文档、作者文档、脚手架和校验脚本 | 文档与作者工具完整覆盖 `skillTriggers` 和 `--skill-trigger` |
| 阶段 8 | 测试计划 Integration / Smoke | 补齐端到端、CLI 入口和 smoke 验收 | unit、integration、build smoke 与真实 dist 入口全部通过 |

## 阶段 1：类型、manifest contract 与 bundle layout

### 目标

先把插件作者能声明什么、bundle 里必须保留什么、ledger 可以记录什么固定下来，避免后续命令层和物化层各自发明字段。

### 开发 TODO

- [x] 在 `packages/cli/src/types.ts` 增加 `SkillTriggerPreference = 'default' | 'manual' | 'auto'`。
- [x] 在 `packages/cli/src/types.ts` 增加 `SkillTriggerPolicy { allowInstallOverride: boolean }`。
- [x] 给 `PluginManifestSource` 增加 `skillTriggers?: Record<string, SkillTriggerPolicy>`。
- [x] 增加 `InstalledScopeInstallOptions { skillTriggerPreference?: SkillTriggerPreference }`。
- [x] 给 `InstalledScopeRecord` 增加 `installOptions?: InstalledScopeInstallOptions`。
- [x] 给 `InstalledScopeRecord` 增加 `skillTriggerWriteOrder?: number`。
- [x] 增加 `ResolvedInstallOptions`，包含 `skillTriggerPreference` 和偏好来源字段。
- [x] 给 `EnsureLocalMarketplaceResult` 增加 `warnings?: string[]`。
- [x] 新增 `CommandWarningError` 或等价结构化错误类型，用于失败路径携带已产生的 warnings、错误信息和 exit code。
- [x] 在 `InstallCommandOptions` / `UpgradeCommandOptions` 增加 `requestedSkillTrigger?: SkillTriggerPreference`。
- [x] 保持基础 `CommandOptions` 不承载 resolved 偏好，避免安装循环误用全局值。
- [x] 更新 `packages/cli/src/utils/manifest.ts` 的通用 schema，允许顶层 `skillTriggers`。
- [x] 校验插件没有声明 `skills` 时不能声明 `skillTriggers`。
- [x] 校验每个 `skillTriggers` entry 只允许 `allowInstallOverride`。
- [x] 校验 `allowInstallOverride` 必须是 boolean。
- [x] 在 `validateSourcePluginManifest()` 中读取 source `skills` 目录，确认每个 `skillTriggers` key 都对应真实 skill 子目录。
- [x] 确保 `readPluginManifest(..., { mode: 'bundle' })` 不假设 bundle root 下还有 source 形态 `./skills` 目录。
- [x] 更新 `createBundleSourceManifest()`，把 `skillTriggers` 深拷贝写入 bundle source manifest。
- [x] 更新 `packages/cli/src/utils/bundle-layout.ts`，让 layout 校验接受并保留新字段。
- [x] 如果 layout 需要校验 bundle 内 skill 存在性，只基于 `./claude/skills/<skill>` / `./codex/skills/<skill>` 或平台 manifest 的 `skills` 路径，不使用 source `./skills`。
- [x] 明确 layout 校验不解析 `SKILL.md` frontmatter 或 `agents/openai.yaml`，把 strict 语义检查留给 install-time materializer。

### 自动化测试

- [x] 更新 `packages/cli/tests/unit/manifest.test.ts`，接受合法 `skillTriggers`。
- [x] 覆盖 `skillTriggers` entry 中未知字段被拒绝。
- [x] 覆盖没有 `skills` 却声明 `skillTriggers` 被拒绝。
- [x] 覆盖 source manifest 中 `skillTriggers` key 指向不存在 skill 目录时被拒绝。
- [x] 覆盖 bundle mode 能保留 `skillTriggers`，且不要求 source `./skills` 目录存在。
- [x] 更新 `packages/cli/tests/unit/manifest-coverage.test.ts`，断言 `createBundleSourceManifest()` 深拷贝 `skillTriggers`。
- [x] 更新 `packages/cli/tests/unit/bundle-layout.test.ts` 或同等测试，确认 bundle layout 校验不会用 source `./skills` 误判。
- [x] 更新 `packages/cli/tests/unit/installed-ledger.test.ts`，接受旧账本缺少 `installOptions` 的情况。
- [x] 覆盖新账本带 `installOptions.skillTriggerPreference` 和 `skillTriggerWriteOrder` 可以通过 validator。
- [x] 覆盖非法偏好值、非法 write order、非法 `installOptions` 结构被拒绝。
- [x] 运行 `pnpm test:unit`。

### 阶段验收

- [x] Source manifest 可以声明 `skillTriggers`，并能准确拒绝非法 key、非法字段和非法类型。
- [x] Bundle source manifest 能完整保留 `skillTriggers`，不会因为 bundle mode 缺少 source `./skills` 目录而误报。
- [x] Ledger 类型兼容旧数据，同时能记录 skill trigger 偏好和写入顺序。
- [x] 通用 layout 校验仍保持浅校验，不提前承担 frontmatter / YAML 语义解析。

## 阶段 2：CLI 参数、命令准备与 per-target 偏好解析

### 目标

把 `--skill-trigger` 接到 CLI 入口和命令准备层，但不急着写 runtime 文件。重点是区分“用户显式传入”“available ledger 继承”“implicit default”和“degraded ledger 拒绝隐式继承”。

### 开发 TODO

- [x] 在 `packages/cli/src/index.ts` 增加 `parseSkillTriggerPreference()`。
- [x] 给 `install` 增加 `.option('--skill-trigger <preference>', 'default | manual | auto')`。
- [x] 给显式 `upgrade` 增加同名 option。
- [x] 明确 `upgrade --all --skill-trigger ...` 首版直接报错。
- [x] 拆出 build-free CLI 入口，例如 `buildProgram({ cwd, env, stdout, stderr })` / `runCli(argv, io, env)`。
- [x] 让 bin 文件只接入真实 `process.argv`、`process.cwd()`、`process.env`、stdout 和 stderr。
- [x] 新增 `resolveInstallOptionsForTargets()` 或同等 helper。
- [x] `install` 显式传参时，所有目标使用 CLI 值，并标记来源为 `cli`。
- [x] `install` 未传参且 ledger 为 `available` 时，已受管 target 沿用当前 `platform / scope / plugin` scope record 的偏好；没有记录或未受管 target 使用 `default`。
- [x] `install` 未传参且 ledger 为 `degraded` 时，已受管 target 在 native state 写入前拒绝继续，并提示显式传入 `--skill-trigger default|manual|auto`。
- [x] `install` 未传参且 ledger 为 `degraded` 时，未受管新 target 使用 `default`，不能从 degraded ledger 继承旧偏好。
- [x] 显式 `upgrade` 传参时使用 CLI 值。
- [x] 显式 `upgrade` 未传参且 ledger 为 `available` 时，按当前 target scope record 读取偏好；没有字段则使用 `default`。
- [x] 显式 `upgrade` 未传参且 ledger 为 `degraded` 时拒绝继续，要求显式传入 `--skill-trigger`。
- [x] `upgrade --all` 在 prepared ledger 为 `available` 时，按每个已安装 scope record 的 ledger 偏好恢复；缺字段使用 `default`。
- [x] `upgrade --all` 在 prepared ledger 为 `degraded` 时，先暴露 preparation warnings，再拒绝继续。
- [x] resolved options 以 `platform + plugin + scopeKey` 为 key，不允许把某个偏好提升成命令全局值。
- [x] 在进入安装循环前读取 ledger 快照和 ledger state，避免同一命令里前一个 target 的写入污染后一个 target 的解析。
- [x] degraded ledger 下的 resolved entry 标记 `ledgerTrust: 'degraded-explicit'` 或等价状态，供后续跳过 sibling 选举和 conflict warning。
- [x] 改造 `loadPluginTargetsForCommand()` 或新增 command preparation helper，把 `ensureLocalMarketplace()` 的 warnings 带回命令结果。
- [x] command preparation 同时区分当前 runtime target 和 embedded policy source。
- [x] `upgrade --all` 必须先执行 command preparation，再进入 `resolveUpgradeAllPlatforms()` / `listManagedPluginNamesForPlatform()`。
- [x] `resolveUpgradeAllPlatforms()` 和 `listManagedPluginNamesForPlatform()` 接收 prepared ledger 快照，不能绕过 preparation 自行读取旧 ledger。
- [x] CLI 统一 catch 支持 `CommandWarningError`：先去重打印 warnings，再打印最终错误。
- [x] 确保 command preparation 和 adapter 防线重复调用 `ensureLocalMarketplace()` 时，rebuild warning 不会吞掉或重复输出。

### 自动化测试

- [x] 新增或更新 CLI 入口测试，非法 `--skill-trigger` 值在入口层被拒绝。
- [x] 覆盖 `install --skill-trigger manual|auto|default` 能传到 command options。
- [x] 覆盖显式 `upgrade --skill-trigger manual|auto|default` 能传到 command options。
- [x] 覆盖 `upgrade --all --skill-trigger manual` 直接拒绝，而不是被内部 helper 静默忽略。
- [x] 覆盖 available ledger 下重复 `install` 未传偏好会沿用当前 target ledger 偏好。
- [x] 覆盖 available ledger 下重复 `install --skill-trigger default` 与未传参数语义不同。
- [x] 覆盖 available ledger 下 `upgrade plugin-a plugin-b` 分别恢复各自偏好。
- [x] 覆盖 available ledger 下 `upgrade plugin-a --platform both` 能恢复 Codex / Claude 各自不同偏好。
- [x] 覆盖 degraded ledger 下已受管 target 重复 `install` 未传偏好会拒绝。
- [x] 覆盖 degraded ledger 下显式 `upgrade` 未传偏好会拒绝。
- [x] 覆盖 degraded ledger 下未受管新 target 未传偏好仍使用 `default`。
- [x] 覆盖 degraded ledger 下显式传参可以继续进入后续流程，并标记为不可信 sibling 路径。
- [x] 覆盖 degraded ledger 下 `upgrade --all` warning 顺序早于最终 error message。
- [x] 覆盖同一条命令里多 target resolved map 不被前一个 target 的写入污染。
- [x] 运行 `pnpm test:unit`。
- [x] 运行 `pnpm test:integration`。

### 阶段验收

- [x] CLI 入口能解析、校验并传递 `--skill-trigger default|manual|auto`。
- [x] `install`、显式 `upgrade`、`upgrade --all` 都通过 per-target resolved map 表达偏好。
- [x] Available ledger 下可以继承旧偏好；degraded ledger 下不会隐式继承旧偏好。
- [x] 自动 rebuild 产生的 warnings 在成功和失败路径都对用户可见，且不会重复打印。

## 阶段 3：物化、patch、签名与 sibling helper

### 目标

建立 skill trigger 的底层能力：只从 embedded pristine 读取 policy 和默认 skill 文件，把目标平台的 `skills` 子树物化到 `~/.aw`，并提供 status / replay / warning 共用的语义签名和胜者选举。

### 开发 TODO

- [x] 把 `yaml` 加入 `packages/cli/package.json` 的 dependencies。
- [x] 新增 `packages/cli/src/utils/skill-trigger-preferences.ts`。
- [x] 实现 `resolveSkillTriggerPolicies({ embeddedRoot, pluginName })`，只读取 embedded bundle 中的 `.agents-plugin/plugin.json`。
- [x] 确保 policy helper 不接收泛化 `PluginMeta`，避免误用 local catalog manifest。
- [x] 实现 `materializeSkillTriggerPreference({ pluginName, platform, resolvedOptions, embeddedRoot, marketplaceRootOrStagingRoot, env, mode })`。
- [x] materializer 内部不调用 `ensureLocalMarketplace()`，避免 rebuild replay 递归。
- [x] materializer 先从 embedded root 复制目标平台 `skills` 子树到临时 staging。
- [x] `default` 路径只恢复 pristine 子树，不解析 skill 内部结构。
- [x] `manual|auto` 只解析和改写 `allowInstallOverride: true` 且本次确实需要覆盖的 skill。
- [x] 对 `allowInstallOverride: false` 的 skill 保持 pristine，并返回 warning。
- [x] 实现 `strictExplicit` 模式：用户显式 `manual|auto` 且需要改写时，缺文件、缺 frontmatter、YAML 非法、root 结构异常都 fail fast。
- [x] strict error 信息包含 `plugin / platform / skill / filePath`。
- [x] 实现 `bestEffortReplay` 模式：遇到 malformed pristine skill 时跳过该 `plugin/platform` 覆盖，保留 pristine 子树并返回 warning。
- [x] 完成校验后原子替换目标平台 `skills` 子树。
- [x] materializer 返回 applied summary、warnings、`committed` 状态和 rollback handle。
- [x] 实现 `rollbackMaterializedSkillTriggerPreference(handle)`。
- [x] 实现 `patchCodexOpenAiYaml(filePath, preference)`，用 `yaml` 解析并写入 `policy.allow_implicit_invocation`。
- [x] Codex patch 中 `policy` 缺失时可以创建，`policy` 存在但不是 object 时 fail fast。
- [x] 实现 `patchClaudeSkillFrontmatter(filePath, preference)`。
- [x] Claude `manual` 写 `disable-model-invocation: true` 和 `user-invocable: true`。
- [x] Claude `auto` 写 `disable-model-invocation: false`，并继承 pristine 中的 `user-invocable`。
- [x] 实现 `buildSkillTriggerMaterializationSignature({ pluginName, platform, preference, embeddedRoot })`。
- [x] 签名只表达平台消费的触发语义，不依赖 YAML 文本格式、字段顺序或注释。
- [x] 签名纳入 `allowInstallOverride` 覆盖面和 pristine 默认值，允许 `default` 与 `auto` 语义等价。
- [x] 签名 helper 遇到 malformed pristine skill 时返回结构化 `unknown`，不抛错中断调用方。
- [x] 实现 `readCurrentSkillTriggerRuntimeSignature({ pluginName, platform, marketplaceRoot, embeddedRoot })`。
- [x] runtime 签名读取使用 embedded policy 决定覆盖面，不能信任 local manifest。
- [x] 实现 `getNextSkillTriggerWriteOrder({ ledger, pluginName, platform })`。
- [x] 实现 `selectEffectiveSkillTriggerRecord({ ledger, pluginName, platform })`。
- [x] 排序规则固定为 `skillTriggerWriteOrder desc`、`updatedAt desc`、`scopeIdentity asc`。
- [x] 实现 `selectEffectiveSkillTriggerPreference({ ledger, pluginName, platform })`。
- [x] 实现 `collectSkillTriggerSiblingConflictWarnings(...)`。
- [x] conflict warning 比较共享 marketplace 的有效物化语义，不只比较 effective scope identity。
- [x] 任一签名为 `unknown` 时返回 skipped diagnostics，不生成确定性 conflict warning。
- [x] degraded ledger 下 helper 拒绝或返回 skipped，调用方不能用 degraded sibling record 生成 warning。

### 自动化测试

- [x] 新增 `packages/cli/tests/unit/skill-trigger-preferences.test.ts`。
- [x] 覆盖 Codex `manual` 把 `allow_implicit_invocation` 改为 `false`。
- [x] 覆盖 Codex `auto` 把 `allow_implicit_invocation` 改为 `true`。
- [x] 覆盖 Codex `default` 恢复 pristine。
- [x] 覆盖 Claude `manual` / `auto` / `default` 正确改写或保留 frontmatter。
- [x] 覆盖 Claude pristine `user-invocable: false` 时，`manual` 临时写回 `true`，`auto` / `default` 恢复 `false`。
- [x] 覆盖不允许覆盖的 skill 保留 pristine，并返回 warning。
- [x] 覆盖 `default` 面对损坏 `SKILL.md` / `openai.yaml` 时不解析、不 fail fast。
- [x] 覆盖 `allowInstallOverride: false` 的损坏 skill 不阻塞 `manual|auto` 物化。
- [x] 覆盖多个 skill 中损坏的非覆盖 skill 或无关 skill 不阻塞允许覆盖 skill。
- [x] 覆盖允许覆盖的 Codex skill 缺少 `agents/openai.yaml`、YAML 非法、`policy` 非 object 时 strict fail fast。
- [x] 覆盖允许覆盖的 Claude skill 缺少 frontmatter、frontmatter YAML 非法、root 非 object 时 strict fail fast。
- [x] 覆盖错误信息指向具体 platform、skill 和文件路径。
- [x] 覆盖先 `manual` 后 `default` 从 embedded pristine 恢复，不残留上次 patch。
- [x] 覆盖 materialize 提交前失败不改 `~/.aw`。
- [x] 覆盖提交后 rollback 能恢复旧子树。
- [x] 覆盖签名对 YAML 字段顺序、注释和格式变化不敏感。
- [x] 覆盖签名能识别 `default` / `auto` 语义等价和语义差异。
- [x] 覆盖 malformed pristine skill 返回结构化 `unknown`。
- [x] 覆盖 `bestEffortReplay` 遇到 malformed pristine skill 时跳过覆盖、保留 pristine 并返回 warning。
- [x] 覆盖 `strictExplicit` 对同一 malformed fixture fail fast。
- [x] 覆盖 policy、materialize、签名全部只读取 embedded manifest；local manifest 被篡改不影响结果。
- [x] 覆盖 `collectSkillTriggerSiblingConflictWarnings()` 在 effective scope 不变但 runtime 语义变化时返回 warning。
- [x] 覆盖 scope 切换但 runtime 语义等价时不误报。
- [x] 覆盖签名 unknown 时只返回 skipped diagnostics。
- [x] 覆盖 degraded ledger 不会生成确定性 sibling warning。
- [x] 运行 `pnpm test:unit`。

### 阶段验收

- [x] `~/.aw` runtime skill 子树能从 embedded pristine 可重复物化，且 `default` 能干净恢复默认。
- [x] 用户显式 `manual|auto` 的 strict fail fast 精确指向具体文件，维护性路径不会被 malformed skill 阻断。
- [x] Status、replay、upgrade warning 可以共用同一套语义签名和 sibling conflict 判断。
- [x] local manifest 被篡改时，policy、签名和物化仍以 embedded manifest 为准。

## 阶段 4：install、upgrade 与 ledger 写入

### 目标

把阶段 2 的 resolved options 和阶段 3 的 materializer 接进真实安装、升级和 ledger 写入顺序中，保证 native install 前先物化共享 marketplace，失败时能恢复。

### 开发 TODO

- [x] 在 `installTargetsOnPlatforms()` 中，`adapter.installPlugin()` 前读取当前 target 的 `ResolvedInstallOptions`。
- [x] 在 native install 前调用 `materializeSkillTriggerPreference()`。
- [x] 只有 `preferenceSource === 'cli'` 且偏好为 `manual|auto` 时使用 `strictExplicit`。
- [x] 从 ledger 恢复的 `manual|auto`、`upgrade --all` 逐项恢复、隐式 default 使用 `bestEffortReplay` 或 pristine 语义。
- [x] 调用物化前解析 embedded policy source，并和当前 local runtime target 分开传递。
- [x] 物化一旦提交，就把本次操作视为 native state 已写入。
- [x] 如果 `installPlugin()`、`installExtensions()`、tracking 或 ledger 写入失败，先回滚 materialize 快照。
- [x] rollback 失败时按现有 degraded 机制写入 `operation_interrupted_after_native_write`。
- [x] 增加 `marketplaceWritten` / `materializationCommitted` 状态位，纳入统一失败处理。
- [x] `applyClaudeInstallLedger()` / `applyCodexInstallLedger()` 接收当前 target 的 `ResolvedInstallOptions`。
- [x] 写入 scope record 的 `installOptions.skillTriggerPreference`。
- [x] available ledger 写入时设置 scope record 顶层 `skillTriggerWriteOrder = getNextSkillTriggerWriteOrder(...)`。
- [x] degraded ledger 下显式继续执行时，可以记录本次 CLI 偏好作为诊断信息，但不能用 degraded sibling record 推导 effective record。
- [x] 显式 `upgrade` 复用 install 物化和 ledger 写入路径。
- [x] `upgrade --all` 在 prepared ledger 为 available 时按每个已安装 scope record 的偏好逐项恢复。
- [x] `upgrade --all` 中每项升级都使用同一套 materializer、write order 和 warning 判断。
- [x] available ledger 下，install / 显式 upgrade / `upgrade --all` 每次写入 scope record 后，用写入前 runtime 语义、写入后候选 ledger 和计划物化语义生成 sibling conflict warning。
- [x] warning 只包含真正被覆盖且语义不等价的 sibling scope。
- [x] 如果签名 unknown，只输出 skipped diagnostics，不生成确定性 warning，也不让命令失败。

### 自动化测试

- [x] 集成测试覆盖 `aw install git-commit --platform codex --skill-trigger manual` 后 `openai.yaml` 为 `false`。
- [x] 覆盖 `--skill-trigger auto` 后 `openai.yaml` 为 `true`。
- [x] 覆盖未允许覆盖的 fixture skill 传 `manual` 也保持默认并输出 warning。
- [x] 覆盖 local manifest 被手工改成 `allowInstallOverride: false` 或删 entry 时，install 仍按 embedded manifest 覆盖。
- [x] 覆盖 available ledger 下重复 `install` 未传偏好沿用 ledger 中的 `manual`。
- [x] 覆盖先 Codex `manual`，再 `--platform both` 未传偏好时 Codex 保持 `manual`、Claude 使用 `default`。
- [x] 覆盖显式 `install --skill-trigger default` 会重置已有 target 偏好。
- [x] 覆盖 available ledger 下 `upgrade` 未传偏好沿用 ledger。
- [x] 覆盖显式多插件 upgrade 分别沿用各自偏好。
- [x] 覆盖 `upgrade --platform both` 能恢复两端不同偏好。
- [x] 覆盖 `upgrade --all` 对多个插件按 ledger 偏好逐个恢复。
- [x] 覆盖同一 `plugin/platform` 不同 scope 偏好冲突时，最新写入成为共享 marketplace 胜者，并 warning 指出被覆盖 sibling scope。
- [x] 覆盖相同 `updatedAt` 时按 `skillTriggerWriteOrder` 稳定判断胜者。
- [x] 覆盖 effective scope 不变但有效物化语义变化时立刻 warning。
- [x] 覆盖 `default` 与 `auto` 语义等价时不误报 warning。
- [x] 覆盖显式 upgrade 或 `upgrade --all` 因新 bundle 导致语义变化时也返回 sibling conflict warning。
- [x] 覆盖 degraded ledger 下显式 install / upgrade 只按本次 CLI 偏好物化，不调用 sibling 选举，也不返回 degraded sibling conflict warning。
- [x] 覆盖显式 `manual|auto` 遇到 malformed pristine skill 时在 native install 前失败。
- [x] 覆盖物化成功后 `installPlugin()` 失败会恢复旧 `skills` 子树。
- [x] 覆盖物化成功后 `installExtensions()` 失败会恢复旧 `skills` 子树并保持 tracking 回滚。
- [x] 覆盖 rollback 失败时 ledger 标记为 degraded。
- [x] 运行 `pnpm test:integration`。

### 阶段验收

- [x] Install / upgrade 都在 native install 前完成 skill trigger runtime 物化。
- [x] Ledger 能记录本次偏好和稳定写入顺序，available ledger 下 sibling 胜者可预测。
- [x] 失败路径不会留下半完成的 `~/.aw` skill 子树；无法回滚时会进入 degraded ledger。
- [x] Degraded ledger 下显式继续执行不会误信历史 sibling record。

## 阶段 5：uninstall、marketplace rebuild 与 ledger replay

### 目标

把共享 marketplace 的后续维护路径补完整：卸载后重新选举有效偏好，`aw init --force`、stale refresh、bundle fingerprint refresh 能按 available ledger best-effort replay，degraded ledger 安全跳过。

### 开发 TODO

- [x] 实现 `replaySkillTriggerPreferencesFromLedger({ ledger, marketplaceRoot, embeddedRoot, env })`。
- [x] replay 只在 preserved ledger 为 `available` 时执行。
- [x] replay 遍历仍为 `managed: true` 的 scope record。
- [x] 同一 `plugin/platform` 通过 `selectEffectiveSkillTriggerRecord()` 选出共享 marketplace 胜者。
- [x] replay 只物化胜者记录；落选记录不触发额外文件解析。
- [x] replay 只处理 embedded bundle / 当前 catalog 中仍存在的插件。
- [x] replay 遇到 malformed pristine skill 时跳过该 `plugin/platform`，保留 pristine staging 并返回 warning。
- [x] replay 比较旧 runtime 与 staging 新 runtime，必要时返回 sibling conflict warning。
- [x] degraded ledger 下 replay 返回 skipped warning，保留 pristine bundle，不写 staging skill 覆盖。
- [x] 在 `initializeLocalMarketplace()` 中保留旧 `installed.json`。
- [x] 如果旧 `~/.aw` 仍能定位 skill 子树，替换前捕获 available ledger 下各 `plugin/platform` 的旧 runtime 语义。
- [x] 复制 embedded bundle 到 staging 后，在写 `config.json` 前执行 available ledger replay。
- [x] 写入 preserved ledger 和新 config，校验 layout 后原子替换 `~/.aw`。
- [x] degraded ledger rebuild 不把 ledger 洗回 `available`。
- [x] `ensureLocalMarketplace()` 返回 replay / skip / conflict warnings。
- [x] `initCommand()` 输出 `EnsureLocalMarketplaceResult.warnings`。
- [x] `installCommand()`、显式 `upgradeCommand()` 和 `upgrade --all` 的 preparation 阶段输出同一类 warnings。
- [x] 实现 `rematerializeSkillTriggerPreferenceAfterUninstall({ pluginName, platform, ledgerAfterUninstall, embeddedRoot, marketplaceRoot, env })`。
- [x] available ledger 下 uninstall 删除 scope record 后，按删除后的 ledger 重新选举并重物化。
- [x] 没有剩余 managed record 时，从 embedded pristine 恢复目标平台 `skills` 子树。
- [x] degraded ledger 下 uninstall 不做 sibling 重选，只返回 skipped warning。
- [x] historical target 或当前 catalog 缺失插件首版 no-op，保留现有 uninstall 清理能力。
- [x] uninstall 中如果重物化提交后失败，先回滚 marketplace skills 快照。
- [x] 回滚失败或 native state 已写入后失败时，把 ledger 标记为 `operation_interrupted_after_native_write`。
- [x] Codex project scope 卸载也触发本地 marketplace 偏好重选。

### 自动化测试

- [x] 更新 `packages/cli/tests/unit/local-marketplace.test.ts`，available ledger 下 `initializeLocalMarketplace({ force: true })` 重建后按 ledger 重放偏好。
- [x] 覆盖 replay 面对冲突 scope record 时复用 `selectEffectiveSkillTriggerRecord()`。
- [x] 覆盖 replay 只物化胜者，落选记录即使对应 malformed skill 也不让 rebuild 失败。
- [x] 覆盖 `skillTriggerWriteOrder` 大的记录在相同 `updatedAt` 下稳定获胜。
- [x] 覆盖旧 ledger 缺少 write order 且 `updatedAt` 相同时，scope identity 兜底排序稳定。
- [x] 覆盖 config 损坏触发的非 force 修复会重放偏好。
- [x] 覆盖 bundle 指纹变化触发刷新后会重放偏好。
- [x] 覆盖 bundle 变化或 `aw init --force` 导致有效物化语义变化时返回 sibling conflict warning。
- [x] 覆盖 malformed embedded pristine skill 不让 `initializeLocalMarketplace()` 整体失败，并通过 warning 暴露原因。
- [x] 覆盖 degraded ledger 下 force rebuild 跳过 replay、保留 pristine bundle、保留 degraded ledger 并返回 warning。
- [x] 覆盖 degraded ledger 下非 force stale refresh / bundle refresh 同样跳过 replay。
- [x] 覆盖 fresh local marketplace 中 local manifest 被篡改时，replay 仍按 embedded policy 生效。
- [x] 集成测试覆盖 `aw init --force`、stale refresh、bundle 指纹变更刷新后 `~/.aw` skill trigger 与 ledger 匹配。
- [x] 覆盖 degraded ledger 下 `aw init --force`、install preparation、显式 upgrade preparation 跳过 replay 并输出 warning。
- [x] 覆盖 `upgrade --all` 遇到 degraded ledger 时，warning 可见后拒绝继续。
- [x] 覆盖同一命令中 preparation 和 adapter 防线都 ensure 时 warning 不吞、不重复。
- [x] 覆盖卸载最新胜者 scope 后，剩余 scope record 的偏好重新成为有效策略。
- [x] 覆盖卸载最新胜者 scope 后相同 `updatedAt` 的剩余记录仍稳定重选。
- [x] 覆盖卸载最后一个 managed scope 后，目标平台 `skills` 子树恢复 pristine 默认。
- [x] 覆盖 degraded ledger 下 uninstall 跳过 skill trigger re-election，并输出 warning。
- [x] 覆盖卸载已写 native state 后重物化失败，会按 native write 失败语义回滚或标记 degraded。
- [x] 运行 `pnpm test:unit`。
- [x] 运行 `pnpm test:integration`。

### 阶段验收

- [x] `aw init --force`、stale refresh 和 bundle refresh 能在 available ledger 下 best-effort replay 偏好。
- [x] Degraded ledger 下所有 rebuild / replay 路径都保留 pristine bundle，并给出可见 warning。
- [x] 卸载后共享 marketplace 会按剩余 scope 重新选举；无剩余记录时恢复 pristine 默认。
- [x] 维护性 replay 遇到 malformed pristine skill 不阻断命令，只把相关项标成 skipped / unknown。

## 阶段 6：status、runtime 匹配与 drift 输出

### 目标

让 `status` 只读展示当前 scope ledger 偏好、共享 marketplace runtime 文件和候选偏好的语义关系，并把 degraded / stale / malformed 情况解释成 `unknown`。

### 开发 TODO

- [x] 给 `PluginStatusReport` 增加 `installOptions` / `skillTriggerPreference` 或同等字段。
- [x] 增加 `skillTriggerRuntimeMatches?: SkillTriggerPreference[]`。
- [x] 增加 `skillTriggerRuntimeState?: 'matched' | 'mixed' | 'unknown'`。
- [x] 增加 `skillTriggerDrift?: 'yes' | 'no' | 'unknown'`。
- [x] status 输出当前 scope record 的偏好：`skillTriggerLedger=default|manual|auto`。
- [x] status 只有在 `resolveCurrentCatalog()` 返回 `source: 'local'` 且 local marketplace layout / freshness 可信时，才读取 `~/.aw/plugins/<plugin>/<platform>/skills`。
- [x] 当 catalog 回退 embedded、`~/.aw` stale、bundle fingerprint mismatch、layout 不健康时，runtime / drift 输出 `unknown`，且不修复本地 marketplace。
- [x] status 从 embedded pristine bundle 计算 `default`、`manual`、`auto` 三种候选签名。
- [x] status 用 embedded manifest policy 和 pristine skill 文件计算候选，不能信任 local manifest。
- [x] 当前 runtime 只匹配一个候选时输出 `skillTriggerRuntime=<preference>`。
- [x] 当前 runtime 匹配多个候选时输出 `skillTriggerRuntime=matches(default,auto)` 这类候选集合。
- [x] 当前 runtime 无法对应单一偏好或各 skill 呈现不同候选时输出 `skillTriggerRuntime=mixed`。
- [x] 文件缺失、runtime 解析失败、插件不在当前 catalog、catalog 不可信或 ledger degraded 时输出 `skillTriggerRuntime=unknown` / `skillTriggerDrift=unknown`。
- [x] drift 判断直接比较当前文件语义是否等价于当前 scope ledger 偏好的期望物化结果。
- [x] 如果 local `.agents-plugin/plugin.json` 与 embedded manifest 的 `skillTriggers` 不一致，可以额外提示 local manifest drift / tamper evidence。
- [x] local manifest drift 提示不能改变候选签名和 drift 判定。
- [x] status 保持只读，不调用 init、ensure、materialize 或 replay。

### 自动化测试

- [x] 集成测试覆盖 status 展示 `skillTriggerLedger` 和 runtime 匹配结果。
- [x] 覆盖 ledger 期望和 marketplace 当前文件不一致时输出 drift warning。
- [x] 覆盖 `default` 和 `auto` 语义相同的 fixture 输出 `matches(default,auto)`，ledger 为其中任一值时不误报 drift。
- [x] 覆盖多 skill 默认值不一致的 fixture 能正确比对候选集合。
- [x] 覆盖手工改成 mixed state 后输出 `mixed`，并基于当前 scope ledger 期望报告 drift。
- [x] 覆盖 `~/.aw` stale 时 status 只读回退 embedded catalog，runtime / drift 输出 `unknown`。
- [x] 覆盖 `~/.aw` layout 不健康但 config 新鲜时，status 回退 embedded catalog且不改写本地文件。
- [x] 覆盖 degraded ledger 下 status 输出 skill trigger drift 为 `unknown`。
- [x] 覆盖可信 local marketplace 中目标平台 skill 文件被手工删除时，status 输出 `unknown` 且不崩溃。
- [x] 覆盖 runtime `SKILL.md` frontmatter 或 `openai.yaml` 不可解析时输出 `unknown`。
- [x] 覆盖 embedded pristine skill 不可解析时，候选签名输出 `unknown`，status 不崩溃。
- [x] 覆盖 current catalog 已缺失插件的 historical fallback，skill trigger runtime / drift 直接输出 `unknown`。
- [x] 覆盖 local manifest 被篡改时，status 候选签名和 drift 判定仍来自 embedded manifest。
- [x] 运行 `pnpm test:integration`。

### 阶段验收

- [x] Status 不会为了 skill trigger 比对修复、物化或改写 `~/.aw`。
- [x] Status 能展示 ledger 偏好、runtime 候选匹配集合和 drift 状态。
- [x] Stale、layout unhealthy、degraded、malformed、historical fallback 等不确定场景都输出 `unknown`，不误报确定 drift。
- [x] local manifest drift 最多作为篡改证据提示，不会污染 policy 真值。

## 阶段 7：文档、作者工具与示例

### 目标

把用户使用方式、插件作者 contract、脚手架默认行为和作者侧校验脚本一起收口，避免实现完成后文档仍停留在平台原生字段层面。

### 开发 TODO

- [x] 更新 `docs/plugin-installation.md`，说明 `--skill-trigger default|manual|auto` 的语义。
- [x] 在安装文档中说明重复 `install` 未传参数会在 available ledger 下沿用旧偏好，而 `--skill-trigger default` 才是显式重置。
- [x] 在安装文档中说明共享 marketplace 边界：同一用户同名插件某平台只有一份当前生效策略。
- [x] 在安装文档中说明 degraded ledger 下必须显式传参的路径。
- [x] 更新 `docs/plugin-authoring.md`，说明 `.agents-plugin/plugin.json` 的 `skillTriggers` contract。
- [x] 在作者文档中说明默认触发策略仍由 `SKILL.md` / `openai.yaml` 定义。
- [x] 在作者文档中说明 `allowInstallOverride` 只允许安装时覆盖，不代表默认策略。
- [x] 更新 `.agents/skills/create-agent-workflows-plugin/references/skills-and-triggers.md`。
- [x] 更新 `.agents/skills/create-agent-workflows-plugin/references/plugin-manifest-spec.md`。
- [x] 更新 `.agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js`。
- [x] 新建 skill 默认可先不生成 `skillTriggers`，保持保守不可覆盖。
- [x] 本阶段未给脚手架增加生成 `skillTriggers` 的参数，因此无需新增参数文案。
- [x] 更新 `.agents/skills/create-agent-workflows-plugin/scripts/validate_plugin.js` 校验 `skillTriggers`。
- [x] 作者校验脚本继续检查 `openai.yaml.policy.allow_implicit_invocation` 和 Claude frontmatter 字段。
- [x] 作者校验脚本校验 `skillTriggers` key 对应 source skill 子目录。
- [x] 更新相关示例 fixture，让至少一个 skill 声明 `allowInstallOverride: true` 供测试使用。

### 自动化测试

- [x] 更新或新增 `authoring-tools.test.ts`，覆盖 `validate_plugin.js` 接受合法 `skillTriggers`。
- [x] 覆盖 `validate_plugin.js` 拒绝不存在 skill key。
- [x] 覆盖 `validate_plugin.js` 拒绝非法 `allowInstallOverride` 类型。
- [x] 覆盖作者文档示例能通过脚本校验。
- [x] 本阶段未让 `init_plugin.js` 支持生成 `skillTriggers`，无需覆盖生成结果。
- [x] 如果默认不生成 `skillTriggers`，覆盖脚手架生成的新插件保持保守不可覆盖。
- [x] 运行 `pnpm test:unit`。

### 阶段验收

- [x] 用户文档能解释三种偏好、重复安装、升级、degraded ledger 和共享 marketplace 边界。
- [x] 作者文档能解释 `skillTriggers` 与平台原生默认字段的分工。
- [x] 作者工具能校验新 contract，且脚手架默认行为与“保守不可覆盖”一致。
- [x] 文档示例、脚本校验和测试 fixture 使用同一套字段，不出现过期写法。

## 阶段 8：端到端回归、CLI 入口与 smoke

### 目标

最后做横向收口，确认前面分阶段能力在真实命令入口、build-free integration、build smoke 和真实 dist 入口中一起工作。

### 开发 TODO

- [x] 整理 `packages/cli/tests/integration/cli.test.ts` 中的 skill trigger 主链路用例，避免和单元测试重复过多实现细节。
- [x] 新增 `packages/cli/tests/integration/cli-entry.test.ts` 或等价入口测试。
- [x] 入口测试直接 import `runCli()` / `buildProgram()`，注入 `cwd/env/stdout/stderr`。
- [x] 入口测试继续使用 `tests/helpers/embedded-root.ts` 和 `setEmbeddedPluginsRootOverrideForTests()`，保持 build-free。
- [x] 不在常规 integration 中 `execFile('node', ['packages/cli/dist/index.js', ...])`。
- [x] smoke 层验证真实 `dist/index.js` 可启动并使用内置 `plugins-dist`。
- [x] 如涉及依赖变更，确认 lockfile 与 package manifest 一致。

### 自动化测试

- [x] 入口测试覆盖非法 `--skill-trigger` 值 exit code 非 0，stderr 包含可读错误。
- [x] 入口测试覆盖 `install --skill-trigger manual|auto|default` 行为与 command-level 测试一致。
- [x] 入口测试覆盖显式 `upgrade --skill-trigger manual|auto|default` 行为与 command-level 测试一致。
- [x] 入口测试覆盖 `upgrade --all --skill-trigger manual` 直接拒绝。
- [x] 入口测试覆盖 degraded ledger 下 `upgrade --all` 先打印 replay-skip warning，再以非零退出拒绝。
- [x] 入口测试覆盖 degraded ledger 下显式 `upgrade plugin` 未传 `--skill-trigger` 时 warning 早于最终 error。
- [x] 入口测试覆盖 `aw init --force`、install preparation、explicit upgrade preparation 的 warnings 不吞、不重复。
- [x] Integration 覆盖 install / upgrade / uninstall / status / rebuild / degraded 主路径组合。
- [x] Integration 覆盖 malformed skill 在 strict explicit 与 best-effort replay 下的不同行为。
- [x] Integration 覆盖 sibling conflict warning、等价语义不误报、unknown signature skipped diagnostics。
- [x] 运行 `pnpm test:unit`。
- [x] 运行 `pnpm test:integration`。
- [x] 运行 `pnpm test`。
- [x] 运行 `pnpm build`。
- [x] 运行 `pnpm test:smoke:build`。
- [x] 运行真实 dist smoke，例如 `node packages/cli/dist/index.js --help`。
- [x] 运行最小真实 dist `aw init --force` / catalog 读取 smoke。

### 阶段验收

- [x] Build-free unit / integration 覆盖源码入口、命令编排和核心 helper。
- [x] Smoke 只验证真实 build 产物和 `plugins-dist` 包装，不替代常规 integration。
- [x] 所有新增 warnings 在成功、失败、入口和 command-level 测试中顺序稳定。
- [x] `pnpm test:unit`、`pnpm test:integration`、`pnpm build`、`pnpm test:smoke:build` 全部通过。
