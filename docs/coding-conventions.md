# Coding Conventions

## Style

TypeScript + ESM，2 空格缩进，NodeNext 导入风格，本地模块导入写 `.js` 扩展名。文件名 `kebab-case`，导出函数/变量/类型 `camelCase` / `PascalCase`。仓库无独立 ESLint / Prettier，质量依赖 `tsc` 严格模式和测试。

## Boundary Rules

- 平台差异收口到 `adapters`，不要在命令层直接写平台判断
- Bundle 生成与 repo-managed 文件生成收口到 `generators`
- 涉及 plugin manifest、marketplace metadata 或 `buildConfig` 改动时，同时检查 `types.ts`、`utils/manifest.ts`、`generators/local-plugin.ts`、`utils/bundle-layout.ts`、`scripts/bundle-plugins.ts` 的 contract 是否仍一致
- 涉及 install/upgrade 的 skill 触发偏好时，同时检查 `utils/skill-trigger-preferences.ts`、`commands/common.ts`、`commands/install.ts`、`commands/upgrade.ts` 和 ledger/status 输出
- 涉及 Codex project scope 时，先判断目标是 native runtime 还是 repo-managed artifact；不要在项目级路径里隐式调用 native marketplace add，也不要把用户级 `[plugins]` 当作 project installed evidence
- 涉及公共 slash command 时，只维护源码 `slashCommands`，不要恢复旧 `commands` 入口；Claude `commands` 和 Codex manual-only skill 都应从 `utils/slash-commands.ts` / `generators/local-plugin.ts` 生成
- 涉及 hooks 时，优先使用 `utils/hooks-contract.ts` 的 normalize/render/validate helper，不在 adapter 或 generator 中复制事件名映射
- 不手工维护 runtime bundle 内的生成清单，不把命令阶段产物回写到仓库 `plugins/` 源码目录
- 生成文件统一以 `aw-` 前缀标识（`GENERATED_FILE_PREFIX`）

## Key Types（`packages/cli/src/types.ts`）

- **`GeneratedArtifact`** — 表示 CLI 生成的单个产物（`kind`: instruction/permission/hook/agent/skill/mcpServer，`platform`: claude/codex，`path`）。`path` 必须是绝对文件系统路径；`skill` 和 `mcpServer` 必须带 `artifactKey`，分别表示 skill 名和 MCP server 原始 key，可附加到 `Error` 对象用于安装失败后的自动回滚
- **`TrackingManifest`**（写入 `.agent-workflows-manifest.json`）— 版本化记录每个插件的生成产物清单，供 uninstall/upgrade 做精确清理
- **`InstalledLedger`**（写入 `~/.aw/installed.json`）— 区分 Claude / Codex、user / project scope 的安装状态账本，包含 capability snapshot 和 `LedgerState`（available / degraded）
- **`ResolvedInstallOptions`** — install/upgrade 阶段已经解析好的运行参数，携带 `skillTriggerApplicability`、必要时的 `skillTriggerPreference`、来源（cli/ledger/default）和 ledger 信任状态。`none` / `fixed` 不能伪造成 default 偏好，只有 `overridable` 需要可恢复的 install options
- **`CatalogCompatibility`** — `'current' | 'missing' | 'capabilityChanged'`，判定 plugin 是否需要重新安装
- **`ScopeInitializedState`** — `'yes' | 'no' | 'unknown'`，表示当前 scope 是否能被 ledger、tracking 或平台 fallback 证明为已初始化
- **`HookEvent`** — `'before_tool' | 'after_tool' | 'session_start'`；公共 hook 不包含平台原生事件全集，也不再包含 `session_stop`
- **Hook 类型边界**：`HookDefinition` 表示公共 hooks；`NativeHookDefinition` / `NativeHooksByPlatform` 表示 `extensions.nativeHooks.<agent>`；`RenderedHookGroup` 表示最终 artifact group，`matcher` 可选；`TrackedHookGroupIdentity` 是 tracking/status/drift 使用的 canonical identity，不能和 rendered artifact 类型混用；`CodexSharedHookGroup` 保留 `.codex/hooks.json` 原始 group，用于无损保留外部配置
- **`RepoManagedSessionStateReport`** — status 输出里用于说明 repo-managed instructions/rules/hooks/agents/skills/MCP 当前是否可见，以及是否被 trust、external layer、missing/drift/orphan/unknown 状态影响。summary 中 `not_applicable` 表示当前 manifest / historical evidence 没声明该 kind，`absent` 只表示声明或期望存在但当前 scope 没有受管项
- **`SkippedUpgradeTarget`** — `upgrade --all` target-level skipped 结果，包含稳定 `code`。部分成功部分 skipped 时 CLI exit code 仍为 `0`；全部 skipped 且无成功升级时为 `1`
- **Extensions 类型**：`InstructionDefinition`、`PermissionDefinition`、`HookDefinition`、`NativeHookDefinition`、`AgentDefinition`
