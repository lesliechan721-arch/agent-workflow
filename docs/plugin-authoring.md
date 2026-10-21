# AW Plugin Source 作者指南

本指南面向在既有合法 [Catalog Workspace](catalog-authoring.md) 中维护单个 Plugin Source 的作者。当前 PATH 的 `aw` CLI 和 `@lesliechan721/aw-plugin-core` 是 manifest、bundle 和 validator 的机器真值；`aw-development-toolkit` 只帮助 Agent 使用这些公开合同。

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

## Config Definition v4 合同

Manifest 配置在 `config` 中显式声明 `schemaVersion: 4`，使用 `config.fields` 定义字段，并可用 `config.presentation.groups` 定义字段分组。字段支持 string、number、boolean、fixed object、KV object 和受约束的一维 array；叶级容器与条件对象的规则见下文。null、混合类型数组及任意递归容器无效。

`definitions` 和本地 `$ref` 用于复用配置定义。引用只允许 `#/config/definitions/Name`，名称遵守字段安全标识规则，拒绝 `__proto__`、`constructor`、`prototype`。引用处只可覆盖 title、description、default、required；覆盖后的 default 按完整字段约束验证。子属性可引用非敏感标量定义，但不能带 default；动态 KV child 不能带 required。

配置最多 64 个定义、256 个顶层字段、8 次引用跳转。每次跟随 `$ref` 算一层，包括对象属性上的引用；内联对象不计数。未知引用、循环、未使用的坏定义及超限输入均拒绝。编译后删除 definitions 和引用，保留 schemaVersion 与 presentation，值校验和 renderer 消费展开后的字段。

`presentation.summaries.<name>` 只支持 `{ kind: "join", parts: [{ path, format? }], separator, missing }`。`fieldViews.<field>.summary` 选择本地摘要。path 是一个已声明 fixed scalar 属性的 JSON Pointer token，支持 `~0` 和 `~1`，不遍历原型、其他字段或外部资源。format 默认为 raw；choiceTitle 优先使用匹配 preset 的 title，无匹配时显示原标量。可选属性缺失使用 missing；空串、0 和 false 保留明确表示。必填缺失或值无效显示“需修正”。摘要不适用于 KV 或 sensitive 字段。

摘要最多 4 段，separator 最多 8 个 Unicode code point，path 最多 128 个字符，显示摘要最多 256 个 Unicode code point。Core 的 `PLUGIN_CONFIG_SUMMARY_MAX_*` 常量公开这些上限。终端呈现清除 ANSI、OSC、C0/C1 和危险双向控制字符。过长摘要或未选中的属性使 `ValuePresentation.complete` 为 false，完整值仍可读取；dirty、preset 匹配、Review diff 和 hash 不使用摘要。没有摘要声明时，界面显示真实属性值，并保留完整读取入口。

配置定义要求 `aw.plugin-config.v4`；摘要另使用 `aw.plugin-config-summary.v1`，数组字段派生 `aw.plugin-config-array.v1`。编译 bundle 保留 requirements，Catalog index 只携带 requirements 与 digest。Store v5 保存原字段名与 JSON 值，不存 ref、summary、preset ID 或编辑 rowId。展示 metadata 变化也改变 schema identity、manifest/bundle digest 和 Review 证据。

```json
{
  "schemaVersion": 4,
  "definitions": {
    "profile": {
      "type": "object",
      "properties": { "model": { "type": "string", "required": true } }
    }
  },
  "fields": {
    "agent": { "$ref": "#/config/definitions/profile", "default": { "model": "local" } }
  },
  "presentation": {
    "summaries": { "model": { "kind": "join", "parts": [{ "path": "/model" }], "separator": "/", "missing": "未设置" } },
    "fieldViews": { "agent": { "summary": "model" } }
  }
}
```

