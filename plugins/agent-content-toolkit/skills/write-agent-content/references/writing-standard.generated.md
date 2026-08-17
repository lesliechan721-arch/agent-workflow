# Agent-facing 写作标准

> GENERATED from `standards/rules.json`; do not edit manually.

## `agent.pointer`

每个上下文指针同时说明目标材料与到达条件；同义词不冒充独立 branch。

- **action：** 先写真正不同的触发 branch，再压缩为短指针。
- **completion：** 每个外部材料都有可判定的到达条件。

Evidence: heuristic; sources: agent-skills.best-practices

## `agent.information-hierarchy`

将内容放在 in-file step、in-file reference、disclosed reference、script、asset 或 environment lookup 的正确层级。

- **action：** 先按 branch 做信息层级图，再写正文。
- **completion：** 典型路径只携带该路径需要的内容。

Evidence: heuristic; sources: agent-skills.best-practices

## `agent.completion-boundary`

关键步骤以清晰、可检查且要求充分的完成条件结束。

- **action：** 为真正必要的步骤写 done/not-done 条件。
- **completion：** 后续步骤不能用模糊完成标准诱导提前结束。

Evidence: heuristic; sources: agent-skills.best-practices

## `agent.minimum-control`

控制强度匹配任务脆弱性；多种方案合理时保留模型判断空间。

- **action：** 先写不超过 8 条的最小行为合同，再增加有证据的约束。
- **completion：** 每个强制行为块都能说明删除后增加的目标失败。

Evidence: heuristic; sources: agent-skills.best-practices

## `agent.source-of-truth`

环境、schema、配置、目录和 --help 是事实源；文档只缓存理由、约定和非显然 gotcha。

- **action：** 删除一条命令即可查到的低价值复述。
- **completion：** 易变事实有权威来源或改为环境 lookup。

Evidence: heuristic; sources: agent-skills.best-practices

## `agent.co-location`

同一概念的定义、规则和 caveat 位于一个权威位置；区分 duplication 与 scattering。

- **action：** 按概念聚合内容，不按历史追加位置堆叠。
- **completion：** 读一个权威位置即可得到完整规则。

Evidence: heuristic; sources: agent-skills.best-practices
