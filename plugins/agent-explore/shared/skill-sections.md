<!-- aw:compatibility-generic -->
支持子代理委派的通用 Agent 宿主，依赖可用的 spawn-subagent；本通用产物仅交付 Skill，不包含原生主会话触发规则或 AW 托管外部执行器。
<!-- /aw:compatibility-generic -->

<!-- aw:compatibility-native -->
AW 支持的宿主，依赖可用的 spawn-subagent；可选平台覆盖与外部执行器由本插件及 agent-subagent 配置决定。
<!-- /aw:compatibility-native -->

<!-- aw:routing-default -->
选型优先级：**用户或上游显式指定 > `spawn-subagent` 默认档位**。

当前未配置专用探索覆盖，直接按任务复杂度通过 `spawn-subagent` 委派：
- 明确、低歧义的检索定位 → `simple` 档；
- 常规跨文件或多来源核对（不确定时默认选此档） → `general` 档；
- 高歧义、多源强冲突或复杂因果深查 → `complex` 档。
<!-- /aw:routing-default -->

<!-- aw:routing-configured-lead -->
选型优先级：**用户或上游显式指定 > 自定义探索路由（若有） > 下方探索档位**。
<!-- /aw:routing-configured-lead -->

<!-- aw:custom-routing-section -->
### 自定义探索路由

按以下数组顺序匹配适用范围，采用首个命中项：

| 适用范围 | executor | model | reasoningEffort |
| --- | --- | --- | --- |
@@ROWS@@
<!-- /aw:custom-routing-section -->

<!-- aw:explore-tiers-section -->
### 探索档位

| 档位 | 适用范围 | executor | model | reasoningEffort |
| --- | --- | --- | --- | --- |
| 常规 / 快速探索 | 明确检索定位或常规跨源核对（不确定时选此档） | @@EXPLORE_CELLS@@ |
| 深度探索 | 高歧义、多源强冲突、复杂因果或高完整性要求 | @@DEEP_CELLS@@ |
<!-- /aw:explore-tiers-section -->
