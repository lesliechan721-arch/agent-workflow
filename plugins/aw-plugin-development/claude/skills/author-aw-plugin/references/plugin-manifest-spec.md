# Manifest 作者策略

`.agents-plugin/plugin.json` 是插件 manifest 的源码真值。只声明任务需要的最小能力；平台 manifest、runtime bundle、Catalog 和 cache 是生成物。

先读取 `aw plugin capabilities --json` receipt；只有 receipt 含所需领域时，才查询该领域。字段、类型、必填项和组合约束以该 live receipt 为准，不复制到文档或插件源码。复杂错误以目标工作区的 `aw plugin validate --help` 和 `aw plugin validate <plugin-root>` 为准。

源码版本使用稳定 SemVer。日常修改遵守目标工作区的版本策略；需要发布时先检查该工作区公开的 release 帮助和维护文档。不要从本 Skill 推断 Catalog floor、ledger、tag、registry 或 publisher 恢复步骤。

每个路径声明必须位于插件根内。静态能力、动态能力和构建输入必须各有单一 owner，不用 postApply 直接写 AW 管理的平台输出。
