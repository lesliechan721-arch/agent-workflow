# AW Config / Helper

先读取 `aw plugin capabilities --json` receipt；只有 receipt 含所需领域时，才查询该领域。`config.schema` 是跨平台 AW 配置真值；Claude `userConfig` 是单独的 Claude runtime 能力，不能替代或镜像 AW config。

presentation 只改变显示，不改变字段类型和值。`valueLabels` 不改变 enum token。preset 是部分更新，且 preset 不得包含 sensitive、`file` 或 `directory` 字段。

配置 helper 由公开 scaffolding 或目标插件源码拥有，不能复制本 Skill 的内部 helper。helper 优先读取 `AW_PLUGIN_CONTEXT` 的已验证 `config.values`、`sources`、`schema` 和 store paths。无 context fallback 必须验证 bundle 与 source identity；失败时关闭，不回退到裸插件名、其它 source 或无 schema store。

敏感值不进入 stdout、stderr、日志或错误摘要。路径值按目标工作区规则解析；project shared、project local 和 user 的作用域不能混用。

脚本化配置只使用当前 `aw config --help` 公布的命令。默认人类输出不作为机器协议解析；需要结构化结果时使用 help 声明的 JSON 选项。
