# Coding Conventions

## Style

TypeScript + ESM，2 空格缩进，NodeNext 导入风格，本地模块导入写 `.js` 扩展名。文件名 `kebab-case`，导出函数/变量/类型 `camelCase` / `PascalCase`。仓库无独立 ESLint / Prettier，质量依赖 `tsc` 严格模式和测试。

## Boundary Rules

- 平台差异收口到 `adapters`，不要在命令层直接写平台判断
- Bundle 生成与 repo-managed 文件生成收口到 `generators`
- 涉及 plugin manifest、marketplace metadata 或 `buildConfig` 改动时，同时检查 `types.ts`、`utils/manifest.ts`、`generators/local-plugin.ts`、`utils/bundle-layout.ts`、`scripts/bundle-plugins.ts` 的 contract 是否仍一致
- 涉及动态 artifact manifest 或 renderer contract 时，同时检查 `types.ts`、`utils/manifest.ts`、`utils/artifact-renderer.ts`、`utils/artifact-plan.ts`、`utils/artifact-sources.ts`、`utils/artifact-refresh.ts`、`utils/bundle-layout.ts`、`scripts/bundle-plugins.ts` 和 Claude/Codex adapter apply 路径
- 涉及 `codex.skill` / `claude.skill`、静态或动态 Skill 文件树或平台 artifact 写盘时，同时检查 `utils/dynamic-skill-tree.ts`、`utils/codex-skill-staging.ts`、`utils/native-skill-materialization.ts`、`adapters/codex.ts`、`adapters/claude.ts`、`utils/generated-artifacts.ts`、install-state facade、project artifact identity、dynamic diagnostic cache、status/uninstall/cleanup/reinstall 以及 `.agents/skills/create-agent-workflows-plugin/` 作者工具
- 涉及 Skill 调用行为时，只读写平台原生元数据：Codex 使用 `agents/openai.yaml` 的 `policy.allow_implicit_invocation`，Claude 使用 `SKILL.md` frontmatter 的 `disable-model-invocation` 和 `user-invocable`。静态复制、动态文件树合并、安装、升级、刷新和 eval materialization 都必须校验并保留最终文件中的值，不能增加 manifest、CLI、AW 配置或状态覆盖层
- 涉及 Codex project scope 时，先判断目标是 native runtime 还是 repo-managed artifact；不要在项目级路径里隐式调用 native marketplace add，也不要把用户级 `[plugins]` 当作 project installed evidence
- 涉及动态 artifact 时，`artifacts.targets` 是 renderer 执行前的能力真值；installability、discovery、status current catalog、project preflight、install record v2 和 project artifact shared identity 必须共用同一套合并逻辑，不能从 renderer 输出倒推安装能力
- `ArtifactPlan` 是插件 renderer 和 AW apply 之间的唯一数据合同。renderer 只能返回 plan，不能直接写 AW 受管文件；V2 plan 和最终合并文件树的校验必须在任何 Claude/Codex Skill runtime、Codex config、role layer、install record v2 或 project artifact shared identity 写入前完成
- target runtime 负责把已校验 plan 应用到具体平台文件。动态 target 写盘收口在 Claude/Codex adapter、Codex config 和动态 Skill tree helper，不把 `.claude/skills/**`、`.agents/skills/**`、Codex user runtime skill、`.codex/config.toml`、`.codex/agents/*.toml`、project artifact shared identity 或 dynamic diagnostic cache 写入散落到 lifecycle、renderer 或命令分支里
- config 写命令先提交 config store，再按 install record v2 中的 `refreshKeys` 触发动态 artifact refresh；refresh 失败不能回滚 config store，但必须更新 dynamic diagnostic cache。user scope 和 project scope 是独立刷新事务，不做跨 scope 回滚
- 涉及公共 slash command 时，只维护源码 `slashCommands`；Claude `commands` 和 Codex manual-only skill 都应从 `utils/slash-commands.ts` / `generators/local-plugin.ts` 生成
- 涉及 hooks 时，优先使用 `utils/hooks-contract.ts` 的 normalize/render/validate helper，不在 adapter 或 generator 中复制事件名映射
- 不手工维护 runtime bundle 内的生成清单，不把命令阶段产物回写到仓库 `plugins/` 源码目录
- 生成文件统一以 `aw-` 前缀标识（`GENERATED_FILE_PREFIX`）

## Key Types（`packages/cli/src/types.ts`）

