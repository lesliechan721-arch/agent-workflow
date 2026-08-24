# review-aw-plugin

只读评审一个 AW plugin、其内部组件和 source/materialized profile 差异。

## 结果

评审会报告 manifest 机器错误、插件组合的设计与复杂度、真实 source/materialized 差异、必要的 leaf Skill findings、高价值改进和关键 unknown。相同 production digest 的 leaf Skill 最多评审一次。

没有 materialized final 时，只评价当前可见 source 和插件组合质量；不声明发布资格，也不推断不可见产物。跨多个插件共同完成的用户工作流使用 `review-aw-workflow`。

## 边界

本 Skill 不修改 Skill、Eval、README、manifest 或 materialized final。只有用户明确要求发布准备状态时，才单独运行确定性发布检查；检查要求完整 ReviewResultLite v2，并对 required Eval 校验 preflight、run bundle 和 result-triage 的实际 digest 链。
