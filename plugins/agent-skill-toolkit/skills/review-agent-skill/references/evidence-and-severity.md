# Evidence and Severity

严重度描述当前可达场景的影响，不由文件长度或工具退出码直接决定。

| 等级 | 使用条件 |
| --- | --- |
| critical | 直接证据或适用硬约束证明核心能力不可用，或存在高影响的越权、数据损失风险 |
| major | 证据证明目标场景会出现实质失败，需要修正方法、资源或接口 |
| minor | 局部质量、维护或证据问题，不支持更强的失败结论 |
| advisory | 经验建议、未来风险或尚需对照验证的改善候选 |

证据类型：

- observed：trace、复现、测试或用户确认失败；
- normative：适用规范、schema、项目硬规则或用户要求；
- structural：直接材料在同一可达路径上蕴含 exact claim，不依赖未证实前提；
- official-guidance：官方设计建议；
- heuristic：第三方或经验模式；
- inferred：尚未验证的推演。

critical/major 至少有 observed、normative 或 structural。必须证明：

1. exact claim；
2. 每个 material premise；
3. scenario reachability；
4. material impact；
5. counterevidence 和合理替代解释；
6. owner；
7. minimal action；
8. validation。

Trigger query 只证明输入，expected output 只证明 Oracle，description 重叠只证明潜在匹配；它们不能单独证明运行状态、共载或失败。

## 使用纪律

structural 是证据直接支持 claim 的关系，不是“两个文件都有相关文字”。每个重要前提必须成立；跨 owner 的真实冲突可以是 structural，同 owner 的推演仍不是。fixture state、schema 和 trace 可证明可达路径；自然语言 scenario、expected output、潜在 description 重叠不能替代它们。

quick 下只在可复现失败、明确硬要求或可直接验证的结构错误时给 critical/major；其余记录候选或未知。尺寸、可读性、可能组合失败属于设计建议，未有强证据不升级。

同根因只报一次，缺失证据不要伪装成已证实缺陷。建议修改前确认 owner；Eval 错误先修 Eval/fixture/grader，不给生产 Skill 增加协调规则。只读与写入由用户要求决定，不由加载 Skill 自动授权。

## 相称报告

quick 的局部发现可用位置、证据、影响和最小行动表达；严重结论才完整展开反证、owner 与验证。工具的 error 不自动等于 critical：先核对规则适用性、source/final 和实际场景影响。未知扩展、保守作者基线及扫描限制保留其限定，不升级为 native 客户端必然失败。