`string` 可用 `minLength`、`maxLength`、`pattern` 和 `identifier|slug|semver|url|hostname|email` 格式校验。value 与 object key 的 pattern 都使用 RE2-WASM Unicode 语法和非锚定匹配；需要整串匹配时显式写 `^` 和 `$`。pattern 最多 512 个 Unicode code point；声明 pattern 时必须同时声明 `maxLength`，且 `maxLength` 必须在 `0..4096`。RE2 不支持 lookaround、backreference 等回溯语法。RE2 只属于 Core 和 CLI 的配置校验实现，不随标准 config helper 分发。`number` 可用 `integer`、`minimum`、`maximum` 和 `multipleOf`。非敏感 scalar、object 和 object child 字段可声明 `choices: { allowCustom, presets }`。每个 preset 使用稳定 `id`、显示 `title` 和实际 `value`；同一字段最多一个 preset 可设 `recommended: true`，且不能声明语义重复的 value。`allowCustom: false` 时，default 和写入值必须与一个 preset 的实际值相同。object preset 是完整 object value，不是 patch。

`sensitive: true` 只用于顶层 string 字段，且 sensitive 字段不得声明 default 或 choices。number、boolean、object、array、array item、fixed object child 和 KV `additionalProperties` child 都不得声明 sensitive。`object` 必须选择一种互斥模式。fixed object 必须声明 `properties`，且 `additionalProperties` 省略或为 `false`；KV object 不得声明 `properties`，且必须用一个 scalar child schema 声明 `additionalProperties`。禁止把 fixed 与 KV 混合。固定 child 用 `required: true` 表示必填；所有 child 都不能声明 default，KV child 也不能声明 required。`validation` 支持 `minProperties`、`maxProperties` 和复用 string 校验的 `key`。对象最多有 32 个属性。Core 提供 canonical object preset 匹配和结构化校验 issue；CLI 和控制台支持标量及一层 object 的完整编辑。

`type: "array"` 必须给出单一 `items` schema，允许 string、number、boolean、fixed object 或 KV object。items 可引用本地 definitions，展开后仍遵守叶级容器边界；items 本身不能声明 default、required、sensitive，fixed object item 的属性可 required。数组级 default 和 choices 是完整数组，allowCustom=false 禁止自定义增删改排。`validation.minItems/maxItems` 是非负整数，最大 128 项，未声明 max 也受此限制；每个数组完整值的规范化紧凑 JSON UTF-8 编码最多 262144 字节，对象元素仍最多 32 属性。`uniqueItems` 默认 false，true 时重复值报错，不静默去重；对象 key 顺序不影响相等，数组顺序影响相等。`[]` 可覆盖非空默认，unset 不等于空数组，required 不代表非空。`fieldViews.<field>.itemSummary` 可引用一个针对 fixed-object 元素的 join summary；KV 元素使用安全对象预览。CLI 用完整 JSON set/unset，TUI 在本地列表中增删改排，确认整列后选一次保存范围，不提供 index 写入命令。

对象数组可以用 `validation.uniqueBy` 指定一个已声明的标量属性。重复属性值会使整个候选无效，属性值保持原类型和大小写。非敏感标量可以声明 `valueRef: { field, key, label?, include? }`：`field` 是另一顶层对象数组，`key` 是同类型标量属性，`label` 是可选展示属性，`include` 是允许的静态内置值。静态值同时保留，源数组不能使用同值的 key。引用只使用固定字段和一层属性；保存、有效配置读取与 apply 都校验依赖闭包。删除仍被引用的 key 会失败，可先新增 key，再切换引用，最后删除旧 key。调用者得到的字段仍受原允许 keys 限制。两项能力分别要求 `aw.plugin-config-unique-by.v1` 和 `aw.plugin-config-value-ref.v1`。

