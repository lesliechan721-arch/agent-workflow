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

每个 source manifest 必须使用 Plugin Manifest v3，即显式写入 `schemaVersion: 3`。当前作者工具拒绝 v2 和更早的 manifest schema。不要混淆：

- `schemaVersion`：manifest 结构版本。
- `version`：单插件稳定 artifact 版本。
- `requires.aw.capabilities`：插件显式要求的 AW capability ID；插件版本只标识 artifact。

字段、类型、required 条件和 accepted values 通过当前 CLI 查询：

```bash
aw plugin capabilities --surface manifest --json
```

其它 surface 以当前 CLI 帮助为准。不要从 development plugin 文档缓存字段表。

## Config v2 合同

Manifest 配置只使用 `config.fields` 定义字段，并可用 `config.presentation.groups` 定义字段分组。字段类型只允许 `string`、`number`、`boolean` 和 `object`。配置值只允许标量或一层标量对象；数组、`null` 和嵌套对象无效。旧的 `config.schema`、`enum`、`file`、`directory`、`presentation.fields`、`presentation.presets`、`valueLabels` 和 `recommendedValue` 都无效。

`string` 可用 `minLength`、`maxLength`、`pattern` 和 `identifier|slug|semver|url|hostname|email|path` 格式校验。`number` 可用 `integer`、`minimum`、`maximum` 和 `multipleOf`。非 boolean 字段可声明 `choices: { allowCustom, presets }`。每个 preset 使用稳定 `id`、显示 `title` 和实际 `value`；同一字段最多一个 preset 可设 `recommended: true`。`allowCustom: false` 时，default 和写入值必须与一个 preset 的实际值相同。sensitive 字段不能声明 choices。

`object` 可声明固定 `properties` 和标量 `additionalProperties`。固定 child 用 `required: true` 表示必填；所有 child 都不能声明 default，动态 child 也不能声明 required。`validation` 支持 `minProperties`、`maxProperties` 和复用 string 校验的 `key`。对象最多有 32 个属性。Core 提供稳定对象序列化、preset 匹配、结构化校验 issue 和一层 sensitive child 脱敏；CLI 当前只保证扁平标量配置的完整交互。

已安装 Author 在开始工作时运行 `aw self check --from <skill-root> --json`。CLI 优先读取同层 `aw-plugin-requirements.json` runtime receipt，再回退到 Manifest；`missingCapabilities` 非空时停止。`aw plugin requirements <plugin-directory> --json` 分开报告 declared、derived、detected 和 effective requirements。`requires.aw.capabilities` 只声明生产行为真正需要的最小集合，不能用 CLI 版本字符串替代 capability compatibility。

同一 Catalog source 内的运行时依赖只在 manifest `dependencies` 中声明，值为裸插件名。不要写 `source/plugin`，也不要用 build import 替代运行时依赖。依赖集合、缺失节点和环由 Catalog 作者聚合验证；本指南只定义单插件声明。

## 单插件作者闭环

开始前确认 `<workspace-root>` 已有合法 `.aw-workspace.json` 和 `plugins/marketplace-source.json`。没有合法 Workspace 时停止，并使用 [Catalog 作者指南](catalog-authoring.md)初始化，不要由 Plugin Author 隐式创建。

使用当前公开命令：

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

作者工具以 best-effort 方式检查 `extensions.hooks`、`extensions.nativeHooks` 和 MCP stdio server 的 executable。静态 `aw <group> <command> ...` 会进入 detected requirements；`node`、`sh`、`bash` 或 `pwsh` 后的插件相对脚本会作为生产入口扫描，其中 Node 包含相对 import closure，shell 只包含指定入口。该检查不是通用 shell parser。变量、动态 argv、引号、转义、缺少可映射 argv 或不安全脚本路径只产生非阻断 observation；此时必须在 `requires.aw.capabilities` 显式声明真实要求。静态未知 AW command 会阻止验证；`echo`、`python` 等静态 foreign executable 不产生 AW requirement。

## 安全删除命令

公开删除入口要求显式确认：

```bash
aw plugin remove "$plugin" --workspace-root "$workspace" --yes --json
```

