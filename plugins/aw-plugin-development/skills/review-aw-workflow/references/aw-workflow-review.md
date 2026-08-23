# AW Workflow Review

在通用 workflow review 之外检查：

- 每个 plugin manifest 的 name、skills root 和产品 profile；
- buildImports、runtimeExports、skillRuntimeFiles.import 的依赖方向；
- 插件依赖是否缺失、循环或反向穿透通用/项目层；
- source Skill 与 materialized final 的身份和差异；
- runtime projection 是否由正确插件拥有；
- 同一用户结果是否在多个插件中重复保存 target、digest、readiness 或 coverage；
- 单插件问题与跨插件 workflow 问题是否由正确 owner 修复。

Inventory 只提供机器事实，不自动判断架构优劣。
