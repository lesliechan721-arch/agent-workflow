<!-- aw:compatibility-generic -->
支持子代理委派的通用 Agent 宿主，依赖可用的 spawn-subagent；本通用产物仅交付 Skill，不包含原生主会话触发规则或 AW 托管外部执行器。
<!-- /aw:compatibility-generic -->

<!-- aw:compatibility-native -->
AW 支持的宿主，依赖可用的 spawn-subagent；可选平台覆盖与异构外部执行器由本插件及 agent-subagent 配置决定。
<!-- /aw:compatibility-native -->

<!-- aw:routing-default-generic -->
选型优先级：**任务禁止外发约束 > 用户或上游显式指定 > 默认顾问路由**。

当前为 `generic` 产物且未配置专用顾问覆盖，按问题复杂度直接通过 `spawn-subagent` 选用 `complex`（常规卡点）或 `advanced`（高歧义/不可逆全局决策）档位。
<!-- /aw:routing-default-generic -->

<!-- aw:routing-default-native -->
选型优先级：**任务禁止外发约束 > 用户或上游显式指定 > 默认顾问路由**。

未配置对应顾问覆盖时：**若任务未禁止外发材料且 `agent-subagent` 已注册与当前宿主不同厂商/家族的可用异构外部执行器，优先通过 `spawn-subagent` 选用异构外部执行器（可回退软偏好**，常规卡点按 `complex` 难度，高歧义/不可逆全局决策按 `advanced` 难度选型）；无可用异构外部执行器时回退 `agent-subagent` 的 `complex` / `advanced` 档位；任务明确禁止外发时限定使用宿主原生 `native`（按对应难度）。
<!-- /aw:routing-default-native -->

<!-- aw:routing-configured-lead -->
选型优先级：**任务禁止外发约束 > 用户或上游显式指定 > 自定义顾问路由（若有） > 下方顾问档位**（命中外部配置但任务禁止外发时改为宿主原生 `native`）。
<!-- /aw:routing-configured-lead -->

<!-- aw:custom-routing-section -->
### 自定义顾问路由

按以下数组顺序匹配适用范围，采用首个命中项：

| 适用范围 | executor | model | reasoningEffort |
| --- | --- | --- | --- |
@@ROWS@@
<!-- /aw:custom-routing-section -->

<!-- aw:advisor-tiers-section -->
### 顾问档位

| 档位 | 适用范围 | executor | model | reasoningEffort |
| --- | --- | --- | --- | --- |
| 常规顾问 | 多模块耦合、冲突假设或影响行动的重要判断卡点 | @@ADVISOR_CELLS@@ |
| 深度顾问 | 高歧义、不可逆后果、全局方案或需深入论证的专业难题 | @@DEEP_CELLS@@ |
<!-- /aw:advisor-tiers-section -->
