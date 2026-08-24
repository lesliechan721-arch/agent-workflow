# 第三方 AW 插件作者指南

本指南面向独立插件作者。`aw` CLI 和 `@lesliechan721/aw-plugin-core` 是机器合同和确定性工具链；Catalog 是分发边界。`aw-plugin-development` 只是一组帮助 Agent 使用这些公开合同的开发助手，不是 SDK，也不是规范真值。

## 三层模型

```text
Source Workspace
  plugins/marketplace-source.json + plugins/<name>/
             ↓ aw catalog build
generated Catalog Snapshot
  .aw/catalog/ (catalog-manifest.json + digest + bundles)
             ↓ path source 或 Git source
installed plugin
  <AW_HOME> 和目标 Codex / Claude Code 范围内的 AW-owned 输出
```

只手动维护第一层的 source 文件。`catalog-manifest.json`、各 digest、`.aw/` 生成输出，以及 `.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json` 两份 marketplace 都由 CLI 生成，禁止手写。`--force` 只能替换 CLI 能证明属于同一 workspace 的生成输出；它不授权覆盖 source、foreign 或 shared 内容。

path source 用本地 snapshot，适合开发和离线验证。Git source 消费已发布的 snapshot，适合分发给其它用户。两者都解析相同的 Catalog 合同。

## Workspace v1 和 manifest

Workspace v1 的固定根布局如下：

```text
<workspace>/
  plugins/
    marketplace-source.json
    <plugin-name>/
      .agents-plugin/plugin.json
```

先用 `aw catalog init --workspace-root <workspace>` 创建 workspace。它写入 `plugins/marketplace-source.json`，其中必须有 `owner`、`interface.displayName` 和严格 SemVer 的 `catalog.version`。插件 source 只放在 `plugins/<name>/`。

每个插件的 `.agents-plugin/plugin.json` 使用 `schemaVersion: 1`。缺失 `schemaVersion` 的历史 manifest 按 legacy v1 读取；其它 schema 版本会被拒绝。不要混淆三个版本：

- `schemaVersion` 是 manifest 结构版本，当前固定为 `1`。
- `version` 是单个插件的稳定 artifact 版本。
- `compatibility.aw.minVersion` 是运行该插件所需的最低 AW CLI 版本。

`catalog.version` 是整个 workspace snapshot 的版本，独立于插件 `version`。日常 source 修改不要为了 build 而提高插件 `version`。但在发布 production artifact 内容已变化、且当前稳定 plugin `version` 已进入 release ledger 的插件前，必须按作者的 release policy 提高该插件的稳定 `version`。发布新 Catalog 时用 `aw catalog version <higher>` 设置新的 Catalog 版本；只提高 `catalog.version` 不能解决同一 plugin `version` 对应不同 production 内容的问题。

同一 source 内的运行时依赖只在 manifest `dependencies` 中声明，值是裸插件名，例如 `"dependencies": ["shared-rules"]`。不要写 `source/plugin`，也不要用 build import 替代运行时依赖。安装选择器 `source/plugin` 用于精确指定插件并固定 trust source。裸插件名必须在当前命令所需和已配置的 Catalog source 集合中唯一匹配；零匹配会失败，多个 source 有同名插件会以歧义失败。需要固定 source 或消除歧义时，使用精确选择器。

## 作者闭环

每次先运行对应的 `--help`。下面的参数表与公开 CLI 一致；所有能接受 workspace 根的作者命令都显式使用 `--workspace-root`。不要使用 `--repo-root`。

```bash
workspace=/absolute/path/to/workspace
plugin=example-plugin

aw catalog init --workspace-root "$workspace"

aw plugin init "$plugin" \
  --description "Describe the plugin." \
  --skill-description "Describe the first Skill." \
  --workspace-root "$workspace"
aw plugin add-skill "$plugin" \
  --skill-name second-skill \
  --skill-description "Describe the Skill." \
  --workspace-root "$workspace"

aw plugin validate "plugins/$plugin" --workspace-root "$workspace" --json
aw plugin test "plugins/$plugin" --workspace-root "$workspace" --json
aw plugin build "plugins/$plugin" --workspace-root "$workspace" --json

aw catalog build --workspace-root "$workspace" --json
aw catalog validate "$workspace/.aw/catalog" --json
```

