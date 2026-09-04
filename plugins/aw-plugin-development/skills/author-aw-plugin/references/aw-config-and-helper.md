# AW Config / Helper

先读取 `aw plugin capabilities --json` receipt。Manifest v3 的跨平台配置合同是 `config.fields`；Claude `userConfig` 是单独的 Claude runtime 能力，不能替代或镜像 AW config。live capability receipt 是支持范围的机器真值。

字段类型只可为 `string`、`number`、`boolean` 或单层 `object`。类型约束放在字段的 `validation` 中；string format 只可为 `identifier`、`slug`、`semver`、`url`、`hostname` 或 `email`。string value 和 object key 的 pattern 都使用 RE2-WASM Unicode 语法和非锚定匹配；需要整串匹配时显式写 `^` 和 `$`。pattern 最多 512 个 Unicode code point；声明 pattern 时必须同时声明 `0..4096` 的 `maxLength`。非敏感 scalar、object 和 object child 的 `choices` 保存实际值 preset。`allowCustom: false` 时，默认值和写入值必须匹配一个 preset。object preset 是完整 object value，不是 patch。`presentation.groups` 只分组，不改变值。

`sensitive: true` 只允许顶层 string 字段，且该字段不得声明 default 或 choices。number、boolean、object、fixed object child 和 KV `additionalProperties` child 都不得声明 sensitive。object 必须选择 fixed 或 KV 模式。fixed object 必须声明 scalar `properties`，且 `additionalProperties` 省略或为 `false`；KV object 不得声明 `properties`，且必须声明一个 scalar `additionalProperties` schema。禁止混合两种模式。它可声明 required fixed child、属性数量和 key validation，但 child 不能有 default，KV child 也不能有 required，且 child 不能嵌套 object。配置值不支持 array、null 或嵌套 object。Config 不提供 path、file 或 directory format；helper 不解析 realpath，也不建立 project artifact path boundary。

配置 helper 由公开 scaffolding 或目标插件源码拥有，不能复制本 Skill 的内部 helper。helper 优先读取 `AW_PLUGIN_CONTEXT` 的已验证 `config.values`、`sources`、`schema` 和 store paths。无 context fallback 必须验证 bundle 与 source identity；失败时关闭，不回退到裸插件名、其它 source 或无 schema store。

AW 只提供 `default < user < project`。namespaced store 使用 schemaVersion 4；user store binding 绑定 source identity，project store binding 绑定 Catalog logical identity。project binding 不绑定 source identity、Git URL 或本地 source path，也不能从 transport 推导 logical identity。object 值按顶层字段完整覆盖，不深合并。无 context fallback 的 helper 在 effective scope 读取 user 和 project；显式 user 或 project scope 只读取该 scope 的 store。

schemaVersion 3、旧 store 和 `plugin-config.local` 是 hard cut：不读取、不迁移，也不自动重写。无效 store 必须先通过明确确认的整层 reset 恢复，不能静默回退。`config reset` 是独立的 schema-independent 恢复入口；即使 Catalog、schema 或 store envelope 无效，仍可按完整 plugin ID 和 scope 重置目标层。

字段覆盖不符合当前 schema 时，runtime 不使用低层 fallback；该 fallback 只说明 unset 后会恢复什么。删除 project 覆盖后若会暴露无效 user 值，fallback 是 `invalid`，不能用 schema default 代替。用户可修改或 unset 该字段，也可 reset 整层。Config Mutation Receipt v7 的 `configWrite: succeeded` 表示配置已经越过 commit point，不表示平台 apply 成功；之后的解析、target discovery、target validation 或 apply 失败使用 `overallState: partial` 和 discriminated `apply` 报告。每个 target 按自己的 platform 和 scope 验证，健康 target 可以继续 apply，无效 target 报告 `skipped/invalidConfig`。apply 失败不回滚设置。reset receipt 的 `absent | deletedFile | unlinkedSymlink | quarantinedDirectory` 是实际处理结果，目录隔离只公开 basename。

写入命令是 `aw config set <plugin> <field> --scope <user|project> (--value-json <json> | --value-stdin | --preset <id>)`。preset 保存其实际值，不保存 ID。敏感顶层 string 只允许 user scope，且不能通过 `--value-json` 或 `--preset` 传入。脚本、JSON 模式和非交互运行必须使用 `--value-stdin`；直接交互 TTY 可省略值选项并使用隐藏输入。stdin 按 EOF 读取原始 UTF-8，不 trim。敏感值不进入命令示例、CLI 输出、stderr、日志或错误摘要。

脚本化配置只使用当前 `aw config --help` 公布的命令。默认人类输出不作为机器协议解析；需要结构化结果时使用 help 声明的 JSON 选项。
