# Triggering and Evals Review

## Description 评审

Description 是启动时最重要的发现信息。静态检查以下内容：

- 使用“何时使用”的指令式表达。
- 描述用户意图和任务，而不是内部实现步骤。
- 同时说明能力、使用时机和关键排除项。
- 包含现实用户可能使用的领域词，但不堆砌测试样例关键词。
- 与相邻 Skill 有清晰边界。
- 足够简洁并低于 1024 字符。

静态文案好看不等于触发可靠；没有实际 trigger eval 时必须降低置信度。

## Trigger eval 设计

建议约 20 个现实查询：8–10 个 should-trigger，8–10 个 should-not-trigger。

正例应变化：

- 正式/口语/拼写错误。
- 显式点名和隐式需求。
- 简短与上下文丰富。
- 单步与嵌套在大任务中的场景。

负例优先 near-miss：共享关键词、文件类型或相邻意图，但实际需要不同 Skill。明显无关问题没有判别价值。

每个查询建议运行至少 3 次，记录触发率。固定 train/validation 划分；只用 train 失败指导修改，validation 检查泛化。

## Behavior eval

每个目标失败行为至少有一个可观察断言，例如：

- 是否选择正确工具或参数。
- 是否省略错误步骤。
- 是否遵守输出合同。
- 是否避免读取无关资源。
- 是否在错误条件下停止。

不要只断言最终答案“看起来不错”；检查执行 trace 和工具调用。

## Regression eval

每次修复都应保留原本通过的场景，并增加导致修改的失败 case。修复一个 near-miss 不得显著扩大误触发。

## Ablation

对重要或持续膨胀的 Skill，比较：

1. 无 Skill。
2. 只含核心默认值和 gotcha 的最小 Skill。
3. 当前完整 Skill。

只有当完整版本在行为指标上明显优于最小版本时，额外文本才有依据保留。

## 评分约束

- 无 trigger eval 结果：`triggering` 通常不高于 3。
- 只有 trigger eval、没有 behavior 断言：`evals` 通常不高于 3。
- 只有最终输出、没有 trace：可靠性结论置信度最多 medium。
- eval 只包含 Skill 名称或精确措辞：视为弱测试，防止过拟合。
