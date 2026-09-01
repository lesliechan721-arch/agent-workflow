# AW Config / Helper

先读取 `aw plugin capabilities --json` receipt。Manifest v3 的跨平台配置合同是 `config.fields`；Claude `userConfig` 是单独的 Claude runtime 能力，不能替代或镜像 AW config。live capability receipt 是支持范围的机器真值。

字段类型只可为 `string`、`number`、`boolean` 或单层 `object`。类型约束放在字段的 `validation` 中。字段级 `choices` 保存实际值 preset；`allowCustom: false` 时，默认值和写入值必须匹配一个 preset。敏感字段和 boolean 字段不能声明 choices。`presentation.groups` 只分组，不改变值。

object 使用固定 scalar `properties` 和可选 scalar `additionalProperties`。它可声明 required child、属性数量和 key validation，但 child 不能有 default，且不能嵌套 object。配置值不支持 array、null、`file` 或 `directory`。

配置 helper 由公开 scaffolding 或目标插件源码拥有，不能复制本 Skill 的内部 helper。helper 优先读取 `AW_PLUGIN_CONTEXT` 的已验证 `config.values`、`sources`、`schema` 和 store paths。无 context fallback 必须验证 bundle 与 source identity；失败时关闭，不回退到裸插件名、其它 source 或无 schema store。

敏感值不进入 stdout、stderr、日志或错误摘要。路径值按目标工作区规则解析；project shared、project local 和 user 的作用域不能混用。

脚本化配置只使用当前 `aw config --help` 公布的命令。默认人类输出不作为机器协议解析；需要结构化结果时使用 help 声明的 JSON 选项。
