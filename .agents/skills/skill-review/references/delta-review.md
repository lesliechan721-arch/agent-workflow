# Delta Review

有上一版时读取。目标是验证改动，而不是重新启动无界初审。

## 范围

只检查：

1. 上轮 P0/P1 是否关闭。
2. 受修改影响的维度和直接回归。
3. `SKILL.md`、pointer、branch、资源、脚本和 eval 的复杂度变化。
4. 新出现的 observed、normative 或 structural 证据。
5. 行为指标是否改善，以及新增内容是否值得其 context/cognitive load。

纯 heuristic 或 inferred 边界不升级为新的发布阻断项。

## Sediment Audit

对每个新增规则记录：

- 它解决哪个真实失败或规范要求。
- 它替换、合并或删除了什么旧内容。
- 对应哪个 behavior/regression eval。
- 净效果是 smaller、neutral 还是 larger。

如果一条旧规则没有当前目标、证据或测试支持，只因“删除可能危险”而保留，标记为 sediment candidate，通过 ablation 决定是否删除。

## No-op 与 Ablation

不要仅凭语言直觉认定某句 no-op。比较：

- 无该句或最小版本。
- 当前版本。
- 相关真实 eval 和 trace。

若删除后质量不降、方差不增，优先删除。若新增文本没有改善 assertion、触发率、token、时间或执行路径，不把它视为成功修复。

## 停止规则

连续两轮出现以下模式时，方向至少为 `at-risk`：

- 正文、控制分支或资源数增长。
- behavior/regression 指标没有改善。
- 新问题主要来自纯推演。

此时停止追加规则，提出架构减法或产品/runtime 改进。旧问题已关闭、无直接回归且没有新强证据时，明确通过并停止。
