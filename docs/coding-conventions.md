# Coding Conventions

## Style

TypeScript + ESM，2 空格缩进，NodeNext 导入风格，本地模块导入写 `.js` 扩展名。文件名 `kebab-case`，导出函数/变量/类型 `camelCase` / `PascalCase`。仓库无独立 ESLint / Prettier，质量依赖 `tsc` 严格模式和测试。

## Boundary Rules

- 平台差异收口到 `adapters`，不要在命令层直接写平台判断
- Bundle 生成与 repo-managed 文件生成收口到 `generators`
- 涉及 plugin manifest、marketplace metadata 或 `buildConfig` 改动时，同时检查 `types.ts`、`utils/manifest.ts`、`generators/local-plugin.ts`、`utils/bundle-layout.ts`、`scripts/bundle-plugins.ts` 的 contract 是否仍一致
- 涉及动态 artifact manifest 或 renderer contract 时，同时检查 `types.ts`、`utils/manifest.ts`、`utils/artifact-renderer.ts`、`utils/artifact-plan.ts`、`utils/artifact-refresh.ts`、`utils/bundle-layout.ts`、`scripts/bundle-plugins.ts` 和 Codex adapter apply 路径
- 涉及 install/upgrade 的 skill 触发偏好时，同时检查 `utils/skill-trigger-preferences.ts`、`commands/common.ts`、`commands/install.ts`、`commands/upgrade.ts` 和 ledger/status 输出
- 涉及 Codex project scope 时，先判断目标是 native runtime 还是 repo-managed artifact；不要在项目级路径里隐式调用 native marketplace add，也不要把用户级 `[plugins]` 当作 project installed evidence
- 涉及动态 artifact 时，`artifacts.targets` 是 renderer 执行前的能力真值；installability、discovery、status current catalog、project preflight 和 ledger capability snapshot 必须共用同一套合并逻辑，不能从 renderer 输出倒推安装能力
- `ArtifactPlan` 是插件 renderer 和 AW apply 之间的唯一数据合同。renderer 只能返回 plan，不能直接写 AW 受管文件；plan 校验必须在任何 Codex config、role layer、tracking 或 ledger 写入前完成
- target runtime 负责把已校验 plan 应用到具体平台文件。首版动态 target 写盘收口在 Codex adapter / Codex config helper，不把 `.codex/config.toml`、`.codex/agents/*.toml` 或 tracking 写入散落到 lifecycle、renderer 或命令分支里
- config 写命令先提交 config store，再按 tracking 的 `refreshKeys` 触发动态 artifact refresh；refresh 失败不能回滚 config store，但必须更新 artifact refresh 诊断。user scope 和 project scope 是独立刷新事务，不做跨 scope 回滚
- 涉及公共 slash command 时，只维护源码 `slashCommands`；Claude `commands` 和 Codex manual-only skill 都应从 `utils/slash-commands.ts` / `generators/local-plugin.ts` 生成
- 涉及 hooks 时，优先使用 `utils/hooks-contract.ts` 的 normalize/render/validate helper，不在 adapter 或 generator 中复制事件名映射
- 不手工维护 runtime bundle 内的生成清单，不把命令阶段产物回写到仓库 `plugins/` 源码目录
- 生成文件统一以 `aw-` 前缀标识（`GENERATED_FILE_PREFIX`）

## Key Types（`packages/cli/src/types.ts`）

- **`GeneratedArtifact`** — 表示 CLI 生成的单个产物（`kind`: instruction/permission/hook/agent/skill/mcpServer，`platform`: claude/codex，`path`）。`path` 必须是绝对文件系统路径；`skill` 和 `mcpServer` 必须带 `artifactKey`，分别表示 skill 名和 MCP server 原始 key，可附加到 `Error` 对象用于安装失败后的自动回滚
- **`ArtifactPlan` / `ArtifactPlanArtifact`** — 动态 artifact renderer 的 stdout JSON contract。顶层 `version` 固定为 `1`；artifact 的 `id + target` 在插件内稳定唯一，`state` 首版只支持 `present` / `disabled`，`refreshKeys` 必须完整匹配 manifest 声明。`disabled` 可以没有 content，但要保留 refresh keys 和可诊断的 `disabledReason`
- **`PluginArtifactTargetDefinition`** — manifest 中 `artifacts.targets[]` 的静态能力声明。它决定动态 artifact 是否可安装、是否需要 Codex project config preflight、project capability snapshot 写入什么 kind，以及 `codex.agentRole` 的静态 `roleKey`
- **`TrackingManifest`**（写入 `.agent-workflows-manifest.json`）— 版本化记录每个插件的生成产物清单，供 uninstall/upgrade 做精确清理
- **`InstalledLedger`**（写入 `~/.aw/installed.json`）— 区分 Claude / Codex、user / project scope 的安装状态账本，包含 capability snapshot 和 `LedgerState`（available / degraded）
- **`ResolvedInstallOptions`** — install/upgrade 阶段已经解析好的运行参数，携带 `skillTriggerApplicability`、必要时的 `skillTriggerPreference`、来源（cli/ledger/default）和 ledger 信任状态。`none` / `fixed` 不能伪造成 default 偏好，只有 `overridable` 需要可恢复的 install options
- **`CatalogCompatibility`** — `'current' | 'missing' | 'capabilityChanged'`，判定 plugin 是否需要重新安装
- **`ScopeInitializedState`** — `'yes' | 'no' | 'unknown'`，表示当前 scope 是否能被 ledger、tracking 或平台 fallback 证明为已初始化
- **`HookEvent`** — `'before_tool' | 'after_tool' | 'session_start'`；公共 hook 不包含平台原生事件全集，也不再包含 `session_stop`
- **Hook 类型边界**：`HookDefinition` 表示公共 hooks；`NativeHookDefinition` / `NativeHooksByPlatform` 表示 `extensions.nativeHooks.<agent>`；`RenderedHookGroup` 表示最终 artifact group，`matcher` 可选；`TrackedHookGroupIdentity` 是 tracking/status/drift 使用的 canonical identity，不能和 rendered artifact 类型混用；`CodexSharedHookGroup` 保留 `.codex/hooks.json` 原始 group，用于无损保留外部配置
- **Artifact 类型边界**：manifest target、renderer plan、validated plan、target apply 输出和 tracking record 不要混用。plan 内部 `kind = "codexRole"` 只表示动态 role artifact；Codex project capability snapshot 应写 `projectManagedKind = "agent"`，不要把内部 kind 泄漏出去
- **`RepoManagedSessionStateReport`** — status 输出里用于说明 repo-managed instructions/rules/hooks/agents/skills/MCP 当前是否可见，以及是否被 trust、external layer、missing/drift/orphan/unknown 状态影响。summary 中 `not_applicable` 表示当前 manifest / historical evidence 没声明该 kind，`absent` 只表示声明或期望存在但当前 scope 没有受管项
- **`SkippedUpgradeTarget`** — `upgrade --all` target-level skipped 结果，包含稳定 `code`。部分成功部分 skipped 时 CLI exit code 仍为 `0`；全部 skipped 且无成功升级时为 `1`
- **Extensions 类型**：`InstructionDefinition`、`PermissionDefinition`、`HookDefinition`、`NativeHookDefinition`、`AgentDefinition`
