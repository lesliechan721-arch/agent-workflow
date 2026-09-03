# AW Plugin Composition Review

检查一个插件内部：

- manifest 与源码真值是否一致；
- Skills、Extensions、Slash Commands、MCP/App、Dynamic Artifacts 是否围绕连贯产品能力；
- 共享脚本和 runtime projection 是否有单一 owner；
- build-generated 与 source 内容是否正确分层；
- source/final profile 差异是否有明确原因；
- 插件依赖方向是否合理，通用层不得反向依赖项目适配层；
- 普通质量 Review 是否承担 release-only 物化或发布成本；
- 相同 Skill digest 是否被重复评审。

如果问题只存在于跨插件路由或 handoff，不修改当前插件内 leaf Skill；把 owner 交给跨插件 workflow。