Workspace 必须位于有有效 HEAD 的 Git worktree 中，也可以是仓库子目录。命令只接受 canonical `<workspace>/plugins/<plugin-name>`。目标必须已提交，当前目标 tree 必须在 inventory、文件 bytes 和 executable mode 上与 HEAD 精确相同。任何 staged、unstaged、untracked、ignored、额外或符号链接节点都会阻止删除。Workspace 其它位置的无关修改不阻止命令。

若其它当前 plugin manifest 的 `dependencies` 包含目标，命令列出反向依赖者并停止。所有检查在删除前完成；缺少 `--yes` 时不修改文件。成功只删除 plugin root，不修改 `catalog.version`，也不 commit、build 或 publish。命令没有 `--force`。删除阶段发生 I/O 失败时，诊断会给出从已核验 HEAD 恢复目标的 Git 命令。

Agent 删除由 Catalog Author 编排：普通用户删除请求先进入 Catalog Author；它先确认用户明确给出的 Workspace 和插件名、当前 inventory 与反向依赖，再明确交接这一个命令给 Plugin Author。没有该 handoff 时 Plugin Author 停止并指向 Catalog Author。Plugin Author 通过 runtime compatibility check 后，只执行公开参数的删除命令并返回 JSON receipt；成功后不对已删除对象运行 validate、test、build 或 status。Catalog Author 重新读取 inventory 和依赖，并验证剩余插件。

## Build、Portable 和信任边界

Build script 只向 CLI 提供的 staging root 写入，并只读取已声明输入。不要隐式安装工具或读取真实用户配置。`buildConfig.runtimeExports`、`buildImports`、`skillRuntimeFiles.import` 和 artifact `runtimeImports` 是 typed build-time reuse edge；它们不自动形成 manifest dependency。

每个 `buildConfig.runtimeExports[]` 必须使用 `{ name, source, requires: { aw: { capabilities: [] } } }`。Provider 作者显式声明该 export 的完整 runtime capability 集合；空数组合法。Core 只规范化、排序、去重并计算稳定 capability set digest，不扫描 export 内容推断 metadata。`skillRuntimeFiles.import` 和 artifact `runtimeImports` 把实际使用 export 的 capability 合并到 consumer 最终 bundle、Catalog entry 和每个 Skill receipt；`buildImports` 不传播。Consumer 自有 `skillRuntimeFiles.source` 和 `generatedSkillRuntimeFiles` 继续由顶层 `requires.aw.capabilities` 负责。

Portable Agent Skills 是插件的显式增量 distribution。其 native capability 门禁、projection 和 materialization 结构以当前 `manifest`、`build-config`、`artifacts` capability surface 和 validator 为准。Consumer 使用 `aw skill materialize` 或 `aw skill install` 时会验证完整依赖闭包；`--skill` 只过滤最终选择。

插件可以声明 executable build/test/lifecycle code、hooks、MCP servers、Apps、config 和 artifacts。AW 验证声明并保护 ownership，但不承诺独立的 permission UI 或 sandbox。安装或执行前必须评审 source 和 trust boundary。

## 版本与恢复

日常 source 修改是否改变 plugin `version`，由目标 workspace 的版本策略和 `aw plugin status` 证据决定。不要为生成 bundle 自动提高版本。Catalog 版本选择、publish plan/apply、version-scoped publication journal、pending repo、remote branch/tag 和 recovery 由 [Catalog 作者指南](catalog-authoring.md)定义。

单插件生成输出是弱状态，可重新运行 `aw plugin build`。安装结果失败时使用 receipt、`aw status`、`aw reinstall` 或安全的 `aw cleanup` 恢复；`cleanup --force` 只用于可证明为专属 AW-owned 的损坏输出，不删除 foreign/shared 内容。

## Related documents

- [Catalog authoring](catalog-authoring.md) defines Workspace composition, aggregate validation, publication, and recovery.
- [Architecture](architecture.md) defines product and runtime boundaries.
- [Plugin maintenance](plugin-maintenance.md) defines this monorepo's maintainer workflow.
- [Testing guide](testing.md) defines verification levels.