AW 只提供 `default < user < project` 两个持久写入层。所有新 namespaced Store 使用 schemaVersion 5，包括只含标量、对象或空 values 的配置；旧格式显示 schemaVersionUnsupported 并保留原文件。user 配置绑定 source identity；project 配置绑定 Catalog logical identity，所以 Git URL、SSH/HTTPS transport 或 path source 的变化不改变同一 Catalog 的项目配置身份。sensitive 字段只允许 user scope。project 写入若无法由 Git 验证可共享性，会返回 `projectConfigShareabilityUnverified` warning；明确被 ignore 时以 `projectConfigIgnored` 拒绝写入。object 和 array 值按顶层字段完整覆盖，不深合并或拼接列表。字符串 validation format 只支持 `identifier`、`slug`、`semver`、`url`、`hostname` 和 `email`；Config 不提供文件系统 path、file 或 directory format，也不解析 realpath 或建立 project artifact path boundary。CLI 写入使用 `aw config set <plugin> <field> --scope <user|project> (--value-json <json> | --value-stdin | --preset <id>)`。sensitive 字段拒绝 `--value-json` 和 `--preset`；非交互或 JSON 模式必须使用 `--scope user --value-stdin`，并按 EOF 原样读取 UTF-8。preset 只用于选择 manifest 中的实际值，store 不保存 preset ID。作者脚本使用 scaffolding 生成的 `scripts/aw-config.mjs` 读取 CLI 已校验的 `AW_PLUGIN_CONTEXT` effective config；helper 保持敏感值脱敏，不读取持久 store，也不维护第二份字段 validator。user/project 层诊断使用 `aw config get/list --scope ...`。

### 条件对象与常量

声明 `config.schemaVersion: 4` 后，固定对象可使用有限 `variants`，非敏感标量可声明 `const`，固定对象的属性可使用叶级标量数组或标量 KV 对象。顶层对象数组的固定元素同样支持这些属性。该合同使用 definitions、局部引用、choices、valueRef、uniqueBy、presentation、scope 和既有限值；不开放任意递归容器。

`variants.discriminator` 指向当前对象 common properties 中已声明的 own string 属性。`cases` 将字符串映射到 `{ properties }` 分支；分支不能覆盖 common 属性。可选 `missing` 指向一个已有 case，只在选择字段缺失时使用；可选 `otherwise` 为其它合法值提供 `{ properties }`。选择值仍须通过 choices 和 valueRef 校验。没有匹配分支时拒绝候选，不猜测默认值；所有分支在 schema 读取时都必须有效。

`const` 必须匹配标量类型及校验条件。显式值不同则报错；省略时可显示常量，但不会将它写入强配置。`required` 仍独立生效。TUI 从相同分支合同显示属性和固定值；叶级数组与 KV 使用结构化编辑。切换分支只改变草稿，保存 Review 显示移除的属性和实际保留值；取消保留原配置。无交互写入不清理错误字段，而是拒绝整个候选。

v4 要求 `aw.plugin-config.v4`。先交付支持该 capability 的 CLI，再分发使用它的插件。Manifest v3、Store v5、Catalog v7 和 installed-runtime-config v2 是独立合同。Store 保存完整原始顶层值，不保存 UI rowId、派生命令路径或环境引用的解析值。分支、常量和呈现元数据均属于 schema identity，变化后需重新取得 Review 证据。

### 已安装配置读取

动态 Skill target 可声明 `runtimeConfig: { keys: ["<field>"] }`，要求 `aw.installed-runtime-config.v2`。keys 非空、无重复，必须属于该 target 的 refresh keys；字段及其校验依赖闭包均不得敏感。AW 在物化时使用正式 Core 配置校验，生效资源只公开允许字段。每个 Skill 独立读取本产物的配置，不声明一致性组，不绑定文件内容版本；不同来源中的同名插件仍保持隔离。

AW 在最终 Skill 中生成 `scripts/aw-runtime-config.mjs` 和 `.aw-runtime-config.json`。二者是保留路径，source 和 renderer 不得提供同名文件。程序从真实安装文件调用：

```js
import { readRuntimeConfig } from './aw-runtime-config.mjs';

const runtime = await readRuntimeConfig({
  from: import.meta.url,
  keys: ['<field>'],
});
```

