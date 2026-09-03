# AW Config / Helper

先读取 `aw plugin capabilities --json` receipt。Manifest v3 的跨平台配置合同是 `config.fields`；Claude `userConfig` 是单独的 Claude runtime 能力，不能替代或镜像 AW config。live capability receipt 是支持范围的机器真值。

字段类型只可为 `string`、`number`、`boolean` 或单层 `object`。类型约束放在字段的 `validation` 中。字段级 `choices` 保存实际值 preset；`allowCustom: false` 时，默认值和写入值必须匹配一个 preset。敏感字段和 boolean 字段不能声明 choices。`presentation.groups` 只分组，不改变值。

object 使用固定 scalar `properties` 和可选 scalar `additionalProperties`。它可声明 required child、属性数量和 key validation，但 child 不能有 default，且不能嵌套 object。配置值不支持 array、null、`file` 或 `directory` 字段类型。string `validation.format` 可使用 `file` 或 `directory`：Core 和 helper 只要求非空且无 NUL；CLI 提交时必须 realpath 到已有普通文件或目录。`path` 不要求该路径存在。project store 的 object 顶层字段只要有 `file` 或 `directory` child，就不能用于 project artifact，且会产生整个顶层字段的 boundary issue。

配置 helper 由公开 scaffolding 或目标插件源码拥有，不能复制本 Skill 的内部 helper。helper 优先读取 `AW_PLUGIN_CONTEXT` 的已验证 `config.values`、`sources`、`schema` 和 store paths。无 context fallback 必须验证 bundle 与 source identity；失败时关闭，不回退到裸插件名、其它 source 或无 schema store。

AW 只提供 `default < user < project`。namespaced store 使用 schemaVersion 3；object 值按顶层字段完整覆盖，不深合并。无 context fallback 的 helper 在 effective scope 读取 user 和 project；显式 user 或 project scope 只读取该 scope 的 store。旧 store 和 `plugin-config.local` 不读取或迁移。无效 store 必须先通过明确确认的整层 reset 恢复，不能静默回退。

写入命令是 `aw config set <plugin> <field> --scope <user|project> (--value-json <json> | --preset <id>)`。preset 保存其实际值，不保存 ID。敏感标量和一层 object child 不进入 CLI 输出、stderr、日志或错误摘要。

脚本化配置只使用当前 `aw config --help` 公布的命令。默认人类输出不作为机器协议解析；需要结构化结果时使用 help 声明的 JSON 选项。
