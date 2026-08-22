# Review AW Plugin

只读评价 AW 插件及其 source/materialized Skill 的设计质量、端到端组合和真实内容差异。

默认路径：

1. `aw plugin validate` 与 `check-agent-skill` 提供确定性事实；
2. build-free source 和已提供 final 按 production digest 去重；声明 build 的插件必须提供 materialized final；
3. 先对完整插件运行一次 `review-agent-skill(target_level=plugin)`，审计 common path、持久合同和最小架构；
4. 仅在定位 finding、区分不同 digest、逐 Skill 请求或发布绑定需要时，按唯一 digest 运行 leaf Review；
5. 输出简洁的人类报告。

普通 Review 不维护 stage、profile coverage row 或 release readiness。只有用户明确请求发布检查时，才运行 `check-aw-plugin-release.mjs` 实时重算支持 profile、final 完整性和接受的 leaf `ReviewResultLite`。

该 Skill 不修改插件。repo-local 或 portable Agent Skill 直接使用 `review-agent-skill`。
