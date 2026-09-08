# Skill Review Standard

## 1. Value and trigger

- 没有 Skill 时具体失败是什么？
- description 是否对应真实用户意图和 near-miss？
- 调用设计按主文件路由的 Skill 调用标准检查；验证声明、实际 metadata 和被测行为，不把当前项目约定当所有客户端规范。

## 2. Composition

按主文件路由的共享组合标准检查连贯职责、caller/leaf 和权衡。多 Skill/plugin 组合交给 Architecture Review；不能只凭规则数量或分支名要求拆分。

## 3. Minimum control

目标或必要控制存在争议时，先归纳最小行为合同；明确的局部问题不做完整重建。再把相关规则分类：keep-invariant、keep-default、relax、move、delete、needs-ablation。步骤完整不等于步骤必要。

## 4. Content and resources

使用 `agent-content` 检查读者、事实依据、pointer、active path、reference focus、control、completion、source of truth 和 co-location。把只涉及 Skill 调用、手动宏或项目 runner 的规则迁给领域 owner，而不是让通用内容层继续承载。大文件只触发语义审计，不自动要求拆分。

## 5. Output consumer

按共享组合标准核对固定格式的真实用途。没有已存在 parser 不等于无用途，明确的用户格式和目标文件要求也有效；只有无使用目的的伪交接才建议删除。

需要包级追踪时，用 `node <skill-root>/scripts/audit-output-contracts.mjs <target-root> --materialized-root <runtime-root>` 取得源码与物化副本的静态引用线索；没有物化目录时省略该选项。`not-found-in-scope` 或扫描不完整只表示未知，不自动删除文件。

## 6. Scripts

检查是否该脚本化、接口、安全、依赖、测试和确定性；不执行不可信脚本。

## 7. Eval

full 中存在 Eval 时先检查 case/Oracle；源用例可直接做设计审核，不要求先 prepare。需要签发运行准入才要求 validated Spec。存在大量用例或将驱动修改时优先独立上下文审核，不能只看 JSON/数量。正负错误代价不默认对称；混合低样本结果先增加运行；失败先归因，不自动修改 Skill。

## 8. Stop

没有新 observed/normative/direct structural 证据时，不继续增加 common-path 规则。
