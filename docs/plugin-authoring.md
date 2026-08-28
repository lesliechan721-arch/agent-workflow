# AW Plugin Source 作者指南

本指南面向在既有合法 [Catalog Workspace](catalog-authoring.md) 中维护单个 Plugin Source 的作者。当前 PATH 的 `aw` CLI 和 `@lesliechan721/aw-plugin-core` 是 manifest、bundle 和 validator 的机器真值；`aw-plugin-development` 只帮助 Agent 使用这些公开合同。

## Plugin Source 边界

一个插件的 canonical root 固定为：

```text
<workspace>/plugins/<plugin-name>/
  .agents-plugin/plugin.json
  README.md
  skills/**
  scripts/**
```

具体目录由 manifest 声明。所有 source path 必须留在插件根内，不能进入任意深度的 `.git` 或 `node_modules`。只维护 source 文件；`.aw/plugins/`、Catalog snapshot、digest 和 platform marketplace 是生成物，不手改。

每个 source manifest 使用 `schemaVersion: 2`。不要混淆：

- `schemaVersion`：manifest 结构版本。
- `version`：单插件稳定 artifact 版本。
- `requires.aw.capabilities`：插件显式要求的 AW capability ID；插件版本只标识 artifact。

字段、类型、required 条件和 accepted values 通过当前 CLI 查询：

```bash
aw plugin capabilities --surface manifest --json
```

其它 surface 以 `aw plugin capabilities --help` 为准。不要从 development plugin 文档缓存字段表。

同一 Catalog source 内的运行时依赖只在 manifest `dependencies` 中声明，值为裸插件名。不要写 `source/plugin`，也不要用 build import 替代运行时依赖。依赖集合、缺失节点和环由 Catalog 作者聚合验证；本指南只定义单插件声明。

## 单插件作者闭环

开始前确认 `<workspace-root>` 已有合法 `.aw-workspace.json` 和 `plugins/marketplace-source.json`。没有合法 Workspace 时停止，并使用 [Catalog 作者指南](catalog-authoring.md)初始化，不要由 Plugin Author 隐式创建。

每次先运行对应的 `--help`：

```bash
workspace=/absolute/path/to/workspace
plugin=example-plugin

aw plugin init "$plugin" \
  --description "Describe the plugin." \
  --skill-description "Describe the first Skill." \
  --workspace-root "$workspace"

aw plugin add-skill "$plugin" \
  --skill-name second-skill \
  --skill-description "Describe the Skill." \
  --workspace-root "$workspace"

aw plugin capabilities --surface manifest --json
aw plugin validate "plugins/$plugin" --workspace-root "$workspace" --json
aw plugin test "plugins/$plugin" --workspace-root "$workspace" --json
aw plugin build "plugins/$plugin" --workspace-root "$workspace" --json
aw plugin status "$plugin" --workspace-root "$workspace" --json
```

`validate` 检查 source contract，`test` 运行 manifest 声明的确定性 Node tests，`build` 生成一个插件 bundle。`status` 默认不要求 Git；只有显式传 `--base <git-ref>` 时才做 Git comparison。

`author-aw-plugin` 修改插件内 Skill 时调用 `author-agent-skill`，返回后运行 `aw skill validate <skill-root>`。它只负责一个 Plugin Source，不维护 Catalog metadata、inventory、精确 Catalog version、聚合 snapshot 或远端 publication。

## 安全删除命令

公开删除入口要求显式确认：

```bash
aw plugin remove "$plugin" --workspace-root "$workspace" --yes --json
```

Workspace 必须位于有有效 HEAD 的 Git worktree 中，也可以是仓库子目录。命令只接受 canonical `<workspace>/plugins/<plugin-name>`。目标必须已提交，当前目标 tree 必须在 inventory、文件 bytes 和 executable mode 上与 HEAD 精确相同。任何 staged、unstaged、untracked、ignored、额外或符号链接节点都会阻止删除。Workspace 其它位置的无关修改不阻止命令。

若其它当前 plugin manifest 的 `dependencies` 包含目标，命令列出反向依赖者并停止。所有检查在删除前完成；缺少 `--yes` 时不修改文件。成功只删除 plugin root，不修改 `catalog.version`，也不 commit、build 或 publish。命令没有 `--force`。删除阶段发生 I/O 失败时，诊断会给出从已核验 HEAD 恢复目标的 Git 命令。

Agent 删除由 Catalog Author 编排：普通用户删除请求先进入 Catalog Author；它先确认用户明确给出的 Workspace 和插件名、当前 inventory 与反向依赖，再明确交接这一个命令给 Plugin Author。没有该 handoff 时 Plugin Author 停止并指向 Catalog Author。Plugin Author 先查询 `aw --version` 和 `aw plugin remove --help`，只执行公开参数的删除命令并返回 JSON receipt；成功后不对已删除对象运行 validate、test、build 或 status。Catalog Author 重新读取 inventory 和依赖，并验证剩余插件。

## Build、Portable 和信任边界

Build script 只向 CLI 提供的 staging root 写入，并只读取已声明输入。不要隐式安装工具或读取真实用户配置。`buildConfig.runtimeExports`、`buildImports`、`skillRuntimeFiles.import` 和 artifact `runtimeImports` 是 typed build-time reuse edge；它们不自动形成 manifest dependency。

Portable Agent Skills 是插件的显式增量 distribution。其 native capability 门禁、projection 和 materialization 结构以当前 `manifest`、`build-config`、`artifacts` capability surface 和 validator 为准。Consumer 使用 `aw skill materialize` 或 `aw skill install` 时会验证完整依赖闭包；`--skill` 只过滤最终选择。

插件可以声明 executable build/test/lifecycle code、hooks、MCP servers、Apps、config 和 artifacts。AW 验证声明并保护 ownership，但不承诺独立的 permission UI 或 sandbox。安装或执行前必须评审 source 和 trust boundary。

## 版本与恢复

日常 source 修改是否改变 plugin `version`，由目标 workspace 的版本策略和 `aw plugin status` 证据决定。不要为生成 bundle 自动提高版本。Catalog candidate、release ledger、remote branch、tag、attempt 和 publication recovery 由 [Catalog 作者指南](catalog-authoring.md)定义。

单插件生成输出是弱状态，可重新运行 `aw plugin build`。安装结果失败时使用 receipt、`aw status`、`aw reinstall` 或安全的 `aw cleanup` 恢复；`cleanup --force` 只用于可证明为专属 AW-owned 的损坏输出，不删除 foreign/shared 内容。

## Related documents

- [Catalog authoring](catalog-authoring.md) defines Workspace composition, aggregate validation, publication, and recovery.
- [Architecture](architecture.md) defines product and runtime boundaries.
- [Plugin maintenance](plugin-maintenance.md) defines this monorepo's maintainer workflow.
- [Testing guide](testing.md) defines verification levels.