返回值包含 `installedIdentity`、请求获准的 `effectiveValues` 和 `resourceRoot`。schema 2 生效资源保存 installed identity、allowed keys、effective values 和本产物需要的来源元数据。reader 无须 `AW_PLUGIN_CONTEXT`，从真实调用位置检查本产物的格式、来源、作用域和安全路径；不读取最新 store，不遍历其他 Skill，也不核验资源树或角色正文。保存但未 apply 的配置不改变返回值；apply 部分成功时，各可用产物按自身内容工作。消费脚本仍须校验本次使用的 profile、命令和输入。

缺失或损坏的本产物配置、未知格式、越权 keys、不安全路径或可观察身份冲突会拒绝调用，并提供修正配置、sync/reinstall 恢复。生效资源是可重建的弱状态，不能改变 ownership、status 或 cleanup 的安装判断。旧 `resourceVersion`、`artifactIds`、v1 binding 和 `expectedRevision` 不再兼容。作者须仅保留 keys、声明新 capability，并先使用支持 v2 的 CLI，再通过正常 build/sync/reinstall 更新已安装 helper；Manifest v3 和 Store v5 不变。

字段覆盖不符合当前 schema 时，AW 保留该层值供用户修改或 unset，但 runtime 不使用低层 fallback 继续运行；fallback 只用于解释删除后的恢复结果。删除 project 覆盖后若会暴露无效 user 值，fallback 是 `invalid`，不能用 schema default 代替。结构损坏的 store 必须整层 reset。Config Mutation Receipt v7 的 `configWrite: succeeded` 说明强配置已经越过 commit point；之后的解析、target discovery、target validation 或 apply 失败使用 `overallState: partial` 和 discriminated `apply` 报告，不回滚已保存设置。每个 target 按自己的 platform 和 scope 验证，健康 target 可以继续 apply，无效 target 报告 `skipped/invalidConfig`。reset receipt 用 `absent | deletedFile | unlinkedSymlink | quarantinedDirectory` 说明实际处理结果，目录隔离只公开 basename。

已安装 Author 在开始工作时运行 `aw self check --from <skill-root> --json`。CLI 优先读取同层 `aw-plugin-requirements.json` runtime receipt，再回退到 Manifest；`missingCapabilities` 非空时停止。`aw plugin requirements <plugin-directory> --json` 分开报告 declared、derived、detected 和 effective requirements。`requires.aw.capabilities` 只声明生产行为真正需要的最小集合，不能用 CLI 版本字符串替代 capability compatibility。

同一 Catalog source 内的运行时依赖只在 manifest `dependencies` 中声明，值为裸插件名。不要写 `source/plugin`，也不要用 build import 替代运行时依赖。依赖集合、缺失节点和环由 Catalog 作者聚合验证；本指南只定义单插件声明。

Codex native target 的 `refreshKeys` 是 user-only。遗留 project override 会保留但不参与 effective value。Status 报告非阻断 `configLayerUnsupported` warning，TUI 只允许删除该旧值。

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

只读 Review 使用 `aw review inspect <plugin-path> --json`。该入口读取 source、已有 Catalog snapshot 和显式 `--materialization <receipt>`，不执行被审插件代码。`plugin validate` 可能运行 renderer fixture，`plugin status` 可能准备 bundle，因此不能替代只读取证。缺少当前 final 时，inspection 返回源码事实和证据缺口；质量判断由 Reviewer 完成。

`develop-aw` 的 Plugin 分支修改插件内 Skill 时调用 `author-agent-skill`，返回后运行 `aw skill validate <skill-root>`。它处理一个 Plugin Source 的内部内容；Catalog metadata、inventory、精确 Catalog version、聚合 snapshot 由它的 Catalog 分支处理，远端 publication 仍由手动 `publish-aw-catalog` 负责。

