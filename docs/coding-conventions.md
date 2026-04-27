# Coding Conventions

## Style

TypeScript + ESM，2 空格缩进，NodeNext 导入风格，本地模块导入写 `.js` 扩展名。文件名 `kebab-case`，导出函数/变量/类型 `camelCase` / `PascalCase`。仓库无独立 ESLint / Prettier，质量依赖 `tsc` 严格模式和测试。

## Boundary Rules

- 平台差异收口到 `adapters`，不要在命令层直接写平台判断
- Bundle 生成与 repo-managed 文件生成收口到 `generators`
- 涉及 plugin manifest、marketplace metadata 或 `buildConfig` 改动时，同时检查 `types.ts`、`utils/manifest.ts`、`generators/local-plugin.ts`、`scripts/bundle-plugins.ts` 的 contract 是否仍一致
- 不手工维护 runtime bundle 内的生成清单，不把命令阶段产物回写到仓库 `plugins/` 源码目录
- 生成文件统一以 `aw-` 前缀标识（`GENERATED_FILE_PREFIX`）

## Key Types（`packages/cli/src/types.ts`）

- **`GeneratedArtifact`** — 表示 CLI 生成的单个产物（`kind`: instruction/permission/hook/agent，`platform`: claude/codex，`path`），可附加到 `Error` 对象用于安装失败后的自动回滚
- **`TrackingManifest`**（写入 `.agent-workflows-manifest.json`）— 版本化记录每个插件的生成产物清单，供 uninstall/upgrade 做精确清理
- **`InstalledLedger`**（写入 `~/.aw/installed.json`）— 区分 Claude / Codex、user / project scope 的安装状态账本，包含 capability snapshot 和 `LedgerState`（available / degraded）
- **`CatalogCompatibility`** — `'current' | 'missing' | 'capabilityChanged'`，判定 plugin 是否需要重新安装
- **`HookEvent`** — `'before_tool' | 'after_tool' | 'session_start'`；公共 hook 不包含平台原生事件全集，也不再包含 `session_stop`
- **Hook 类型边界**：`HookDefinition` 表示公共 hooks；`NativeHookDefinition` / `NativeHooksByPlatform` 表示 `extensions.nativeHooks.<agent>`；`RenderedHookGroup` 表示最终 artifact group，`matcher` 可选；`TrackedHookGroupIdentity` 是 tracking/status/drift 使用的 canonical identity，不能和 rendered artifact 类型混用；`CodexSharedHookGroup` 保留 `.codex/hooks.json` 原始 group，用于无损保留外部配置
- **Extensions 类型**：`InstructionDefinition`、`PermissionDefinition`、`HookDefinition`、`NativeHookDefinition`、`AgentDefinition`
