# Review AW Plugin

只读评价 AW 插件 source/materialized Skill 的设计质量和真实内容差异。

默认路径：

1. `aw plugin validate` 与 `check-agent-skill` 提供确定性事实；
2. build-free source 和已提供 final 按 production digest 去重；声明 build 的插件必须提供 materialized final；
3. 每个唯一 digest 只运行一次通用 `review-agent-skill`；
4. 输出简洁的人类报告。

普通 Review 不维护 stage、profile coverage row 或 release readiness。只有用户明确请求发布检查时，才运行 `check-aw-plugin-release.mjs` 实时重算支持 profile、final 完整性和接受的 ReviewResultLite。

该 Skill 不修改插件。repo-local 或 portable Agent Skill 直接使用 `review-agent-skill`。
