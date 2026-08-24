# AW Workflow Review

在通用 workflow review 之外检查：

- 每个 plugin manifest 的 name、skills root 和产品 profile；
- manifest dependencies、buildImports、skillRuntimeFiles.import、artifact runtimeImports 与 runtimeExports 的依赖方向；
- 四类边各自的 provider、export、manifest dependency、产品覆盖和 cycle 事实；不同边不能合成联合 cycle；
- source Skill 与 materialized final 的身份和差异；
- runtime projection 是否由正确插件拥有；
- 同一用户结果是否在多个插件中重复保存 target、digest、readiness 或 coverage；
- 单插件问题与跨插件 workflow 问题是否由正确 owner 修复。

Inventory 只提供机器事实，不自动判断架构优劣。
