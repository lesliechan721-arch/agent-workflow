# Skill Review Standard

## 1. Value and trigger

- 按共享调用标准确定需要补足方法的任务族、默认适用范围、普通执行路径和目标环境；价值结论限于相应执行者、模型与环境。
- 核对 description、metadata、可见 caller、Eval 与真实用户意图/near-miss。约定一致不证明增益；显式选择和合理辅助调用保留。

## 2. Composition

按共享组合标准核对每个实际支持的角色入口能否直接完成其范围；所需角色或调用事实不可见时标为 unknown。跨组件真实路径交 Architecture Review，Skill 数量、名称或潜在共载本身不证明失败。

## 3. Minimum control

目标或必要控制存在争议时，先归纳最小行为合同；明确的局部问题不做完整重建。再把相关规则分类：keep-invariant、keep-default、relax、move、delete、needs-ablation。步骤完整不等于步骤必要。

## 4. Content and resources

先按共享组合标准确认对象视图。源码声明由构建提供的文件，在对应产物中核验；源目录缺少该文件仅说明尚需项目证据。最终包真实断链才作为该包完整性问题，归因另查来源映射。评审所需的源 Eval 可以作为附带材料，不要求测试文件随运行包发布。

使用 `agent-content` 检查读者、事实依据、pointer、active path、reference focus、control、completion、source of truth 和 co-location；按实际输出消费者核对重要决定、设计关系和验收含义是否保留且可访问。

链接与模板存在只证明结构；实际方法和证据是否足以判断目标结果，按该领域要求核对。大文件触发语义检查，Skill 调用、手动宏和 runner 机制由对应领域 owner 处理。

## 5. Output consumer

按共享组合标准核对固定格式的真实用途。没有已存在 parser 不等于无用途，明确的用户格式和目标文件要求也有效；只有无使用目的的伪交接才建议删除。

需要包级追踪时，用 `node <skill-root>/scripts/audit-output-contracts.mjs <target-root> --materialized-root <runtime-root>` 取得源码与物化副本的静态引用线索；没有物化目录时省略该选项。`not-found-in-scope` 或扫描不完整只表示未知，不自动删除文件。

## 6. Scripts

检查是否该脚本化、接口、安全、依赖、测试和确定性；不执行不可信脚本。

## 7. Eval

full 中存在 Eval 时检查 case/Oracle 是否直接支持所声称能力。证据不足、已知缺陷修复、自主检出和真实交接分别取证；交接必须让下游使用本次上游产物。

源设计可先审核；正式运行准入才要求 validated Spec。大量或驱动修改的用例优先由独立上下文审核，已具备本次条件的 Auditor 可直接执行。沿 Eval 标准解释 FN/FP、混合低样本和归因；未运行只说明覆盖与假设，不推导生产 Skill 已失败。

## 8. Stop

没有新 observed/normative/direct structural 证据时，不继续增加 common-path 规则。
