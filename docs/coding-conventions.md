# Coding Conventions

## Style

- TypeScript strict mode；ESM import 使用 `.js` 后缀。
- 2 空格缩进，单引号，无分号省略。
- public function 和复杂边界使用明确类型。
- 优先小函数和已有 helper，不为单次使用创建抽象。

## Architecture Boundaries

- 五个写命令只进入 `write-commands.ts`、`rebuild-command.ts` 和 `rebuild-operations.ts`。
- 平台能力转换集中在 `rebuild-integration.ts`。
- 归属检查和删除集中在 `utils/ownership.ts`。
- status 只读取 current catalog、live owner 和平台组件。
- lifecycle active store 只保存下一次脚本执行所需输入，不参与 status。
- config store 只由 config API 写入或删除。
- strict catalog cache 与 active marketplace 是不同层；active marketplace 重建必须保留 cache。

不要在 command 分支新增另一套安装状态投影、依赖图或平台输出记录。

## Key Types

- `PluginManifestSource`：源码 manifest。顶层 `dependencies` unsupported。
- `PluginMeta`：manifest 加 bundle root 和 manifest path。
- `CatalogResolution`：current catalog identity、selector 和 strict cache 证据。
- `OwnedComponent`：可检查、可删除的平台组件。
- `OwnerIdentity`：owner、plugin、artifactKey、platform、scope。
- `DesiredTarget`：rebuild 前计算出的目标组件与 artifact。
- `RebuildResult`：五个写命令的统一结果。
- `StatusJsonPayload`：status v3；target state 为 `present | absent | partial | error`。
- `ArtifactPlan`：renderer 和 AW apply 之间的 v2 数据合同。

## Artifact Rules

- renderer 只能返回 plan，不能写平台文件。
- 写入前验证 scope、path boundary、target identity 和最终 Skill tree。
- Codex/Claude Skill 原生调用 metadata 来自最终文件树，AW 只校验和保留。
- MCP、hooks、permissions、roles、instructions、skills 和 apps 保持各自的平台语义。
- owner marker 是后续 status、cleanup 和 reinstall 的归属依据。
- markerless Codex user Skill 只有在文件树与当前受信期望树完全一致时，才可按 absent 处理并由 install/reinstall 写入 marker。这个判定不提供删除权限；有 drift、额外文件、符号链接或 foreign marker 时必须 fail closed。

## Config Rules

- 合并顺序是 default、user、project shared、project local。
- project repo-visible artifact 只使用 project shared 中允许共享的值。
- config write 后对当前 target 运行完整 reinstall。
- uninstall、cleanup 和 reinstall 保留 config；只有 config reset 删除 store。

## Test Rules

- unit 使用 synthetic catalog 和 fake native runner。
- integration 覆盖 CLI 与真实模块桥接，不访问用户 home。
- strict cache 测试只构造 cache、selector、lock 和 marketplace fixture。
- platform tests 覆盖 MCP、apps、hooks、permissions、roles 和 Skill 输出。
- JSON 测试同时断言 schema、stdout/stderr 和退出码。
- 修改公开合同后同步更新 `docs/` 和插件作者 reference。