作者工具以 best-effort 方式检查 `extensions.hooks`、`extensions.nativeHooks` 和 MCP stdio server 的 executable。静态 `aw <group> <command> ...` 会进入 detected requirements；`node`、`sh`、`bash` 或 `pwsh` 后的插件相对脚本会作为生产入口扫描，其中 Node 包含相对 import closure，shell 只包含指定入口。该检查不是通用 shell parser。变量、动态 argv、引号、转义、缺少可映射 argv 或不安全脚本路径只产生非阻断 observation；此时必须在 `requires.aw.capabilities` 显式声明真实要求。静态未知 AW command 会阻止验证；`echo`、`python` 等静态 foreign executable 不产生 AW requirement。

## 安全删除命令

公开删除入口要求显式确认：

```bash
aw plugin remove "$plugin" --workspace-root "$workspace" --yes --json
```

Workspace 必须位于有有效 HEAD 的 Git worktree 中，也可以是仓库子目录。命令只接受 canonical `<workspace>/plugins/<plugin-name>`。目标必须已提交，当前目标 tree 必须在 inventory、文件 bytes 和 executable mode 上与 HEAD 精确相同。任何 staged、unstaged、untracked、ignored、额外或符号链接节点都会阻止删除。Workspace 其它位置的无关修改不阻止命令。

若其它当前 plugin manifest 的 `dependencies` 包含目标，命令列出反向依赖者并停止。所有检查在删除前完成；缺少 `--yes` 时不修改文件。成功只删除 plugin root，不修改 `catalog.version`，也不 commit、build 或 publish。命令没有 `--force`。删除阶段发生 I/O 失败时，诊断会给出从已核验 HEAD 恢复目标的 Git 命令。

Agent 在 `develop-aw` 的 Catalog 维护路径处理删除：从用户指定的 Workspace 和插件名唯一定位 canonical 目标，确认显式删除授权、inventory、反向依赖及 Git 状态。公开 remove 要求有效 Git HEAD，目标已在 HEAD 中，且当前目标树的内容、可执行位和形状精确匹配 HEAD；目标内 staged、unstaged、untracked、ignored 或额外节点均按真实命令诊断处理。通过能力检查后，按公开帮助执行 remove 并保留 JSON receipt。保护性拒绝时报告阻碍，不丢弃用户变更或绕过删除保护。成功后重新读取 inventory 和依赖，只验证剩余受影响插件；空 inventory 只验证空 Catalog，不对已删除对象运行 validate、test、build 或 status。remove 不自动提升版本、提交或发布。

## Build、Portable 和信任边界

Build script 只向 CLI 提供的 staging root 写入，并只读取已声明输入。不要隐式安装工具或读取真实用户配置。`buildConfig.runtimeExports`、`buildImports`、`skillRuntimeFiles.import` 和 artifact `runtimeImports` 是 typed build-time reuse edge；它们不自动形成 manifest dependency。

每个 `buildConfig.runtimeExports[]` 必须使用 `{ name, source, requires: { aw: { capabilities: [] } } }`。Provider 作者显式声明该 export 的完整 runtime capability 集合；空数组合法。Core 只规范化、排序、去重并计算稳定 capability set digest，不扫描 export 内容推断 metadata。`skillRuntimeFiles.import` 和 artifact `runtimeImports` 把实际使用 export 的 capability 合并到 consumer 最终 bundle、Catalog entry 和每个 Skill receipt；`buildImports` 不传播。Consumer 自有 `skillRuntimeFiles.source` 和 `generatedSkillRuntimeFiles` 继续由顶层 `requires.aw.capabilities` 负责。

Portable Agent Skills 是插件的显式增量 distribution。其 native capability 门禁、projection 和 materialization 结构以当前 `manifest`、`build-config`、`artifacts` capability surface 和 validator 为准。Consumer 使用 `aw skill materialize` 或 `aw skill install` 时会验证完整依赖闭包；`--skill` 只过滤最终选择。

