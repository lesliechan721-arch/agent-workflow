# 来源综合与实际消费对照

这是后续执行设计，不是已运行结果或新 Runner 格式。生成阶段已有可解析用例 `synthesize_method_from_source_topics`，位于 [redesign-behavior-cases.json](redesign-behavior-cases.json)。下游必须使用该次真正生成的包，不能换成 Reviewer 用例中的人工正确版本。

## 输入与隔离

冻结 Author、内容方法、源用例和判定依据。生成阶段只提供 case 的 prompt 与 workspaceFiles；断言、判定说明和旧纠正记录仅供评价者使用。方法依赖若已经包含被要求生成的完整目标正文，不计作独立综合。

本轮作者已见这些样例，它们用于诊断与回归，不是真正未见测试。需要泛化结论时，在方法冻结后另外准备未参与修改和选择的新请求；不能仅根据 split 标签声称隔离成立。

取得该次 `skills/window-digest/` 的真实全部文件。运行器核对允许修改范围和来源，将原字节交给新的消费会话，连同下方任务输入。接收者只能访问这个包、输入和已有标准工具；不能通过作者会话或源仓库补读缺失规则。外部依据可由包内引用到达时，按两组相同的允许环境提供并记录。

每个消费任务用独立会话，生成者的历史、Reviewer 判定和答案不进入会话。对比旧版 Author 或无 Author 基线时，生成输入、工具、权限和内容方法条件相同；只改变明确被测的方法。需要比较整个工具包时另列该干预范围。

## 下游任务

共同任务：使用该次生成的 window-digest，摘要 `events.json` 在 UTC `2024-06-01T00:00:00Z` 至 `2024-06-01T01:00:00Z` 的事件。只输出结果，不修改输入。下面的预期只供评价者使用。

### 普通输入

```json
[
  {"eventId":"a1","eventAt":"2024-06-01T00:15:00Z","category":"notice"},
  {"eventId":"a2","eventAt":"2024-06-01T01:00:00Z","category":"notice"}
]
```

预期：notice 为 1；没有无效序号或冲突 ID；不从数量推导服务健康。末端事件不能重复进入相邻窗口。

### 重放、冲突与时区

```json
[
  {"eventId":"e1","eventAt":"2024-06-01T00:00:00Z","category":"info","source":"stream-a"},
  {"eventId":"e1","eventAt":"2024-06-01T00:00:00Z","category":"info","source":"stream-a"},
  {"eventId":"e2","eventAt":"2024-06-01T00:20:00Z","category":"warn","source":"stream-b"},
  {"eventId":"e2","eventAt":"2024-06-01T00:20:00Z","category":"info","source":"stream-b"},
  {"eventId":"e3","eventAt":"2024-06-01T00:25:00","category":"info","source":"stream-b"},
  {"eventId":"e4","eventAt":"2024-06-01T01:00:00Z","category":"info","source":"stream-a"},
  {"eventId":"e5","eventAt":"2024-06-01T01:30:00+01:00","category":"info"},
  {"eventId":"e6","eventAt":"2024-05-31T23:59:59Z","category":"info","source":"stream-a"}
]
```

预期：info 为 2；无效序号为 `[4]`，冲突 ID 为 `e2`，须确认而非选择最后一条。普通摘要不增加缺 source 错误。在另一独立会话对同一数据请求“归档来源比较”：stream-a/info 为 1，未注明来源/info 为 1，其余排除原因不变。

再分别给空数组和不给输入文件：前者明确零，后者索取；都不推导在线服务健康。生成包若带脚本，只在当前授权范围执行并核对其实际结果，不能把命令展示视为运行。

## 判定与当前状态

机械检查输入不变、准确数量、序号与 ID；语义检查分支选择、未知解释和资料可达。实际结果与轨迹分别记录生成、消费两段；人工另看可用性，必要时隐藏版本标签比较。任一方换成手工样本、获得额外答案或缺少独立会话，均不提供整链证据。

三个下游数据场景和缺输入/空输入对照已定义，不属于 Selected Cases 的动态串联功能声明。后续由实际 Runner 依据真实生成包准备本次输入、独立准入与成本授权；本轮不实现新运行器、不执行模型。运行状态为 NOT_RUN。