`aw plugin build` materializes one plugin bundle. `aw catalog build` materializes the complete development snapshot. Run either when its output is needed; then validate the result. `aw plugin test` runs the deterministic Node tests declared by that plugin. `aw plugin status <plugin> --workspace-root "$workspace"` is a development status check and does not require Git. Only an explicit `--base <git-ref>` comparison requires Git.

To consume the generated path snapshot, use a separate isolated AW home when testing:

```bash
export AW_HOME=/tmp/aw-home
export AW_CODEX_HOME=/tmp/aw-codex-home
export AW_CLAUDE_HOME=/tmp/aw-claude-home

aw catalog source add local-example --path "$workspace/.aw/catalog" --primary --json
aw install local-example/example-plugin -p both --json
```

The install command writes platform output. Treat each Catalog as executable software, and inspect its content before adding or installing it.

## Git publication and recovery

`aw catalog publish` is optional and is never an automatic author step. Run it only after the user has explicitly authorized publication.

```bash
aw catalog version 0.2.0 --workspace-root "$workspace"
aw catalog publish \
  --workspace-root "$workspace" \
  --remote origin \
  --branch catalog \
  --yes \
  --json
```

Publication requires a clean source Git worktree, an existing Git commit, a configured remote, and a valid branch. In non-TTY or JSON use, `--yes` is required. The CLI builds the published snapshot, creates an immutable annotated `catalog-v<version>` tag, and atomically pushes the dedicated branch and tag. It does not use the official `catalog/latest` or `catalog/beta` release train.

Before the first remote write, the CLI records a version-specific publish attempt. A failed or uncertain push permanently blocks that Catalog version. Do not retry it and do not delete the attempt file: increase `catalog.version` with `aw catalog version <higher>`, then publish the new Catalog candidate. This recovery does not change a plugin artifact identity. If an already-ledgered stable plugin `version` would publish different production content, first increase that plugin `version` under the author release policy; only increasing `catalog.version` is not valid recovery for same-version different-content. A consumer can add the published source with:

```bash
aw catalog source add example \
  --git <git-url> \
  --ref refs/heads/catalog \
  --primary \
  --json
aw install example/example-plugin -p both --json
```

Third-party Catalog publication is independent from this repository's official CLI and Catalog release train. Do not use this repository's `pnpm release` commands for a third-party workspace.

## Trust and recovery boundaries

A third-party Catalog can contain executable plugin software. Its manifests and bundles can declare lifecycle scripts, Node build or test scripts, artifacts, hooks, MCP servers, Apps, configuration schema, and sensitive configuration. AW validates declared structure and applies its ownership rules, but this is not a promise of a separate permission UI or sandbox for plugin code. Review the source, transport, and trust decision before installation.

Use `--json` for CI and parse the single JSON receipt from stdout. Keep diagnostics on stderr. A minimal CI job can run the authoring commands above with isolated `AW_HOME`, `AW_CODEX_HOME`, and `AW_CLAUDE_HOME`; it must not rely on a repository `node_modules`, `NODE_PATH`, or a workspace symlink.

Generated Catalog output is weak state: rebuild it with `aw plugin build` or `aw catalog build`. Source configuration is strong state: source mutations are committed atomically, but refresh and platform installation can still report partial failure. For installed output, use the receipt and `aw status`; retry a recoverable operation with `aw reinstall`, `aw cleanup`, `aw cleanup --force` only for exclusively owned damaged output, or refresh the source. AW never uses force to delete foreign or shared content.

## Related documents

- [Architecture](architecture.md) defines the product and runtime boundaries.
- [Plugin maintenance](plugin-maintenance.md) defines this repository's maintainer workflow.
- [Testing guide](testing.md) lists the external authoring smoke that exercises this contract from packed tarballs.