独立审核源 Skill 时，使用 `aw review inspect <target> --json` 取得默认的精简 review 导航；已有来源凭据通过 `--materialization <path>` 传入。需要 final 时使用 `aw review prepare <plugin-or-source-skill> --platform <codex|claude|agent-skills> --scope <user|project> --out <new-dir> --json`，可加 `--skill` 和 `--config` 选择本次输入。它无需 Eval，配置仅取 manifest 默认值与合法非敏感覆盖，在隔离环境执行必要 build/renderer，不安装插件。inspection 回执使用 schema 2，view 为 review；取证完成不代表质量或发布通过。

`aw skill materialize`、`aw skill eval prepare` 和 `aw review prepare` 均返回 `sourceBindingPath`，指向被测 Skill 外的 schema 2 `aw-source-binding.json`。它把本次 source 或 Catalog snapshot、profile 输入和实际产物绑定，供后续 inspection 只读核验。该文件不替代 EvalSpec/Audit/Result，也不证明语义质量。缺失、过期或 v1 凭据均需通过对应入口在新目录重新准备，不原地迁移或手工补写 digest。inspection v2 提供当前 source 到 final 的导航。

Eval Manifest v1 profile 的 `plugins` 对象选择参与插件，并为每个插件提供公共非敏感配置。可选 `configByScope` 使用 `{ "user": { "plugin-name": {} }, "project": { "plugin-name": {} } }`；其中插件必须已在 `plugins` 中声明。每个 scope 覆盖按顶层字段替换，未写字段继承公共配置。普通 artifact 和 role 使用 profile 的 `scope`；共享 `codex-native` Skill 始终使用合并后的 user 配置。`prepare` 将这些实际输入写入隔离 config store，并把有效配置摘要绑定到 source binding；它不安装插件或启动模型。

本次准备可用 `--config-file <file>` 传入同形的插件配置 map，按顶层字段覆盖选定 profile 的公共及 scope 值。文件必须是普通文件；插件必须已被选中，字段不得敏感。来源绑定保存实际覆盖，输出提交前复查输入。此入口可为独立运行包提供已经安装的绝对 adapter 路径，不在 source profile 保存机器专属占位路径。

renderer 的结构化 stdout 保持完整 JSON，最大为 16 MiB；超限时 AW 停止本次进程树并拒绝产物。诊断摘要仍有独立的 64 KiB 上限和脱敏。已声明 runtimeConfig 的 Skill 源脚本可导入该 Skill 的 `scripts/aw-runtime-config.mjs`；源码和 bundle 检查识别这个注入合同，最终读取脚本仍由 AW 提供。其它缺失导入继续失败。

每个 `codex.skill` dynamic target 必须显式声明 `delivery`。AW-owned 输出使用 `{ "mode": "aw-extension" }`。Codex native 输出只使用 `{ "mode": "codex-native", "identity": "shared", "renderProfile": "user" }`。所有 `codex.skill` delivery、`claude.skill` 和 `agent-skills.skill` 的 `refreshKeys` 都不得引用 sensitive config；非 Skill target 可以读取 sensitive config。native target 使用 user 配置 profile；与其 `refreshKeys` 匹配的字段只能在 user scope 写入，project scope 的 set 会被拒绝。user 配置中与 `refreshKeys` 匹配的变更会刷新投影，空数组合法。非 `codex.skill` target 不能声明 `delivery`。native dynamic Skill 不能与静态 Codex Skill 同名。同一插件 identity 的所有 Codex native 组件必须使用完全相同的 scope 集；静态 Skill、MCP、Hook 和 App 固定为 `{project,user}`，dynamic native 使用声明 scopes，slash command 不参与该规则。