- **`GeneratedArtifact`** — 表示 CLI 生成的单个产物（`kind`: instruction/permission/hook/agent/skill/mcpServer，`platform`: claude/codex，`path`）。`path` 必须是绝对文件系统路径；`skill` 和 `mcpServer` 必须带 `artifactKey`，分别表示 skill 名和 MCP server 原始 key，可附加到 `Error` 对象用于安装失败后的自动回滚
- **`ArtifactPlan` / `ArtifactPlanArtifact`** — 动态 artifact renderer 的 stdout JSON contract。顶层 `version` 固定为 `2`；artifact 的 `id + target` 在插件内稳定唯一，`state` 支持 `present` / `disabled`，`refreshKeys` 必须完整匹配 manifest 声明。动态 Skill 的 `content.files` 只接受安全 POSIX 相对路径到 UTF-8 字符串的映射；`disabled` 可以没有 content，但要保留 refresh keys 和可诊断的 `disabledReason`
- **`PluginArtifactTargetDefinition`** — manifest 中 `artifacts.targets[]` 的静态能力声明。它决定动态 artifact 是否可安装、是否需要 Codex project config preflight、install record v2 写入什么 artifact kind，以及 `codex.skill` / `claude.skill` 的静态 `skillKey`、有序 `sourceDirs` 和 `codex.agentRole` 的静态 `roleKey`。同一 platform/scope/skillKey 只能有一个动态 owner
- **install-state facade** — install/status/upgrade/remove 读取当前安装状态的唯一入口。facade 负责合并 install record v2、project artifact shared identity、dependency index、native transaction marker、dynamic diagnostic cache 和 legacy evidence；调用方不能把某个底层文件当作安装真值。用户可见顶层状态只允许 `installed`、`notInstalled`、`cleanupRequired` 和 `external`
- **install record v2** — 当前插件安装记录，保存 scope、platform、artifact target 和 refresh keys。它是 install-state facade 的主输入，不直接承担诊断缓存、依赖索引、native transaction 或 Skill 调用元数据语义
- **project artifact shared identity** — project scope repo-managed artifact 的共享身份记录，用来让 status、refresh、upgrade 和 remove 稳定识别同一份项目产物；不要用 renderer plan kind、文件路径猜测或 legacy tracking record 替代
- **dynamic diagnostic cache** — 保存动态 artifact 最近一次 refresh/apply 的诊断结果。它可以解释 status 中的 current/stale/error 状态，但不是安装存在性的真值，也不能驱动 uninstall 精确清理
- **dependency index** — 记录插件之间的安装依赖和共享 artifact 关系，供 remove/upgrade 规划使用；不要把依赖判断散落到 command 分支
- **native transaction marker** — 标记平台原生安装事务的 pending/committed/failed 进度，供失败恢复和回滚判断使用；它不是用户可见状态的主来源，只能进入 diagnostics、cleanup 范围或 command blocker
- **legacy evidence** — `InstalledLedger`、旧 `installed.json`、`LedgerState`、`TrackingManifest` / tracking manifest、legacy capability snapshot 和 install snapshot 只能作为兼容迁移、回归测试或历史证据输入，经 install-state facade 解释后使用；不要把它们当作当前安装真值、current catalog 或用户可见排障主入口
- **Skill 原生调用元数据** — 平台文件是唯一真值。Codex 的 `policy.allow_implicit_invocation` 必须显式为 boolean；Claude 的 `disable-model-invocation` 和 `user-invocable` 如有声明必须为 boolean。AW 只校验并保留，不把这些值投影到 config、receipt、status 或 install record
- **`CatalogCompatibility`** — `'current' | 'missing' | 'capabilityChanged'`，判定 plugin 是否需要重新安装
- **`ScopeInitializedState`** — `'yes' | 'no' | 'unknown'`，表示当前 scope 是否能被 install-state facade、平台 fallback 或 legacy evidence 证明为已初始化
- **`HookEvent`** — `'before_tool' | 'after_tool' | 'session_start'`；公共 hook 不包含平台原生事件全集，也不再包含 `session_stop`
- **Hook 类型边界**：`HookDefinition` 表示公共 hooks；`NativeHookDefinition` / `NativeHooksByPlatform` 表示 `extensions.nativeHooks.<platform>`；`RenderedHookGroup` 表示最终 artifact group，`matcher` 可选；`TrackedHookGroupIdentity` 是 status/drift 使用的 canonical identity，不能和 rendered artifact 类型混用；`CodexSharedHookGroup` 保留 `.codex/hooks.json` 原始 group，用于无损保留外部配置
- **Artifact 类型边界**：manifest target、renderer plan、validated plan、target apply 输出、install record v2 和 project artifact shared identity 不要混用。`codex.skill` 使用 `skillKey` / `artifactKey` 识别 skill 目录；plan 内部 `kind = "codexRole"` 只表示动态 role artifact；Codex project artifact identity 应写 `projectManagedKind = "agent"`，不要把内部 kind 泄漏出去
- **`RepoManagedSessionStateReport`** — status 输出里用于说明 repo-managed instructions/rules/hooks/agents/skills/MCP 当前是否可见，以及是否被 trust、external layer、missing/drift/orphan/unknown 状态影响。summary 中 `not_applicable` 表示当前 manifest / historical evidence 没声明该 kind，`absent` 只表示声明或期望存在但当前 scope 没有受管项
- **`SkippedUpgradeTarget`** — `upgrade --all` target-level skipped 结果，包含稳定 `code`。部分成功部分 skipped 时 CLI exit code 仍为 `0`；全部 skipped 且无成功升级时为 `1`
- **Extensions 类型**：`InstructionDefinition`、`PermissionDefinition`、`HookDefinition`、`NativeHookDefinition`、`AgentDefinition`