AW 为 Codex native dynamic projection 生成 `.agents-plugin/aw-codex-native-render.json`，插件源码和 renderer 不得声明该保留文件。schema 1 receipt 只记录规范化 identity 和 digest，不记录原始 config；所有 `codex-native` target 的 ID 与 Skill key 在整个 shared projection 内分别全局唯一，即使 scopes 不重叠也不能复用。`configDigest` 聚合 validated artifact 的 per-target config digest，`renderInputDigest` 绑定 source、plugin version、renderer digest 和规范化 target config/artifact digest。动态 payload digest 排除该 receipt 和 AW owner marker，规范化 `.codex-plugin/plugin.json` 的 version，但绑定 renderer 产生的真实 skills projection；静态 shared native digest 继续规范化 Codex-managed skills。AW 会检查完整 user effective config 中至少 8 个 Unicode code point 的 sensitive string 原文和 JSON 转义形态；该阈值只减少短值误报，不表示 secret 强度，日志仍脱敏所有长度。receipt 只有在 AW 生成或内容验证后，才从精确路径的扫描中排除；不得按 basename 通配。命中时停止，不改变 live marketplace、Codex registration 或 activation。receipt 是可删除、可重建的现场证据，不是作者维护的 ledger。

renderer context 的 `requestedArtifactIds` 是本次唯一允许返回的 target ID 集合。它非空、无重复，并按 manifest 声明顺序规范化。因此，任两个在同一 platform/distribution surface 和 scope 内可被同次请求的 target 不能使用相同 ID；不同 surface 或不重叠 scope 可复用 ID，但 `codex-native` shared projection 使用上段更严格的全局唯一规则。同一 surface/scope 同时有 Skill 和读取 sensitive config 的非 Skill target 时，AW 把它们分成两个请求；两个请求读取同一份不可变 `previousArtifacts`，每个 `ArtifactPlan` 必须精确匹配该批 ID。`config.schema/values/sources/issues` 和 `changedConfigKeys` 只含本次 target `refreshKeys` 的并集。`artifactSources` 按 manifest 顺序提供当前 surface/scope 全部 Skill target 的真实 `sourceDirs`，即使该 Skill 未在本批请求中；renderer 可用这些路径复用静态资源，但不能据此读取更多配置或返回更多产物。不要猜测 bundle 的私有目录布局。context 不提供 config store 路径；renderer 的三个 `AW_*_HOME` 和 context home 路径都指向本次请求的临时目录。该输入隔离不是 OS sandbox。配置 helper 只支持 effective context 读取，缺少 `AW_PLUGIN_CONTEXT` 或显式 user/project 读取都会失败。renderer 必须对每个请求 ID 精确返回一个 artifact；缺失、重复或未请求输出都会失败。

插件可以声明 executable build/test/preApply code、hooks、MCP servers、Apps、config 和 artifacts。preApply 只用于安装前环境校验或安装外部系统工具，必须幂等；它不能替代 manifest dependencies 或 build-time Node bundle。AW 验证声明并保护 ownership；请求级临时 home 是输入隔离，不是 OS sandbox。需要 context 的 preApply 必须完整读取 stdin 后再决定结果；不需要 context 的脚本可以直接成功退出。preApply 必须在返回前等待自己的全部后代退出，不得 daemonize 或遗留后台任务；AW 会在正常退出、超时和中断后清理本次脚本进程树，清理无法确认时 preApply 失败。安装或执行前必须把 executable source 和 trust boundary 作为受信任代码评审。

## 版本与恢复

日常 source 修改是否改变 plugin `version`，由目标 workspace 的版本策略和 `aw plugin status` 证据决定。不要为生成 bundle 自动提高版本。Catalog 版本选择、publish plan/apply、version-scoped publication journal、pending repo、remote branch/tag 和 recovery 由 [Catalog 作者指南](catalog-authoring.md)定义。

单插件生成输出是弱状态，可重新运行 `aw plugin build`。安装结果失败时使用 receipt、`aw status`、`aw reinstall` 或安全的 `aw cleanup` 恢复；`cleanup --force` 只用于可证明为专属 AW-owned 的损坏输出，不删除 foreign/shared 内容。

## Related documents

- [Catalog authoring](catalog-authoring.md) defines Workspace composition, aggregate validation, publication, and recovery.
- [Architecture](architecture.md) defines product and runtime boundaries.
- [Plugin maintenance](plugin-maintenance.md) defines this monorepo's maintainer workflow.
- [Testing guide](testing.md) defines verification levels.
